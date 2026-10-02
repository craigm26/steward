#!/usr/bin/env node
// steward-agent: how any agent (a coding model, a script, a person) works with Steward. No dependencies.
//
//   STEWARD_URL=https://steward.example.workers.dev STEWARD_AGENT_KEY=sa_... steward-agent <command>
//
//   tasks                                  open tasks, with their path's done checks and who has claimed what
//   claim <task> [--files a,b] [--dir d]   claim files; Steward forks the app for you alone and returns a token
//                                          for that fork only. With --dir, clones the fork there, ready to push.
//   status <task>                          your candidate: gate 1's checks, its Preview, any bounce
//   done <task> --summary "..." [--tokens N]  say it works. A hedged summary counts as not done.
//   withdraw <task>                        give the task up; your fork closes
//
// Admin (STEWARD_ADMIN_KEY instead of an agent key):  register <name>  prints a new agent key.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function client({ url = process.env.STEWARD_URL, key = process.env.STEWARD_AGENT_KEY ?? process.env.STEWARD_ADMIN_KEY } = {}) {
	if (!url) throw new Error("set STEWARD_URL");
	const call = async (method, path, body) => {
		const res = await fetch(`${url.replace(/\/+$/, "")}${path}`, {
			method,
			headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
			body: body ? JSON.stringify(body) : undefined,
		});
		const text = await res.text();
		let out;
		try {
			out = JSON.parse(text);
		} catch {
			out = { error: text };
		}
		if (!res.ok) {
			const err = new Error(`${method} ${path}: ${res.status} ${out.error ?? text}`);
			err.status = res.status;
			err.body = out;
			throw err;
		}
		return out;
	};
	return {
		tasks: (status = "open") => call("GET", `/api/tasks?status=${status}`),
		task: (id) => call("GET", `/api/tasks/${id}`),
		claim: (task, files, plan) => call("POST", `/api/tasks/${task}/claim`, { files, plan }),
		status: (task) => call("GET", `/api/tasks/${task}/me`),
		done: (task, summary, tokens_used) => call("POST", `/api/tasks/${task}/done`, { summary, tokens_used }),
		withdraw: (task) => call("POST", `/api/tasks/${task}/withdraw`, {}),
		register: (name, kind = "agent") => call("POST", "/api/agents", { name, kind }),
		call,
	};
}

/** Clones a claimed fork into `dir`, with the fork token set for this repo only (git's http.extraHeader). */
export function cloneFork(claim, dir, { name, email } = {}) {
	const header = `Authorization: Bearer ${claim.token}`;
	execFileSync("git", ["-c", `http.extraHeader=${header}`, "clone", "-q", claim.remote, dir], { stdio: "inherit" });
	execFileSync("git", ["config", "http.extraHeader", header], { cwd: dir });
	if (name) execFileSync("git", ["config", "user.name", name], { cwd: dir });
	if (email) execFileSync("git", ["config", "user.email", email], { cwd: dir });
	return dir;
}

const arg = (name) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : undefined;
};

async function main() {
	const [cmd, a1] = process.argv.slice(2);
	const s = client();
	const print = (x) => console.log(JSON.stringify(x, null, 2));
	switch (cmd) {
		case "tasks":
			return print(await s.tasks());
		case "claim": {
			const files = arg("files")?.split(",").map((f) => f.trim()).filter(Boolean);
			const c = await s.claim(a1, files);
			const dir = arg("dir");
			if (dir) {
				if (existsSync(dir)) throw new Error(`${dir} exists`);
				cloneFork(c, dir, { name: arg("name"), email: arg("email") });
			}
			return print({ ...c, token: `${c.token.slice(0, 10)}… (set in ${dir ?? "nowhere: pass --dir to clone"})` });
		}
		case "status":
			return print(await s.status(a1));
		case "done":
			return print(await s.done(a1, arg("summary") ?? "", Number(arg("tokens") ?? 0)));
		case "withdraw":
			return print(await s.withdraw(a1));
		case "register":
			return print(await s.register(a1, arg("kind") ?? "agent"));
		default:
			console.log("usage: steward-agent tasks | claim <task> [--files a,b] [--dir d] | status <task> | done <task> --summary \"...\" | withdraw <task> | register <name>");
			process.exit(2);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main().catch((e) => {
		console.error(e.message);
		process.exit(1);
	});
}
