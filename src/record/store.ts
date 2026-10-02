// The decision record: a git repo in Artifacts that holds the playbooks, every decision, the check reports and the
// auto-merge grants. This is PlatAtlas's RepoClient (repos, head, text, texts, commit) over Artifacts instead of the
// GitHub API: reads go through the binding, writes through git, and a write that loses a race re-reads and retries.

import { getRepo, remoteFor, type ArtifactsEnv } from "../artifacts";
import { commitFiles, ConflictError, withRetry, type FileChange } from "../git/ops";

export type Author = { name: string; email: string };
export const STEWARD_AUTHOR: Author = { name: "Steward", email: "steward@steward.invalid" };

/** Files read together at one commit, so a decision never sees half of another write. */
export interface Snapshot {
	head: string | null;
	files: Record<string, string | null>;
}

const writeTokens = new Map<string, { token: string; url: string; until: number }>();

export class RecordStore {
	constructor(
		private readonly env: ArtifactsEnv,
		readonly repo: string,
		readonly branch = "main",
	) {}

	/** The branch tip, or null for an empty repo. */
	async head(): Promise<string | null> {
		using r = await getRepo(this.env, this.repo);
		const [tip] = await r.log({ ref: this.branch, limit: 1 });
		return tip?.hash ?? null;
	}

	/** One file at `ref` (a branch or commit), or null when it does not exist. */
	async text(path: string, ref?: string): Promise<string | null> {
		using r = await getRepo(this.env, this.repo);
		const blob = await r.readFile({ ref: ref ?? this.branch, path });
		return blob ? await blob.text() : null;
	}

	/** Several files at one commit. */
	async snapshot(paths: string[]): Promise<Snapshot> {
		const head = await this.head();
		if (!head) return { head, files: Object.fromEntries(paths.map((p) => [p, null])) };
		using r = await getRepo(this.env, this.repo);
		const texts = await Promise.all(
			paths.map(async (p) => {
				const blob = await r.readFile({ ref: head, path: p });
				return [p, blob ? await blob.text() : null] as const;
			}),
		);
		return { head, files: Object.fromEntries(texts) };
	}

	/** Paths under `dir` at `ref` (one level, files and folders), or [] when the folder does not exist. */
	async list(dir: string, ref?: string): Promise<{ name: string; type: string }[]> {
		using r = await getRepo(this.env, this.repo);
		const [tip] = await r.log({ ref: ref ?? this.branch, limit: 1 });
		if (!tip) return [];
		let tree = tip.treeHash;
		for (const part of dir.split("/").filter(Boolean)) {
			const entries = (await r.readTree(tree)) ?? [];
			const next = entries.find((e) => e.name === part && e.type === "tree");
			if (!next) return [];
			tree = next.hash;
		}
		return ((await r.readTree(tree)) ?? []).map((e) => ({ name: e.name, type: e.type }));
	}

	private async writer() {
		const cached = writeTokens.get(this.repo);
		if (cached && cached.until > Date.now() + 30_000) return { url: cached.url, token: cached.token };
		const remote = await remoteFor(this.env, this.repo, "write", 600);
		writeTokens.set(this.repo, { url: remote.url, token: remote.token, until: Date.parse(remote.expiresAt) || Date.now() + 540_000 });
		return { url: remote.url, token: remote.token };
	}

	/**
	 * Read, build, commit; on a lost race, read again and rebuild. `build` gets a fresh snapshot each attempt and
	 * returns the files to write (or null to write nothing).
	 */
	async update(
		paths: string[],
		build: (snap: Snapshot) => Promise<{ files: FileChange[]; message: string } | null> | { files: FileChange[]; message: string } | null,
		author: Author = STEWARD_AUTHOR,
	): Promise<{ commit: string; parent: string | null } | null> {
		return withRetry(async () => {
			const snap = await this.snapshot(paths);
			const change = await build(snap);
			if (!change || change.files.length === 0) return null;
			const remote = await this.writer();
			return commitFiles({ repo: remote, branch: this.branch, files: change.files, message: change.message, author, expectParent: snap.head });
		});
	}

	/** Appends lines to a JSONL file (creating it), in its own commit. */
	async append(path: string, lines: unknown[], message: string, author: Author = STEWARD_AUTHOR) {
		if (!lines.length) return null;
		return this.update([path], (snap) => {
			const before = snap.files[path] ?? "";
			const sep = before && !before.endsWith("\n") ? "\n" : "";
			return { files: [{ path, content: before + sep + lines.map((l) => JSON.stringify(l)).join("\n") + "\n" }], message };
		}, author);
	}
}

export function jsonl<T = Record<string, unknown>>(text: string | null | undefined): T[] {
	if (!text) return [];
	return text
		.split(/\r?\n/)
		.filter((l) => l.trim())
		.map((l, i) => {
			try {
				return JSON.parse(l) as T;
			} catch {
				throw new Error(`line ${i + 1} is not JSON`);
			}
		});
}

export { ConflictError };
