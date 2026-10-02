#!/usr/bin/env node
// Saves what the film needs beside the board recording (record.mjs): one API answer at a moment that matters, or the
// Preview page of every candidate on a task, so shoot.mjs can render them later without the network.
//   node film/snap.mjs <run> <name> <api-path>      e.g. node film/snap.mjs race3 decision-d-t2-ready /api/decisions/d-t2
//   node film/snap.mjs <run> previews <task>        each candidate's Preview as previews/cand-<task>-<agent>.html
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const [run, name, target] = process.argv.slice(2);
if (!run || !name || !target) throw new Error("usage: snap.mjs <run> <name> <api-path> | snap.mjs <run> previews <task>");
const dir = join(root, "film", "capture", run);
mkdirSync(join(dir, "previews"), { recursive: true });
const get = async (url) => {
	const res = await fetch(url, { headers: { "cache-control": "no-cache" } });
	if (!res.ok) throw new Error(`${url}: ${res.status}`);
	return res.text();
};

if (name === "previews") {
	const board = JSON.parse(await get(`${vars.STEWARD_URL}/api/board`));
	for (const c of board.candidates.filter((x) => x.task === target && x.preview_url)) {
		try {
			writeFileSync(join(dir, "previews", `cand-${target}-${c.agent}.html`), await get(c.preview_url));
			console.log(`previews/cand-${target}-${c.agent}.html`);
		} catch (e) {
			console.log(`  ${c.agent}: ${e.message}`);
		}
	}
} else {
	writeFileSync(join(dir, `${name}.json`), await get(`${vars.STEWARD_URL}${target}`));
	console.log(`${name}.json`);
}
