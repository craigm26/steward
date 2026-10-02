// Reading Artifacts push events and fork names. Pure, so tests import it without the Workers runtime.

export interface Push {
	namespace: string;
	repo: string;
	ref: string;
	before: string | null;
	after: string;
	message: string | null;
	author: string | null;
}

/** Reads a push out of the Workflow's event, whichever envelope it arrives in. */
export function parsePush(raw: unknown): Push | null {
	const o = raw as Record<string, any> | null;
	if (!o || typeof o !== "object") return null;
	const env = o.type === "cf.artifacts.repo.pushed" || o.source ? o : (o.event ?? o.data ?? o);
	const source = env.source ?? {};
	const p = env.payload ?? env;
	const repo = source.repoName ?? source.repo_name ?? p.repoName ?? p.repo;
	const after = p.after ?? p.commit;
	if (typeof repo !== "string" || typeof after !== "string" || typeof p.ref !== "string") return null;
	const last = Array.isArray(p.commits) && p.commits.length ? p.commits[p.commits.length - 1] : null;
	return {
		namespace: String(source.namespace ?? p.namespace ?? ""),
		repo,
		ref: p.ref,
		before: typeof p.before === "string" ? p.before : null,
		after,
		message: last ? String(last.message ?? "") : null,
		author: last?.author?.email ? String(last.author.email) : null,
	};
}

/** `<app>--<task>--<agent>` back into its parts, or null for any other repo. */
export function parseFork(repo: string): { app: string; task: string; agent: string } | null {
	const m = /^(.+)--([a-z0-9._-]+)--([a-z0-9._-]+)$/.exec(repo);
	return m ? { app: m[1]!, task: m[2]!, agent: m[3]! } : null;
}
