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

/** Runs `fn`, waiting out a repo that is still being created, imported or forked (up to `waitMs`). */
export async function whenReady<T>(fn: () => Promise<T>, waitMs = 30_000): Promise<T> {
	const until = Date.now() + waitMs;
	for (let delay = 500; ; delay = Math.min(delay * 2, 4000)) {
		try {
			return await fn();
		} catch (e) {
			const code = (e as ArtifactsError).code;
			if (!RETRYABLE.has(code) || Date.now() + delay > until) throw e;
			await sleep(delay);
		}
	}
}

/** A remote URL plus a fresh repo-scoped token. Keep `ttl` as short as the work allows. */
export async function remoteFor(env: ArtifactsEnv, name: string, scope: "read" | "write", ttl = 600): Promise<Remote & { expiresAt: string }> {
	return whenReady(async () => {
		using repo = await getRepo(env, name);
		const [info, token] = await Promise.all([repo.info(), repo.createToken(scope, ttl)]);
		return { url: info.remote, token: token.plaintext, expiresAt: token.expiresAt };
	});
}

/** The repo's info once it is ready, or null when it does not exist. */
async function readyInfo(env: ArtifactsEnv, name: string, waitMs = 60_000): Promise<ArtifactsRepoInfo | null> {
	try {
		return await whenReady(async () => {
			using r = await env.ARTIFACTS.get(name);
			return await r.info();
		}, waitMs);
	} catch (e) {
		if ((e as ArtifactsError).code === "NOT_FOUND") return null;
		throw e;
	}
}

/**
 * Forks `app` for one agent on one task, or returns the fork that already exists. A fork call can fail and still
 * start the fork on Artifacts' side, so every failure re-checks for the repo (waiting for it to be ready) before
 * trying again.
 */
export async function ensureFork(env: ArtifactsEnv, app: string, task: string, agent: string, description?: string) {
	const name = forkName(app, task, agent);
	const existing = await readyInfo(env, name);
	if (existing) return { name, remote: existing.remote, created: false };
	using base = await getRepo(env, app);
	for (let attempt = 1, delay = 1000; ; attempt++, delay = Math.min(delay * 2, 8000)) {
		try {
			await base.fork(name, { description: description ?? `${agent} working on ${task}`, defaultBranchOnly: true, readOnly: false });
		} catch (e) {
			const code = (e as ArtifactsError).code;
			if (!["ALREADY_EXISTS", "FORK_IN_PROGRESS", "INTERNAL_ERROR"].includes(code) || attempt >= 5) throw e;
			if (code === "INTERNAL_ERROR") await sleep(delay);
		}
		const info = await readyInfo(env, name);
		if (info) return { name, remote: info.remote, created: true };
	}
}

export function isArtifactsError(e: unknown, code: ArtifactsErrorCode): boolean {
	return (e as ArtifactsError)?.code === code;
}
