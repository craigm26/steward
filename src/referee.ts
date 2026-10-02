// The referee attacks every candidate that cleared gate 1 and posts its strongest objection on the card. It runs on
// Workers AI in the same account; when the model is unavailable, a rule from the evidence stands in, and the card
// says which wrote it.

import type { CandidateEvidence, DecisionState } from "./judge";
import { hedged } from "./probe";

export interface Objection {
	candidate: string;
	objection: string;
	generated_by: { backend: string; model: string; source: "inferred" };
}

export const DEFAULT_REFEREE_MODEL = "@cf/deepseek-ai/deepseek-v4-flash-0731";

/** Reasoning models spend their whole budget thinking unless told not to; the referee wants the answer. */
function quiet(model: string): Record<string, unknown> {
	if (/glm/i.test(model)) return { reasoning_effort: "low" };
	return { chat_template_kwargs: { enable_thinking: false } };
}

function textOf(result: unknown): string {
	const r = result as Record<string, any>;
	if (typeof r?.response === "string") return r.response;
	if (Array.isArray(r?.choices)) return String(r.choices[0]?.message?.content ?? r.choices[0]?.text ?? "");
	if (Array.isArray(r?.output)) {
		for (const item of r.output) for (const c of item?.content ?? []) if (typeof c?.text === "string") return c.text;
	}
	return typeof result === "string" ? result : "";
}

/** One objection from the evidence alone, used when no model answers. */
export function ruleObjection(c: CandidateEvidence, all: CandidateEvidence[]): string {
	const size = (x: CandidateEvidence) => x.diff.added + x.diff.removed;
	if (!c.testsAdded) return "No test covers the new rule, so a later change could break it without any check failing.";
	const hedge = hedged(c.summary);
	if (hedge) return `The agent's own summary hedges ("${hedge}"); the evidence passes, but the author is not sure it is right.`;
	const biggest = all.reduce((a, b) => (size(b) > size(a) ? b : a), c);
	if (biggest.id === c.id && all.length > 1) return `The largest change of the candidates (+${c.diff.added}/-${c.diff.removed} lines in ${c.diff.files.length} file(s)) for the same passing checks.`;
	return "The done checks cover the playbook's cases only; nothing tests an account that changed and then changed back.";
}

export async function referee(ai: Ai | undefined, model: string, state: DecisionState): Promise<Objection[]> {
	const pool = state.candidates.filter((c) => c.gate1.passed);
	return Promise.all(
		pool.map(async (c): Promise<Objection> => {
			if (ai) {
				try {
					const result = await ai.run(model as keyof AiModels, {
						messages: [
							{
								role: "system",
								content:
									"You referee code changes that already passed their automatic checks. Give the single strongest objection a careful reviewer would raise against this candidate: a real risk to correctness, safety or maintainability, not style. One or two plain sentences, no preamble, no praise. If there is truly nothing, say what you would test next.",
							},
							{
								role: "user",
								content: [
									`Task: ${state.task.title}\n${state.task.description}`,
									`Taste rules for this path:\n${state.path.taste.map((t) => `- ${t}`).join("\n")}`,
									`Checks it passed:\n${c.gate1.checks.map((k) => `- ${k.name}`).join("\n")}`,
									`Diff (+${c.diff.added}/-${c.diff.removed}):\n${(c.diff.patch ?? "").slice(0, 9000)}`,
									`The agent's own summary (least trusted): ${c.summary ?? "(none)"}`,
								].join("\n\n"),
							},
						],
						max_tokens: 400,
						temperature: 0.2,
						...quiet(model),
					} as never);
					const text = textOf(result).replace(/\s+/g, " ").trim();
					if (text) return { candidate: c.id, objection: text.slice(0, 600), generated_by: { backend: "workers-ai", model, source: "inferred" } };
				} catch (e) {
					console.error("referee model failed", model, (e as Error).message);
				}
			}
			return { candidate: c.id, objection: ruleObjection(c, pool), generated_by: { backend: "rule", model: "evidence", source: "inferred" } };
		}),
	);
}
