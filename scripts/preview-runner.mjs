#!/usr/bin/env node
// A stand-in for Workers Builds: builds a Preview for every candidate gate 1 is waiting on. Gate 1 only needs the
// candidate's Preview to serve its commit, so any CI can do this job; Workers Builds does it inside Cloudflare once
// the app's Worker is connected to its Artifacts repo. Use this until then, or on an account without Builds.
//
//   node scripts/preview-runner.mjs            (needs wrangler logged in; one build at a time)
//
// Per candidate: clone cand/<task>/<agent> from the app repo, run `npm run build` (writes the commit, runs the
// tests), then `wrangler preview --name <branch as a name>`. A failing build makes no Preview, which gate 1 reports.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const APP = process.env.APP ?? "larkspur-ap";
const NAMESPACE = process.env.NAMESPACE ?? "steward";
const deps = join(root, "demo", APP, "node_modules");
const built = new Set();
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
const previewName = (branch) => branch.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);

function token() {
	const out = sh("npx", ["wrangler", "artifacts", "repos", "issue-token", APP, "--namespace", NAMESPACE, "--scope", "read", "--ttl", "900", "--json"], { cwd: root });
	return JSON.parse(out).plaintext;
}

async function build(c) {
	const t0 = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "steward-preview-"));
	try {
		const remote = `https://71d59adbd067633aca3e95f915fbf2b4.artifacts.cloudflare.net/git/${NAMESPACE}/${APP}.git`;
		sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token()}`, "clone", "-q", "--depth", "1", "-b", c.branch, remote, dir]);
		const head = sh("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
		if (head !== c.commit) return console.log(`  skip ${c.id}: branch is at ${head.slice(0, 7)}, gate waits for ${c.commit.slice(0, 7)}`);
		if (existsSync(deps) && !existsSync(join(dir, "node_modules"))) symlinkSync(deps, join(dir, "node_modules"));
		const env = { ...process.env, WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: c.commit, WORKERS_CI_BRANCH: c.branch };
		try {
			sh("npm", ["run", "build"], { cwd: dir, env });
		} catch (e) {
			return console.log(`  FAIL ${c.id} ${c.commit.slice(0, 7)}: build or tests failed, no Preview\n${String(e.stdout).split("\n").filter((l) => /not ok|fail/i.test(l)).slice(0, 5).join("\n")}`);
		}
		const out = JSON.parse(sh("npx", ["wrangler", "preview", "--name", previewName(c.branch), "--json"], { cwd: dir, env }));
		console.log(`  built ${c.id} ${c.commit.slice(0, 7)} -> ${out.preview?.urls?.[0]} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(`preview runner: watching ${vars.STEWARD_URL} for candidates gate 1 is checking`);
for (;;) {
	try {
		const board = await (await fetch(`${vars.STEWARD_URL}/api/board`)).json();
		for (const c of board.candidates ?? []) {
			if (c.status !== "checking" || !c.commit || built.has(c.commit)) continue;
			built.add(c.commit);
			await build(c);
		}
	} catch (e) {
		console.log(`  error: ${e.message}`);
	}
	await new Promise((r) => setTimeout(r, 4000));
}
