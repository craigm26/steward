// The board: one Durable Object per app. It holds the live state the record repo does not: open tasks, who has
// claimed which files, each candidate's progress through gate 1, and each decision until it merges. Every change
// is an event, pushed to every open board over a hibernating WebSocket.
//
// Claims answer "how do agents know what others are working on?": a claim names the files an agent will touch.
// Overlapping claims on one task are rivals in one decision; a claim that overlaps nobody gets a decision of its own.

import { DurableObject } from "cloudflare:workers";
import type { DoneCheck } from "./record/playbook";

export type TaskStatus = "open" | "deciding" | "merged" | "closed";
export type CandidateStatus = "claimed" | "working" | "checking" | "passed" | "bounced" | "over-budget" | "withdrawn" | "merged" | "lost";
export type DecisionStatus = "open" | "judging" | "ready" | "merging" | "merged" | "closed";

export interface Task {
	id: string;
	title: string;
	description: string;
	path: string;
	status: TaskStatus;
	created_at: string;
	created_by: string;
	/** The task's own acceptance checks, run with the path's checks. */
	done: DoneCheck[];
}

export interface Claim {
	task: string;
	agent: string;
	files: string[];
	fork: string;
	claimed_at: string;
	expires_at: string;
	budget_minutes: number;
	budget_tokens: number;
	status: "active" | "released";
}

export interface GateCheck {
	name: string;
	ok: boolean;
	detail?: string;
}

export interface Candidate {
	id: string;
	task: string;
	agent: string;
	fork: string;
	branch: string;
	commit: string | null;
	status: CandidateStatus;
	done: boolean;
	summary: string | null;
	tokens_used: number;
	preview_url: string | null;
	checks: GateCheck[];
	diff: { files: { path: string; added: number; removed: number }[]; added: number; removed: number; patch?: string } | null;
	tests_added: number;
	note: string | null;
	decision: string | null;
	updated_at: string;
}

export interface Decision {
	id: string;
	task: string;
	path: string;
	status: DecisionStatus;
	candidates: string[];
	judge: unknown | null;
	referee: unknown | null;
	verdict: unknown | null;
	merged_commit: string | null;
	workflow: string | null;
	created_at: string;
	updated_at: string;
}

export interface BoardEvent {
	seq: number;
	at: string;
	kind: string;
	task: string | null;
	agent: string | null;
	text: string;
	data: unknown;
}

const now = () => new Date().toISOString();
const j = (x: unknown) => JSON.stringify(x ?? null);
const parse = <T>(s: unknown, fallback: T): T => {
	if (typeof s !== "string") return fallback;
	try {
		return JSON.parse(s) as T;
	} catch {
		return fallback;
	}
};

async function sha256(s: string): Promise<string> {
	const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
	return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export class ProjectBoard extends DurableObject {
	private sql = this.ctx.storage.sql;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ctx.blockConcurrencyWhile(async () => this.migrate());
	}

	private migrate() {
		this.sql.exec(`CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, title TEXT, description TEXT, path TEXT, status TEXT, created_at TEXT, created_by TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS claims (task TEXT, agent TEXT, files TEXT, fork TEXT, claimed_at TEXT, expires_at TEXT, budget_minutes INTEGER, budget_tokens INTEGER, status TEXT, PRIMARY KEY (task, agent))`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS candidates (id TEXT PRIMARY KEY, task TEXT, agent TEXT, fork TEXT, branch TEXT, commit_sha TEXT, status TEXT, done INTEGER, summary TEXT, tokens_used INTEGER, preview_url TEXT, checks TEXT, diff TEXT, tests_added INTEGER, note TEXT, decision TEXT, updated_at TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, task TEXT, path TEXT, status TEXT, candidates TEXT, judge TEXT, referee TEXT, verdict TEXT, merged_commit TEXT, created_at TEXT, updated_at TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, kind TEXT, task TEXT, agent TEXT, text TEXT, data TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS agents (name TEXT PRIMARY KEY, key_hash TEXT, kind TEXT, created_at TEXT)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS builds (commit_sha TEXT PRIMARY KEY, ok INTEGER, detail TEXT, url TEXT, at TEXT)`);
		// Columns added after v1: which gate run is checking which commit.
		const cols = new Set(this.sql.exec(`PRAGMA table_info(candidates)`).toArray().map((r) => String(r.name)));
		for (const [name, type] of [["gate_commit", "TEXT"], ["gate_run", "TEXT"], ["gate_at", "TEXT"]] as const) {
			if (!cols.has(name)) this.sql.exec(`ALTER TABLE candidates ADD COLUMN ${name} ${type}`);
		}
		const tcols = new Set(this.sql.exec(`PRAGMA table_info(tasks)`).toArray().map((r) => String(r.name)));
		if (!tcols.has("done")) this.sql.exec(`ALTER TABLE tasks ADD COLUMN done TEXT`);
		const dcols = new Set(this.sql.exec(`PRAGMA table_info(decisions)`).toArray().map((r) => String(r.name)));
		if (!dcols.has("workflow")) this.sql.exec(`ALTER TABLE decisions ADD COLUMN workflow TEXT`);
	}

	/**
	 * One gate run per commit: a push and an agent's "done" for the same commit share a run. Returns false when
	 * another run is already checking `commit` (a run older than 15 minutes is treated as stopped).
	 */
	async startGate(id: string, commit: string, run: string): Promise<boolean> {
		const r = this.sql.exec(`SELECT gate_commit, gate_run, gate_at FROM candidates WHERE id = ?`, id).toArray()[0];
		if (!r) return false;
		const fresh = typeof r.gate_at === "string" && Date.now() - Date.parse(r.gate_at) < 15 * 60_000;
		// Checked already ("done"), or being checked by another run that has not stalled: one run per commit.
		if (r.gate_commit === commit && (r.gate_run === "done" || (r.gate_run && r.gate_run !== run && fresh))) return false;
		this.sql.exec(`UPDATE candidates SET gate_commit = ?, gate_run = ?, gate_at = ? WHERE id = ?`, commit, run, now(), id);
		return true;
	}

	async finishGate(id: string, run: string) {
		this.sql.exec(`UPDATE candidates SET gate_run = 'done' WHERE id = ? AND gate_run = ?`, id, run);
	}

	/** Is a gate run checking this commit right now? */
	async gateBusy(id: string, commit: string): Promise<boolean> {
		const r = this.sql.exec(`SELECT gate_commit, gate_run, gate_at FROM candidates WHERE id = ?`, id).toArray()[0];
		return !!r && r.gate_commit === commit && !!r.gate_run && r.gate_run !== "done" && typeof r.gate_at === "string" && Date.now() - Date.parse(r.gate_at) < 15 * 60_000;
	}

	// ----------------------------------------------------------------- events

	private emit(kind: string, text: string, opts: { task?: string; agent?: string; data?: unknown } = {}): BoardEvent {
		const at = now();
		this.sql.exec(`INSERT INTO events (at, kind, task, agent, text, data) VALUES (?, ?, ?, ?, ?, ?)`, at, kind, opts.task ?? null, opts.agent ?? null, text, j(opts.data));
		const seq = Number(this.sql.exec(`SELECT last_insert_rowid() AS seq`).one().seq);
		const ev: BoardEvent = { seq, at, kind, task: opts.task ?? null, agent: opts.agent ?? null, text, data: opts.data ?? null };
		const msg = JSON.stringify({ type: "event", event: ev });
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.send(msg);
			} catch {
				// A closed socket is dropped by the runtime.
			}
		}
		return ev;
	}

	/** An event from outside the board (the gate, the check, the API). */
	async note(kind: string, text: string, opts: { task?: string; agent?: string; data?: unknown } = {}): Promise<BoardEvent> {
		return this.emit(kind, text, opts);
	}

	async events(since = 0, limit = 200): Promise<BoardEvent[]> {
		return this.sql
			.exec(`SELECT * FROM events WHERE seq > ? ORDER BY seq DESC LIMIT ?`, since, limit)
			.toArray()
			.map((r) => ({ seq: Number(r.seq), at: String(r.at), kind: String(r.kind), task: (r.task as string) ?? null, agent: (r.agent as string) ?? null, text: String(r.text), data: parse(r.data, null) }))
			.reverse();
	}

	async fetch(request: Request): Promise<Response> {
		if (request.headers.get("upgrade") !== "websocket") return new Response("expected a WebSocket", { status: 426 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].send(JSON.stringify({ type: "hello", board: await this.snapshot() }));
		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
		if (message === "ping") ws.send("pong");
	}

	async webSocketClose(ws: WebSocket, code: number) {
		try {
			ws.close(code, "bye");
		} catch {
			// Already closed.
		}
	}

	// ----------------------------------------------------------------- agents

	async registerAgent(name: string, kind = "agent"): Promise<string> {
		const key = `sa_${crypto.randomUUID().replace(/-/g, "")}`;
		this.sql.exec(`INSERT OR REPLACE INTO agents (name, key_hash, kind, created_at) VALUES (?, ?, ?, ?)`, name, await sha256(key), kind, now());
		this.emit("agent", `${name} joined`, { agent: name, data: { kind } });
		return key;
	}

	async agentForKey(key: string): Promise<{ name: string; kind: string } | null> {
		const row = this.sql.exec(`SELECT name, kind FROM agents WHERE key_hash = ?`, await sha256(key)).toArray()[0];
		return row ? { name: String(row.name), kind: String(row.kind) } : null;
	}

	// ----------------------------------------------------------------- tasks

	async createTask(t: { id?: string; title: string; description: string; path: string; by: string; done?: DoneCheck[] }): Promise<Task> {
		const id = t.id ?? `t${Date.now().toString(36).slice(-5)}`;
		if (this.sql.exec(`SELECT id FROM tasks WHERE id = ?`, id).toArray().length) throw new Error(`task ${id} exists`);
		const task: Task = { id, title: t.title, description: t.description, path: t.path, status: "open", created_at: now(), created_by: t.by, done: t.done ?? [] };
		this.sql.exec(`INSERT INTO tasks (id, title, description, path, status, created_at, created_by, done) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, task.title, task.description, task.path, task.status, task.created_at, task.created_by, j(task.done));
		this.emit("task", `Task ${id} opened: ${task.title}`, { task: id, data: { path: task.path } });
		return task;
	}

	private rowTask(r: Record<string, unknown>): Task {
		return { id: String(r.id), title: String(r.title), description: String(r.description), path: String(r.path), status: r.status as TaskStatus, created_at: String(r.created_at), created_by: String(r.created_by), done: parse<DoneCheck[]>(r.done, []) };
	}

	async task(id: string): Promise<Task | null> {
		const r = this.sql.exec(`SELECT * FROM tasks WHERE id = ?`, id).toArray()[0];
		return r ? this.rowTask(r) : null;
	}

	async setTaskStatus(id: string, status: TaskStatus) {
		this.sql.exec(`UPDATE tasks SET status = ? WHERE id = ?`, status, id);
		this.emit("task", `Task ${id} is ${status}`, { task: id, data: { status } });
	}

	// ----------------------------------------------------------------- claims

	private rowClaim(r: Record<string, unknown>): Claim {
		return {
			task: String(r.task),
			agent: String(r.agent),
			files: parse<string[]>(r.files, []),
			fork: String(r.fork),
			claimed_at: String(r.claimed_at),
			expires_at: String(r.expires_at),
			budget_minutes: Number(r.budget_minutes),
			budget_tokens: Number(r.budget_tokens),
			status: r.status as Claim["status"],
		};
	}

	async claim(c: Omit<Claim, "claimed_at" | "status">): Promise<{ claim: Claim; rivals: { agent: string; files: string[] }[]; elsewhere: { task: string; agent: string; files: string[] }[] }> {
		const task = await this.task(c.task);
		if (!task) throw new Error(`no task ${c.task}`);
		if (task.status !== "open") throw new Error(`task ${c.task} is ${task.status}, not open`);
		const claim: Claim = { ...c, claimed_at: now(), status: "active" };
		this.sql.exec(
			`INSERT OR REPLACE INTO claims (task, agent, files, fork, claimed_at, expires_at, budget_minutes, budget_tokens, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
			claim.task, claim.agent, j(claim.files), claim.fork, claim.claimed_at, claim.expires_at, claim.budget_minutes, claim.budget_tokens,
		);
		const id = `${c.task}/${c.agent}`;
		this.sql.exec(
			`INSERT OR IGNORE INTO candidates (id, task, agent, fork, branch, commit_sha, status, done, summary, tokens_used, preview_url, checks, diff, tests_added, note, decision, updated_at) VALUES (?, ?, ?, ?, ?, NULL, 'claimed', 0, NULL, 0, NULL, '[]', NULL, 0, NULL, NULL, ?)`,
			id, c.task, c.agent, c.fork, `cand/${c.task}/${c.agent}`, now(),
		);
		const mine = new Set(claim.files);
		const active = this.sql.exec(`SELECT * FROM claims WHERE status = 'active' AND NOT (task = ? AND agent = ?)`, c.task, c.agent).toArray().map((r) => this.rowClaim(r));
		const overlapping = active.filter((o) => o.files.some((f) => mine.has(f)));
		const rivals = overlapping.filter((o) => o.task === c.task).map((o) => ({ agent: o.agent, files: o.files.filter((f) => mine.has(f)) }));
		const elsewhere = overlapping.filter((o) => o.task !== c.task).map((o) => ({ task: o.task, agent: o.agent, files: o.files.filter((f) => mine.has(f)) }));
		this.regroup(c.task);
		this.emit("claim", `${c.agent} claimed ${claim.files.join(", ")}` + (rivals.length ? `, overlapping ${rivals.map((r) => r.agent).join(", ")}` : ""), {
			task: c.task,
			agent: c.agent,
			data: { files: claim.files, rivals, elsewhere },
		});
		return { claim, rivals, elsewhere };
	}

	async claimOf(task: string, agent: string): Promise<Claim | null> {
		const r = this.sql.exec(`SELECT * FROM claims WHERE task = ? AND agent = ?`, task, agent).toArray()[0];
		return r ? this.rowClaim(r) : null;
	}

	/**
	 * Rebuilds the open decisions of a task from its claims: overlapping claims are one decision (connected
	 * components of the overlap graph). A decision already judged keeps its id and members.
	 */
	private regroup(taskId: string) {
		const task = this.sql.exec(`SELECT * FROM tasks WHERE id = ?`, taskId).toArray()[0];
		if (!task) return;
		const claims = this.sql.exec(`SELECT * FROM claims WHERE task = ? AND status = 'active'`, taskId).toArray().map((r) => this.rowClaim(r));
		const settled = new Set(
			this.sql
				.exec(`SELECT candidates FROM decisions WHERE task = ? AND status NOT IN ('open')`, taskId)
				.toArray()
				.flatMap((r) => parse<string[]>(r.candidates, [])),
		);
		const free = claims.filter((c) => !settled.has(`${c.task}/${c.agent}`));
		// Union-find over overlapping claims.
		const parent = new Map(free.map((c) => [c.agent, c.agent]));
		const find = (a: string): string => (parent.get(a) === a ? a : find(parent.get(a)!));
		for (let i = 0; i < free.length; i++)
			for (let k = i + 1; k < free.length; k++) {
				const a = free[i]!, b = free[k]!;
				if (a.files.some((f) => b.files.includes(f))) parent.set(find(a.agent), find(b.agent));
			}
		const groups = new Map<string, string[]>();
		for (const c of free) {
			const root = find(c.agent);
			groups.set(root, [...(groups.get(root) ?? []), `${c.task}/${c.agent}`]);
		}
		this.sql.exec(`UPDATE candidates SET decision = NULL WHERE task = ? AND decision IN (SELECT id FROM decisions WHERE task = ? AND status = 'open')`, taskId, taskId);
		this.sql.exec(`DELETE FROM decisions WHERE task = ? AND status = 'open'`, taskId);
		const taken = new Set(this.sql.exec(`SELECT id FROM decisions WHERE task = ?`, taskId).toArray().map((r) => String(r.id)));
		for (const members of groups.values()) {
			// One group keeps the plain id; several are told apart by their first agent. Ids never collide with a
			// decision already judged.
			const first = members.map((m) => m.split("/")[1]!).sort()[0]!;
			let id = groups.size === 1 ? `d-${taskId}` : `d-${taskId}-${first}`;
			for (let k = 2; taken.has(id); k++) id = `d-${taskId}-${first}-${k}`;
			taken.add(id);
			this.sql.exec(
				`INSERT OR REPLACE INTO decisions (id, task, path, status, candidates, judge, referee, verdict, merged_commit, created_at, updated_at) VALUES (?, ?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
				id, taskId, String(task.path), j(members.sort()), now(), now(),
			);
			for (const m of members) this.sql.exec(`UPDATE candidates SET decision = ? WHERE id = ?`, id, m);
		}
	}

	// ----------------------------------------------------------------- candidates

	private rowCandidate(r: Record<string, unknown>): Candidate {
		return {
			id: String(r.id),
			task: String(r.task),
			agent: String(r.agent),
			fork: String(r.fork),
			branch: String(r.branch),
			commit: (r.commit_sha as string) ?? null,
			status: r.status as CandidateStatus,
			done: !!r.done,
			summary: (r.summary as string) ?? null,
			tokens_used: Number(r.tokens_used ?? 0),
			preview_url: (r.preview_url as string) ?? null,
			checks: parse<GateCheck[]>(r.checks, []),
			diff: parse(r.diff, null),
			tests_added: Number(r.tests_added ?? 0),
			note: (r.note as string) ?? null,
			decision: (r.decision as string) ?? null,
			updated_at: String(r.updated_at),
		};
	}

	async candidate(id: string): Promise<Candidate | null> {
		const r = this.sql.exec(`SELECT * FROM candidates WHERE id = ?`, id).toArray()[0];
		return r ? this.rowCandidate(r) : null;
	}

	async candidatesOf(task: string): Promise<Candidate[]> {
		return this.sql.exec(`SELECT * FROM candidates WHERE task = ? ORDER BY agent`, task).toArray().map((r) => this.rowCandidate(r));
	}

	async updateCandidate(id: string, patch: Partial<Omit<Candidate, "id" | "task" | "agent">>, event?: { kind: string; text: string; data?: unknown }) {
		const c = await this.candidate(id);
		if (!c) throw new Error(`no candidate ${id}`);
		const next = { ...c, ...patch, updated_at: now() };
		this.sql.exec(
			`UPDATE candidates SET commit_sha = ?, status = ?, done = ?, summary = ?, tokens_used = ?, preview_url = ?, checks = ?, diff = ?, tests_added = ?, note = ?, decision = ?, updated_at = ? WHERE id = ?`,
			next.commit, next.status, next.done ? 1 : 0, next.summary, next.tokens_used, next.preview_url, j(next.checks), j(next.diff), next.tests_added, next.note, next.decision, next.updated_at, id,
		);
		if (event) this.emit(event.kind, event.text, { task: c.task, agent: c.agent, data: event.data });
		return next;
	}

	// ----------------------------------------------------------------- decisions

	private rowDecision(r: Record<string, unknown>): Decision {
		return {
			id: String(r.id),
			task: String(r.task),
			path: String(r.path),
			status: r.status as DecisionStatus,
			candidates: parse<string[]>(r.candidates, []),
			judge: parse(r.judge, null),
			referee: parse(r.referee, null),
			verdict: parse(r.verdict, null),
			merged_commit: (r.merged_commit as string) ?? null,
			workflow: (r.workflow as string) ?? null,
			created_at: String(r.created_at),
			updated_at: String(r.updated_at),
		};
	}

	/** The decide Workflow instance working on this decision (instance ids are unique, decision ids may repeat). */
	async setDecisionWorkflow(id: string, workflow: string) {
		this.sql.exec(`UPDATE decisions SET workflow = ? WHERE id = ?`, workflow, id);
	}

	async decision(id: string): Promise<Decision | null> {
		const r = this.sql.exec(`SELECT * FROM decisions WHERE id = ?`, id).toArray()[0];
		return r ? this.rowDecision(r) : null;
	}

	async decisionsOf(task: string): Promise<Decision[]> {
		return this.sql.exec(`SELECT * FROM decisions WHERE task = ? ORDER BY id`, task).toArray().map((r) => this.rowDecision(r));
	}

	/**
	 * Is the decision ready for the judge? Every candidate must have settled (passed, bounced, over budget or
	 * withdrawn), unless `force` (the steward's "decide now"), which goes ahead with whoever has passed. With none
	 * passed the decision closes. Moving open → judging happens once, so only one caller starts the judge.
	 */
	async readyToJudge(id: string, force = false): Promise<"judge" | "waiting" | "empty"> {
		const d = await this.decision(id);
		if (!d || d.status !== "open") return "waiting";
		const members = (await Promise.all(d.candidates.map((c) => this.candidate(c)))).filter((c): c is Candidate => !!c);
		const settled = (c: Candidate) => ["passed", "bounced", "over-budget", "withdrawn"].includes(c.status);
		if (!force && !members.every(settled)) return "waiting";
		const passed = members.filter((c) => c.status === "passed");
		if (!passed.length) {
			await this.advanceDecision(id, ["open"], "closed", {}, { text: `Decision ${id} closed: no candidate passed gate 1` });
			return "empty";
		}
		const moved = await this.advanceDecision(id, ["open"], "judging", {}, { text: `Decision ${id}: ${passed.length} of ${members.length} candidates passed gate 1; the judge is looking`, data: { passed: passed.map((c) => c.id) } });
		return moved ? "judge" : "waiting";
	}

	/** Moves a decision on, only from the status the caller expects (so two workers never both judge or merge it). */
	async advanceDecision(id: string, from: DecisionStatus[], to: DecisionStatus, patch: Partial<Pick<Decision, "judge" | "referee" | "verdict" | "merged_commit">> = {}, event?: { text: string; data?: unknown }): Promise<Decision | null> {
		const d = await this.decision(id);
		if (!d || !from.includes(d.status)) return null;
		const next = { ...d, ...patch, status: to, updated_at: now() };
		this.sql.exec(`UPDATE decisions SET status = ?, judge = ?, referee = ?, verdict = ?, merged_commit = ?, updated_at = ? WHERE id = ?`, to, j(next.judge), j(next.referee), j(next.verdict), next.merged_commit, next.updated_at, id);
		this.emit("decision", event?.text ?? `Decision ${id} is ${to}`, { task: d.task, data: { decision: id, status: to, ...((event?.data as object) ?? {}) } });
		return next;
	}

	/** Candidates whose claim ran past its wall-clock budget while still unsettled: marks them over budget. */
	async sweepBudgets(at = now()): Promise<{ id: string; fork: string; decision: string | null }[]> {
		const late = this.sql
			.exec(
				`SELECT c.id, c.fork, c.decision, c.agent, c.task FROM candidates c JOIN claims k ON k.task = c.task AND k.agent = c.agent
				 WHERE k.status = 'active' AND k.expires_at < ? AND c.status IN ('claimed', 'working', 'checking')`,
				at,
			)
			.toArray();
		for (const r of late) {
			this.sql.exec(`UPDATE candidates SET status = 'over-budget', note = ?, updated_at = ? WHERE id = ?`, "Over budget (wall clock); the fork is closed.", at, String(r.id));
			this.sql.exec(`UPDATE claims SET status = 'released' WHERE task = ? AND agent = ?`, String(r.task), String(r.agent));
			this.emit("bounce", `${r.agent} ran out of time; fork closed`, { task: String(r.task), agent: String(r.agent) });
		}
		return late.map((r) => ({ id: String(r.id), fork: String(r.fork), decision: (r.decision as string) ?? null }));
	}

	/** A build system (Workers Builds events, or any CI) reports how a commit's build went. */
	async reportBuild(commit: string, ok: boolean, detail: string | null, url: string | null) {
		this.sql.exec(`INSERT OR REPLACE INTO builds (commit_sha, ok, detail, url, at) VALUES (?, ?, ?, ?, ?)`, commit, ok ? 1 : 0, detail, url, now());
	}

	async build(commit: string): Promise<{ ok: boolean; detail: string | null; url: string | null } | null> {
		const r = this.sql.exec(`SELECT ok, detail, url FROM builds WHERE commit_sha = ?`, commit).toArray()[0];
		return r ? { ok: !!r.ok, detail: (r.detail as string) ?? null, url: (r.url as string) ?? null } : null;
	}

	// ----------------------------------------------------------------- whole board

	async snapshot() {
		const tasks = this.sql.exec(`SELECT * FROM tasks ORDER BY created_at DESC`).toArray().map((r) => this.rowTask(r));
		const claims = this.sql.exec(`SELECT * FROM claims ORDER BY claimed_at`).toArray().map((r) => this.rowClaim(r));
		const candidates = this.sql.exec(`SELECT * FROM candidates ORDER BY updated_at DESC`).toArray().map((r) => this.rowCandidate(r));
		const decisions = this.sql.exec(`SELECT * FROM decisions ORDER BY created_at DESC`).toArray().map((r) => this.rowDecision(r));
		const agents = this.sql.exec(`SELECT name, kind, created_at FROM agents ORDER BY created_at`).toArray();
		return { tasks, claims, candidates: candidates.map((c) => ({ ...c, diff: c.diff ? { ...c.diff, patch: undefined } : null })), decisions, agents, events: await this.events(0, 80) };
	}

	/** Wipes the board (demo reset). The record repo and the Artifacts repos are not touched. */
	async reset() {
		for (const t of ["tasks", "claims", "candidates", "decisions", "events", "builds"]) this.sql.exec(`DELETE FROM ${t}`);
		this.emit("reset", "The board was reset");
	}
}

/** The project's board. Calls go over RPC; typed as the class so results read as the plain values they are. */
export function boardFor(env: { BOARD: DurableObjectNamespace<ProjectBoard>; PROJECT: string }): ProjectBoard {
	return env.BOARD.get(env.BOARD.idFromName(env.PROJECT)) as unknown as ProjectBoard;
}
