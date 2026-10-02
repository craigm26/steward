// The judge: proposes one candidate per decision and names the taste rule that decided it. It never decides; the
// steward does, unless the path has earned auto-merge. Two engines share PlatAtlas's judgment contract:
//   typesafe  Jev over HTTP (needs TYPESAFE_API_KEY)
//   mock      a rubric that scores the evidence by the playbook's taste rules, deterministic and free
// Honesty canon: every verdict carries generated_by and is inferred.

import {
	MockJudgmentBackend,
	TypeSafeJudgmentBackend,
	parseEngineSpec,
	type ChoiceAnswer,
	type JudgmentBackend,
	type JudgmentQuestion,
	type JudgmentRequest,
	type JudgmentResult,
} from "../vendor/platatlas/judgment-core.ts";

/** Everything a judge (or the steward) sees about one candidate. Evidence first; the agent's own summary last. */
export interface CandidateEvidence {
	id: string; // `${task}/${agent}`
	agent: string;
	commit: string;
	previewUrl?: string;
	gate1: { passed: boolean; checks: { name: string; ok: boolean; detail?: string }[] };
	diff: { files: { path: string; added: number; removed: number }[]; added: number; removed: number; patch?: string };
	testsAdded?: number;
	summary?: string;
}

export interface DecisionState {
	decision: string;
	task: { id: string; title: string; description: string };
	path: { id: string; title: string; taste: string[] };
	candidates: CandidateEvidence[];
}

export interface JudgeVerdict {
	pick: string;
	probability: number;
	probabilities: Record<string, number>;
	rule: number; // index into path.taste
	ruleText: string;
	generated_by: JudgmentResult["generated_by"];
	usage?: JudgmentResult["usage"];
	eligible: string[];
}

export interface JudgeEnv {
	TYPESAFE_API_KEY?: string;
}

/** Only candidates that cleared gate 1 can be picked. */
export function eligible(state: DecisionState): CandidateEvidence[] {
	return state.candidates.filter((c) => c.gate1.passed);
}

const optionId = (i: number) => `c${i + 1}`;
const ruleId = (i: number) => `r${i + 1}`;

/** The judgment request for one decision: which candidate ships, and which taste rule decided it. */
export function judgeRequest(state: DecisionState): { req: JudgmentRequest; options: Map<string, string> } {
	const pool = eligible(state);
	if (!pool.length) throw new Error(`decision ${state.decision}: no candidate cleared gate 1`);
	const options = new Map(pool.map((c, i) => [optionId(i), c.id]));
	const candidates: Record<string, string> = {};
	pool.forEach((c, i) => {
		candidates[optionId(i)] = `${c.agent}: ${c.diff.added} lines added, ${c.diff.removed} removed in ${c.diff.files.length} file(s)` + (c.testsAdded ? `, ${c.testsAdded} test(s) added` : "");
	});
	const questions: Record<string, JudgmentQuestion> = {
		pick: {
			type: "choice",
			instructions: `Pick the candidate that should ship for this task, judged only by the path's taste rules. Every option already passed the path's done checks.`,
			criteria: pool.length >= 2 ? candidates : { ...candidates, none: "None of the candidates should ship" },
		},
	};
	const taste = state.path.taste;
	if (taste.length >= 2) {
		questions.rule = {
			type: "choice",
			instructions: "Which taste rule most separates the best candidate from the rest?",
			criteria: Object.fromEntries(taste.map((t, i) => [ruleId(i), t])),
		};
	}
	const view = {
		task: state.task,
		path: { id: state.path.id, title: state.path.title, taste },
		candidates: pool.map((c, i) => ({
			option: optionId(i),
			agent: c.agent,
			checks: c.gate1.checks.map((k) => `${k.ok ? "pass" : "fail"}: ${k.name}`),
			files: c.diff.files,
			tests_added: c.testsAdded ?? 0,
			patch: (c.diff.patch ?? "").slice(0, 6000),
			agent_summary: c.summary ?? "",
		})),
	};
	return { req: { state: view, questions }, options };
}

// ---------------------------------------------------------------------------
// The rubric behind the mock engine. Each taste rule is scored per candidate in [0, 1] by what it asks for; the
// totals become probabilities. It reads the same view the real judge reads.

interface View {
	task: { id: string; title: string; description: string };
	path: { id: string; title: string; taste: string[] };
	candidates: { option: string; agent: string; files: { path: string; added: number; removed: number }[]; tests_added: number; patch: string; checks: string[]; agent_summary: string }[];
}

export function rubricScores(view: View): { scores: number[][]; totals: number[] } {
	const cands = view.candidates;
	const size = cands.map((c) => c.files.reduce((n, f) => n + f.added + f.removed, 0) || 1);
	const smallest = Math.min(...size);
	const scores = view.path.taste.map((rule) => {
		const r = rule.toLowerCase();
		return cands.map((c, i) => {
			const added = c.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).join("\n").toLowerCase();
			if (/small|minimal|least|focused/.test(r)) return smallest / size[i]!;
			if (/test/.test(r)) return c.tests_added > 0 ? 1 : 0;
			if (/reason|says why|explain|words|message/.test(r)) {
				const hasMessage = /message\s*:/.test(added);
				const namesAccounts = /(account|bank).*\$\{|previous|on file|was|changed/.test(added);
				return (hasMessage ? 0.5 : 0) + (namesAccounts ? 0.5 : 0);
			}
			if (/window|days|recent|configur/.test(r)) return /days|window|_ms|86400|date/.test(added) ? 1 : 0;
			if (/break|existing|other rules|regress/.test(r)) return c.checks.every((k) => k.startsWith("pass")) ? 1 : 0;
			return 0.5;
		});
	});
	const totals = cands.map((_, i) => scores.reduce((s, row) => s + row[i]!, 0));
	return { scores, totals };
}

// The rubric's totals become probabilities through a softmax. Its temperature is a free parameter of the mock (there
// is no ground truth to fit it to): 4 makes a candidate that leads on every rule that separates them confident.
function softmax(xs: number[], temp = 4): number[] {
	const m = Math.max(...xs);
	const e = xs.map((x) => Math.exp((x - m) * temp));
	const z = e.reduce((a, b) => a + b, 0);
	return e.map((v) => v / z);
}

/** The mock engine: PlatAtlas's MockJudgmentBackend with the rubric as its rule for both questions. */
export function rubricBackend(): JudgmentBackend {
	return new MockJudgmentBackend([
		(req, id, q) => {
			if (q.type !== "choice") return undefined;
			const view = req.state as unknown as View;
			if (!view?.candidates?.length) return undefined;
			const { scores, totals } = rubricScores(view);
			if (id === "pick") {
				const probs = softmax(totals);
				const opts = Object.keys(q.criteria);
				const probabilities = Object.fromEntries(opts.map((o) => [o, 0]));
				view.candidates.forEach((c, i) => (probabilities[c.option] = Math.round(probs[i]! * 1000) / 1000));
				const best = view.candidates[probs.indexOf(Math.max(...probs))]!.option;
				return { type: "choice", choice: best, probabilities, confidence: probabilities[best]! } satisfies ChoiceAnswer;
			}
			if (id === "rule") {
				const order = totals.map((t, i) => [t, i] as const).sort((a, b) => b[0] - a[0]);
				const [w, r] = [order[0]![1], order[1]?.[1] ?? order[0]![1]];
				const gaps = scores.map((row) => row[w]! - row[r]!);
				const best = gaps.indexOf(Math.max(...gaps));
				const probs = softmax(gaps, 4);
				const probabilities = Object.fromEntries(probs.map((p, i) => [ruleId(i), Math.round(p * 1000) / 1000]));
				return { type: "choice", choice: ruleId(best), probabilities, confidence: probabilities[ruleId(best)]! } satisfies ChoiceAnswer;
			}
			return undefined;
		},
	]);
}

export function backendFor(engine: string, env: JudgeEnv): JudgmentBackend {
	const spec = parseEngineSpec(engine);
	if (spec.backend === "mock") return rubricBackend();
	if (spec.backend === "typesafe") {
		if (!env.TYPESAFE_API_KEY) throw new Error("the typesafe engine needs the TYPESAFE_API_KEY secret");
		return new TypeSafeJudgmentBackend({ apiKey: env.TYPESAFE_API_KEY, model: spec.model });
	}
	throw new Error(`engine ${spec.backend} does not run in a Worker; use mock or typesafe`);
}

/** Ask the judge about one decision. */
export async function judge(backend: JudgmentBackend, state: DecisionState): Promise<JudgeVerdict> {
	const { req, options } = judgeRequest(state);
	const result = await backend.judge(req);
	const pickA = result.answers.pick as ChoiceAnswer | undefined;
	if (!pickA || pickA.type !== "choice") throw new Error("the judge gave no pick");
	const pick = options.get(pickA.choice);
	if (!pick) throw new Error(`the judge picked ${pickA.choice}, which is not a candidate`);
	const probabilities: Record<string, number> = {};
	for (const [opt, cand] of options) probabilities[cand] = pickA.probabilities[opt] ?? 0;
	const ruleA = result.answers.rule as ChoiceAnswer | undefined;
	const rule = ruleA?.type === "choice" ? Number(ruleA.choice.replace(/^r/, "")) - 1 : 0;
	return {
		pick,
		probability: probabilities[pick] ?? pickA.confidence,
		probabilities,
		rule,
		ruleText: state.path.taste[rule] ?? "",
		generated_by: result.generated_by,
		usage: result.usage,
		eligible: [...options.values()],
	};
}
