// Model agents: coding agents that run inside Cloudflare, one Workflow instance each, each on its own Workers AI
// model. They use exactly the path an outside agent uses (claim, push to their own fork, say done) and get exactly the
// same treatment: gate 1, the judge, the steward. An agent bounced by gate 1 reads why and tries again, within its
// rounds and budget, while its decision is still open.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../index";
import { boardFor } from "../board";
import { getRepo, remoteFor } from "../artifacts";
import { commitFiles } from "../git/ops";
import { listFiles } from "../blame";
import { loadProject } from "../project";
import { globMatch, type DoneCheck } from "../record/playbook";
import { claimTask, markDone } from "../work";
import { chat } from "./model";
import { parseReply } from "./reply";
import { translation, type Variant } from "../demo/locales";
export { parseReply } from "./reply";

export interface RaceParams {
	task: string;
	agent: string;
	model: string;
	rounds?: number;
	/** A scripted agent (the scale run): writes a known translation variant instead of asking a model. */
	script?: { code: string; variant: Variant };
}

/** The demo's six agents, six models. */
export const LINEUP: { agent: string; model: string }[] = [
	{ agent: "kimi", model: "@cf/moonshotai/kimi-k2.7-code" },
	{ agent: "deepseek", model: "@cf/deepseek-ai/deepseek-v4-pro-0813" },
	{ agent: "glm", model: "@cf/zai-org/glm-5.3" },
	{ agent: "qwen", model: "@cf/qwen/qwen3.8-27b" },
	{ agent: "gemma", model: "@cf/google/gemma-4-26b-a4b-it" },
	{ agent: "nemotron", model: "@cf/nvidia/nemotron-3-120b-a12b" },
];

const describe = (d: DoneCheck) =>
	d.kind === "build"
		? `- ${d.name} (Steward runs \`npm run build\`, which runs the tests, then deploys a Preview)`
		: d.kind === "file"
			? `- ${d.name}: ${d.file} must exist${d.json || d.like ? " and be valid JSON" : ""}${d.like ? ` with every key of ${d.like}, none empty` : ""}`
			: `- ${d.name}: GET ${d.get}${Object.keys(d.expect).length ? ` must answer ${Object.entries(d.expect).map(([k, v]) => `${k}=${v}`).join(", ")}` : ""}${d.contains ? ` must contain "${d.contains}"` : ""}`;

export class AgentWorkflow extends WorkflowEntrypoint<Env, RaceParams> {
	async run(event: Readonly<WorkflowEvent<RaceParams>>, step: WorkflowStep) {
		const env = this.env;
		const { task: taskId, agent, model } = event.payload;
		const rounds = event.payload.rounds ?? 2;
		const board = boardFor(env);
		let tokens = 0;
		if (event.payload.script) return this.scripted(step, event.payload);

		// 1. Read the task and the code, plan, and claim the files to touch.
		const plan = await step.do("plan and claim", { retries: { limit: 2, delay: "5 seconds" } }, async () => {
			const task = await board.task(taskId);
			if (!task) throw new Error(`no task ${taskId}`);
			const project = await loadProject(env);
			const pb = project.playbooks[task.path]!;
			const files = await listFiles(env, env.PROJECT);
			const inPath = files.filter((f) => pb.globs.some((g) => globMatch(g, f)));
			const r = await chat(
				env.AI,
				model,
				[
					{ role: "system", content: `You are ${agent}, a coding agent. You plan before you write. Be brief.` },
					{
						role: "user",
						content: [
							`Task: ${task.title}\n${task.description}`,
							`Done means every check passes:\n${[...task.done, ...pb.done].map(describe).join("\n")}`,
							`You may change files matching: ${pb.globs.join(", ")}. Files there now: ${inPath.join(", ")}.`,
							"Which files will you change or add? Reply exactly as:\nCLAIM: <comma-separated paths>\nPLAN:\n- <three short steps>",
						].join("\n\n"),
					},
				],
				400,
			);
			tokens += r.tokens;
			const claimed = (/CLAIM:\s*(.+)/i.exec(r.text)?.[1] ?? "")
				.split(",")
				.map((f) => f.trim().replace(/^[`'"]+|[`'".]+$/g, ""))
				.filter((f) => f && pb.globs.some((g) => globMatch(g, f)));
			const want = claimed.length ? claimed : inPath;
			const planText = (/PLAN:\s*([\s\S]+)/i.exec(r.text)?.[1] ?? "- Make the change\n- Add a test").trim().slice(0, 1200);
			await board.registerAgent(agent, model.split("/").pop() ?? "model");
			const c = await claimTask(env, agent, taskId, { files: want, plan: `# Plan: ${agent} (${model})\n\n${planText}\n\nStatus: working\n` });
			return { files: c.files, fork: c.fork, plan: planText, tokens };
		});
		tokens = plan.tokens;

		let feedback = "";
		for (let round = 1; round <= rounds; round++) {
			// 2. Write the change and push it to the fork.
			const wrote = await step.do(`write the change (round ${round})`, { retries: { limit: 2, delay: "10 seconds" } }, async () => {
				const task = (await board.task(taskId))!;
				const project = await loadProject(env);
				const pb = project.playbooks[task.path]!;
				using fork = await getRepo(env, plan.fork);
				const read = async (path: string) => (await (await fork.readFile({ ref: "main", path }))?.text()) ?? null;
				const current = await Promise.all(plan.files.map(async (p) => ({ path: p, text: await read(p) })));
				const context = await Promise.all(["src/data.js", "src/index.js"].filter((p) => !plan.files.includes(p)).map(async (p) => ({ path: p, text: await read(p) })));
				const r = await chat(
					env.AI,
					model,
					[
						{
							role: "system",
							content: `You are ${agent}, a careful coding agent working alone in your own fork of a small Cloudflare Worker app (plain JavaScript ES modules; tests use node:test and node:assert/strict and run with \`node --test\`). Change only your claimed files. Keep existing behaviour working. Write every changed file in full.`,
						},
						{
							role: "user",
							content: [
								`Task: ${task.title}\n${task.description}`,
								`Done means every check passes:\n${[...task.done, ...pb.done].map(describe).join("\n")}`,
								`How a passing candidate is chosen:\n${pb.taste.map((t) => `- ${t}`).join("\n")}`,
								`Your plan:\n${plan.plan}`,
								...current.map((f) => `Your claimed file ${f.path}:\n${f.text === null ? "(does not exist yet)" : "```js\n" + f.text + "\n```"}`),
								...context.filter((f) => f.text).map((f) => `For reference, ${f.path} (do not change it):\n\`\`\`js\n${f.text}\n\`\`\``),
								feedback ? `Gate 1 rejected your last commit:\n${feedback}\nFix exactly that.` : "",
								"You already have every file you need above; there is nothing to explore. Reply in exactly this format and nothing else:\n=== FILE: <path> ===\n<the whole new file>\n=== END ===\n(one block per file you change)\nSUMMARY: <one sentence saying plainly what works now>",
							]
								.filter(Boolean)
								.join("\n\n"),
						},
					],
					6000,
					0.2,
				);
				tokens += r.tokens;
				const reply = parseReply(r.text);
				const files = reply.files.filter((f) => plan.files.includes(f.path) || pb.globs.some((g) => globMatch(g, f.path)));
				if (!files.length) return { pushed: false, summary: "", tokens, note: `no files in the reply (${r.text.slice(0, 120)})` };
				const remote = await remoteFor(env, plan.fork, "write", 600);
				const done = await commitFiles({
					repo: remote,
					files: [...files, { path: ".steward/PLAN.md", content: `# Plan: ${agent} (${model})\n\n${plan.plan}\n\nRound ${round}: ${reply.summary || "changed " + files.map((f) => f.path).join(", ")}\n` }],
					message: `${agent}: ${task.title} (round ${round})`,
					author: { name: agent, email: `${agent}@agents.steward.invalid` },
				});
				return { pushed: true, commit: done.commit, summary: reply.summary || `Changed ${files.map((f) => f.path).join(", ")}.`, tokens, note: "" };
			});
			tokens = wrote.tokens;
			if (!wrote.pushed) {
				await step.do(`note: nothing to push (round ${round})`, async () => {
					await board.note("checked", `${agent} (${model.split("/").pop()}) wrote no usable change: ${wrote.note.slice(0, 160)}`, { task: taskId, agent });
					return true;
				});
				continue;
			}

			// 3. Say done; gate 1 checks the commit.
			await step.do(`say done (round ${round})`, async () => {
				const cand = await board.candidate(`${taskId}/${agent}`);
				if (!cand) throw new Error("no candidate");
				return markDone(env, cand, wrote.summary, tokens, () => {});
			});

			// 4. Wait for gate 1's verdict on this commit.
			let verdict: { status: string; failing: string; open: boolean } = { status: "checking", failing: "", open: true };
			for (let i = 0; i < 72 && !["passed", "bounced", "working", "over-budget", "withdrawn"].includes(verdict.status); i++) {
				await step.sleep(`wait for gate 1 (round ${round}, ${i + 1})`, "10 seconds");
				verdict = await step.do(`read gate 1 (round ${round}, ${i + 1})`, async () => {
					const c = await board.candidate(`${taskId}/${agent}`);
					const d = c?.decision ? await board.decision(c.decision) : null;
					const mine = c && c.commit === wrote.commit && c.checks.length > 0;
					return {
						status: mine ? c!.status : "checking",
						failing: (c?.checks ?? []).filter((k) => !k.ok).map((k) => `- ${k.name}${k.detail ? `: ${k.detail}` : ""}`).join("\n"),
						open: !d || d.status === "open",
					};
				});
			}
			if (verdict.status === "passed" || !verdict.open || round === rounds) break;
			feedback = verdict.failing || "the checks did not pass";
		}
		return { agent, model, tokens };
	}

	/** The scale run's scripted agent: claim one file, write its variant, say done. No model, no retry. */
	private async scripted(step: WorkflowStep, p: RaceParams) {
		const env = this.env;
		const board = boardFor(env);
		const { code, variant } = p.script!;
		const file = `locales/${code}.json`;
		const claimed = await step.do("claim", { retries: { limit: 6, delay: "3 seconds", backoff: "exponential" } }, async () => {
			await board.registerAgent(p.agent, "scripted");
			const c = await claimTask(env, p.agent, p.task, { files: [file], plan: `# Plan: ${p.agent} (scripted, ${variant})\n\nWrite ${file}.\n` });
			return { fork: c.fork };
		});
		await step.do("write and push", { retries: { limit: 6, delay: "3 seconds", backoff: "exponential" } }, async () => {
			const remote = await remoteFor(env, claimed.fork, "write", 300);
			await commitFiles({ repo: remote, files: [{ path: file, content: translation(code, variant) }], message: `${p.agent}: translate the queue (${variant})`, author: { name: p.agent, email: `${p.agent}@agents.steward.invalid` } });
			return true;
		});
		await step.do("say done", { retries: { limit: 6, delay: "3 seconds", backoff: "exponential" } }, async () => {
			const cand = await board.candidate(`${p.task}/${p.agent}`);
			if (!cand) throw new Error("no candidate");
			return markDone(env, cand, `Wrote ${file} with every label translated.`, 0, () => {});
		});
		return { agent: p.agent, variant };
	}
}
