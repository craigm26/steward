// Naming and access for the repos Steward keeps in its Artifacts namespace.
import type { Remote } from "./git/ops";

export interface ArtifactsEnv {
	ARTIFACTS: Artifacts;
	WORKERS_SUBDOMAIN: string;
}

const RETRYABLE = new Set(["FORK_IN_PROGRESS", "CREATE_IN_PROGRESS", "IMPORT_IN_PROGRESS"]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Repo names allow letters, digits, `.`, `_` and `-`; ids from callers are folded into that alphabet. */
export function slug(s: string, max = 40): string {
	const out = s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").replace(/-+$/, "");
	if (!out) throw new Error(`"${s}" has no letters or digits`);
	return out.slice(0, max);
}

/** One fork per agent per task: `<app>--<task>--<agent>`. */
export function forkName(app: string, task: string, agent: string): string {
	return `${slug(app)}--${slug(task, 24)}--${slug(agent, 24)}`;
}

/** The branch a candidate occupies on the app repo once promoted. */
export function candidateBranch(task: string, agent: string): string {
	return `cand/${slug(task, 24)}/${slug(agent, 24)}`;
}

/**
 * The Preview a candidate branch gets from Workers Builds. Workers Builds names a branch Preview after the
 * branch, folded to lowercase letters, digits and hyphens.
 */
export function previewName(branch: string): string {
	return branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
}

export function previewUrl(env: ArtifactsEnv, worker: string, branch: string): string {
	return `https://${previewName(branch)}-${worker}.${env.WORKERS_SUBDOMAIN}.workers.dev`;
}

/** `get()` throws while a repo is still being created or forked; wait for it instead of failing. */
export async function getRepo(env: ArtifactsEnv, name: string, waitMs = 30_000): Promise<ArtifactsRepo> {
	const until = Date.now() + waitMs;
	for (let delay = 250; ; delay = Math.min(delay * 2, 4000)) {
		try {
			return await env.ARTIFACTS.get(name);
		} catch (e) {
			const code = (e as ArtifactsError).code;
			if (!RETRYABLE.has(code) || Date.now() + delay > until) throw e;
			await sleep(delay);
		}
	}
}

/** A remote URL plus a fresh repo-scoped token. Keep `ttl` as short as the work allows. */
export async function remoteFor(env: ArtifactsEnv, name: string, scope: "read" | "write", ttl = 600): Promise<Remote & { expiresAt: string }> {
	using repo = await getRepo(env, name);
	const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttl)]);
	return { url: info.remote, token: token.plaintext, expiresAt: token.expiresAt };
}

/** Forks `app` for one agent on one task, or returns the fork that already exists. */
export async function ensureFork(env: ArtifactsEnv, app: string, task: string, agent: string, description?: string) {
	const name = forkName(app, task, agent);
	try {
		using existing = await env.ARTIFACTS.get(name);
		const info = await existing.info();
		return { name, remote: info.remote, created: false };
	} catch (e) {
		if ((e as ArtifactsError).code !== "NOT_FOUND") {
			if (!RETRYABLE.has((e as ArtifactsError).code)) throw e;
			using waited = await getRepo(env, name);
			return { name, remote: (await waited.info()).remote, created: false };
		}
	}
	using base = await getRepo(env, app);
	const forked = await base.fork(name, { description: description ?? `${agent} working on ${task}`, defaultBranchOnly: true, readOnly: false });
	return { name, remote: forked.remote, created: true };
}

export function isArtifactsError(e: unknown, code: ArtifactsErrorCode): boolean {
	return (e as ArtifactsError)?.code === code;
}
