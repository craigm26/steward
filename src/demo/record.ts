// The demo's decision record: Larkspur Garden Co. (fictional), one steward (Dana, AP lead), two paths.
// The past decisions here are SYNTHETIC, made up so the check has history to replay on day one. Every line and
// record says so (`synthetic: true`), and the UI labels them. Real decisions are appended by the live loop.

import type { FileChange } from "../git/ops";
import type { CandidateEvidence, DecisionState } from "../judge";
import type { DecisionRecord, LedgerLine } from "../check";

export const STEWARD_YAML = `# Steward project: the app agents change, and who decides.
app: larkspur-ap
worker: larkspur-ap
title: Larkspur Garden Co. accounts payable
stewards:
  - key: dana
    name: Dana
    role: AP lead
judge:
  engine: mock
  agent: judge
`;

export const THRESHOLDS_YAML = `# What the judge may decide alone. A decision has two labels: ship (merge this candidate) and pass.
# A path earns auto-merge only through its playbook (auto_merge: earn) and a passing check.
labels:
  - ship
  - pass
act_alone:
  - label: ship
    min_probability: 0.8
always_to_person:
sample:
  fraction: 0.1
  min_per_week: 2
measure:
  weekly_miss_rate_over: all
  full_validation_every_days: 7
  max_acceptable_miss_rate: 0.05
`;

export const RULES_PLAYBOOK = `# Payment rules: what Larkspur pays and what it holds for a person.
# Every change here must keep these checks passing; each task adds its own.
path: rules
title: Payment rules
steward: dana
globs:
  - src/rules.js
  - src/rules/**
  - test/**
done:
  - name: Tests pass and the Preview builds
    kind: build
  - name: The Preview is healthy
    kind: probe
    get: /api/health
    expect: ok=true
  - name: An ordinary invoice is still paid
    kind: probe
    get: /api/invoices/INV-1041/decision
    expect: action=pay
  - name: A large invoice with no purchase order is still held
    kind: probe
    get: /api/invoices/INV-1043/decision
    expect: action=hold
  - name: A duplicate invoice is still held
    kind: probe
    get: /api/invoices/INV-1045/decision
    expect: action=hold
budget:
  minutes: 45
  tokens: 400000
taste:
  - The smallest change that passes every check
  - Adds a test for the new rule
  - The hold reason says what changed, in words an AP clerk understands
auto_merge:
  mode: earn
  min_probability: 0.8
  until_days: 30
max_agents: 6
`;

export const UI_PLAYBOOK = `# The invoice queue page the AP team works from.
path: ui
title: Invoice queue page
steward: dana
globs:
  - src/index.js
  - src/page.js
done:
  - name: Tests pass and the Preview builds
    kind: build
  - name: The queue page renders
    kind: probe
    get: /
    contains: Invoices to pay
  - name: The Preview is healthy
    kind: probe
    get: /api/health
    expect: ok=true
budget:
  minutes: 30
  tokens: 300000
taste:
  - The smallest change that does the job
  - Every hold shows its reason next to the invoice
  - Does not break existing behaviour
auto_merge:
  mode: earn
  min_probability: 0.8
  until_days: 30
max_agents: 4
`;

export const LOCALES_PLAYBOOK = `# Translations of the queue's labels: data only, so the checks read files and no Preview is built.
path: locales
title: Translations
steward: dana
globs:
  - locales/*.json
done:
  - name: The English labels are still valid JSON
    kind: file
    file: locales/en.json
    json: true
budget:
  minutes: 20
  tokens: 100000
taste:
  - The shortest wording that stays clear
  - Every label is in the target language
auto_merge:
  mode: earn
  min_probability: 0.8
  until_days: 30
max_agents: 6
`;

export const RECORD_README = `# Larkspur Garden Co. decision record

Steward keeps every decision about the larkspur-ap app here. This repo is the record; the app repo is the work.

| Path | What it holds |
| --- | --- |
| \`steward.yaml\` | The app, its Worker, the stewards, the judge's engine |
| \`thresholds.yaml\` | What the judge may decide alone |
| \`playbooks/<path>.yaml\` | Per path: its steward, files, done checks, budget, taste rules, auto-merge |
| \`decisions/<id>.json\` | One decision: the candidates, the evidence, the judge, the referee, the steward |
| \`ledger.jsonl\` | One line per merge: who decided, what merged |
| \`checks/<path>/last-report.json\` | The latest check of the judge against the steward |
| \`preferences/grants.jsonl\` | Auto-merge grants, append-only: earned, suspended, revoked |

Decisions marked \`synthetic: true\` are made-up history for the demo, not real work.
`;

// ---------------------------------------------------------------------------
// Synthetic history. A small seeded PRNG keeps it the same on every seed.

function prng(seed: number) {
	let s = seed >>> 0;
	return () => {
		s = (s + 0x6d2b79f5) >>> 0;
		let t = s;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const AGENTS = ["ada", "brook", "cole", "dev", "emery", "finch"];
const RULE_TASKS = [
	"Hold invoices over the approval limit with no purchase order",
	"Hold a second invoice with the same vendor invoice number",
	"Hold invoices from vendors on the payment watch list",
	"Hold invoices dated more than 90 days ago",
	"Hold invoices whose amount differs from the purchase order by more than 5%",
	"Hold invoices from vendors with no tax ID on file",
	"Hold invoices sent to a personal email address",
	"Hold invoices that round to a whole thousand dollars",
];
const LOCALE_TASKS = [
	"Translate the invoice queue into Welsh",
	"Translate the invoice queue into Icelandic",
	"Translate the invoice queue into Catalan",
	"Translate the invoice queue into Estonian",
	"Translate the invoice queue into Basque",
	"Translate the invoice queue into Latvian",
];
const UI_TASKS = [
	"Show the hold reason under each held invoice",
	"Sort held invoices to the top of the queue",
	"Show how many invoices are held in the page header",
	"Show the vendor's account on file next to the pay-to account",
	"Mark invoices received today",
	"Show amounts with thousands separators",
	"Add the purchase order number to each row",
	"Make the queue readable on a phone",
];

function patchFor(kind: "rules" | "ui" | "locales", strong: boolean, i: number): string {
	if (kind === "locales") {
		return strong
			? `+{\n+  "title": "Label ${i}",\n+  "pay": "Pay"\n+}`
			: `+{\n+  "title": "Label ${i}: a much longer way to say the same short thing for the people reading it",\n+  "pay": "Please go ahead and pay this invoice now, when you are ready"\n+}`;
	}
	if (kind === "rules") {
		return strong
			? `+export function rule${i}(invoice, ctx) {\n+\tif (flagged(invoice, ctx)) return { code: "rule-${i}", message: \`Held: the account on file was changed from ••\${prev} on \${date}\` };\n+\treturn null;\n+}`
			: `+export function rule${i}(invoice, ctx) {\n+\tif (flagged(invoice, ctx)) return { code: "rule-${i}" };\n+\treturn null;\n+}\n+// TODO tidy`;
	}
	return strong
		? `+\t<td>\${why}<div class="sub">\${reason.message}</div></td>`
		: `+\t<td class="hold-big">\${why}</td>\n+\t<style>.hold-big { font-size: 18px }</style>`;
}

function candidate(task: string, agent: string, kind: "rules" | "ui" | "locales", strong: boolean, size: number, tests: number, i: number): CandidateEvidence {
	const files = kind === "locales" ? [{ path: `locales/x${i}.json`, added: 10, removed: 0 }] : kind === "rules" ? [{ path: "src/rules.js", added: size, removed: 1 }, ...(tests ? [{ path: "test/rules.test.js", added: 6 * tests, removed: 0 }] : [])] : [{ path: "src/index.js", added: size, removed: 2 }];
	return {
		id: `${task}/${agent}`,
		agent,
		commit: [...`${task}${agent}`].reduce((h, c) => ((h * 31 + c.charCodeAt(0)) >>> 0), 7).toString(16).padStart(8, "0").repeat(5),
		gate1: { passed: true, checks: [{ name: "Tests pass and the Preview builds", ok: true }, { name: "The Preview is healthy", ok: true }] },
		diff: { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0), patch: patchFor(kind, strong, i) },
		testsAdded: tests,
		summary: strong ? "Done: the rule holds the cases in the task and says why." : "I think this should work for most cases.",
	};
}

export interface DemoHistory {
	ledger: LedgerLine[];
	records: DecisionRecord[];
	grants: unknown[];
}

/**
 * Eight past decisions per path. On `rules` the steward always shipped the candidate the playbook's taste rules
 * favour, so the judge agrees and the path can earn auto-merge. On `ui` the steward overruled that candidate three
 * times, so a check finds the judge drifting and suspends the auto-merge `ui` held from an earlier check.
 */
export function demoHistory(now = new Date()): DemoHistory {
	const rand = prng(20261002);
	const ledger: LedgerLine[] = [];
	const records: DecisionRecord[] = [];
	const day = (back: number) => new Date(now.getTime() - back * 864e5).toISOString();
	const build = (kind: "rules" | "ui" | "locales", tasks: string[], taste: string[], title: string, overruled: Set<number>) => {
		tasks.forEach((title_, i) => {
			const task = `${kind === "rules" ? "r" : kind === "ui" ? "u" : "l"}${100 + i}`;
			const id = `d-${task}`;
			const n = 3 + Math.floor(rand() * 2);
			const agents = AGENTS.slice(i % 3, (i % 3) + n);
			const winner = Math.floor(rand() * n);
			const cands = agents.map((a, j) => (j === winner ? candidate(task, a, kind, true, 8, kind === "rules" ? 1 : 0, i) : candidate(task, a, kind, false, 16 + Math.floor(rand() * 20), 0, i)));
			const state: DecisionState = { decision: id, task: { id: task, title: title_, description: title_ }, path: { id: kind, title, taste }, candidates: cands };
			const runnerUp = cands[(winner + 1) % n]!;
			const stewardPick = overruled.has(i) ? runnerUp.id : cands[winner]!.id;
			const at = day(40 - i * 4 - (kind === "ui" ? 1 : 0));
			const overrule = stewardPick !== cands[winner]!.id;
			records.push({
				id,
				state,
				steward: { verdict: overrule ? "overrule" : "agree", pick: stewardPick, by: "dana", at, ...(overrule ? { reason: "Bigger is fine here: the clerks asked for a louder hold." } : {}) },
				synthetic: true,
			});
			ledger.push({
				decision: id,
				task,
				path: kind,
				at,
				pick: stewardPick,
				judge_pick: cands[winner]!.id,
				decided_by: { kind: "person", key: "dana", name: "Dana" },
				verdict: overrule ? "overrule" : "agree",
				synthetic: true,
			});
		});
	};
	build("rules", RULE_TASKS, ["The smallest change that passes every check", "Adds a test for the new rule", "The hold reason says what changed, in words an AP clerk understands"], "Payment rules", new Set());
	build("ui", UI_TASKS, ["The smallest change that does the job", "Every hold shows its reason next to the invoice", "Does not break existing behaviour"], "Invoice queue page", new Set([5, 6, 7]));
	build("locales", LOCALE_TASKS, ["The shortest wording that stays clear", "Every label is in the target language"], "Translations", new Set());
	ledger.sort((a, b) => a.at.localeCompare(b.at));
	const earned = day(18);
	const grants = [
		{
			kind: "grant",
			id: "g-ui-earlier",
			at: earned,
			by: "Dana (playbook ui: auto_merge earn)",
			by_key: "dana",
			agent: "Judge",
			agent_key: "judge",
			engine: "mock",
			label: "ship",
			min_probability: 0.8,
			when: { path: "ui" },
			until: new Date(now.getTime() + 12 * 864e5).toISOString().slice(0, 10),
			note: "Earned by an earlier check: 5 past decisions the judge would have merged on its own, none wrong (synthetic)",
			evidence: { would_sign: 5, wrong: 0, measured_at: earned, model: "mock" },
			synthetic: true,
		},
	];
	return { ledger, records, grants };
}

/** Every file of a freshly seeded demo record. */
export function demoRecordFiles(now = new Date()): FileChange[] {
	const h = demoHistory(now);
	return [
		{ path: "README.md", content: RECORD_README },
		{ path: "steward.yaml", content: STEWARD_YAML },
		{ path: "thresholds.yaml", content: THRESHOLDS_YAML },
		{ path: "playbooks/rules.yaml", content: RULES_PLAYBOOK },
		{ path: "playbooks/ui.yaml", content: UI_PLAYBOOK },
		{ path: "playbooks/locales.yaml", content: LOCALES_PLAYBOOK },
		{ path: "ledger.jsonl", content: h.ledger.map((l) => JSON.stringify(l)).join("\n") + "\n" },
		{ path: "preferences/grants.jsonl", content: h.grants.map((g) => JSON.stringify(g)).join("\n") + "\n" },
		...h.records.map((r) => ({ path: `decisions/${r.id}.json`, content: JSON.stringify(r, null, 2) + "\n" })),
	];
}
