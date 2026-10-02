// A small in-memory filesystem with the promise API isomorphic-git needs. Workers have no disk, so every git
// operation here works on a throwaway tree that lives for one request.

type Node = { kind: "dir"; children: Set<string>; mtimeMs: number } | { kind: "file"; data: Uint8Array; mtimeMs: number };

class Stats {
	constructor(private node: Node) {}
	get size() { return this.node.kind === "file" ? this.node.data.byteLength : 0; }
	get mtimeMs() { return this.node.mtimeMs; }
	get ctimeMs() { return this.node.mtimeMs; }
	get mode() { return this.node.kind === "file" ? 0o100644 : 0o040000; }
	get uid() { return 1; }
	get gid() { return 1; }
	get ino() { return 0; }
	get dev() { return 0; }
	isFile() { return this.node.kind === "file"; }
	isDirectory() { return this.node.kind === "dir"; }
	isSymbolicLink() { return false; }
}

function fsError(code: string, path: string): Error {
	const e = new Error(`${code}: ${path}`) as Error & { code: string };
	e.code = code;
	return e;
}

export class MemoryFS {
	private nodes = new Map<string, Node>([["/", { kind: "dir", children: new Set(), mtimeMs: Date.now() }]]);
	private enc = new TextEncoder();
	private dec = new TextDecoder();

	readonly promises = {
		readFile: this.readFile.bind(this),
		writeFile: this.writeFile.bind(this),
		unlink: this.unlink.bind(this),
		readdir: this.readdir.bind(this),
		mkdir: this.mkdir.bind(this),
		rmdir: this.rmdir.bind(this),
		stat: this.stat.bind(this),
		lstat: this.stat.bind(this),
		readlink: async (p: string) => { throw fsError("ENOENT", p); },
		symlink: async (_t: string, p: string) => { throw fsError("EPERM", p); },
		chmod: async () => {},
	};

	private norm(p: string): string {
		const out: string[] = [];
		for (const part of p.split("/")) {
			if (!part || part === ".") continue;
			if (part === "..") out.pop();
			else out.push(part);
		}
		return "/" + out.join("/");
	}
	private parent(p: string): string {
		const parts = this.norm(p).split("/").filter(Boolean);
		parts.pop();
		return "/" + parts.join("/");
	}
	private base(p: string): string { return this.norm(p).split("/").filter(Boolean).pop() ?? ""; }
	private get(p: string): Node {
		const n = this.nodes.get(this.norm(p));
		if (!n) throw fsError("ENOENT", p);
		return n;
	}
	private dir(p: string) {
		const n = this.get(p);
		if (n.kind !== "dir") throw fsError("ENOTDIR", p);
		return n;
	}

	async mkdir(p: string, opts?: { recursive?: boolean } | number): Promise<void> {
		const t = this.norm(p);
		if (t === "/" || this.nodes.has(t)) {
			if (this.nodes.get(t)?.kind === "file") throw fsError("EEXIST", p);
			return;
		}
		const parent = this.parent(t);
		if (!this.nodes.has(parent)) {
			if (!(typeof opts === "object" && opts?.recursive)) throw fsError("ENOENT", parent);
			await this.mkdir(parent, { recursive: true });
		}
		this.nodes.set(t, { kind: "dir", children: new Set(), mtimeMs: Date.now() });
		this.dir(parent).children.add(this.base(t));
	}

	async writeFile(p: string, data: string | Uint8Array | ArrayBuffer): Promise<void> {
		const t = this.norm(p);
		await this.mkdir(this.parent(t), { recursive: true });
		const bytes = typeof data === "string" ? this.enc.encode(data) : data instanceof Uint8Array ? data : new Uint8Array(data);
		this.nodes.set(t, { kind: "file", data: bytes, mtimeMs: Date.now() });
		this.dir(this.parent(t)).children.add(this.base(t));
	}

	async readFile(p: string, opts?: string | { encoding?: string }): Promise<Uint8Array | string> {
		const n = this.get(p);
		if (n.kind !== "file") throw fsError("EISDIR", p);
		const encoding = typeof opts === "string" ? opts : opts?.encoding;
		return encoding ? this.dec.decode(n.data) : n.data;
	}

	async readdir(p: string): Promise<string[]> { return [...this.dir(p).children].sort(); }

	async unlink(p: string): Promise<void> {
		const t = this.norm(p);
		if (this.get(t).kind !== "file") throw fsError("EISDIR", p);
		this.nodes.delete(t);
		this.dir(this.parent(t)).children.delete(this.base(t));
	}

	async rmdir(p: string): Promise<void> {
		const t = this.norm(p);
		if (this.dir(t).children.size) throw fsError("ENOTEMPTY", p);
		this.nodes.delete(t);
		this.dir(this.parent(t)).children.delete(this.base(t));
	}

	async stat(p: string): Promise<Stats> { return new Stats(this.get(p)); }
}
