// Why-blame: for any line of a file on main, the decision that put it there. Main holds one squash commit per
// decision, each carrying a Steward-Decision trailer, so line origins come from main's first-parent history and
// each origin commit names its decision. Computed from Artifacts objects in the Worker; no clone.

import { getRepo, type ArtifactsEnv } from "./artifacts";
import { diffLines } from "./diff";

export interface BlameLine {
	n: number;
	text: string;
	commit: string;
	decision: string | null;
	author: string;
	at: number;
	summary: string;
}

const trailer = (message: string, key: string) => new RegExp(`^${key}:\\s*(.+)$`, "m").exec(message)?.[1]?.trim() ?? null;

async function blobAt(repo: ArtifactsRepo, tree: string, path: string): Promise<string | null> {
	let cur = tree;
	const parts = path.split("/").filter(Boolean);
	for (let i = 0; i < parts.length; i++) {
		const entries = (await repo.readTree(cur)) ?? [];
		const e = entries.find((x) => x.name === parts[i]);
		if (!e) return null;
		if (i === parts.length - 1) return e.type === "tree" ? null : e.hash;
		if (e.type !== "tree") return null;
		cur = e.hash;
	}
	return null;
}

export async function blame(env: ArtifactsEnv, repoName: string, path: string, ref = "main", depth = 300): Promise<BlameLine[]> {
	using repo = await getRepo(env, repoName);
	const commits = (await repo.log({ ref, limit: depth })).reverse(); // oldest first
	const texts = new Map<string, string>();
	let prevHash: string | null = null;
	let lines: string[] = [];
	let origin: number[] = []; // index into commits
	for (let ci = 0; ci < commits.length; ci++) {
		const c = commits[ci]!;
		const hash = await blobAt(repo, c.treeHash, path);
		if (hash === prevHash) continue;
		prevHash = hash;
		if (!hash) {
			lines = [];
			origin = [];
			continue;
		}
		if (!texts.has(hash)) texts.set(hash, (await (await repo.readBlob(hash))?.text()) ?? "");
		const next = texts.get(hash)!.replace(/\n$/, "").split("\n");
		const nextOrigin: number[] = new Array(next.length);
		for (const op of diffLines(lines, next)) {
			if (op.kind === "same") nextOrigin[op.b] = origin[op.a]!;
			else if (op.kind === "add") nextOrigin[op.b] = ci;
		}
		lines = next;
		origin = nextOrigin;
	}
	return lines.map((text, i) => {
		const c = commits[origin[i] ?? 0]!;
		return {
			n: i + 1,
			text,
			commit: c.hash,
			decision: trailer(c.message, "Steward-Decision"),
			author: c.author.name,
			at: c.authoredAt,
			summary: c.message.split("\n")[0] ?? "",
		};
	});
}

/** Every file on main (paths), for the blame file picker. */
export async function listFiles(env: ArtifactsEnv, repoName: string, ref = "main"): Promise<string[]> {
	using repo = await getRepo(env, repoName);
	const [tip] = await repo.log({ ref, limit: 1 });
	if (!tip) return [];
	const out: string[] = [];
	const walk = async (tree: string, prefix: string) => {
		for (const e of (await repo.readTree(tree)) ?? []) {
			const p = prefix ? `${prefix}/${e.name}` : e.name;
			if (e.type === "tree") await walk(e.hash, p);
			else out.push(p);
		}
	};
	await walk(tip.treeHash, "");
	return out.sort();
}
