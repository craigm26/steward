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

/** Where the voice pauses inside a line: [start, end] seconds from the line's start, at least 0.12 s under an eighth
 * of the line's own speaking level (so a person's recording with room noise works too), plus the silence before the
 * first word and after the last. */
function pauses(samples) {
	const win = RATE / 100; // 10 ms
	const rms = [];
	for (let i = 0; (i + 1) * win * 2 <= samples.length; i++) {
		let sum = 0;
		for (let j = 0; j < win; j++) {
			const v = samples.readInt16LE((i * win + j) * 2);
			sum += v * v;
		}
		rms.push(Math.sqrt(sum / win));
	}
	const loud = [...rms].sort((a, b) => a - b)[Math.floor(rms.length * 0.9)] ?? 0;
	const quiet = rms.map((r) => r < Math.max(150, loud * 0.12));
	// A blip under 40 ms (a breath, a click, a soft consonant) does not break a pause or start the speech.
	for (let i = 0; i < quiet.length; ) {
		let j = i;
		while (j < quiet.length && quiet[j] === quiet[i]) j++;
		if (!quiet[i] && j - i < 4 && (i === 0 || quiet[i - 1]) && (j === quiet.length || quiet[j])) quiet.fill(true, i, j);
		i = j;
	}
	const lead = quiet.indexOf(false);
	const trail = quiet.length - 1 - quiet.lastIndexOf(false);
	const inner = [];
	for (let i = lead; i < quiet.length - trail; ) {
		if (!quiet[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < quiet.length - trail && quiet[j]) j++;
		if (j - i >= 12) inner.push([i / 100, j / 100]);
		i = j;
	}
	return { lead: Math.max(0, lead) / 100, trail: Math.max(0, trail) / 100, inner };
}

/** Marks [character, seconds from the line's start] tying the text to the voice: each pause is matched to the
 * punctuation it follows (an alignment that may leave commas without a pause, or a pause without a comma), so a word's
 * place in the text maps to when it is said, by characters between marks. */
function marks(text, dur, p) {
	const speak = [p.lead, dur - p.trail];
	const B = [...text.matchAll(/[.,;:?!]["')]?\s+/g)].map((m) => ({ at: m.index + m[0].length, strong: /[.?!;:]/.test(m[0][0]) }));
	const est = (b) => speak[0] + ((speak[1] - speak[0]) * b.at) / text.length;
	const G = p.inner;
	const INF = 1e9;
	const cost = Array.from({ length: B.length + 1 }, () => Array(G.length + 1).fill(INF));
	const move = Array.from({ length: B.length + 1 }, () => Array(G.length + 1).fill(""));
	cost[0][0] = 0;
	for (let i = 0; i <= B.length; i++)
		for (let j = 0; j <= G.length; j++) {
			if (cost[i][j] === INF) continue;
			const c = cost[i][j];
			if (i < B.length && c + (B[i].strong ? 0.9 : 0.35) < cost[i + 1][j]) [cost[i + 1][j], move[i + 1][j]] = [c + (B[i].strong ? 0.9 : 0.35), "b"];
			if (j < G.length && c + 0.9 < cost[i][j + 1]) [cost[i][j + 1], move[i][j + 1]] = [c + 0.9, "g"];
			if (i < B.length && j < G.length) {
				const d = Math.abs(est(B[i]) - (G[j][0] + G[j][1]) / 2);
				if (d < 1.6 && c + d < cost[i + 1][j + 1]) [cost[i + 1][j + 1], move[i + 1][j + 1]] = [c + d, "m"];
			}
		}
	const out = [];
	for (let i = B.length, j = G.length; i > 0 || j > 0; ) {
		const m = move[i][j];
		if (m === "m") out.unshift([B[i - 1].at, +G[j - 1][1].toFixed(3)]);
		if (m === "m" || m === "b") i--;
		if (m === "m" || m === "g") j--;
	}
	return [[0, +speak[0].toFixed(3)], ...out, [text.length, +speak[1].toFixed(3)]];
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
		timeline.lines.push({ scene: scene.id, text, start: +a.toFixed(3), end: +t.toFixed(3), marks: marks(text, t - a, pauses(samples)) });
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
