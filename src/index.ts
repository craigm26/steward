// Steward: the pull request as a decision. Agents race in their own Artifacts forks; gate 1 checks every
// candidate mechanically; a judge proposes one; a human steward decides, unless the path earned auto-merge.

import { candidateBranch, ensureFork, forkName, previewUrl, remoteFor, type ArtifactsEnv } from "./artifacts";
import { promote } from "./git/ops";
import { handleApi } from "./api";
import { runCheck } from "./check";
import { closeFork, maybeDecide } from "./lifecycle";
import { loadProject } from "./project";
import { RecordStore } from "./record/store";
import type { JudgeEnv } from "./judge";
import type { ProjectBoard } from "./board";
import { boardFor } from "./board";

export { ProjectBoard } from "./board";
export { GateWorkflow } from "./gate";
export { DecideWorkflow } from "./decide";
export { AgentWorkflow } from "./agents/race";

export interface Env extends ArtifactsEnv, JudgeEnv {
	STEWARD_ADMIN_KEY: string;
	RECORD_REPO: string;
	PROJECT: string;
	PUBLIC_READ: string;
	REFEREE_MODEL?: string;
	BOARD: DurableObjectNamespace<ProjectBoard>;
	GATE: Workflow;
	DECIDE: Workflow;
	AGENTS: Workflow;
	AI: Ai;
	ASSETS: Fetcher;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });
const isAdmin = (request: Request, env: Env) => !!env.STEWARD_ADMIN_KEY && request.headers.get("authorization") === `Bearer ${env.STEWARD_ADMIN_KEY}`;

/** The day-one spike's two calls, kept for scripts/spike.mjs. */
async function spike(request: Request, env: Env, path: string): Promise<Response | null> {
	if (request.method !== "POST" || !path.startsWith("/api/spike/")) return null;
	if (!isAdmin(request, env)) return json({ error: "unauthorized" }, 401);
	const b = (await request.json()) as { app: string; task: string; agent: string; ttl?: number; worker?: string };
	const t0 = Date.now();
	if (path === "/api/spike/fork") {
		const fork = await ensureFork(env, b.app, b.task, b.agent);
		const remote = await remoteFor(env, fork.name, "write", b.ttl ?? 3600);
		return json({ fork: fork.name, created: fork.created, remote: remote.url, token: remote.token, expiresAt: remote.expiresAt, ms: Date.now() - t0 });
	}
	if (path === "/api/spike/promote") {
		const [source, target] = await Promise.all([remoteFor(env, forkName(b.app, b.task, b.agent), "read", 300), remoteFor(env, b.app, "write", 300)]);
		const branch = candidateBranch(b.task, b.agent);
		const promoted = await promote({ source, target, targetRef: `refs/heads/${branch}` });
		return json({ ...promoted, branch, previewUrl: previewUrl(env, b.worker ?? b.app, branch), ms: Date.now() - t0 });
	}
	return json({ error: "not found" }, 404);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname.startsWith("/api/")) {
			try {
				return (await spike(request, env, url.pathname)) ?? (await handleApi(request, env, ctx));
			} catch (e) {
				console.error("unhandled", url.pathname, (e as Error).message);
				return json({ error: (e as Error).message }, 500);
			}
		}
		return env.ASSETS.fetch(request);
	},

	/** Every 5 minutes: close forks past their wall-clock budget. Mondays 04:00 UTC: the weekly check of every path. */
	async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
		const board = boardFor(env);
		if (controller.cron === "0 4 * * 1") {
			const project = await loadProject(env, true);
			for (const pb of Object.values(project.playbooks)) {
				ctx.waitUntil(
					runCheck(new RecordStore(env, env.RECORD_REPO), pb.path, env)
						.then((o) => board.note("check", `Weekly check ${pb.path}: ${o.report.pass ? "pass" : "fail"}, ${o.report.misses} of ${o.report.judged} differ; auto-merge ${o.autoMerge}`, { data: { path: pb.path, autoMerge: o.autoMerge } }))
						.catch((e) => console.error("weekly check", pb.path, (e as Error).message)),
				);
			}
			return;
		}
		for (const late of await board.sweepBudgets()) {
			ctx.waitUntil(closeFork(env, late.fork).then(() => maybeDecide(env, late.decision)));
		}
	},
} satisfies ExportedHandler<Env>;
