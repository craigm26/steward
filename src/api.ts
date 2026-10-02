// Steward's HTTP API.
//   read     the board, decisions, paths, the ledger, why-blame (public when PUBLIC_READ is "on")
//   agents   list tasks, claim files (get a fork and a token for it only), say done, withdraw
//   steward  open tasks, decide a card, decide now, run a check
//   admin    seed the demo, reset the board, register agents

import { ensureFork, getRepo, previewUrl, remoteFor, slug, whenReady } from "./artifacts";
import { commitFiles, deleteBranches, listBranches, resetBranch } from "./git/ops";
import { runCheck } from "./check";
import { demoRecordFiles } from "./demo/record";
import { RecordStore, jsonl } from "./record/store";
import { globMatch, parseDoneCheck, type DoneCheck, type Playbook } from "./record/playbook";
import { DEMO_TASKS } from "./demo/tasks";
import { forgetProject, loadProject } from "./project";
import { blame, listFiles } from "./blame";
import { closeFork, maybeDecide } from "./lifecycle";
import { gateForHead, STEWARD_EMAIL } from "./gate";
import { gateVerdict } from "./verdict";
import { DEFAULT_REFEREE_MODEL } from "./referee";
import { foldGrants } from "../vendor/platatlas/grants.ts";
import type { Env } from "./index";
import type { LedgerLine } from "./check";
import type { StewardVerdict } from "./decide";
import { HttpError } from "./errors";
import { claimTask, markDone } from "./work";
import { LINEUP } from "./agents/race";
import { boardFor } from "./board";

type Who = { kind: "admin" } | { kind: "agent"; name: string } | { kind: "public" };


const json = (body: unknown, status = 200, headers: HeadersInit = {}) => Response.json(body, { status, headers });

async function body<T>(request: Request): Promise<T> {
	try {
		return (await request.json()) as T;
	} catch {
		throw new HttpError(400, "body must be JSON");
	}
}

function boardOf(env: Env) {
	return boardFor(env);
}

async function who(request: Request, env: Env): Promise<Who> {
	const header = request.headers.get("authorization") ?? "";
	const token = header.startsWith("Bearer ") ? header.slice(7) : "";
	if (token && env.STEWARD_ADMIN_KEY && token === env.STEWARD_ADMIN_KEY) return { kind: "admin" };
	if (token.startsWith("sa_")) {
		const agent = await boardOf(env).agentForKey(token);
		if (agent) return { kind: "agent", name: agent.name };
	}
	return { kind: "public" };
}

const need = (w: Who, ...kinds: Who["kind"][]) => {
	if (!kinds.includes(w.kind)) throw new HttpError(w.kind === "public" ? 401 : 403, w.kind === "public" ? "sign in with a steward or agent key" : "not allowed for this key");
};

async function pathsView(env: Env) {
	const project = await loadProject(env, true);
	const store = new RecordStore(env, env.RECORD_REPO);
	const now = new Date().toISOString();
	const grants = foldGrants(project.grants, now);
	const out = [];
	for (const pb of Object.values(project.playbooks)) {
		const report = await store.text(`checks/${pb.path}/last-report.json`);
		const r = report ? JSON.parse(report) : null;
		const mine = grants.filter((g) => g.when?.path === pb.path && g.label === "ship");
		const active = mine.find((g) => g.status === "active");
		out.push({
			path: pb.path,
			title: pb.title,
			steward: project.config.stewards.find((s) => s.key === pb.steward) ?? { key: pb.steward, name: pb.steward },
			globs: pb.globs,
			done: pb.done.map((d) => d.name),
			taste: pb.taste,
			budget: pb.budget,
			auto_merge: { mode: pb.auto_merge.mode, min_probability: pb.auto_merge.min_probability, on: !!active, grant: active ?? null },
			grants: mine.map((g) => ({ id: g.id, status: g.status, at: g.at, by: g.by, until: g.until, note: g.note, reason: g.reason, ended_at: g.ended_at })),
			last_check: r ? { at: r.at, pass: r.pass, judged: r.judged, misses: r.misses, miss_rate: r.miss_rate, bar: r.max_acceptable_miss_rate, engine: r.engine, rows: (r.detail ?? []).map((d: { id: string; expected: string; probability: number; miss: boolean }) => ({ id: d.id, miss: d.miss, p: d.probability })) } : null,
		});
	}
	return { project: project.config, thresholds: project.thresholds, paths: out };
}

async function decisionView(env: Env, id: string) {
	const board = boardOf(env);
	const d = await board.decision(id);
	const store = new RecordStore(env, env.RECORD_REPO);
	const recorded = await store.text(`decisions/${id}.json`);
	if (!d && !recorded) throw new HttpError(404, `no decision ${id}`);
	const candidates = d ? (await Promise.all(d.candidates.map((c) => board.candidate(c)))).filter(Boolean) : [];
	const task = d ? await board.task(d.task) : null;
	return { decision: d, task, candidates, record: recorded ? JSON.parse(recorded) : null };
}

export async function handleApi(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
	const url = new URL(request.url);
	const p = url.pathname;
	const m = request.method;
	try {
		if (p === "/api/health") return json({ ok: true, service: "steward", project: env.PROJECT });
		const w = await who(request, env);
		const readable = () => {
			if (env.PUBLIC_READ !== "on") need(w, "admin", "agent");
		};
		const board = boardOf(env);
		let r: RegExpMatchArray | null;

		// ---------------------------------------------------------------- read
		if (m === "GET" && p === "/api/whoami") return json(w);
		if (m === "GET" && p === "/api/board") {
			readable();
			return json(await board.snapshot());
		}
		if (m === "GET" && p === "/api/board/ws") {
			readable();
			return board.fetch(request);
		}
		if (m === "GET" && p === "/api/board/events") {
			readable();
			return json(await board.events(Number(url.searchParams.get("since") ?? 0)));
		}
		if (m === "GET" && (r = p.match(/^\/api\/decisions\/([A-Za-z0-9._-]+)$/))) {
			readable();
			return json(await decisionView(env, r[1]!));
		}
		if (m === "GET" && p === "/api/paths") {
			readable();
			return json(await pathsView(env));
		}
		if (m === "GET" && p === "/api/ledger") {
			readable();
			const lines = jsonl<LedgerLine>(await new RecordStore(env, env.RECORD_REPO).text("ledger.jsonl"));
			return json(lines.reverse());
		}
		if (m === "GET" && p === "/api/files") {
			readable();
			return json(await listFiles(env, env.PROJECT, url.searchParams.get("ref") ?? "main"));
		}
		if (m === "GET" && p === "/api/blame") {
			readable();
			const file = url.searchParams.get("file");
			if (!file) throw new HttpError(400, "file is required");
			return json(await blame(env, env.PROJECT, file, url.searchParams.get("ref") ?? "main"));
		}
		if (m === "GET" && p === "/api/record/file") {
			readable();
			const path = url.searchParams.get("path");
			if (!path) throw new HttpError(400, "path is required");
			const text = await new RecordStore(env, env.RECORD_REPO).text(path, url.searchParams.get("ref") ?? undefined);
			if (text === null) throw new HttpError(404, "not found");
			return new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
		}
		if (m === "GET" && p === "/api/tasks") {
			readable();
			const snap = await board.snapshot();
			const status = url.searchParams.get("status");
			return json(snap.tasks.filter((t) => !status || t.status === status));
		}
		if (m === "GET" && (r = p.match(/^\/api\/tasks\/([a-z0-9._-]+)$/))) {
			readable();
			const task = await board.task(r[1]!);
			if (!task) throw new HttpError(404, `no task ${r[1]}`);
			const project = await loadProject(env);
			return json({ task, playbook: project.playbooks[task.path] ?? null, candidates: await board.candidatesOf(task.id), decisions: await board.decisionsOf(task.id) });
		}

		// ---------------------------------------------------------------- agents
		if (m === "POST" && (r = p.match(/^\/api\/tasks\/([a-z0-9._-]+)\/claim$/))) {
			need(w, "agent", "admin");
			const req = await body<{ files?: string[]; plan?: string; agent?: string }>(request);
			const agent = w.kind === "agent" ? w.name : slug(req.agent ?? "", 24);
			return json(await claimTask(env, agent, r[1]!, req));
		}
		if (m === "POST" && (r = p.match(/^\/api\/tasks\/([a-z0-9._-]+)\/done$/))) {
			need(w, "agent", "admin");
			const req = await body<{ summary: string; tokens_used?: number; agent?: string }>(request);
			const agent = w.kind === "agent" ? w.name : slug(req.agent ?? "", 24);
			const id = `${r[1]}/${agent}`;
			const cand = await board.candidate(id);
			if (!cand) throw new HttpError(404, `${agent} has not claimed task ${r[1]}`);
			if (!req.summary?.trim()) throw new HttpError(400, "say what works in summary");
			return json(await markDone(env, cand, req.summary, Number(req.tokens_used ?? 0), (p) => ctx.waitUntil(p)));
		}
		if (m === "POST" && (r = p.match(/^\/api\/tasks\/([a-z0-9._-]+)\/withdraw$/))) {
			need(w, "agent", "admin");
			const req = await body<{ agent?: string }>(request).catch(() => ({ agent: undefined }));
			const agent = w.kind === "agent" ? w.name : slug(req.agent ?? "", 24);
			const id = `${r[1]}/${agent}`;
			const cand = await board.candidate(id);
			if (!cand) throw new HttpError(404, `${agent} has not claimed task ${r[1]}`);
			await board.updateCandidate(id, { status: "withdrawn", note: "Withdrawn by the agent." }, { kind: "withdraw", text: `${agent} withdrew` });
			ctx.waitUntil(closeFork(env, cand.fork).then(() => maybeDecide(env, cand.decision)));
			return json({ ok: true });
		}
		if (m === "GET" && (r = p.match(/^\/api\/tasks\/([a-z0-9._-]+)\/me$/))) {
			need(w, "agent");
			const cand = await board.candidate(`${r[1]}/${(w as { name: string }).name}`);
			if (!cand) throw new HttpError(404, "no claim");
			return json(cand);
		}

		// ---------------------------------------------------------------- steward
		if (m === "POST" && p === "/api/tasks") {
			need(w, "admin");
			const req = await body<{ id?: string; title: string; description?: string; path: string; done?: unknown[] }>(request);
			const project = await loadProject(env);
			if (!project.playbooks[req.path]) throw new HttpError(400, `no playbook for path ${req.path}; paths: ${Object.keys(project.playbooks).join(", ")}`);
			if (!req.title?.trim()) throw new HttpError(400, "title is required");
			let done: DoneCheck[];
			try {
				done = (req.done ?? []).map((d, i) => parseDoneCheck(d, `done[${i}]`));
			} catch (e) {
				throw new HttpError(400, (e as Error).message);
			}
			try {
				return json(await board.createTask({ id: req.id ? slug(req.id, 24) : undefined, title: req.title.trim(), description: (req.description ?? req.title).trim(), path: req.path, by: project.playbooks[req.path]!.steward, done }));
			} catch (e) {
				throw new HttpError(409, (e as Error).message);
			}
		}
		if (m === "POST" && p === "/api/admin/race") {
			// Start model agents on a task: one Workflow each, each on its own Workers AI model.
			need(w, "admin");
			const req = await body<{ task: string; agents?: { agent: string; model: string }[]; rounds?: number }>(request);
			const task = await board.task(req.task);
			if (!task) throw new HttpError(404, `no task ${req.task}`);
			const lineup = (req.agents?.length ? req.agents : LINEUP).map((a) => ({ agent: slug(a.agent, 24), model: a.model }));
			const stamp = Date.now().toString(36);
			const created = await env.AGENTS.createBatch(lineup.map((a) => ({ id: `${task.id}-${a.agent}-${stamp}`, params: { task: task.id, agent: a.agent, model: a.model, rounds: req.rounds ?? 2 } })));
			await board.note("race", `${lineup.length} model agents started on task ${task.id}: ${lineup.map((a) => a.agent).join(", ")}`, { task: task.id, data: { lineup } });
			return json({ started: created.map((c) => c.id), lineup });
		}
		if (m === "POST" && p === "/api/admin/demo-task") {
			need(w, "admin");
			const req = await body<{ name: string; id?: string }>(request);
			const t = DEMO_TASKS[req.name];
			if (!t) throw new HttpError(400, `demo tasks: ${Object.keys(DEMO_TASKS).join(", ")}`);
			const project = await loadProject(env);
			try {
				return json(await board.createTask({ ...t, id: req.id ?? t.id, by: project.playbooks[t.path]?.steward ?? "steward", done: t.done.map((d, i) => parseDoneCheck(d, `${req.name} done[${i}]`)) }));
			} catch (e) {
				throw new HttpError(409, (e as Error).message);
			}
		}
		if (m === "POST" && (r = p.match(/^\/api\/decisions\/([A-Za-z0-9._-]+)\/decide$/))) {
			need(w, "admin");
			const req = await body<{ pick: string; reason?: string; by?: string }>(request);
			const d = await board.decision(r[1]!);
			if (!d) throw new HttpError(404, `no decision ${r[1]}`);
			if (d.status !== "ready") throw new HttpError(409, `decision ${d.id} is ${d.status}, not waiting for a steward`);
			const judgePick = (d.judge as { pick?: string; eligible?: string[] } | null)?.pick;
			const eligible = (d.judge as { eligible?: string[] } | null)?.eligible ?? [];
			if (!eligible.includes(req.pick)) throw new HttpError(400, `${req.pick} did not pass gate 1 in this decision`);
			// As in PlatAtlas: choosing differently from the suggestion needs a reason, written down.
			if (req.pick !== judgePick && !req.reason?.trim()) throw new HttpError(400, "choosing differently from the judge needs a reason", "note_needed");
			const project = await loadProject(env);
			const stewardKey = req.by ?? project.playbooks[d.path]?.steward ?? "steward";
			const steward = project.config.stewards.find((s) => s.key === stewardKey);
			const verdict: StewardVerdict = { pick: req.pick, ...(req.reason?.trim() ? { reason: req.reason.trim() } : {}), by: stewardKey, by_name: steward?.name ?? stewardKey, at: new Date().toISOString() };
			// Moving ready -> merging happens once, so a double click never merges twice.
			const agree = req.pick === judgePick;
			const moved = await board.advanceDecision(d.id, ["ready"], "merging", { verdict: { ...verdict, kind: "person", verdict: agree ? "agree" : "overrule" } }, {
				text: agree ? `${verdict.by_name} agreed: ship ${req.pick.split("/")[1]}'s candidate` : `${verdict.by_name} overruled the judge: ship ${req.pick.split("/")[1]}'s candidate. ${verdict.reason}`,
			});
			if (!moved) throw new HttpError(409, `decision ${d.id} was decided already`);
			const run = `${d.id}-merge-${Date.now().toString(36)}`;
			await env.DECIDE.create({ id: run, params: { decision: d.id, verdict } });
			await board.setDecisionWorkflow(d.id, run);
			return json({ ok: true, verdict, run });
		}
		if (m === "POST" && (r = p.match(/^\/api\/decisions\/([A-Za-z0-9._-]+)\/decide-now$/))) {
			need(w, "admin");
			return json({ result: await maybeDecide(env, r[1]!, true) });
		}
		if (m === "POST" && (r = p.match(/^\/api\/check\/([a-z0-9._-]+)$/))) {
			need(w, "admin");
			const t0 = Date.now();
			const outcome = await runCheck(new RecordStore(env, env.RECORD_REPO), r[1]!, env);
			forgetProject();
			await board.note("check", `Check ${r[1]}: ${outcome.report.pass ? "pass" : "fail"}, ${outcome.report.misses} of ${outcome.report.judged} differ; auto-merge ${outcome.autoMerge}`, { data: { path: r[1], pass: outcome.report.pass, autoMerge: outcome.autoMerge, note: outcome.note } });
			const { detail, ...summary } = outcome.report;
			return json({ ...outcome, report: summary, rows: detail.map((d) => ({ id: d.id, expected: d.expected, got: d.got, p: d.probability, miss: d.miss })), ms: Date.now() - t0 });
		}

		// ---------------------------------------------------------------- admin
		if (m === "POST" && p === "/api/builds") {
			// A build system reports a commit's build (the preview runner today; Workers Builds events later).
			need(w, "admin");
			const req = await body<{ commit: string; ok: boolean; detail?: string; url?: string }>(request);
			if (!/^[0-9a-f]{40}$/.test(req.commit ?? "")) throw new HttpError(400, "commit must be a 40-character sha");
			await board.reportBuild(req.commit, !!req.ok, req.detail?.slice(0, 2000) ?? null, req.url ?? null);
			return json({ ok: true });
		}
		if (m === "POST" && p === "/api/agents") {
			need(w, "admin");
			const req = await body<{ name: string; kind?: string }>(request);
			const name = slug(req.name, 24);
			return json({ name, key: await board.registerAgent(name, req.kind ?? "agent") });
		}
		if (m === "POST" && p === "/api/admin/seed-record") {
			need(w, "admin");
			const { reset } = await body<{ reset?: boolean }>(request).catch(() => ({ reset: false }));
			let created = false;
			try {
				using rr = await getRepo(env, env.RECORD_REPO);
				await rr.info();
			} catch (e) {
				if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
				await env.ARTIFACTS.create(env.RECORD_REPO, { description: "Steward decision record: playbooks, decisions, checks, grants", setDefaultBranch: "main" });
				created = true;
			}
			const files = demoRecordFiles();
			const store = new RecordStore(env, env.RECORD_REPO);
			// A reset puts the record back exactly as seeded: every file not in the seed is deleted.
			const seeded = new Set(files.map((f) => f.path));
			const stale = reset ? (await store.listAll()).filter((p) => !seeded.has(p)).map((path) => ({ path, content: null })) : [];
			const written = await store.update(["steward.yaml"], (snap) => {
				if (snap.files["steward.yaml"] && !reset) return null;
				return { files: [...files, ...stale], message: `${reset ? "Reset" : "Seed"} the demo record: playbooks, thresholds, synthetic history\n\nThe past decisions in this commit are synthetic (synthetic: true).` };
			});
			forgetProject();
			return json({ repo: env.RECORD_REPO, created, seeded: !!written, commit: written?.commit ?? null, files: files.length });
		}
		if (m === "POST" && p === "/api/admin/test-referee") {
			need(w, "admin");
			const req = await body<{ model?: string; max_tokens?: number; prompt?: string; extra?: Record<string, unknown> }>(request).catch(() => ({}) as { model?: string; max_tokens?: number; prompt?: string; extra?: Record<string, unknown> });
			const model = req.model || env.REFEREE_MODEL || DEFAULT_REFEREE_MODEL;
			const t0 = Date.now();
			try {
				const raw = await env.AI.run(model as keyof AiModels, { messages: [{ role: "user", content: req.prompt ?? "Say the word ready." }], max_tokens: req.max_tokens ?? 20, ...(req.extra ?? {}) } as never);
				return json({ model, ms: Date.now() - t0, raw });
			} catch (e) {
				return json({ model, error: (e as Error).message, name: (e as Error).name }, 502);
			}
		}
		if (m === "POST" && p === "/api/admin/reset-demo") {
			// Rehearsal reset: the board, the record (as seeded), the app's main back to its first commit, and every
			// fork and candidate branch deleted.
			need(w, "admin");
			const out: Record<string, unknown> = {};
			await board.reset();
			const app = await remoteFor(env, env.PROJECT, "write", 600);
			// main goes back to the commit tagged `seed` (or the first commit when there is no tag).
			const [seedTag] = await listBranches(app, "refs/tags/seed");
			using appRepo = await getRepo(env, env.PROJECT);
			const history = await appRepo.log({ ref: "main", limit: 1000 });
			const target = seedTag?.oid ?? history[history.length - 1]?.hash;
			if (target && history[0]?.hash !== target) {
				await resetBranch(app, "main", target);
				out.main = `reset to ${target.slice(0, 7)}`;
			}
			const cands = await listBranches(app, "refs/heads/cand/");
			out.candidate_branches = await deleteBranches(app, cands);
			let cursor: string | undefined;
			const forks: string[] = [];
			do {
				const page = await env.ARTIFACTS.list({ limit: 200, cursor });
				forks.push(...page.repos.map((r) => r.name).filter((n) => n.startsWith(`${env.PROJECT}--`)));
				cursor = page.cursor;
			} while (cursor);
			await Promise.all(forks.map((f) => env.ARTIFACTS.delete(f).catch(() => false)));
			out.forks_deleted = forks.length;
			// Deletes finish in the background; wait (up to 30 s) so a new fork can reuse a name straight away.
			for (let i = 0; i < 15 && forks.length; i++) {
				const left = (await env.ARTIFACTS.list({ limit: 200 })).repos.filter((r) => forks.includes(r.name)).length;
				if (!left) break;
				await new Promise((r) => setTimeout(r, 2000));
			}
			const files = demoRecordFiles();
			const store = new RecordStore(env, env.RECORD_REPO);
			const seeded = new Set(files.map((f) => f.path));
			const stale = (await store.listAll()).filter((x) => !seeded.has(x)).map((path) => ({ path, content: null }));
			await store.update(["steward.yaml"], () => ({ files: [...files, ...stale], message: "Reset the demo record for a rehearsal\n\nThe past decisions in this commit are synthetic (synthetic: true)." }));
			forgetProject();
			out.record = "reset to the seed";
			await board.note("reset", "The demo was reset: app main, forks, candidate branches, record and board");
			return json(out);
		}
		if (m === "POST" && p === "/api/admin/reset-board") {
			need(w, "admin");
			await board.reset();
			return json({ ok: true });
		}

		throw new HttpError(404, "not found");
	} catch (e) {
		const err = e as Error & { status?: number; code?: string };
		const status = e instanceof HttpError ? e.status : (err.status ?? 500);
		if (status >= 500) console.error("api error", m, p, err.code ?? "", err.message, err.stack);
		return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, status);
	}
}
