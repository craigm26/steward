#!/usr/bin/env node
// Renders the film: film/scenes.html stepped frame by frame in one headless Chromium (render(t), then a screenshot),
// then ffmpeg joins the frames and the narration into film/out/steward-explainer.mp4.
//   node film/render.mjs                         every frame, then the MP4
//   node film/render.mjs --at 61,98.5,150        single frames to film/check/, and a contact sheet of them
//   node film/render.mjs --from 100 --to 130     re-render a slice of frames (seconds); no encode
//   node film/render.mjs --encode                encode the frames already in film/frames/
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const film = new URL(".", import.meta.url).pathname;
const timeline = JSON.parse(readFileSync(join(film, "timeline.json"), "utf8"));
const FPS = timeline.fps;
const total = Math.ceil(timeline.duration * FPS);
const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? undefined : (process.argv[i + 1] ?? "");
};
const has = (name) => process.argv.includes(`--${name}`);
const frames = join(film, "frames");
const out = join(film, "out");

/** The narration at -16 LUFS (the TTS comes out near -23): ffmpeg's loudnorm, measured first, then applied. */
function normalized() {
	const src = join(film, "audio", "narration.wav");
	const dst = join(film, "audio", "narration-16lufs.wav");
	if (existsSync(dst) && statSync(dst).mtimeMs > statSync(src).mtimeMs) return dst;
	const target = "I=-16:TP=-1.5:LRA=11";
	const probe = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" });
	const a = probe.stderr.lastIndexOf("{");
	const m = JSON.parse(probe.stderr.slice(a, probe.stderr.indexOf("}", a) + 1));
	const r = spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", src, "-af", `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`, "-ar", "48000", dst], { stdio: "inherit" });
	if (r.status !== 0) throw new Error("loudnorm failed");
	return dst;
}

function encode() {
	mkdirSync(out, { recursive: true });
	const mp4 = join(out, "steward-explainer.mp4");
	const r = spawnSync(
		"nice",
		["ffmpeg", "-loglevel", "error", "-stats", "-y", "-framerate", String(FPS), "-i", join(frames, "%05d.jpg"), "-i", normalized(), "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", "-g", String(FPS * 2), "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart", mp4],
		{ stdio: "inherit" },
	);
	if (r.status !== 0) throw new Error("ffmpeg failed");
	console.log(mp4);
}

if (has("encode")) {
	encode();
	process.exit(0);
}

// ---------------------------------------------------------------- what the page needs: the timeline, and every shot's boxes
const shots = join(film, "shots");
const rects = Object.fromEntries(readdirSync(shots).filter((f) => f.endsWith(".json")).map((f) => [f.slice(0, -5), JSON.parse(readFileSync(join(shots, f), "utf8"))]));
const inject = `window.TIMELINE = ${JSON.stringify(timeline)};\nwindow.RECTS = ${JSON.stringify(rects)};`;

// ---------------------------------------------------------------- Chromium over CDP
async function cdp(port) {
	let list = [];
	for (let i = 0; i < 80 && !list.length; i++) {
		try {
			list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((x) => x.type === "page");
		} catch {}
		await new Promise((r) => setTimeout(r, 250));
	}
	if (!list.length) throw new Error("chromium did not open a page");
	const ws = new WebSocket(list[0].webSocketDebuggerUrl);
	await new Promise((ok, no) => {
		ws.onopen = ok;
		ws.onerror = no;
	});
	let id = 0;
	const wait = new Map();
	const events = [];
	ws.onmessage = (m) => {
		const j = JSON.parse(String(m.data));
		if (j.id && wait.has(j.id)) {
			wait.get(j.id)(j);
			wait.delete(j.id);
		} else if (j.method) for (const f of events) f(j);
	};
	const call = (method, params = {}) =>
		new Promise((ok, no) => {
			const n = ++id;
			wait.set(n, (j) => (j.error ? no(new Error(`${method}: ${j.error.message}`)) : ok(j.result)));
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	return { call, on: (f) => events.push(f), close: () => ws.close() };
}

let fullRun = false;
const port = 9700 + Math.floor(Math.random() * 100);
const prof = mkdtempSync(join(tmpdir(), "steward-film-"));
const chrome = spawn("nice", ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, "--window-size=1920,1080", "about:blank"], { stdio: "ignore" });
try {
	const { call, on, close } = await cdp(port);
	const errors = [];
	on((e) => {
		if (e.method === "Runtime.exceptionThrown") errors.push(e.params.exceptionDetails.exception?.description ?? e.params.exceptionDetails.text);
		if (e.method === "Runtime.consoleAPICalled" && e.params.type === "error") errors.push(e.params.args.map((a) => a.value ?? a.description).join(" "));
	});
	await call("Page.enable");
	await call("Runtime.enable");
	await call("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
	await call("Page.addScriptToEvaluateOnNewDocument", { source: inject });
	await call("Page.navigate", { url: `file://${join(film, "scenes.html")}` });
	const ready = await call("Runtime.evaluate", {
		expression: "new Promise((ok) => { const t0 = Date.now(); const go = () => (window.READY ? window.READY.then(() => ok('ready')) : Date.now() - t0 > 15000 ? ok('timeout') : setTimeout(go, 50)); go(); })",
		awaitPromise: true,
		returnByValue: true,
	});
	if (ready.result.value !== "ready" || errors.length) throw new Error(`the film page did not start:\n${errors.join("\n") || ready.result.value}`);

	const frame = async (t) => {
		const r = await call("Runtime.evaluate", { expression: `window.render(${t})`, awaitPromise: true, returnByValue: true });
		if (r.exceptionDetails) throw new Error(`render(${t}): ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
		const shot = await call("Page.captureScreenshot", { format: "jpeg", quality: 92 });
		return Buffer.from(shot.data, "base64");
	};

	if (arg("probe") !== undefined) {
		// What is on screen at one moment: the camera's shot, and every visible highlight and label.
		for (const t of arg("probe").split(",").map(Number)) {
			await call("Runtime.evaluate", { expression: `window.render(${t})`, awaitPromise: true });
			const r = await call("Runtime.evaluate", {
				expression: `JSON.stringify({ imgs: [...document.querySelectorAll("#cam img")].map((i) => i.src.split("/").pop() + " " + i.style.opacity), hl: [...document.querySelectorAll("#hls .hl")].filter((e) => +e.style.opacity > 0).map((e) => [e.className, e.style.left, e.style.top, e.style.width, e.style.height, (+e.style.opacity).toFixed(2)].join(" ")), tags: [...document.querySelectorAll(".tagline")].filter((e) => +e.style.opacity > 0).map((e) => e.textContent + " @" + e.style.left + "," + e.style.top) })`,
				returnByValue: true,
			});
			console.log(t, r.result.value);
		}
	} else if (arg("at") !== undefined) {
		// Check frames: one JPEG per time asked, and a contact sheet of them (three across).
		const check = join(film, "check");
		rmSync(check, { recursive: true, force: true });
		mkdirSync(check, { recursive: true });
		const times = arg("at").split(",").map(Number);
		for (const [i, t] of times.entries()) {
			writeFileSync(join(check, `c-${String(i).padStart(3, "0")}.jpg`), await frame(t));
			console.log(`${t.toFixed(2)} s`);
		}
		spawnSync("ffmpeg", ["-loglevel", "error", "-y", "-i", join(check, "c-%03d.jpg"), "-vf", "scale=960:-1,tile=2x3:padding=8:color=white", join(check, "sheet-%02d.jpg")], { stdio: "inherit" });
	} else {
		mkdirSync(frames, { recursive: true });
		const from = arg("from") !== undefined ? Math.floor(Number(arg("from")) * FPS) : 0;
		const to = arg("to") !== undefined ? Math.min(total, Math.ceil(Number(arg("to")) * FPS)) : total;
		const t0 = Date.now();
		for (let f = from; f < to; f++) {
			writeFileSync(join(frames, `${String(f).padStart(5, "0")}.jpg`), await frame(f / FPS));
			if ((f - from) % 240 === 239) {
				const per = (Date.now() - t0) / (f - from + 1);
				console.log(`frame ${f + 1} of ${to} (${(f / FPS).toFixed(0)} s), ${per.toFixed(0)} ms a frame, ${(((to - f) * per) / 60000).toFixed(1)} min to go`);
			}
		}
		if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
		fullRun = from === 0 && to === total;
	}
	close();
} finally {
	await new Promise((r) => {
		chrome.once("exit", r);
		chrome.kill();
		setTimeout(r, 3000);
	});
	try {
		rmSync(prof, { recursive: true, force: true });
	} catch {
		// Chromium may still be writing its profile; a leftover temp folder is harmless.
	}
}
if (fullRun) encode();
