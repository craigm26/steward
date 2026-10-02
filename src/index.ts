import { candidateBranch, ensureFork, forkName, getRepo, isArtifactsError, previewUrl, remoteFor, type ArtifactsEnv } from "./artifacts";
import { promote } from "./git/ops";
import { runCheck } from "./check";
import { demoRecordFiles } from "./demo/record";
import { RecordStore } from "./record/store";
import type { JudgeEnv } from "./judge";

export interface Env extends ArtifactsEnv, JudgeEnv {
	STEWARD_ADMIN_KEY: string;
	RECORD_REPO: string;
}

const json = (body: unknown, status = 200) => Response.json(body, { status });

function authorized(request: Request, env: Env): boolean {
	const header = request.headers.get("authorization") ?? "";
	return !!env.STEWARD_ADMIN_KEY && header === `Bearer ${env.STEWARD_ADMIN_KEY}`;
}

async function body<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw Object.assign(new Error("body must be JSON"), { status: 400 });
	}
}

/** Creates the record repo when it does not exist yet. */
async function ensureRecordRepo(env: Env): Promise<boolean> {
	try {
		using r = await getRepo(env, env.RECORD_REPO);
		await r.info();
		return false;
	} catch (e) {
		if (!isArtifactsError(e, "NOT_FOUND")) throw e;
	}
	await env.ARTIFACTS.create(env.RECORD_REPO, { description: "Steward decision record: playbooks, decisions, checks, grants", setDefaultBranch: "main" });
	return true;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		try {
			if (url.pathname === "/api/health") return json({ ok: true, service: "steward" });
			if (!url.pathname.startsWith("/api/")) return new Response("Steward", { status: 200 });
			if (!authorized(request, env)) return json({ error: "unauthorized" }, 401);

			// Spike: give an agent its own fork of the app plus a write token for that fork only.
			if (request.method === "POST" && url.pathname === "/api/spike/fork") {
				const { app, task, agent, ttl } = await body<{ app: string; task: string; agent: string; ttl?: number }>(request);
				const t0 = Date.now();
				const fork = await ensureFork(env, app, task, agent);
				const remote = await remoteFor(env, fork.name, "write", ttl ?? 3600);
				return json({ fork: fork.name, created: fork.created, remote: remote.url, token: remote.token, expiresAt: remote.expiresAt, ms: Date.now() - t0 });
			}

			// Spike: copy the agent's latest commit to cand/<task>/<agent> on the app repo, which Workers Builds previews.
			if (request.method === "POST" && url.pathname === "/api/spike/promote") {
				const { app, task, agent, worker } = await body<{ app: string; task: string; agent: string; worker?: string }>(request);
				const t0 = Date.now();
				const [source, target] = await Promise.all([remoteFor(env, forkName(app, task, agent), "read", 300), remoteFor(env, app, "write", 300)]);
				const branch = candidateBranch(task, agent);
				const promoted = await promote({ source, target, targetRef: `refs/heads/${branch}` });
				return json({ ...promoted, branch, previewUrl: previewUrl(env, worker ?? app, branch), ms: Date.now() - t0 });
			}

			// Seed the demo record (playbooks, thresholds and the synthetic history) into the record repo.
			if (request.method === "POST" && url.pathname === "/api/admin/seed-record") {
				const { reset } = await body<{ reset?: boolean }>(request).catch(() => ({ reset: false }));
				const created = await ensureRecordRepo(env);
				const store = new RecordStore(env, env.RECORD_REPO);
				const files = demoRecordFiles();
				const written = await store.update(["steward.yaml"], (snap) => {
					if (snap.files["steward.yaml"] && !reset) return null;
					return { files, message: "Seed the demo record: playbooks, thresholds, synthetic history\n\nThe past decisions in this commit are synthetic (synthetic: true)." };
				});
				return json({ repo: env.RECORD_REPO, created, seeded: !!written, commit: written?.commit ?? null, files: files.length });
			}

			// Run the check for one path now: replay the judge against the steward, then grant or suspend auto-merge.
			const check = url.pathname.match(/^\/api\/check\/([a-z0-9._-]+)$/);
			if (request.method === "POST" && check) {
				const store = new RecordStore(env, env.RECORD_REPO);
				const t0 = Date.now();
				const outcome = await runCheck(store, check[1]!, env);
				const { detail, ...summary } = outcome.report;
				return json({ ...outcome, report: summary, rows: detail.map((d) => ({ id: d.id, expected: d.expected, got: d.got, p: d.probability, miss: d.miss })), ms: Date.now() - t0 });
			}

			// Read one file of the record (for debugging and the UI).
			if (request.method === "GET" && url.pathname === "/api/record/file") {
				const path = url.searchParams.get("path");
				if (!path) return json({ error: "path is required" }, 400);
				const text = await new RecordStore(env, env.RECORD_REPO).text(path, url.searchParams.get("ref") ?? undefined);
				return text === null ? json({ error: "not found" }, 404) : new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
			}

			return json({ error: "not found" }, 404);
		} catch (e) {
			const err = e as Error & { status?: number; code?: string };
			console.error("request failed", url.pathname, err.code ?? "", err.message, err.stack);
			return json({ error: err.message, code: err.code }, err.status ?? 500);
		}
	},
} satisfies ExportedHandler<Env>;
