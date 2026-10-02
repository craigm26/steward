#!/usr/bin/env node
// Records the live board for the film: every 2 s it saves /api/board (and /api/paths every 10 s) with the time since
// the recording began, until stopped. The film renders these snapshots through the real UI, so every frame of
// product footage is the product's own screen at a real moment.
//   node film/record.mjs <name>          writes film/capture/<name>/board-<ms>.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const name = process.argv[2] ?? "run";
const dir = join(root, "film", "capture", name);
mkdirSync(dir, { recursive: true });
const t0 = Date.now();
let last = "";
let i = 0;
console.log(`recording ${vars.STEWARD_URL} into ${dir}`);
for (;;) {
	const ms = Date.now() - t0;
	try {
		const board = await (await fetch(`${vars.STEWARD_URL}/api/board`)).text();
		// Skip a snapshot identical to the last (same events tail and statuses): the board did not move.
		const sig = board.length + ":" + board.slice(-400);
		if (sig !== last) {
			writeFileSync(join(dir, `board-${String(ms).padStart(8, "0")}.json`), board);
			last = sig;
		}
		if (i % 5 === 0) writeFileSync(join(dir, `paths-${String(ms).padStart(8, "0")}.json`), await (await fetch(`${vars.STEWARD_URL}/api/paths`)).text());
	} catch (e) {
		console.log(`  ${ms} ms: ${e.message}`);
	}
	i++;
	await new Promise((r) => setTimeout(r, 2000));
}
