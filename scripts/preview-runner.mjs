#!/usr/bin/env node
// A stand-in for Workers Builds: builds a Preview for every candidate gate 1 is waiting on, and deploys main to
// production whenever it moves. Gate 1 only needs the
// candidate's Preview to serve its commit, so any CI can do this job; Workers Builds does it inside Cloudflare once
// the app's Worker is connected to its Artifacts repo. Use this until then, or on an account without Builds.
//
//   node scripts/preview-runner.mjs            (needs wrangler logged in; one build at a time)
//
// Per candidate: clone cand/<task>/<agent> from the app repo; refuse it if it changed files outside its task's path;
// run the build and tests inside a bubblewrap sandbox (no network, read-only root, home hidden, only the build folder
// writable), because an agent's tests are code nobody has read; then `wrangler preview` (which bundles but never runs
// the candidate's code). A failing build makes no Preview and is reported to Steward, which bounces it at once.
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

let cached = { token: "", until: 0 };
function token() {
	if (cached.until > Date.now() + 60_000) return cached.token;
	const out = sh("npx", ["wrangler", "artifacts", "repos", "issue-token", APP, "--namespace", NAMESPACE, "--scope", "read", "--ttl", "900", "--json"], { cwd: root });
	cached = { token: JSON.parse(out).plaintext, until: Date.now() + 840_000 };
	return cached.token;
}
// The app repo's git remote, as Artifacts reports it for this account (or REMOTE to point elsewhere).
const REMOTE = process.env.REMOTE ?? JSON.parse(sh("npx", ["wrangler", "artifacts", "repos", "get", APP, "--namespace", NAMESPACE, "--json"], { cwd: root })).remote;

/** Production: when main moves, build it and `wrangler deploy` (what Workers Builds does on the production branch). */
async function deployMain(prodUrl) {
	const head = sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token()}`, "ls-remote", REMOTE, "refs/heads/main"]).split(/\s+/)[0];
	let live = "";
	try {
		live = (await (await fetch(`${prodUrl}/api/health`, { headers: { "cache-control": "no-cache" } })).json()).commit;
	} catch {}
	if (!head || head === live) return;
	const t0 = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "steward-prod-"));
	try {
		sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token()}`, "clone", "-q", "--depth", "1", REMOTE, dir]);
		const env = { ...process.env, WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: head, WORKERS_CI_BRANCH: "main" };
		sandboxedBuild(dir, env);
		if (existsSync(deps)) symlinkSync(deps, join(dir, "node_modules"));
		sh("npx", ["wrangler", "deploy"], { cwd: dir, env });
		console.log(`  deployed main ${head.slice(0, 7)} to production in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	} catch (e) {
		console.log(`  FAIL deploying main ${head.slice(0, 7)}: ${String(e.message).slice(0, 200)}`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

const HOME = process.env.HOME;
const NODE_DIR = process.execPath.replace(/\/bin\/node$/, "");
/** The build and tests, sandboxed: nothing but this folder is writable, and there is no network. */
function sandboxedBuild(dir, env) {
	const args = [
		// Order matters: later mounts cover earlier ones, so /tmp and HOME are emptied before the build folder
		// (which lives under /tmp) and node are bound back in.
		"--ro-bind", "/", "/",
		"--tmpfs", "/tmp",
		"--tmpfs", HOME,
		"--ro-bind", NODE_DIR, NODE_DIR,
		"--bind", dir, dir,
		"--dev", "/dev",
		"--proc", "/proc",
		"--unshare-net",
		"--unshare-pid",
		"--die-with-parent",
		"--new-session",
		"--chdir", dir,
		"--setenv", "PATH", `${NODE_DIR}/bin:/usr/bin:/bin`,
		"--setenv", "HOME", dir,
		...Object.entries(env).filter(([k]) => k.startsWith("WORKERS_CI")).flatMap(([k, v]) => ["--setenv", k, v]),
		"node", "-e", "require('child_process').execSync('node scripts/build-info.mjs && node --test', { stdio: 'inherit' })",
	];
	return sh("bwrap", args, { cwd: dir });
}

/** Files a candidate changed against the commit it started from (needs main fetched too). */
function changedFiles(dir) {
	const base = sh("git", ["merge-base", "origin/main", "HEAD"], { cwd: dir }).trim();
	return sh("git", ["diff", "--name-only", base, "HEAD"], { cwd: dir }).split("\n").filter(Boolean);
}

const globRe = (glob) =>
	new RegExp(
		"^" +
			glob
				.split("/")
				.map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")))
				.join("/")
				.replace(/\/\(\?:\.\*\)$/, "(?:/.*)?") +
			"$",
	);

async function report(commit, ok, detail) {
	await fetch(`${vars.STEWARD_URL}/api/builds`, {
		method: "POST",
		headers: { authorization: `Bearer ${vars.STEWARD_ADMIN_KEY}`, "content-type": "application/json" },
		body: JSON.stringify({ commit, ok, detail }),
	}).catch(() => {});
}

async function build(c) {
	const t0 = Date.now();
	const dir = mkdtempSync(join(tmpdir(), "steward-preview-"));
	try {
		sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token()}`, "clone", "-q", "-b", c.branch, REMOTE, dir]);
		sh("git", ["-c", `http.extraHeader=Authorization: Bearer ${token()}`, "fetch", "-q", "origin", "main:refs/remotes/origin/main"], { cwd: dir });
		const head = sh("git", ["rev-parse", "HEAD"], { cwd: dir }).trim();
		if (head !== c.commit) return console.log(`  skip ${c.id}: branch is at ${head.slice(0, 7)}, gate waits for ${c.commit.slice(0, 7)}`);
		const globs = c.globs ?? [];
		const outside = changedFiles(dir).filter((f) => !f.startsWith(".steward/") && !globs.some((g) => globRe(g).test(f)));
		if (outside.length) {
			await report(c.commit, false, `changed files outside its path, so nothing was built: ${outside.join(", ")}`);
			return console.log(`  REFUSED ${c.id} ${c.commit.slice(0, 7)}: outside its path: ${outside.join(", ")}`);
		}
		const env = { ...process.env, WORKERS_CI: "1", WORKERS_CI_COMMIT_SHA: c.commit, WORKERS_CI_BRANCH: c.branch };
		try {
			sandboxedBuild(dir, env);
		} catch (e) {
			const why = String(e.stdout).split("\n").filter((l) => /^not ok|# fail/i.test(l.trim())).slice(0, 5).join("; ") || "npm run build exited non-zero";
			await report(c.commit, false, `npm run build: ${why}`);
			return console.log(`  FAIL ${c.id} ${c.commit.slice(0, 7)}: build or tests failed, no Preview: ${why}`);
		}
		if (existsSync(deps) && !existsSync(join(dir, "node_modules"))) symlinkSync(deps, join(dir, "node_modules"));
		const out = JSON.parse(sh("npx", ["wrangler", "preview", "--name", previewName(c.branch), "--json"], { cwd: dir, env }));
		console.log(`  built ${c.id} ${c.commit.slice(0, 7)} -> ${out.preview?.urls?.[0]} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

console.log(`preview runner: watching ${vars.STEWARD_URL} for candidates gate 1 is checking, and main for production`);
let loops = 0;
for (;;) {
	if (loops++ % 3 === 0) await deployMain(`https://${APP}.craigm26.workers.dev`).catch((e) => console.log(`  prod check failed: ${e.message}`));
	try {
		const board = await (await fetch(`${vars.STEWARD_URL}/api/board`)).json();
		const waiting = (board.candidates ?? []).filter((c) => c.status === "checking" && c.commit && !built.has(c.commit));
		if (waiting.length) {
			const paths = await (await fetch(`${vars.STEWARD_URL}/api/paths`)).json();
			for (const c of waiting) {
				built.add(c.commit);
				const task = board.tasks.find((t) => t.id === c.task);
				c.globs = paths.paths.find((p) => p.path === task?.path)?.globs ?? [];
				await build(c);
			}
		}
	} catch (e) {
		console.log(`  error: ${e.message}`);
	}
	await new Promise((r) => setTimeout(r, 4000));
}
