#!/usr/bin/env node
// Day-one spike: fork the app for one agent, push a commit to the fork with the fork's own token, promote it
// to cand/<task>/<agent> on the app repo, then wait for its Preview to serve that commit.
//
//   node scripts/spike.mjs [--task t-spike] [--agent spike] [--wait 600]
//
// Reads STEWARD_URL and STEWARD_ADMIN_KEY from .dev.vars.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const vars = Object.fromEntries(
	readFileSync(new URL("../.dev.vars", import.meta.url), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const arg = (name, fallback) => {
	const i = process.argv.indexOf(`--${name}`);
	return i > 0 ? process.argv[i + 1] : fallback;
};
const APP = arg("app", "larkspur-ap");
const TASK = arg("task", "t-spike");
const AGENT = arg("agent", "spike");
const WAIT_S = Number(arg("wait", "600"));

async function api(path, payload) {
	const res = await fetch(`${vars.STEWARD_URL}${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${vars.STEWARD_ADMIN_KEY}`, "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	const out = await res.json();
	if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(out)}`);
	return out;
}
const git = (cwd, args, token) =>
	execFileSync("git", [...(token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : []), ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const sec = (ms) => `${(ms / 1000).toFixed(1)} s`;

const t0 = Date.now();
const fork = await api("/api/spike/fork", { app: APP, task: TASK, agent: AGENT, ttl: 3600 });
console.log(`1. fork      ${fork.fork} (${fork.created ? "new" : "existing"}) in ${sec(fork.ms)}`);

const dir = mkdtempSync(join(tmpdir(), "steward-spike-"));
try {
	git(dir, ["clone", "-q", fork.remote, "work"], fork.token);
	const work = join(dir, "work");
	const stamp = new Date().toISOString();
	const rules = join(work, "src", "rules.js");
	writeFileSync(rules, readFileSync(rules, "utf8") + `\n// Spike marker ${stamp}: proves an agent's commit reaches a Preview.\n`);
	git(work, ["add", "-A"]);
	git(work, ["-c", "user.name=Spike agent", "-c", "user.email=spike@steward.invalid", "commit", "-q", "-m", `Spike: marker ${stamp}`]);
	const commit = git(work, ["rev-parse", "HEAD"]);
	const tPush = Date.now();
	git(work, ["push", "-q", "origin", "HEAD:main"], fork.token);
	console.log(`2. push      ${commit.slice(0, 7)} to the fork in ${sec(Date.now() - tPush)} (fork token only)`);

	const tPromote = Date.now();
	const promoted = await api("/api/spike/promote", { app: APP, task: TASK, agent: AGENT });
	console.log(`3. promote   ${promoted.commit.slice(0, 7)} -> ${promoted.branch} in ${sec(Date.now() - tPromote)} (worker ${sec(promoted.ms)})`);
	if (promoted.commit !== commit) throw new Error(`promoted ${promoted.commit}, pushed ${commit}`);

	console.log(`4. preview   waiting up to ${WAIT_S} s for ${promoted.previewUrl}/api/health to serve ${commit.slice(0, 7)}`);
	const tWait = Date.now();
	let last = "";
	while (Date.now() - tWait < WAIT_S * 1000) {
		try {
			const res = await fetch(`${promoted.previewUrl}/api/health`, { headers: { "cache-control": "no-cache" } });
			const text = await res.text();
			last = `${res.status} ${text.slice(0, 160)}`;
			if (res.ok && JSON.parse(text).commit === commit) {
				console.log(`   PASS      Preview serves ${commit.slice(0, 7)}: push-to-preview ${sec(Date.now() - tPush)}, total ${sec(Date.now() - t0)}`);
				process.exit(0);
			}
		} catch (e) {
			last = String(e.message ?? e);
		}
		await new Promise((r) => setTimeout(r, 5000));
	}
	console.log(`   FAIL      no Preview for ${commit.slice(0, 7)} after ${WAIT_S} s; last answer: ${last}`);
	process.exit(1);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
