#!/usr/bin/env node
// Admin calls against a deployed Steward. Reads STEWARD_URL and STEWARD_ADMIN_KEY from .dev.vars.
//
//   node scripts/admin.mjs seed [--reset]     seed the demo record (playbooks, thresholds, synthetic history)
//   node scripts/admin.mjs check <path>       run the check for one path now
//   node scripts/admin.mjs file <path>        print one file of the record
import { readFileSync } from "node:fs";

const vars = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const base = process.env.STEWARD_URL ?? vars.STEWARD_URL;
const auth = { authorization: `Bearer ${vars.STEWARD_ADMIN_KEY}` };

async function call(method, path, payload) {
	const res = await fetch(`${base}${path}`, { method, headers: { ...auth, "content-type": "application/json" }, body: payload ? JSON.stringify(payload) : undefined });
	const text = await res.text();
	let out;
	try {
		out = JSON.parse(text);
	} catch {
		out = text;
	}
	if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${typeof out === "string" ? out : JSON.stringify(out)}`);
	return out;
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") {
	console.log(await call("POST", "/api/admin/seed-record", { reset: process.argv.includes("--reset") }));
} else if (cmd === "check") {
	const d = await call("POST", `/api/check/${arg}`);
	const r = d.report;
	console.log(`check ${arg}: ${r.pass ? "PASS" : "FAIL"}  ${r.misses} of ${r.judged} differ from the steward (miss rate ${r.miss_rate.toFixed(3)}, bar ${r.max_acceptable_miss_rate})  engine ${r.engine}, ran on ${r.ran_on}`);
	console.log(`auto-merge ${d.autoMerge}; saved ${d.saved} ${d.commit ? d.commit.slice(0, 7) : ""} in ${d.ms} ms`);
	console.log(`note: ${d.note}`);
	for (const a of d.added) console.log(`  + ${a.kind} ${a.id}: ${a.reason ?? a.note}`);
	console.log(`rows: ${d.rows.map((x) => `${x.miss ? "x" : "."}${x.p.toFixed(2)}`).join(" ")}`);
} else if (cmd === "file") {
	console.log(await call("GET", `/api/record/file?path=${encodeURIComponent(arg)}`));
} else {
	console.log("usage: admin.mjs seed [--reset] | check <path> | file <path>");
	process.exit(2);
}
