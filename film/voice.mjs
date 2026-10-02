#!/usr/bin/env node
// The narration: each line of film/script.json spoken by Workers AI (Deepgram Aura-2), cached by its text, then laid
// end to end with short pauses into film/audio/narration.wav, and the timeline (when each line starts and ends, and
// each scene) written to film/timeline.json for the film to follow. Uses wrangler's own login for the REST call.
// A line recorded by a person replaces the synthetic one: save it as film/audio/own/<scene>-<n>.wav (or .m4a, .mp3),
// n counting that scene's spoken lines from 1; `--list` prints every name and its line.
//   node film/voice.mjs [--list]
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const here = new URL(".", import.meta.url).pathname;
const script = JSON.parse(readFileSync(join(here, "script.json"), "utf8"));
const audio = join(here, "audio");
mkdirSync(audio, { recursive: true });
const RATE = 48000;
const token = /^oauth_token = "(.*)"$/m.exec(readFileSync(join(process.env.HOME, ".wrangler/config/default.toml"), "utf8"))?.[1];
let account = process.env.CLOUDFLARE_ACCOUNT_ID;
/** The account the Workers AI call bills: CLOUDFLARE_ACCOUNT_ID, or the first account wrangler's login can see. */
async function accountId() {
	account ??= (await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${token}` } })).json()).result?.[0]?.id;
	if (!account) throw new Error("no Cloudflare account: run `npx wrangler login`, or set CLOUDFLARE_ACCOUNT_ID");
	return account;
}

const GAP_LINE = 0.6; // seconds between lines in a scene
const GAP_SCENE = 1.6; // seconds between scenes
const HEAD = 1.2; // silence before the first line
const TAIL = 2.5; // silence after the last line

/** PCM samples (16-bit mono) from a WAV file, wherever its data chunk is. */
function pcm(buf) {
	let p = 12;
	while (p < buf.length) {
		const id = buf.toString("ascii", p, p + 4);
		const size = buf.readUInt32LE(p + 4);
		if (id === "data") return buf.subarray(p + 8, p + 8 + size);
		p += 8 + size;
	}
	throw new Error("no data chunk");
}

/** A person's recording of this line, if there is one, as 48 kHz mono 16-bit samples. */
function own(name) {
	for (const ext of ["wav", "m4a", "mp3", "aiff"]) {
		const f = join(audio, "own", `${name}.${ext}`);
		if (!existsSync(f)) continue;
		const wav = join(audio, `own-${name}.wav`);
		const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", f, "-ac", "1", "-ar", String(RATE), "-sample_fmt", "s16", wav], { stdio: "inherit" });
		if (r.status !== 0) throw new Error(`could not read ${f}`);
		return pcm(readFileSync(wav));
	}
	return null;
}

if (process.argv.includes("--list")) {
	for (const scene of script.scenes) scene.lines.filter((l) => typeof l === "string").forEach((l, i) => console.log(`${scene.id}-${i + 1}  ${l}`));
	process.exit(0);
}

async function speak(text) {
	const file = join(audio, `line-${createHash("sha1").update(script.voice + "\n" + text).digest("hex").slice(0, 12)}.wav`);
	if (!existsSync(file)) {
		for (let attempt = 1; ; attempt++) {
			const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${await accountId()}/ai/run/@cf/deepgram/aura-2-en`, {
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
				body: JSON.stringify({ text, speaker: script.voice, encoding: "linear16", container: "wav", sample_rate: RATE }),
			});
			if (res.ok) {
				writeFileSync(file, Buffer.from(await res.arrayBuffer()));
				break;
			}
			if (attempt >= 4) throw new Error(`TTS ${res.status}: ${(await res.text()).slice(0, 200)}`);
			await new Promise((r) => setTimeout(r, 1500 * attempt));
		}
	}
	return pcm(readFileSync(file));
}

const chunks = [];
const silence = (s) => Buffer.alloc(Math.round(s * RATE) * 2);
let t = 0;
const push = (buf) => {
	chunks.push(buf);
	t += buf.length / 2 / RATE;
};
push(silence(HEAD));
const timeline = { fps: 24, scenes: [], lines: [] };
for (const [si, scene] of script.scenes.entries()) {
	const start = t;
	for (const [li, text] of scene.lines.entries()) {
		// {"hold": seconds}: a silent beat where the picture carries the story.
		if (typeof text === "object") {
			const a = t;
			push(silence(text.hold));
			timeline.lines.push({ scene: scene.id, hold: true, start: +a.toFixed(3), end: +t.toFixed(3) });
			continue;
		}
		const name = `${scene.id}-${scene.lines.slice(0, li + 1).filter((l) => typeof l === "string").length}`;
		const samples = own(name) ?? (await speak(text));
		const a = t;
		push(samples);
		timeline.lines.push({ scene: scene.id, text, start: +a.toFixed(3), end: +t.toFixed(3) });
		if (li < scene.lines.length - 1) push(silence(GAP_LINE));
	}
	const last = si === script.scenes.length - 1;
	push(silence(last ? TAIL : GAP_SCENE));
	timeline.scenes.push({ id: scene.id, start: +start.toFixed(3), end: +t.toFixed(3) });
	console.log(`${scene.id.padEnd(10)} ${start.toFixed(1).padStart(6)} s to ${t.toFixed(1).padStart(6)} s`);
}
timeline.duration = +t.toFixed(3);

const data = Buffer.concat(chunks);
const header = Buffer.alloc(44);
header.write("RIFF", 0);
header.writeUInt32LE(36 + data.length, 4);
header.write("WAVEfmt ", 8);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(RATE, 24);
header.writeUInt32LE(RATE * 2, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write("data", 36);
header.writeUInt32LE(data.length, 40);
writeFileSync(join(audio, "narration.wav"), Buffer.concat([header, data]));
writeFileSync(join(here, "timeline.json"), JSON.stringify(timeline, null, 2) + "\n");
console.log(`narration ${t.toFixed(1)} s (${Math.floor(t / 60)}:${String(Math.round(t % 60)).padStart(2, "0")}), ${timeline.lines.length} lines`);
