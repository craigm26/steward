// Gate 1: does the candidate work? Started by Artifacts itself on every push in the namespace
// (triggers.events, cf.artifacts.repo.pushed), or by the API when an agent says it is done.
//
//   load      the claim and its budget; over budget, the fork closes
//   promote   copy the fork's commit to cand/<task>/<agent> on the app repo (the agent never holds an app token)
//   diff      what changed against the commit the candidate started from; files outside the claim fail
//   preview   wait for the candidate's Preview to serve exactly this commit (the build ran the tests)
//   checks    run the playbook's done checks against that Preview
//   verdict   passed only when every check passes AND the agent said done without hedging; a candidate that
//             claimed done and failed is bounced before any person sees it
// Pushes Steward makes itself (seeding a fork, promoting, merging) and pushes to other repos return at once.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "./index";
import type { GateCheck } from "./board";
import { getRepo, previewUrl, remoteFor } from "./artifacts";
import { promote } from "./git/ops";
import { diffCommits, forkPoint } from "./diff";
import { runProbe } from "./probe";
import { gateVerdict } from "./verdict";
import { loadProject } from "./project";
import { globMatch } from "./record/playbook";
import { closeFork, maybeDecide } from "./lifecycle";
import { boardFor } from "./board";

export { parsePush, parseFork, type Push } from "./push";
import { parsePush, parseFork } from "./push";

export const STEWARD_EMAIL = "steward@steward.invalid";
const PREVIEW_POLLS = 60;
const PREVIEW_EVERY = "10 seconds";

export type GateParams = { type?: string; source?: unknown; payload?: unknown; reason?: string };

export class GateWorkflow extends WorkflowEntrypoint<Env, GateParams> {
	async run(event: Readonly<WorkflowEvent<GateParams>>, step: WorkflowStep) {
		const push = parsePush(event.payload);
		if (!push) return { skipped: "not a push" };
		const fork = parseFork(push.repo);
		if (!fork || fork.app !== this.env.PROJECT) return { skipped: `not a fork of ${this.env.PROJECT}` };
		if (push.ref !== "refs/heads/main") return { skipped: `push to ${push.ref}` };
		if (push.author === STEWARD_EMAIL) return { skipped: "Steward's own commit" };

		const env = this.env;
		const id = `${fork.task}/${fork.agent}`;
		const board = boardFor(env);

		const ctx = await step.do("load the claim", async () => {
			const [claim, cand, task] = await Promise.all([board.claimOf(fork.task, fork.agent), board.candidate(id), board.task(fork.task)]);
			if (!claim || claim.status !== "active" || !cand || !task) return { skip: "no active claim" as string };
			if (!(await board.startGate(id, push.after, event.instanceId))) return { skip: `another gate run is checking ${push.after.slice(0, 7)}` };
			if (["merged", "lost", "withdrawn", "over-budget"].includes(cand.status)) return { skip: `candidate is ${cand.status}` };
			const late = Date.now() > Date.parse(claim.expires_at);
			const spent = cand.tokens_used > claim.budget_tokens;
			return { claim, cand, task, over: late ? `wall clock: past ${claim.budget_minutes} minutes` : spent ? `tokens: ${cand.tokens_used} of ${claim.budget_tokens}` : null };
		});
		if ("skip" in ctx && ctx.skip) return { skipped: ctx.skip };
		const { claim, cand, task } = ctx as Exclude<typeof ctx, { skip: string }>;
		if ((ctx as { over: string | null }).over) {
			await step.do("close the fork: over budget", async () => {
				await closeFork(env, claim.fork);
				await board.updateCandidate(id, { status: "over-budget", note: `Over budget (${(ctx as { over: string }).over}); the fork is closed.` }, { kind: "bounce", text: `${fork.agent} ran over budget; fork closed` });
				await maybeDecide(env, cand.decision);
				return true;
			});
			return { overBudget: true };
		}

		const project = await step.do("read the playbook", async () => {
			const p = await loadProject(env);
			const playbook = p.playbooks[task.path];
			if (!playbook) throw new Error(`no playbook for path ${task.path}`);
			return { worker: p.config.worker, playbook };
		});

		const promoted = await step.do("promote to a candidate branch", { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
			const [source, target] = await Promise.all([remoteFor(env, claim.fork, "read", 300), remoteFor(env, env.PROJECT, "write", 300)]);
			const p = await promote({ source, target, targetRef: `refs/heads/${cand.branch}` });
			const url = previewUrl(env, project.worker, cand.branch);
			await board.updateCandidate(id, { commit: p.commit, status: "checking", preview_url: url, note: null, checks: [] }, { kind: "checking", text: `${fork.agent} pushed ${p.commit.slice(0, 7)}; gate 1 is checking it`, data: { commit: p.commit, preview: url } });
			return { commit: p.commit, url };
		});

		const diff = await step.do("diff against where it started", async () => {
			const base = (await forkPoint(env, env.PROJECT, cand.branch)) ?? promoted.commit;
			const d = await diffCommits(env, env.PROJECT, base, promoted.commit);
			// An agent changes only the files it claimed. A new file is fine inside its path; an existing file it did
			// not claim is not, because another agent may hold it.
			const outside = d.files
				.filter((f) => !claim.files.includes(f.path))
				.filter((f) => f.status !== "added" || !project.playbook.globs.some((g) => globMatch(g, f.path)))
				.map((f) => f.path);
			return { base, d, outside };
		});

		const checks: GateCheck[] = [];
		if (diff.outside.length) checks.push({ name: "Changes stay inside the claim", ok: false, detail: `changed files it did not claim: ${diff.outside.join(", ")}` });
		else checks.push({ name: "Changes stay inside the claim", ok: true });

		// The build check: Workers Builds (or any CI) builds and tests the branch; a Preview that serves this
		// commit means the build and its tests passed.
		let served = false;
		let lastSeen = "";
		let buildFailed: string | null = null;
		for (let i = 0; i < PREVIEW_POLLS && !served && !buildFailed; i++) {
			const r = await step.do(`wait for the Preview (${i + 1})`, async () => {
				// A build system that reported a failed build for this commit ends the wait at once.
				const b = await board.build(promoted.commit);
				if (b && !b.ok) return { ok: false, seen: "build failed", failed: b.detail ?? "the build failed" };
				try {
					const res = await fetch(`${promoted.url}/api/health`, { headers: { "cache-control": "no-cache" }, signal: AbortSignal.timeout(10_000) });
					const body = (await res.json().catch(() => ({}))) as { commit?: string };
					return { ok: res.ok && body.commit === promoted.commit, seen: `${res.status} ${body.commit?.slice(0, 7) ?? "-"}` };
				} catch (e) {
					return { ok: false, seen: (e as Error).message.slice(0, 80) };
				}
			});
			served = r.ok;
			lastSeen = r.seen;
			buildFailed = (r as { failed?: string }).failed ?? null;
			if (!served && !buildFailed) await step.sleep(`before checking the Preview again (${i + 1})`, PREVIEW_EVERY);
		}
		const buildCheck = project.playbook.done.find((d) => d.kind === "build");
		checks.push({
			name: buildCheck?.name ?? "Tests pass and the Preview builds",
			ok: served,
			...(served ? {} : { detail: buildFailed ? `the build failed: ${buildFailed}` : `the Preview never served ${promoted.commit.slice(0, 7)} within ${PREVIEW_POLLS * 10} s (last answer ${lastSeen}): the build or its tests failed` }),
		});

		if (served) {
			const probes = await step.do("run the done checks", async () => {
				const out: GateCheck[] = [];
				for (const d of [...task.done, ...project.playbook.done]) if (d.kind === "probe") out.push(await runProbe(promoted.url, d));
				return out;
			});
			checks.push(...probes);
		}

		return step.do("record gate 1", async () => {
			const now = await board.candidate(id);
			if (!now) return { gone: true };
			// A newer push already superseded this one: its own run records the verdict.
			if (now.commit && now.commit !== promoted.commit) {
				await board.finishGate(id, event.instanceId);
				return { superseded: now.commit };
			}
			const failing = checks.filter((c) => !c.ok);
			const { status, note } = gateVerdict(checks, now.done, now.summary);
			await board.updateCandidate(
				id,
				{ status, note, checks, diff: { files: diff.d.files, added: diff.d.added, removed: diff.d.removed, patch: diff.d.patch }, tests_added: diff.d.testsAdded },
				{
					kind: status === "passed" ? "passed" : status === "bounced" ? "bounce" : "checked",
					text: status === "passed" ? `${fork.agent} passed gate 1 (${checks.length} checks)` : status === "bounced" ? `${fork.agent} claimed done and failed gate 1: bounced` : `${fork.agent}: ${note}`,
					data: { commit: promoted.commit, checks },
				},
			);
			await board.finishGate(id, event.instanceId);
			if (status === "passed" || status === "bounced") await maybeDecide(env, now.decision);
			return { status, checks: checks.length, failing: failing.length };
		});
	}
}

/** Mints a push-shaped event for the fork's current head, so "done" re-runs gate 1 without a new commit. */
export async function gateForHead(env: Env, forkRepo: string, reason: string) {
	using repo = await getRepo(env, forkRepo);
	const [tip] = await repo.log({ ref: "main", limit: 1 });
	if (!tip) throw new Error(`${forkRepo} has no commits`);
	const payload = {
		type: "cf.artifacts.repo.pushed",
		source: { namespace: "steward", repoName: forkRepo },
		payload: { ref: "refs/heads/main", before: null, after: tip.hash, commits: [{ id: tip.hash, message: tip.message, author: tip.author }] },
		reason,
	};
	return env.GATE.create({ id: `${forkRepo}-${tip.hash.slice(0, 7)}-${Date.now().toString(36)}`, params: payload });
}
