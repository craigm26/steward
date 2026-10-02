// Git operations over Artifacts remotes, run in memory inside a Worker with isomorphic-git.
// The Artifacts binding manages repos and tokens but has no push, so every write goes through git here.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./memfs";

const DIR = "/repo";

export type Remote = { url: string; token: string };

/** A push that lost a race: the branch moved since we read it. Callers re-read and try again. */
export class ConflictError extends Error {
	readonly status = 409;
}

const auth = (r: Remote) => ({ Authorization: `Bearer ${r.token}` });

async function fresh() {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	return fs;
}

function isRejected(e: unknown): boolean {
	const err = e as { code?: string; data?: { reason?: string }; message?: string };
	return (
		err?.code === "PushRejectedError" ||
		err?.data?.reason === "not-fast-forward" ||
		/non-fast-forward|not-fast-forward|fetch first|stale info|cannot lock ref/i.test(err?.message ?? "")
	);
}

function rejectedRefs(result: { ok?: boolean; refs?: Record<string, { ok: boolean; error?: string }> }): string | null {
	if (!result || result.ok) return null;
	const bad = Object.entries(result.refs ?? {}).find(([, r]) => !r.ok);
	return bad ? `${bad[0]}: ${bad[1].error ?? "rejected"}` : "push rejected";
}

/**
 * Copies one commit from a source repo to a branch on a target repo: fetch the source ref, then push it to
 * `targetRef`. This is how an agent's fork becomes a candidate branch on the app repo without the agent ever
 * holding a token for the app repo. Force-pushes, because a candidate branch belongs to one agent and one task.
 */
export async function promote(opts: { source: Remote; sourceRef?: string; target: Remote; targetRef: string }) {
	const fs = await fresh();
	await git.addRemote({ fs, dir: DIR, remote: "source", url: opts.source.url });
	const fetched = await git.fetch({
		fs,
		http,
		dir: DIR,
		remote: "source",
		ref: opts.sourceRef ?? "main",
		singleBranch: true,
		tags: false,
		headers: auth(opts.source),
	});
	const commit = fetched.fetchHead;
	if (!commit) throw new Error(`nothing to promote: ${opts.sourceRef ?? "main"} is empty in the source repo`);
	await git.writeRef({ fs, dir: DIR, ref: "refs/heads/candidate", value: commit, force: true });
	await git.addRemote({ fs, dir: DIR, remote: "target", url: opts.target.url });
	const result = await git.push({
		fs,
		http,
		dir: DIR,
		remote: "target",
		ref: "refs/heads/candidate",
		remoteRef: opts.targetRef,
		force: true,
		headers: auth(opts.target),
	});
	const bad = rejectedRefs(result);
	if (bad) throw new Error(`promotion push failed: ${bad}`);
	return { commit, ref: opts.targetRef };
}

/**
 * Fast-forwards (or force-moves, when `force`) `targetRef` on the target repo to `commit` taken from `source`.
 * Used to merge a decided candidate into main. Without `force`, a moved branch raises ConflictError.
 */
export async function moveRef(opts: { source: Remote; sourceRef: string; commit: string; target: Remote; targetRef: string; force?: boolean }) {
	const fs = await fresh();
	await git.addRemote({ fs, dir: DIR, remote: "source", url: opts.source.url });
	await git.addRemote({ fs, dir: DIR, remote: "target", url: opts.target.url });
	await git.fetch({ fs, http, dir: DIR, remote: "source", ref: opts.sourceRef, singleBranch: true, tags: false, headers: auth(opts.source) });
	// Fetch the target branch too, so isomorphic-git can tell a fast-forward from a rewrite.
	try {
		await git.fetch({ fs, http, dir: DIR, remote: "target", ref: opts.targetRef.replace(/^refs\/heads\//, ""), singleBranch: true, tags: false, headers: auth(opts.target) });
	} catch {
		// An empty target branch is fine: the push creates it.
	}
	await git.writeRef({ fs, dir: DIR, ref: "refs/heads/outgoing", value: opts.commit, force: true });
	try {
		const result = await git.push({ fs, http, dir: DIR, remote: "target", ref: "refs/heads/outgoing", remoteRef: opts.targetRef, force: !!opts.force, headers: auth(opts.target) });
		const bad = rejectedRefs(result);
		if (bad) throw new ConflictError(bad);
	} catch (e) {
		if (e instanceof ConflictError || isRejected(e)) throw new ConflictError(`${opts.targetRef} moved: ${(e as Error).message}`);
		throw e;
	}
	return { commit: opts.commit, ref: opts.targetRef };
}

export type FileChange = { path: string; content: string | Uint8Array | null };

/**
 * Writes files onto the tip of `branch` as one commit and pushes it without force. Builds the new trees
 * directly from the parent's trees (no checkout), so cost grows with the paths touched, not the repo size.
 * `content: null` deletes a path. Throws ConflictError when the branch moved since it was read, or when
 * `expectParent` is given and no longer matches the tip.
 */
export async function commitFiles(opts: {
	repo: Remote;
	branch?: string;
	files: FileChange[];
	message: string;
	author: { name: string; email: string };
	expectParent?: string | null;
}) {
	const branch = opts.branch ?? "main";
	const fs = await fresh();
	let parent: string | null = null;
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: opts.repo.url });
	try {
		const fetched = await git.fetch({ fs, http, dir: DIR, remote: "origin", ref: branch, singleBranch: true, depth: 1, tags: false, headers: auth(opts.repo) });
		parent = fetched.fetchHead ?? null;
	} catch (e) {
		// A brand-new repo has no branch yet; the first commit creates it.
		if (!/could not find|not found|NotFoundError|empty/i.test(String((e as Error).message))) throw e;
	}
	if (opts.expectParent !== undefined && opts.expectParent !== parent) {
		throw new ConflictError(`${branch} is at ${parent ?? "nothing"}, expected ${opts.expectParent ?? "nothing"}`);
	}

	const enc = new TextEncoder();
	const bytes = (c: string | Uint8Array) => (typeof c === "string" ? enc.encode(c) : c);
	type Entry = { mode: string; path: string; oid: string; type: "blob" | "tree" | "commit" };

	async function update(treeOid: string | null, changes: Map<string, string | Uint8Array | null>): Promise<string | null> {
		const current: Entry[] = treeOid ? ((await git.readTree({ fs, dir: DIR, oid: treeOid })).tree as Entry[]) : [];
		const byName = new Map(current.map((e) => [e.path, e]));
		const nested = new Map<string, Map<string, string | Uint8Array | null>>();
		for (const [p, content] of changes) {
			const slash = p.indexOf("/");
			if (slash < 0) {
				if (content === null) byName.delete(p);
				else byName.set(p, { mode: "100644", path: p, oid: await git.writeBlob({ fs, dir: DIR, blob: bytes(content) }), type: "blob" });
			} else {
				const d = p.slice(0, slash);
				if (!nested.has(d)) nested.set(d, new Map());
				nested.get(d)!.set(p.slice(slash + 1), content);
			}
		}
		for (const [d, sub] of nested) {
			const existing = byName.get(d);
			const oid = await update(existing?.type === "tree" ? existing.oid : null, sub);
			if (oid === null) byName.delete(d);
			else byName.set(d, { mode: "040000", path: d, oid, type: "tree" });
		}
		if (byName.size === 0) return null;
		return git.writeTree({ fs, dir: DIR, tree: [...byName.values()] });
	}

	const changes = new Map(opts.files.map((f) => [f.path.replace(/^\/+/, ""), f.content]));
	const baseTree = parent ? (await git.readCommit({ fs, dir: DIR, oid: parent })).commit.tree : null;
	const tree = (await update(baseTree, changes)) ?? (await git.writeTree({ fs, dir: DIR, tree: [] }));
	const now = Math.floor(Date.now() / 1000);
	const who = { ...opts.author, timestamp: now, timezoneOffset: 0 };
	const commit = await git.writeCommit({
		fs,
		dir: DIR,
		commit: { message: opts.message.endsWith("\n") ? opts.message : opts.message + "\n", tree, parent: parent ? [parent] : [], author: who, committer: who },
	});
	await git.writeRef({ fs, dir: DIR, ref: `refs/heads/${branch}`, value: commit, force: true });
	try {
		const result = await git.push({ fs, http, dir: DIR, remote: "origin", ref: `refs/heads/${branch}`, remoteRef: `refs/heads/${branch}`, force: false, headers: auth(opts.repo) });
		const bad = rejectedRefs(result);
		if (bad) throw new ConflictError(bad);
	} catch (e) {
		if (e instanceof ConflictError || isRejected(e)) throw new ConflictError(`${branch} moved while committing: ${(e as Error).message}`);
		throw e;
	}
	return { commit, parent };
}

/** Retries `fn` when it loses a race (ConflictError), re-reading each time, like PlatAtlas's commitWithRetry. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
	for (let i = 1; ; i++) {
		try {
			return await fn();
		} catch (e) {
			if (!(e instanceof ConflictError) || i >= attempts) throw e;
			await new Promise((r) => setTimeout(r, 50 * i + Math.floor(Math.random() * 100)));
		}
	}
}
