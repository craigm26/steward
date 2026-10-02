// The work an agent does through Steward, shared by the HTTP API (outside agents) and the in-Cloudflare agents:
// claim files on a task (Steward forks the app for that agent alone), and say done.

import { ensureFork, getRepo, previewUrl, remoteFor, whenReady } from "./artifacts";
import { boardFor, type Candidate } from "./board";
import { commitFiles } from "./git/ops";
import { gateForHead, STEWARD_EMAIL } from "./gate";
import { listFiles } from "./blame";
import { loadProject } from "./project";
import { globMatch, type DoneCheck, type Playbook } from "./record/playbook";
import { gateVerdict } from "./verdict";
import { maybeDecide } from "./lifecycle";
import { HttpError } from "./errors";
import type { Env } from "./index";

const boardOf = boardFor;

export function taskBrief(task: { id: string; title: string; description: string; done: DoneCheck[] }, pb: Playbook, files: string[], agent: string) {
	const probe = (d: DoneCheck) => (d.kind === "probe" ? ` (GET ${d.get}${Object.keys(d.expect).length ? `, expect ${Object.entries(d.expect).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}${d.contains ? `, contains "${d.contains}"` : ""})` : "");
	return [
		`# Task ${task.id}: ${task.title}`,
		"",
		task.description,
		"",
		"## Done means: every check must pass",
		"This task:",
		...task.done.map((d) => `- ${d.name}${probe(d)}`),
		`Every change on the ${pb.path} path:`,
		...pb.done.map((d) => `- ${d.name}${probe(d)}`),
		"",
		"## Taste: how a passing candidate is chosen",
		...pb.taste.map((t) => `- ${t}`),
		"",
		"## Your claim",
		`Files: ${files.join(", ")}`,
		`Budget: ${pb.budget.minutes} minutes and ${pb.budget.tokens} tokens. Over budget, this fork closes.`,
		"",
		"## How to work",
		"1. Keep .steward/PLAN.md current and commit it with every push.",
		"2. Push to main of this fork. Every push runs gate 1, which reports back on the board and to `steward-agent status`.",
		"3. When it works, say done with a summary of what works. A hedged summary counts as not done.",
		`4. Only ${agent} can push here, with the token Steward issued for this fork alone.`,
		"",
	].join("\n");
}

export async function claimTask(env: Env, agent: string, taskId: string, req: { files?: string[]; plan?: string }) {
	const board = boardOf(env);
	const task = await board.task(taskId);
	if (!task) throw new HttpError(404, `no task ${taskId}`);
	if (task.status !== "open") throw new HttpError(409, `task ${taskId} is ${task.status}`);
	const project = await loadProject(env);
	const pb = project.playbooks[task.path];
	if (!pb) throw new HttpError(500, `no playbook for path ${task.path}`);
	const existing = (await board.candidatesOf(taskId)).filter((c) => !["withdrawn"].includes(c.status));
	if (!existing.some((c) => c.agent === agent) && existing.length >= pb.max_agents) throw new HttpError(409, `task ${taskId} already has ${pb.max_agents} agents, the path's limit`);

	const appFiles = await listFiles(env, env.PROJECT);
	const wanted = req.files?.length ? req.files : appFiles.filter((f) => pb.globs.some((g) => globMatch(g, f)));
	// A claim names files: ones that exist, or new ones (with an extension) inside the path. A folder is not a claim.
	const onMain = new Set(appFiles);
	const files = [...new Set(wanted.map((f) => f.replace(/^\/+/, "").replace(/\/+$/, "")))].filter((f) => onMain.has(f) || /\.[a-z0-9]+$/i.test(f.split("/").pop() ?? ""));
	const outside = files.filter((f) => !pb.globs.some((g) => globMatch(g, f)));
	if (outside.length) throw new HttpError(400, `outside the ${pb.path} path (${pb.globs.join(", ")}): ${outside.join(", ")}`);
	if (!files.length) throw new HttpError(400, "claim at least one file");

	const fork = await ensureFork(env, env.PROJECT, taskId, agent, `${agent} working on ${task.title}`);
	const seeded = await whenReady(async () => {
		using f = await getRepo(env, fork.name);
		return !!(await f.readFile({ ref: "main", path: ".steward/TASK.md" }));
	});
	if (!seeded) {
		const seed = await remoteFor(env, fork.name, "write", 300);
		await commitFiles({
			repo: seed,
			files: [
				{ path: ".steward/TASK.md", content: taskBrief(task, pb, files, agent) },
				{ path: ".steward/PLAN.md", content: req.plan ?? `# Plan: ${agent} on task ${taskId}\n\n- [ ] Read the code the task touches\n- [ ] Make the change\n- [ ] Add or update a test\n\nStatus: working\n` },
			],
			message: `Steward: task ${taskId} for ${agent}`,
			author: { name: "Steward", email: STEWARD_EMAIL },
		});
	}
	const ttl = Math.max(60, Math.round(pb.budget.minutes * 60));
	const token = await remoteFor(env, fork.name, "write", ttl);
	const result = await board.claim({ task: taskId, agent, files, fork: fork.name, expires_at: token.expiresAt, budget_minutes: pb.budget.minutes, budget_tokens: pb.budget.tokens });
	const branch = `cand/${taskId}/${agent}`;
	return {
		task,
		fork: fork.name,
		remote: token.url,
		token: token.token,
		expires_at: token.expiresAt,
		files,
		rivals: result.rivals,
		elsewhere: result.elsewhere,
		branch,
		preview_url: previewUrl(env, project.config.worker, branch),
		done: [...task.done, ...pb.done].map((d) => d.name),
		taste: pb.taste,
		budget: pb.budget,
		next: "Clone the remote with the token, keep .steward/PLAN.md current, push to main, then POST /api/tasks/:id/done with a summary.",
	};
}

/**
 * The agent says it is done. A gate run already checking its latest commit will read that when it records; checks
 * that already finished on that commit are re-read; otherwise gate 1 runs on the fork's head.
 */
export async function markDone(env: Env, cand: Candidate, summary: string, tokensUsed: number, waitUntil: (p: Promise<unknown>) => void) {
	const board = boardFor(env);
	const id = cand.id;
	const agent = cand.agent;
	if (!summary?.trim()) throw new HttpError(400, "say what works in summary");
	const after = await board.updateCandidate(id, { done: true, summary: summary.trim().slice(0, 2000), tokens_used: Math.max(cand.tokens_used, tokensUsed) }, { kind: "done", text: `${agent} says done`, data: { summary: summary.slice(0, 300) } });
	using fork = await getRepo(env, cand.fork);
	const [tip] = await fork.log({ ref: "main", limit: 1 });
	if (!tip) throw new HttpError(409, "push your work to your fork's main first");
	if (await board.gateBusy(id, tip.hash)) return { ok: true, note: "Gate 1 is already checking your latest commit; it will see that you are done." };
	if (after.commit === tip.hash && after.checks.length && ["working", "bounced"].includes(after.status)) {
		const v = gateVerdict(after.checks, true, after.summary);
		await board.updateCandidate(id, v, { kind: v.status === "passed" ? "passed" : v.status === "bounced" ? "bounce" : "checked", text: v.status === "passed" ? `${agent} passed gate 1 (${after.checks.length} checks)` : v.status === "bounced" ? `${agent} claimed done and failed gate 1: bounced` : `${agent}: ${v.note}` });
		if (v.status !== "working") waitUntil(maybeDecide(env, after.decision).then(() => undefined));
		return { ok: true, status: v.status, note: v.note };
	}
	const instance = await gateForHead(env, cand.fork, "done");
	return { ok: true, gate: instance.id, note: "Gate 1 is checking your latest commit." };
}
