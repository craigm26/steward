import { candidateBranch, ensureFork, forkName, previewUrl, remoteFor, type ArtifactsEnv } from "./artifacts";
import { promote } from "./git/ops";

export interface Env extends ArtifactsEnv {
	STEWARD_ADMIN_KEY: string;
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

			return json({ error: "not found" }, 404);
		} catch (e) {
			const err = e as Error & { status?: number; code?: string };
			console.error("request failed", url.pathname, err.code ?? "", err.message, err.stack);
			return json({ error: err.message, code: err.code }, err.status ?? 500);
		}
	},
} satisfies ExportedHandler<Env>;
