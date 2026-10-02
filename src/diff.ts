// Line diffs, computed in the Worker from Artifacts objects: what a candidate changed against the commit it
// started from. Myers' O(ND) algorithm; unified hunks with three lines of context.

import { getRepo, type ArtifactsEnv } from "./artifacts";

export type Op = { kind: "same" | "add" | "del"; a: number; b: number; line: string };

/** The shortest edit script from `a` to `b`, as one op per line. */
export function diffLines(a: string[], b: string[]): Op[] {
	const n = a.length, m = b.length, max = n + m;
	const v = new Map<number, number>([[1, 0]]);
	const trace: Map<number, number>[] = [];
	outer: for (let d = 0; d <= max; d++) {
		trace.push(new Map(v));
		for (let k = -d; k <= d; k += 2) {
			let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) { x++; y++; }
			v.set(k, x);
			if (x >= n && y >= m) break outer;
		}
	}
	const ops: Op[] = [];
	let x = n, y = m;
	for (let d = trace.length - 1; d >= 0 && (x > 0 || y > 0); d--) {
		const vd = trace[d]!;
		const k = x - y;
		const prevK = k === -d || (k !== d && (vd.get(k - 1) ?? -1) < (vd.get(k + 1) ?? -1)) ? k + 1 : k - 1;
		const prevX = vd.get(prevK) ?? 0, prevY = prevX - prevK;
		while (x > prevX && y > prevY) { x--; y--; ops.push({ kind: "same", a: x, b: y, line: a[x]! }); }
		if (d > 0) {
			if (x === prevX) { y--; ops.push({ kind: "add", a: x, b: y, line: b[y]! }); }
			else { x--; ops.push({ kind: "del", a: x, b: y, line: a[x]! }); }
		}
	}
	return ops.reverse();
}

const split = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));

/** A unified diff of one file, with `context` lines around each change. */
export function unified(path: string, before: string | null, after: string | null, context = 3): { patch: string; added: number; removed: number } {
	const ops = diffLines(split(before ?? ""), split(after ?? ""));
	const added = ops.filter((o) => o.kind === "add").length, removed = ops.filter((o) => o.kind === "del").length;
	if (!added && !removed) return { patch: "", added, removed };
	const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
	let i = 0;
	while (i < ops.length) {
		while (i < ops.length && ops[i]!.kind === "same") i++;
		if (i >= ops.length) break;
		let start = Math.max(0, i - context), end = i;
		// Extend the hunk while changes are closer than 2*context lines apart.
		for (let k = i; k < ops.length; k++) {
			if (ops[k]!.kind !== "same") end = k;
			else if (k - end > 2 * context) break;
		}
		end = Math.min(ops.length - 1, end + context);
		const hunk = ops.slice(start, end + 1);
		const aStart = (hunk.find((o) => o.kind !== "add")?.a ?? hunk[0]!.a) + 1;
		const bStart = (hunk.find((o) => o.kind !== "del")?.b ?? hunk[0]!.b) + 1;
		out.push(`@@ -${aStart},${hunk.filter((o) => o.kind !== "add").length} +${bStart},${hunk.filter((o) => o.kind !== "del").length} @@`);
		for (const o of hunk) out.push((o.kind === "add" ? "+" : o.kind === "del" ? "-" : " ") + o.line);
		i = end + 1;
	}
	return { patch: out.join("\n"), added, removed };
}

type Entry = { name: string; hash: string; type: string };

/** Every file under a tree, as path → blob hash. */
async function flatten(repo: ArtifactsRepo, tree: string | null, prefix = "", out = new Map<string, string>()): Promise<Map<string, string>> {
	if (!tree) return out;
	const entries = ((await repo.readTree(tree)) ?? []) as Entry[];
	await Promise.all(
		entries.map(async (e) => {
			const path = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.type === "tree") await flatten(repo, e.hash, path, out);
			else if (e.type === "blob" || e.type === "exec") out.set(path, e.hash);
		}),
	);
	return out;
}

export interface TreeDiff {
	files: { path: string; added: number; removed: number; status: "added" | "removed" | "modified" }[];
	added: number;
	removed: number;
	patch: string;
	testsAdded: number;
}

/**
 * What changed between two commits of one repo, ignoring Steward's own `.steward/` folder. Reads trees and blobs
 * through the binding, so no clone is needed. `patch` is cut at `maxPatch` characters.
 */
export async function diffCommits(env: ArtifactsEnv, repoName: string, base: string, head: string, maxPatch = 40_000): Promise<TreeDiff> {
	using repo = await getRepo(env, repoName);
	const [bc, hc] = await Promise.all([repo.readCommit(base), repo.readCommit(head)]);
	if (!hc) throw new Error(`no commit ${head} in ${repoName}`);
	const [a, b] = await Promise.all([flatten(repo, bc?.treeHash ?? null), flatten(repo, hc.treeHash)]);
	const paths = [...new Set([...a.keys(), ...b.keys()])].filter((p) => !p.startsWith(".steward/") && a.get(p) !== b.get(p)).sort();
	const text = async (hash: string | undefined) => (hash ? ((await (await repo.readBlob(hash))?.text()) ?? "") : null);
	const files: TreeDiff["files"] = [];
	const patches: string[] = [];
	let testsAdded = 0;
	for (const p of paths) {
		const [before, after] = await Promise.all([text(a.get(p)), text(b.get(p))]);
		const u = unified(p, before, after);
		files.push({ path: p, added: u.added, removed: u.removed, status: before === null ? "added" : after === null ? "removed" : "modified" });
		if (u.patch) patches.push(u.patch);
		if (/(^|\/)(test|tests|__tests__)\/|\.test\.[jt]s$|\.spec\.[jt]s$/.test(p) && after) {
			const added = u.patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
			testsAdded += added.filter((l) => /\b(test|it)\s*\(/.test(l)).length;
		}
	}
	const patch = patches.join("\n");
	return {
		files,
		added: files.reduce((n, f) => n + f.added, 0),
		removed: files.reduce((n, f) => n + f.removed, 0),
		patch: patch.length > maxPatch ? patch.slice(0, maxPatch) + "\n… (cut)" : patch,
		testsAdded,
	};
}

/** The newest commit on `ref` that is also on `onto`'s first-parent history: where a candidate started. */
export async function forkPoint(env: ArtifactsEnv, repoName: string, ref: string, onto = "main"): Promise<string | null> {
	using repo = await getRepo(env, repoName);
	const [mine, theirs] = await Promise.all([repo.log({ ref, limit: 200 }), repo.log({ ref: onto, limit: 1000 })]);
	const known = new Set(theirs.map((c) => c.hash));
	return mine.find((c) => known.has(c.hash))?.hash ?? null;
}
