#!/usr/bin/env node
// Compares judge engines on decisions a person made: for each one, which candidate each engine picks and whether
// that matches the steward. The same question the weekly check asks, with nothing saved. Covers the demo record's
// history (synthetic, as seeded) and, with --live, decisions read from a running Steward's record.
//   node scripts/judge-eval.mjs                                    mock only
//   node scripts/judge-eval.mjs --engines mock,clef,clef-flash --live    Clef over Workers AI's REST API (wrangler login)
//   TYPESAFE_API_KEY=... node scripts/judge-eval.mjs --engines mock,typesafe --live
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { demoHistory } from "../src/demo/record.ts";
import { backendFor, judge, restModelRunner } from "../src/judge.ts";

const root = new URL("..", import.meta.url).pathname;
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i < 0 ? fallback : (process.argv[i + 1] ?? "");
};
const engines = arg("engines", "mock").split(",");
const live = process.argv.includes("--live");

/** Decisions a person made, with the state the judge sees: [{ id, path, pick, state, synthetic }]. */
async function decisions() {
	const h = demoHistory();
	const out = h.ledger.filter((l) => l.decided_by.kind === "person").map((l) => ({ id: l.decision, path: l.path, pick: l.pick, state: h.records.find((r) => r.id === l.decision)?.state, synthetic: true }));
	if (!live) return out;
	const vars = Object.fromEntries(
		readFileSync(join(root, ".dev.vars"), "utf8")
			.split("\n")
			.filter((l) => l.includes("="))
			.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
	);
	const url = process.env.STEWARD_URL ?? vars.STEWARD_URL;
	const file = async (path) => (await fetch(`${url}/api/record/file?path=${encodeURIComponent(path)}`)).text();
	const ledger = (await file("ledger.jsonl")).split("\n").filter(Boolean).map((l) => JSON.parse(l));
	for (const l of ledger.filter((x) => x.decided_by?.kind === "person" && !x.synthetic)) {
		out.push({ id: l.decision, path: l.path, pick: l.pick, state: JSON.parse(await file(`decisions/${l.decision}.json`)).state, synthetic: false });
	}
	return out;
}

/** Workers AI from here: CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN, or wrangler's login and its first account. */
async function clefRunner() {
	const token = process.env.CLOUDFLARE_API_TOKEN ?? /^oauth_token = "(.*)"$/m.exec(readFileSync(join(process.env.HOME, ".wrangler/config/default.toml"), "utf8"))?.[1];
	const account = process.env.CLOUDFLARE_ACCOUNT_ID ?? (await (await fetch("https://api.cloudflare.com/client/v4/accounts", { headers: { authorization: `Bearer ${token}` } })).json()).result?.[0]?.id;
	return restModelRunner(account, token);
}

const rows = await decisions();
const env = { ...process.env, ...(engines.some((e) => e.startsWith("clef")) ? { CLEF_RUNNER: await clefRunner() } : {}) };
const results = {};
for (const engine of engines) {
	const backend = backendFor(engine, env);
	results[engine] = [];
	for (const d of rows) {
		try {
			const v = await judge(backend, d.state);
			results[engine].push({ pick: v.pick, p: v.probability, rule: v.ruleText, model: v.generated_by.model, cost: v.usage?.cost_usd ?? 0, ms: v.usage?.ms ?? 0 });
		} catch (e) {
			results[engine].push({ error: e.message.slice(0, 120) });
		}
	}
}

const short = (pick) => pick?.split("/").pop() ?? "";
console.log(["decision".padEnd(10), "path".padEnd(8), "steward".padEnd(10), ...engines.map((e) => e.padEnd(26))].join(" "));
rows.forEach((d, i) => {
	const cells = engines.map((e) => {
		const r = results[e][i];
		if (r.error) return `ERROR ${r.error}`.slice(0, 26).padEnd(26);
		return `${r.pick === d.pick ? "  " : "x "}${short(r.pick)} ${r.p.toFixed(2)}`.padEnd(26);
	});
	console.log([`${d.id}${d.synthetic ? "" : "*"}`.padEnd(10), d.path.padEnd(8), short(d.pick).padEnd(10), ...cells].join(" "));
});
console.log("\nmisses (x above) by path, against the steward's pick; * = a live decision");
for (const e of engines) {
	const by = {};
	rows.forEach((d, i) => {
		const r = results[e][i];
		by[d.path] ??= { n: 0, miss: 0, err: 0 };
		by[d.path].n++;
		if (r.error) by[d.path].err++;
		else if (r.pick !== d.pick) by[d.path].miss++;
	});
	const cost = results[e].reduce((a, r) => a + (r.cost ?? 0), 0);
	const ms = results[e].filter((r) => r.ms).map((r) => r.ms).sort((a, b) => a - b);
	console.log(`${e.padEnd(10)} ${Object.entries(by).map(([p, s]) => `${p} ${s.miss}/${s.n}${s.err ? ` (${s.err} errors)` : ""}`).join(", ")}${cost ? `, $${cost.toFixed(6)}` : ""}${ms.length ? `, median ${ms[Math.floor(ms.length / 2)]} ms` : ""}${results[e].find((r) => r.model) ? `, model ${results[e].find((r) => r.model).model}` : ""}`);
}
