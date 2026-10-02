// The check: replay the judge against the steward's past decisions on one path, then turn auto-merge on or off.
// It is PlatAtlas's weekly check, run in a Worker on the record repo in Artifacts:
//   - one row per past decision the steward made: would shipping the judge's pick have matched the steward?
//   - buildCheckReport counts it the way PlatAtlas does; a pass needs at least one judged decision and a miss rate
//     at or under the bar
//   - grants.ts decides the rest: reviewReport suspends a grant whose evidence now holds a wrong merge, and
//     checkNewGrant lets a path earn one only on enough evidence with none wrong
// Fails closed: a judge call that fails counts as a miss, and a check with too many failed calls is not saved.

import { buildCheckReport, historyLine, type CheckReport, type CheckRow } from "../vendor/platatlas/report.ts";
import { checkNewGrant, foldGrants, reviewReport, type GrantState } from "../vendor/platatlas/grants.ts";
import { backendFor, judge, type DecisionState, type JudgeEnv } from "./judge";
import { parsePlaybook, parseProject, parseThresholds } from "./record/playbook";
import { jsonl, RecordStore, type Author } from "./record/store";

export const MAX_CHECK_ERROR_SHARE = 0.05;
export const CHECK_AUTHOR: Author = { name: "Steward check", email: "check@steward.invalid" };

/** One line of ledger.jsonl: a decision, who made it, and what merged. */
export interface LedgerLine {
	decision: string;
	task: string;
	path: string;
	at: string;
	pick: string;
	judge_pick?: string;
	judge_probability?: number;
	decided_by: { kind: "person" | "agent"; key: string; name: string; grant?: string };
	verdict: "agree" | "overrule" | "auto";
	merged_commit?: string;
	synthetic?: boolean;
}

/** decisions/<id>.json: the full record of one decision, enough to replay the judge on it. */
export interface DecisionRecord {
	id: string;
	state: DecisionState;
	judge?: { pick: string; probability: number; rule: number; ruleText: string; generated_by: unknown };
	referee?: { candidate: string; objection: string; generated_by: unknown }[];
	steward?: { verdict: "agree" | "overrule"; pick: string; reason?: string; by: string; at: string };
	auto?: { grant: string; sampled: boolean };
	merge?: { commit: string; at: string; from: string };
	synthetic?: boolean;
}

/** PlatAtlas's report shape, saying where it ran. */
export type StewardReport = Omit<CheckReport, "ran_on"> & { ran_on: string };

export interface CheckOutcome {
	path: string;
	report: StewardReport;
	grantsBefore: GrantState[];
	added: unknown[];
	autoMerge: "on" | "off";
	commit: string | null;
	saved: boolean;
	note: string;
}

const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * 864e5).toISOString().slice(0, 10);

export async function runCheck(store: RecordStore, pathId: string, env: JudgeEnv, opts: { at?: string; engine?: string } = {}): Promise<CheckOutcome> {
	const at = opts.at ?? new Date().toISOString();
	const files = ["steward.yaml", "thresholds.yaml", `playbooks/${pathId}.yaml`, "preferences/grants.jsonl", "ledger.jsonl"];
	const snap = await store.snapshot(files);
	const need = (p: string) => {
		const t = snap.files[p];
		if (t == null) throw new Error(`the record has no ${p}`);
		return t;
	};
	const project = parseProject(need("steward.yaml"));
	const thresholds = parseThresholds(need("thresholds.yaml"));
	const playbook = parsePlaybook(need(`playbooks/${pathId}.yaml`), `playbooks/${pathId}.yaml`);
	const engine = opts.engine ?? project.judge.engine;
	const backend = backendFor(engine, env);

	// Only decisions a person made are evidence: a merge the judge made on its own never grades the judge.
	const lines = jsonl<LedgerLine>(snap.files["ledger.jsonl"]).filter((l) => l.path === pathId && l.decided_by.kind === "person");
	const records = await Promise.all(
		lines.map(async (l) => {
			const t = await store.text(`decisions/${l.decision}.json`, snap.head ?? undefined);
			return t ? (JSON.parse(t) as DecisionRecord) : null;
		}),
	);

	const detail: CheckRow[] = [];
	let generatedBy: { backend: string; model: string; source: "inferred" } | null = null;
	const usage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, ms: 0 };
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		const rec = records[i];
		if (!rec) {
			detail.push({ id: line.decision, expected: "ship", got: "(error)", probability: 0, miss: true, error: "decision record missing" });
			continue;
		}
		const t0 = Date.now();
		try {
			const v = await judge(backend, rec.state);
			generatedBy = { backend: v.generated_by.backend, model: v.generated_by.model, source: "inferred" };
			usage.input_tokens += v.usage?.input_tokens ?? 0;
			usage.output_tokens += v.usage?.output_tokens ?? 0;
			usage.cost_usd += v.usage?.cost_usd ?? 0;
			const same = v.pick === line.pick;
			detail.push({ id: line.decision, expected: same ? "ship" : "pass", got: "ship", probability: v.probability, miss: !same, probabilities: v.probabilities });
		} catch (e) {
			detail.push({ id: line.decision, expected: "ship", got: "(error)", probability: 0, miss: true, error: (e as Error).message.slice(0, 200) });
		}
		usage.ms += Date.now() - t0;
	}

	const base = buildCheckReport({
		at,
		full: true,
		over: "all",
		rows: lines.length,
		max_acceptable_miss_rate: thresholds.measure.max_acceptable_miss_rate,
		detail,
		generated_by: generatedBy,
		engine,
		usage,
	});
	const report: StewardReport = { ...base, ran_on: "steward" };

	const grantsBefore = foldGrants(snap.files["preferences/grants.jsonl"] ?? "", at);
	const mine = (g: GrantState) => g.when?.path === pathId && g.label === "ship";
	const caseStateOf = () => ({ path: pathId });
	const failed = detail.filter((d) => d.error !== undefined).length;

	// An outage is not a check: its failed calls would read as wrong answers.
	if (detail.length && failed > detail.length * MAX_CHECK_ERROR_SHARE) {
		const active = grantsBefore.some((g) => mine(g) && g.status === "active");
		return { path: pathId, report, grantsBefore, added: [], autoMerge: active ? "on" : "off", commit: null, saved: false, note: `${failed} of ${detail.length} judge calls failed; nothing saved` };
	}

	const added: unknown[] = [];
	if (!report.pass) {
		// Drift: on a failed check every auto-merge grant on the path stops, saying by how much the judge differs.
		for (const g of grantsBefore.filter((g) => mine(g) && g.status === "active")) {
			added.push({ kind: "suspend", id: g.id, at, reason: `The check failed: ${report.misses} of ${report.judged} past decisions differ from the steward's, over the bar of ${Math.round(report.max_acceptable_miss_rate * 100)}%` });
		}
	} else {
		// On a passing check, a grant whose own evidence now holds a wrong merge, or too little, still stops
		// (PlatAtlas reviewReport). Its sentence speaks of signed cases; here those are merged decisions.
		for (const s of reviewReport(grantsBefore.filter(mine), report as unknown as CheckReport, caseStateOf, at)) {
			added.push({ ...s, reason: s.reason.replace(/the measure of \d{4}-\d{2}-\d{2}: /g, "The check: ").replace(/the measure of/g, "the check of").replace(/would have signed/g, "would have merged").replace(/past cases/g, "past decisions") });
		}
	}
	const stillActive = grantsBefore.some((g) => mine(g) && g.status === "active" && !added.some((a) => (a as { id: string }).id === g.id));

	let note = report.pass ? "the judge agrees with the steward within the bar" : "the judge drifts from the steward";
	if (playbook.auto_merge.mode === "earn" && report.pass && !stillActive && generatedBy) {
		const until = addDays(at, playbook.auto_merge.until_days);
		const verdict = checkNewGrant({
			thresholds,
			terms: { label: "ship", min_probability: playbook.auto_merge.min_probability, when: { path: pathId }, until },
			at,
			report: report as unknown as CheckReport,
			caseStateOf,
			engine: generatedBy.backend,
		});
		if (verdict.ok) {
			const steward = project.stewards.find((s) => s.key === playbook.steward);
			added.push({
				kind: "grant",
				id: `g-${pathId}-${at.slice(0, 10)}-${Math.random().toString(36).slice(2, 6)}`,
				at,
				by: `${steward?.name ?? playbook.steward} (playbook ${pathId}: auto_merge earn)`,
				by_key: playbook.steward,
				agent: "Judge",
				agent_key: project.judge.agent,
				engine: generatedBy.backend,
				label: "ship",
				min_probability: verdict.min_probability,
				when: verdict.when,
				until,
				note: `Earned by the check: ${verdict.evidence.would_sign} past decisions the judge would have merged on its own, none wrong`,
				evidence: { would_sign: verdict.evidence.would_sign, wrong: 0, measured_at: at, model: generatedBy.model },
			});
			note = `auto-merge earned on ${verdict.evidence.would_sign} past decisions, none wrong`;
		} else {
			note = `the check passed, but auto-merge is not earned yet (${verdict.code}${"n" in verdict ? `: ${verdict.n}` : ""})`;
		}
	}
	const autoMerge = stillActive || added.some((a) => (a as { kind: string }).kind === "grant") ? "on" : "off";

	const written = await store.update(["checks/history.jsonl", "preferences/grants.jsonl"], (s) => {
		const hist = s.files["checks/history.jsonl"] ?? "";
		const grants = s.files["preferences/grants.jsonl"] ?? "";
		const line = (text: string, more: unknown[]) => (more.length ? text + (text && !text.endsWith("\n") ? "\n" : "") + more.map((m) => JSON.stringify(m)).join("\n") + "\n" : text);
		const changes = [
			{ path: `checks/${pathId}/last-report.json`, content: JSON.stringify(report, null, 2) + "\n" },
			{ path: "checks/history.jsonl", content: line(hist, [{ path: pathId, ...historyLine(report as unknown as CheckReport), auto_merge: autoMerge }]) },
		];
		if (added.length) changes.push({ path: "preferences/grants.jsonl", content: line(grants, added) });
		return { files: changes, message: `Check ${pathId}: ${report.pass ? "pass" : "fail"}, ${report.misses} of ${report.judged} differ, auto-merge ${autoMerge}\n\n${note}` };
	}, CHECK_AUTHOR);

	return { path: pathId, report, grantsBefore, added, autoMerge, commit: written?.commit ?? null, saved: !!written, note };
}
