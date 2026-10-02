// Merging a decided candidate: one squash commit on main per decision, so main's history reads as a list of
// decisions and every line traces back to one. Steward's .steward/ folder (the task and the agent's plan) never
// reaches main. When main moved since the candidate started, a three-way merge carries both; a real conflict stops
// the merge and says so.

import git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { MemoryFS } from "./git/memfs";
import { ConflictError, type Remote } from "./git/ops";

const DIR = "/repo";
type Who = { name: string; email: string };

async function withoutSteward(fs: MemoryFS, tree: string): Promise<string> {
	const { tree: entries } = await git.readTree({ fs, dir: DIR, oid: tree });
	if (!entries.some((e) => e.path === ".steward")) return tree;
	return git.writeTree({ fs, dir: DIR, tree: entries.filter((e) => e.path !== ".steward") });
}

export async function squashMerge(opts: { app: Remote; candidateBranch: string; commit: string; message: string; author: Who; committer: Who }) {
	const fs = new MemoryFS();
	await git.init({ fs, dir: DIR, defaultBranch: "main" });
	await git.addRemote({ fs, dir: DIR, remote: "origin", url: opts.app.url });
	const headers = { Authorization: `Bearer ${opts.app.token}` };
	const main = (await git.fetch({ fs, http, dir: DIR, remote: "origin", ref: "main", singleBranch: true, tags: false, headers })).fetchHead;
	const cand = (await git.fetch({ fs, http, dir: DIR, remote: "origin", ref: opts.candidateBranch, singleBranch: true, tags: false, headers })).fetchHead;
	if (!main || !cand) throw new Error(`could not read main or ${opts.candidateBranch}`);
	if (cand !== opts.commit) throw new Error(`${opts.candidateBranch} is at ${cand.slice(0, 7)}, not the decided commit ${opts.commit.slice(0, 7)}`);

	const [base] = await git.findMergeBase({ fs, dir: DIR, oids: [main, cand] });
	let tree: string;
	let mode: "fast-forward" | "three-way";
	if (base === main) {
		tree = (await git.readCommit({ fs, dir: DIR, oid: cand })).commit.tree;
		mode = "fast-forward";
	} else {
		await git.writeRef({ fs, dir: DIR, ref: "refs/heads/main", value: main, force: true });
		await git.writeRef({ fs, dir: DIR, ref: "refs/heads/candidate", value: cand, force: true });
		const stamp = { ...opts.committer, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 };
		try {
			const r = await git.merge({ fs, dir: DIR, ours: "main", theirs: "candidate", fastForward: false, abortOnConflict: true, noUpdateBranch: true, author: stamp, committer: stamp, message: "three-way" });
			if (!r.oid) throw new Error("the merge produced no commit");
			tree = (await git.readCommit({ fs, dir: DIR, oid: r.oid })).commit.tree;
		} catch (e) {
			const err = e as { code?: string; data?: { filepaths?: string[] } };
			if (err.code === "MergeConflictError" || err.code === "MergeNotSupportedError") {
				throw new Error(`the candidate conflicts with main in ${(err.data?.filepaths ?? []).join(", ") || "its files"}; it needs a fresh fork`);
			}
			throw e;
		}
		mode = "three-way";
	}
	tree = await withoutSteward(fs, tree);

	const now = Math.floor(Date.now() / 1000);
	const commit = await git.writeCommit({
		fs,
		dir: DIR,
		commit: {
			message: opts.message.endsWith("\n") ? opts.message : opts.message + "\n",
			tree,
			parent: [main],
			author: { ...opts.author, timestamp: now, timezoneOffset: 0 },
			committer: { ...opts.committer, timestamp: now, timezoneOffset: 0 },
		},
	});
	await git.writeRef({ fs, dir: DIR, ref: "refs/heads/outgoing", value: commit, force: true });
	try {
		const result = await git.push({ fs, http, dir: DIR, remote: "origin", ref: "refs/heads/outgoing", remoteRef: "refs/heads/main", force: false, headers });
		if (!result.ok) throw new ConflictError(JSON.stringify(result.refs));
	} catch (e) {
		if (e instanceof ConflictError || /PushRejected|not-fast-forward|fetch first|stale/i.test(`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`)) {
			throw new ConflictError(`main moved while merging: ${(e as Error).message}`);
		}
		throw e;
	}
	return { commit, parent: main, base: base ?? null, mode };
}
