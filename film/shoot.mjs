#!/usr/bin/env node
// Product footage for the film: renders the real Steward UI (public/) from file:// against recorded API answers
// (film/capture/<run>), one shot per moment, at 1600x900 CSS pixels (or taller) and 2x scale, in one headless
// Chromium driven over the DevTools protocol. Nothing is mocked up: each shot is the UI's own rendering of a recorded
// board, decision, blame or ledger.
//   node film/shoot.mjs [shot-name ...]          writes film/shots/<name>.png
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const RUN = process.env.FILM_RUN ?? "race3";
const cap = join(root, "film", "capture", RUN);
const out = join(root, "film", "shots");
const stage = join(root, "film", "stage");
mkdirSync(out, { recursive: true });
rmSync(stage, { recursive: true, force: true });
cpSync(join(root, "public"), stage, { recursive: true });
cpSync(join(cap, "previews"), join(stage, "previews"), { recursive: true });
writeFileSync(join(stage, "styles.css"), readFileSync(join(stage, "styles.css"), "utf8").replace('url("/fonts/Archivo.ttf")', 'url("fonts/Archivo.ttf")'));
writeFileSync(
	join(stage, "index.html"),
	readFileSync(join(stage, "index.html"), "utf8")
		.replace('<link rel="preload" href="/fonts/Archivo.ttf" as="font" type="font/ttf" crossorigin>', "")
		.replace('href="/styles.css"', 'href="styles.css"')
		.replace('<script type="module" src="/app.js"></script>', '<script src="fixtures.js"></script><script type="module" src="app.js"></script>'),
);

// ---------------------------------------------------------------- recorded answers
const boards = readdirSync(cap).filter((f) => /^board-\d+\.json$/.test(f)).map((f) => ({ f, ms: Number(f.slice(6, 14)) })).sort((a, b) => a.ms - b.ms);
const pathsAt = readdirSync(cap).filter((f) => /^paths-\d+\.json$/.test(f)).map((f) => ({ f, ms: Number(f.slice(6, 14)) })).sort((a, b) => a.ms - b.ms);
const read = (f) => readFileSync(join(cap, f), "utf8");
const nearest = (list, s) => list.reduce((best, x) => (Math.abs(x.ms - s * 1000) < Math.abs(best.ms - s * 1000) ? x : best));
const boardAt = (s) => read(nearest(boards, s).f);
const pathsNear = (s) => read(nearest(pathsAt, s).f);
const localPreviews = (text) => text.replace(/https:\/\/(cand-[a-z0-9-]+)-larkspur-ap\.craigm26\.workers\.dev/g, "previews/$1.html");

const maybe = (f) => (existsSync(join(cap, f)) ? { [f]: read(f) } : {});
function fixtures(over) {
	const files = { ...maybe("files.json"), ...maybe("blame-src-rules.js.json"), ...maybe("ledger.json"), ...maybe("decision-d-t1-merged.json") };
	return {
		"/api/whoami": JSON.stringify({ kind: "admin" }),
		...(files["files.json"] ? { "/api/files": files["files.json"] } : {}),
		...(files["blame-src-rules.js.json"] ? { "/api/blame?file=src%2Frules.js": files["blame-src-rules.js.json"] } : {}),
		...(files["ledger.json"] ? { "/api/ledger": files["ledger.json"] } : {}),
		...(files["decision-d-t1-merged.json"] ? { "/api/decisions/d-t1": files["decision-d-t1-merged.json"] } : {}),
		...over,
	};
}

// ---------------------------------------------------------------- the shot list
const open = (sel) => `document.querySelectorAll(${JSON.stringify(sel)}).forEach((d) => d.open = true)`;
const shots = [];
const boardShot = (name, s, task = "t2", post = "", h) => shots.push({ name, h, hash: `#/board/${task}`, fx: fixtures({ "/api/board": boardAt(s), "/api/paths": pathsNear(s) }), post });
// The terms race (task t2), as the board showed it: opened, claimed by seven, checked, two bounced, five through.
// Seven rows run past 900 px, so these shots are taller and the camera pans down to the decision row and the bounces.
for (const s of [20, 31, 33, 38, 43, 50, 55, 64, 67, 78, 95, 106, 135, 141, 150]) boardShot(`race-${String(s).padStart(3, "0")}`, s, "t2", "", 1000);
boardShot("race-064-checks", 64, "t2", `[...document.querySelectorAll("tr")].filter((r) => /nemotron|deepseek/.test(r.textContent)).forEach((r) => r.querySelectorAll("details").forEach((d) => d.open = true))`, 1200);
// The card: ready, Dana writing her reason, shipped. Taller than the screen (h), so the film can pan down a lane to
// the referee's objection and the agent's own words.
const ready = localPreviews(read("decision-d-t2-ready.json"));
const merged = localPreviews(read("decision-d-t2-merged.json"));
shots.push({ name: "card-ready", h: 1400, hash: "#/decision/d-t2", fx: fixtures({ "/api/board": boardAt(150), "/api/paths": pathsNear(150), "/api/decisions/d-t2": ready }), post: "" });
shots.push({
	name: "card-reason",
	h: 1400,
	hash: "#/decision/d-t2",
	fx: fixtures({ "/api/board": boardAt(150), "/api/paths": pathsNear(150), "/api/decisions/d-t2": ready }),
	post: `(() => { const lane = [...document.querySelectorAll(".lane")].find((l) => /\\bglm\\b/.test(l.querySelector(".lanehead").textContent)); const d = lane.querySelector("details.ship"); d.open = true; const t = d.querySelector("textarea"); t.value = "GLM's hold reason says the same as the judge's pick, net 90 against the 60-day limit, in three fewer lines. With the reasons this close, the smallest change decides."; lane.scrollIntoView({ inline: "center" }); })()`,
});
shots.push({ name: "card-merged", h: 1400, hash: "#/decision/d-t2", fx: fixtures({ "/api/board": boardAt(300), "/api/paths": pathsNear(300), "/api/decisions/d-t2": merged }), post: "" });
// Why-blame on a line GLM's decision put there.
const blame = JSON.parse(read("blame-src-rules.js.json"));
const line = blame.find((l) => l.decision === "d-t2" && /unusual|terms/i.test(l.text))?.n ?? blame.find((l) => l.decision === "d-t2")?.n;
shots.push({ name: "why", hash: `#/why/src%2Frules.js/${line}`, fx: fixtures({ "/api/board": boardAt(300), "/api/paths": pathsNear(300), "/api/decisions/d-t2": merged }), post: "", wait: 1400 });
shots.push({ name: "why-plain", hash: "#/why/src%2Frules.js", fx: fixtures({ "/api/board": boardAt(300), "/api/paths": pathsNear(300), "/api/decisions/d-t2": merged }), post: "" });
// The check, path by path.
for (const [name, f] of [["paths-before", "paths-before-checks.json"], ["paths-rules", "paths-after-rules.json"], ["paths-ui", "paths-after-ui.json"], ["paths-locales", "paths-after-locales.json"]]) {
	shots.push({ name, hash: "#/paths", fx: fixtures({ "/api/board": boardAt(300), "/api/paths": read(f) }), post: "" });
}
// The scale run.
for (const s of [440, 450, 455, 460, 465, 470, 475, 480, 490, 500, 520, 540]) boardShot(`scale-${s}`, s, "l-fr");
boardShot("scale-999", 99999, "l-fr");
// What a visitor arriving from a link sees first (not in the film; a check on the visitor strip).
shots.push({ name: "visitor", hash: "#/board/t2", fx: fixtures({ "/api/whoami": JSON.stringify({ kind: "public" }), "/api/board": boardAt(99999), "/api/paths": pathsNear(99999) }), post: "" });
// The ledger at the end, tall enough to reach Dana's two decisions under the judge's sixteen.
shots.push({ name: "ledger", h: 1500, hash: "#/ledger", fx: fixtures({ "/api/board": boardAt(99999), "/api/paths": read("paths-end.json") }), post: "" });

// ---------------------------------------------------------------- element boxes
const RECTS = `(() => {
	const box = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
	const out = {};
	const add = (key, el, text) => { (out[key] ??= []).push({ ...box(el), text: String(text ?? el.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 140) }); };
	document.querySelectorAll(".claims tbody tr").forEach((tr) => {
		const name = tr.querySelector(".agent")?.childNodes[1]?.textContent ?? "";
		add("row", tr, name);
		tr.querySelectorAll("td").forEach((td, i) => add("cell" + i, td, name));
	});
	document.querySelectorAll(".claims thead th").forEach((th) => add("th", th));
	for (const s of [".taskhead", ".taskhead h1", ".feed", ".decisionrow", ".totals", ".tasks", ".rail", ".proposal", ".verdict", ".seal", ".whypanel", ".code", ".code tr.sel", ".finish", ".files", ".bar"]) document.querySelectorAll(s).forEach((el) => add(s, el));
	document.querySelectorAll(".code tr.from").forEach((tr) => add("fromline", tr, tr.dataset.n));
	document.querySelectorAll(".lane").forEach((lane) => {
		const name = lane.querySelector(".lanehead .agent")?.childNodes[1]?.textContent ?? "";
		add("lane", lane, name);
		for (const s of [".frame", ".figures", ".objection", ".words", "details.ship", "details.checks", ".tag", "button"]) lane.querySelectorAll(s).forEach((el) => add("lane" + s, el, name));
	});
	document.querySelectorAll("section.path").forEach((p) => {
		const name = p.querySelector("h2")?.textContent ?? "";
		add("path", p, name);
		for (const s of [".auto .big", ".dots", "ul.grants", ".rate", "button"]) p.querySelectorAll(s).forEach((el) => add("path" + s, el, name));
	});
	document.querySelectorAll("table.ledger tbody tr").forEach((tr) => {
		add("ledgerrow", tr);
		tr.querySelectorAll("td").forEach((td, i) => add("ledgercell" + i, td, tr.textContent));
	});
	document.querySelectorAll("table.ledger thead th").forEach((th) => add("ledgerth", th));
	document.querySelectorAll(".whypanel .verdict, .whypanel .objection, .whypanel .alsoran, .whypanel h2, .whypanel .row").forEach((el) => add("why" + el.tagName + "." + el.className.split(" ")[0], el));
	document.querySelectorAll(".totals .fig").forEach((el) => add("fig", el));
	out._view = [{ x: 0, y: 0, w: innerWidth, h: innerHeight, text: "" }];
	return JSON.stringify(out);
})()`;

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
	ws.onmessage = (m) => {
		const j = JSON.parse(String(m.data));
		if (j.id && wait.has(j.id)) {
			wait.get(j.id)(j);
			wait.delete(j.id);
		}
	};
	const call = (method, params = {}) =>
		new Promise((ok, no) => {
			const n = ++id;
			wait.set(n, (j) => (j.error ? no(new Error(`${method}: ${j.error.message}`)) : ok(j.result)));
			ws.send(JSON.stringify({ id: n, method, params }));
		});
	return { call, close: () => ws.close() };
}

const want = new Set(process.argv.slice(2));
const todo = shots.filter((s) => !want.size || want.has(s.name));
const port = 9800 + Math.floor(Math.random() * 100);
const prof = mkdtempSync(join(tmpdir(), "steward-shoot-"));
const chrome = spawn("nice", ["chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${prof}`, `--remote-debugging-port=${port}`, "--window-size=1600,900", "about:blank"], { stdio: "ignore" });
try {
	const { call, close } = await cdp(port);
	await call("Page.enable");
	for (const s of todo) {
		await call("Emulation.setDeviceMetricsOverride", { width: 1600, height: s.h ?? 900, deviceScaleFactor: 2, mobile: false });
		const fx = Object.fromEntries(Object.entries(s.fx).map(([k, v]) => [k, { status: 200, body: v }]));
		writeFileSync(
			join(stage, "fixtures.js"),
			`window.__F = ${JSON.stringify(fx)};\nlocalStorage.setItem("steward.key", "film");\nwindow.fetch = async (url) => { const u = new URL(url, "http://x/"); const k = u.pathname + u.search; const f = window.__F[k] ?? window.__F[u.pathname] ?? { status: 404, body: JSON.stringify({ error: "not recorded: " + k }) }; return new Response(f.body, { status: f.status, headers: { "content-type": "application/json" } }); };\nwindow.WebSocket = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 5); } send() {} close() {} };\n`,
		);
		// A query string per shot makes each one a fresh page load (a hash change alone keeps the old page and data).
		await call("Page.navigate", { url: `file://${join(stage, "index.html")}?shot=${encodeURIComponent(s.name)}${s.hash}` });
		await call("Runtime.evaluate", { expression: "new Promise((ok) => { const go = () => (document.readyState === 'complete' ? ok(1) : setTimeout(go, 50)); go(); })", awaitPromise: true });
		await call("Runtime.evaluate", { expression: "document.fonts.ready.then(() => 1)", awaitPromise: true });
		await new Promise((r) => setTimeout(r, s.wait ?? 900));
		if (s.post) await call("Runtime.evaluate", { expression: s.post });
		await new Promise((r) => setTimeout(r, 400));
		const shot = await call("Page.captureScreenshot", { format: "png" });
		writeFileSync(join(out, `${s.name}.png`), Buffer.from(shot.data, "base64"));
		// Where things are, in CSS pixels of this shot, so the film's camera and highlights land on them.
		const rects = await call("Runtime.evaluate", { expression: RECTS, returnByValue: true });
		writeFileSync(join(out, `${s.name}.json`), rects.result.value);
		console.log(`${s.name}.png`);
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
