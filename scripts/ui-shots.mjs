#!/usr/bin/env node
// Screenshots of the board UI on a machine whose headless Chromium cannot fetch over the network: captures the live
// API's answers with Node, then renders public/ from file:// with fetch and WebSocket stubbed to those answers.
//   node scripts/ui-shots.mjs [route ...]      e.g. "#/board/t1" "#/decision/d-t1" "#/paths" "#/why" "#/ledger"
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const routes = process.argv.slice(2).length ? process.argv.slice(2) : ["#/board", "#/paths", "#/why", "#/ledger"];
const out = "/tmp/steward-shots";
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, "public"), join(out, "site"), { recursive: true });
writeFileSync(join(out, "site/styles.css"), readFileSync(join(out, "site/styles.css"), "utf8").replace('url("/fonts/Archivo.ttf")', 'url("fonts/Archivo.ttf")'));

const get = async (p, auth = true) => {
	const res = await fetch(vars.STEWARD_URL + p, { headers: auth ? { authorization: `Bearer ${vars.STEWARD_ADMIN_KEY}` } : {} });
	return { status: res.status, body: await res.text() };
};
const board = JSON.parse((await get("/api/board")).body);
const fixtures = {
	"/api/board": await get("/api/board"),
	"/api/paths": await get("/api/paths"),
	"/api/files": await get("/api/files"),
	"/api/ledger": await get("/api/ledger"),
	"/api/whoami": { status: 200, body: JSON.stringify({ kind: process.env.AS === "public" ? "public" : "admin" }) },
};
for (const d of board.decisions) fixtures[`/api/decisions/${d.id}`] = await get(`/api/decisions/${d.id}`);
const files = JSON.parse(fixtures["/api/files"].body);
for (const f of files.filter((f) => f.startsWith("src/"))) fixtures[`/api/blame?file=${encodeURIComponent(f)}`] = await get(`/api/blame?file=${encodeURIComponent(f)}`);
for (const r of routes) {
	const m = r.match(/^#\/decision\/(.+)$/);
	if (m && !fixtures[`/api/decisions/${m[1]}`]) fixtures[`/api/decisions/${m[1]}`] = await get(`/api/decisions/${m[1]}`);
}

// Previews: fetch each candidate's page with Node and serve it locally, so iframes never touch the network.
mkdirSync(join(out, "site/previews"), { recursive: true });
let json = JSON.stringify(fixtures);
const urls = [...new Set(json.match(/https:\/\/cand-[a-z0-9-]+\.craigm26\.workers\.dev/g) ?? [])];
for (const u of urls) {
	const name = u.replace(/^https:\/\//, "").split(".")[0];
	try {
		const page = await (await fetch(u + "/")).text();
		writeFileSync(join(out, `site/previews/${name}.html`), page);
		json = json.split(u).join(`previews/${name}.html`);
	} catch {}
}
Object.assign(fixtures, JSON.parse(json));

const stub = `<script>
window.__F = ${JSON.stringify(fixtures)};
localStorage.setItem("steward.key", ${JSON.stringify(process.env.AS === "public" ? "" : "shot")});
window.fetch = async (url) => {
	const u = new URL(url, "http://x/"); const k = u.pathname + u.search;
	const f = window.__F[k] ?? window.__F[u.pathname] ?? { status: 404, body: JSON.stringify({ error: "not in fixtures: " + k }) };
	return new Response(f.body, { status: f.status, headers: { "content-type": "application/json" } });
};
window.WebSocket = class { constructor() { setTimeout(() => this.onopen && this.onopen(), 10); } send() {} close() {} };
</script>`;
const html = readFileSync(join(out, "site/index.html"), "utf8")
	.replace('<link rel="preload" href="/fonts/Archivo.ttf" as="font" type="font/ttf" crossorigin>', "")
	.replace('href="/styles.css"', 'href="styles.css"')
	.replace('<script type="module" src="/app.js"></script>', `${stub}<script type="module" src="app.js"></script>`);
writeFileSync(join(out, "site/index.html"), html);

for (const r of routes) {
	const name = r.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "board";
	const png = join(out, `${name}.png`);
	const url = `file://${join(out, "site/index.html")}${r}`;
	try {
		execFileSync("timeout", ["90", "chromium", "--headless=new", "--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--allow-file-access-from-files", `--user-data-dir=${out}/chr-${name}`, `--window-size=${process.env.W ?? 1440},${process.env.H ?? 1600}`, "--virtual-time-budget=6000", `--screenshot=${png}`, url], { stdio: "pipe" });
		console.log(png);
	} catch (e) {
		console.log(`FAIL ${r}: ${String(e.stderr ?? e.message).slice(0, 300)}`);
	}
}
