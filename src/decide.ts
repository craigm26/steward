// The decide Workflow, one instance per decision:
//   1. gather the evidence of every candidate that cleared gate 1
//   2. the judge proposes one and names the rule; the referee objects to each
//   3. auto-merge only if the path earned it (an active grant), the judge clears the bar, and this one is not
//      sampled for a person; otherwise the card waits for the steward (waitForEvent, up to 7 days)
//   4. squash-merge the chosen candidate into main; write the decision and a ledger line to the record; an
//      overrule suspends any grant that would have merged the judge's pick
//   5. close every fork in the decision
// Every step is durable and retried; a lost race on main re-reads and merges again.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import type { Candidate } from "./board";
import { remoteFor } from "./artifacts";
import { backendFor, judge, type CandidateEvidence, type DecisionState, type JudgeVerdict } from "./judge";
import { referee, DEFAULT_REFEREE_MODEL, type Objection } from "./referee";
import { squashMerge } from "./merge";
import { loadProject } from "./project";
import { closeFork } from "./lifecycle";
import { RecordStore } from "./record/store";
import type { DecisionRecord, LedgerLine } from "./check";
import { foldGrants, grantFor, mustSample, reviewOnAnswer, sampleFraction, sampledWhy } from "../vendor/platatlas/grants.ts";
import { route as routeJudgment } from "../vendor/platatlas/thresholds.ts";
import { boardFor } from "./board";

export const STEWARD_WHO = { name: "Steward", email: "steward@steward.invalid" };

export interface StewardVerdict {
	pick: string;
	reason?: string;
	by: string;
	by_name: string;
	at: string;
}

export function evidenceOf(c: Candidate): CandidateEvidence {
	return {
		id: c.id,
		agent: c.agent,
		commit: c.commit ?? "",
		previewUrl: c.preview_url ?? undefined,
		gate1: { passed: c.status === "passed" || c.status === "merged" || c.status === "lost", checks: c.checks },
		diff: c.diff ?? { files: [], added: 0, removed: 0 },
		testsAdded: c.tests_added,
		summary: c.summary ?? undefined,
	};
}

function mergeMessage(state: DecisionState, pick: CandidateEvidence, v: JudgeVerdict, decided: { kind: string; by_name: string; verdict: string; reason?: string; grant?: string }, objection?: Objection) {
	const who =
		decided.kind === "agent"
			? `merged by the judge on its own, under grant ${decided.grant}`
			: decided.verdict === "agree"
				? `chosen by ${decided.by_name}, agreeing with the judge`
				: `chosen by ${decided.by_name}, overruling the judge (${v.pick.split("/")[1]}): ${decided.reason}`;
	return [
		`${state.task.title} (decision ${state.decision})`,
		"",
		`Ships ${pick.agent}'s candidate (${pick.commit.slice(0, 7)}), ${who}.`,
		`Judge: ${v.pick.split("/")[1]} at ${v.probability.toFixed(2)}, by the rule "${v.ruleText}".`,
		...(objection ? [`Referee: ${objection.objection}`] : []),
		"",
		`Steward-Decision: ${state.decision}`,
		`Steward-Task: ${state.task.id}`,
		`Steward-Candidate: ${pick.id} ${pick.commit}`,
		`Steward-Decided-By: ${decided.kind === "agent" ? `Judge (agent, grant ${decided.grant})` : `${decided.by_name} (person)`}`,
	].join("\n");
}

type Evidence = { state: DecisionState; task: string; engine: string; judgeAgent: string; steward: string; stewardName: string; refereeModel: string };
type Decided = StewardVerdict & { kind: "person" | "agent"; verdict: "agree" | "overrule" | "auto"; grant?: string };
export type DecideParams = { decision: string; verdict?: StewardVerdict };

/** What the card keeps about the judging, so the merge run (started by the steward's click) sees what the judge saw. */
export type SavedJudge = JudgeVerdict & { route: { auto: boolean; why: string; grant?: string }; ev: Evidence };

export class DecideWorkflow extends WorkflowEntrypoint<Env, DecideParams> {
	async run(event: Readonly<WorkflowEvent<DecideParams>>, step: WorkflowStep) {
		const env = this.env;
		const id = event.payload.decision;
		const board = boardFor(env);

		// The steward decided (the API already moved the card to merging): merge what the card showed.
		if (event.payload.verdict) {
			const got = event.payload.verdict;
			const card = await step.do("read the card", async () => {
				const d = await board.decision(id);
				if (!d?.judge) throw new Error(`decision ${id} has no card`);
				return { judged: d.judge as SavedJudge, objections: (d.referee ?? []) as Objection[] };
			});
			const decided: Decided = { ...got, kind: "person", verdict: got.pick === card.judged.pick ? "agree" : "overrule" };
			return this.merge(step, id, card.judged.ev, card.judged, card.objections, decided);
		}

		const ev: Evidence = await step.do("gather the evidence", async () => {
			const d = await board.decision(id);
			if (!d) throw new Error(`no decision ${id}`);
			const task = await board.task(d.task);
			if (!task) throw new Error(`no task ${d.task}`);
			const members = (await Promise.all(d.candidates.map((c) => board.candidate(c)))).filter((c): c is Candidate => !!c);
			const project = await loadProject(env, true);
			const pb = project.playbooks[d.path];
			if (!pb) throw new Error(`no playbook for ${d.path}`);
			const state: DecisionState = {
				decision: id,
				task: { id: task.id, title: task.title, description: task.description },
				path: { id: pb.path, title: pb.title, taste: pb.taste },
				candidates: members.map(evidenceOf),
			};
			const steward = project.config.stewards.find((s) => s.key === pb.steward);
			return { state, task: task.id, engine: project.config.judge.engine, judgeAgent: project.config.judge.agent, steward: pb.steward, stewardName: steward?.name ?? pb.steward, refereeModel: env.REFEREE_MODEL || DEFAULT_REFEREE_MODEL };
		});

		const verdict = await step.do("the judge proposes", { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" } }, async () => judge(backendFor(ev.engine, env), ev.state));
		const objections = await step.do("the referee objects", async () => referee(env.AI, ev.refereeModel, ev.state));

		const routed = await step.do("may the judge merge alone", async () => {
			const project = await loadProject(env, true);
			const now = new Date().toISOString();
			const grants = foldGrants(project.grants, now);
			const judgment = { label: "ship", probability: verdict.probability };
			const agents = [{ key: ev.judgeAgent, name: "Judge", stage: "suggest", steward: ev.steward }];
			const earned = grants.find((x) => x.status === "active" && x.label === "ship" && x.when?.path === ev.state.path.id);
			if (!earned) return { auto: false, why: "This path has not earned auto-merge, so the steward decides." };
			const g = grantFor({ judgment, generated_by: verdict.generated_by }, grants, agents, { hosted: true, caseState: { path: ev.state.path.id }, thresholds: project.thresholds });
			const r = routeJudgment(project.thresholds, judgment);
			if (!g || r.decision !== "act_alone") return { auto: false, grant: earned.id, why: `This path has auto-merge, but the judge's ${verdict.probability.toFixed(2)} is under its bar of ${earned.min_probability}, so the steward decides.` };
			// PlatAtlas's sampler hashes its key with FNV-1a and no final mix, so short ids that differ in one character
			// (d-t1, d-t2...) all land near 0 and would all be sampled. A SHA-256 of the id spreads them evenly.
			const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
			const sampleKey = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
			if (mustSample(project.thresholds, sampleKey)) return { auto: false, grant: g.id, why: sampledWhy("The judge", sampleFraction(project.thresholds)) };
			const owner = project.config.stewards.find((x) => x.key === g.by_key)?.name ?? g.by_key ?? "the steward";
			return { auto: true, grant: g.id, why: `The judge merged it on its own, under the auto-merge ${owner}'s path earned (grant ${g.id}).` };
		});

		await step.do("put the card up", async () => {
			const saved: SavedJudge = { ...verdict, route: routed, ev };
			await board.advanceDecision(
				id,
				["judging"],
				routed.auto ? "merging" : "ready",
				{ judge: saved, referee: objections },
				{ text: routed.auto ? `The judge merges ${verdict.pick.split("/")[1]}'s candidate on its own (grant ${routed.grant})` : `Decision ${id} is ready: the judge proposes ${verdict.pick.split("/")[1]}'s candidate`, data: { pick: verdict.pick, auto: routed.auto } },
			);
			return true;
		});

		if (!routed.auto) return { ready: true, pick: verdict.pick };
		const decided: Decided = { pick: verdict.pick, by: ev.judgeAgent, by_name: "Judge", at: new Date().toISOString(), kind: "agent", verdict: "auto", grant: routed.grant };
		return this.merge(step, id, ev, verdict, objections, decided);
	}

	/** Squash-merge the chosen candidate, write the decision and its ledger line, close every fork. */
	private async merge(step: WorkflowStep, id: string, ev: Evidence, verdict: JudgeVerdict, objections: Objection[], decided: Decided) {
		const env = this.env;
		const board = boardFor(env);
		const chosen = ev.state.candidates.find((c) => c.id === decided.pick);
		if (!chosen) throw new Error(`the chosen candidate ${decided.pick} is not in decision ${id}`);
		const objection = objections.find((o) => o.candidate === chosen.id);

		const merged = await step.do("merge into main", { retries: { limit: 4, delay: "5 seconds", backoff: "exponential" } }, async () => {
			const app = await remoteFor(env, env.PROJECT, "write", 600);
			const cand = await board.candidate(chosen.id);
			return squashMerge({
				app,
				candidateBranch: cand?.branch ?? `cand/${chosen.id}`,
				commit: chosen.commit,
				message: mergeMessage(ev.state, chosen, verdict, decided, objection),
				author: { name: chosen.agent, email: `${chosen.agent}@agents.steward.invalid` },
				committer: STEWARD_WHO,
			});
		});

		await step.do("write the ledger", { retries: { limit: 4, delay: "3 seconds", backoff: "exponential" } }, async () => {
			const store = new RecordStore(env, env.RECORD_REPO);
			const at = new Date().toISOString();
			await store.update(["ledger.jsonl", "preferences/grants.jsonl"], (snap) => {
				const record: DecisionRecord = {
					id,
					state: ev.state,
					judge: { pick: verdict.pick, probability: verdict.probability, rule: verdict.rule, ruleText: verdict.ruleText, generated_by: verdict.generated_by },
					referee: objections,
					...(decided.kind === "person" ? { steward: { verdict: decided.verdict as "agree" | "overrule", pick: decided.pick, by: decided.by, at: decided.at, ...(decided.reason ? { reason: decided.reason } : {}) } } : { auto: { grant: decided.grant!, sampled: false } }),
					merge: { commit: merged.commit, at, from: chosen.commit },
				};
				const line: LedgerLine = {
					decision: id,
					task: ev.task,
					path: ev.state.path.id,
					at,
					pick: decided.pick,
					judge_pick: verdict.pick,
					judge_probability: verdict.probability,
					decided_by: decided.kind === "person" ? { kind: "person", key: decided.by, name: decided.by_name } : { kind: "agent", key: ev.judgeAgent, name: "Judge", grant: decided.grant },
					verdict: decided.verdict,
					merged_commit: merged.commit,
				};
				const suspends =
					decided.kind === "person" && decided.verdict === "overrule"
						? reviewOnAnswer({ id, judgment: { label: "ship", probability: verdict.probability }, generated_by: verdict.generated_by }, "pass", foldGrants(snap.files["preferences/grants.jsonl"] ?? "", at), {
								by: decided.by_name,
								at,
								caseState: { path: ev.state.path.id },
								hosted: true,
							}).map((s) => ({ ...s, reason: `${decided.by_name} overruled the judge on ${id}, where this grant would have merged ${verdict.pick.split("/")[1]}'s candidate` }))
						: [];
				const ledger = snap.files["ledger.jsonl"] ?? "";
				const grants = snap.files["preferences/grants.jsonl"] ?? "";
				const add = (text: string, more: unknown[]) => (more.length ? text + (text && !text.endsWith("\n") ? "\n" : "") + more.map((m) => JSON.stringify(m)).join("\n") + "\n" : text);
				return {
					files: [
						{ path: `decisions/${id}.json`, content: JSON.stringify(record, null, 2) + "\n" },
						{ path: "ledger.jsonl", content: add(ledger, [line]) },
						...(suspends.length ? [{ path: "preferences/grants.jsonl", content: add(grants, suspends) }] : []),
					],
					message: `Decision ${id}: ${decided.kind === "person" ? decided.by_name : "the judge"} shipped ${chosen.agent}'s candidate\n\nMerged as ${merged.commit} on main.${suspends.length ? `\nSuspended ${suspends.length} auto-merge grant(s) after the overrule.` : ""}`,
				};
			});
			return { at, written: true };
		});

		await step.do("close the forks", async () => {
			const d = await board.decision(id);
			for (const cid of d?.candidates ?? []) {
				const c = await board.candidate(cid);
				if (!c) continue;
				const status = cid === chosen.id ? "merged" : c.status === "passed" ? "lost" : c.status;
				await board.updateCandidate(cid, { status }, cid === chosen.id ? { kind: "merged", text: `${c.agent}'s candidate merged into main as ${merged.commit.slice(0, 7)}` } : undefined);
				await closeFork(env, c.fork);
			}
			await board.advanceDecision(id, ["merging"], "merged", { merged_commit: merged.commit }, { text: `Decision ${id} merged as ${merged.commit.slice(0, 7)}`, data: { commit: merged.commit } });
			const open = (await board.decisionsOf(ev.task)).filter((x) => !["merged", "closed"].includes(x.status));
			if (!open.length) await board.setTaskStatus(ev.task, "merged");
			return true;
		});

		return { merged: merged.commit, by: decided.by_name, verdict: decided.verdict };
	}
}
