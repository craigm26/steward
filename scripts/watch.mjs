#!/usr/bin/env node
// Prints the board: candidates, decisions and the latest events. `--until ready|merged` keeps polling until a
// decision reaches that status (or --timeout seconds pass).
//   node scripts/watch.mjs [--task t1] [--until ready] [--timeout 300] [--events 15]
import { readFileSync } from "node:fs";

const vars = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const arg = (n, d) => {
	const i = process.argv.indexOf(`--${n}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const task = arg("task");
const until = arg("until");
const timeout = Number(arg("timeout", "300")) * 1000;
const nEvents = Number(arg("events", "12"));
const t0 = Date.now();

function show(b, final) {
	const cands = b.candidates.filter((c) => !task || c.task === task);
	const decs = b.decisions.filter((d) => !task || d.task === task);
	const line = cands.map((c) => `${c.agent}:${c.status}${c.checks?.length ? `(${c.checks.filter((k) => k.ok).length}/${c.checks.length})` : ""}`).join(" ") + " | " + decs.map((d) => `${d.id}:${d.status}`).join(" ");
	console.log(`t+${Math.round((Date.now() - t0) / 1000)}s ${line}`);
	if (final) {
		for (const c of cands) {
			console.log(`  ${c.id} ${c.status} ${c.commit?.slice(0, 7) ?? ""} ${c.note ?? ""}`);
			for (const k of c.checks ?? []) console.log(`     ${k.ok ? "pass" : "FAIL"} ${k.name}${k.detail ? `: ${k.detail}` : ""}`);
		}
		for (const d of decs) {
			const j = d.judge;
			if (j) console.log(`  ${d.id}: judge picks ${j.pick} at ${j.probability?.toFixed?.(3)} by "${j.ruleText}" (${j.generated_by?.backend}); route: ${j.route?.why ?? ""}`);
			for (const o of d.referee ?? []) console.log(`     referee on ${o.candidate} (${o.generated_by?.backend} ${o.generated_by?.model}): ${o.objection}`);
			if (d.verdict) console.log(`     verdict: ${JSON.stringify(d.verdict)}`);
			if (d.merged_commit) console.log(`     merged ${d.merged_commit}`);
		}
		console.log("events:");
		for (const e of b.events.slice(-nEvents)) console.log(`  ${e.at.slice(11, 19)} ${e.kind.padEnd(9)} ${e.text}`);
	}
}

for (;;) {
	const b = await (await fetch(`${vars.STEWARD_URL}/api/board`)).json();
	const decs = b.decisions.filter((d) => !task || d.task === task);
	const reached = until && decs.some((d) => d.status === until || (until === "ready" && ["ready", "merging", "merged"].includes(d.status)));
	if (!until || reached || Date.now() - t0 > timeout) {
		show(b, true);
		break;
	}
	show(b, false);
	await new Promise((r) => setTimeout(r, 5000));
}
