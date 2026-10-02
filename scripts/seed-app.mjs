#!/usr/bin/env node
// One-time setup of the demo on your own Cloudflare account, after `npx wrangler deploy` of Steward itself:
//   1. creates the Artifacts namespace (with a jurisdiction, US by default) unless it exists
//   2. creates the app repo, pushes demo/larkspur-ap as its first commit and tags it `seed` (resets go back to it)
//   3. deploys the demo app's Worker once, so Workers Builds can connect to it
//   4. seeds the decision record through Steward (playbooks, thresholds, the synthetic history)
//
//   node scripts/seed-app.mjs [--jurisdiction us|eu]
// Reads STEWARD_URL and STEWARD_ADMIN_KEY from .dev.vars; the namespace and repo names from wrangler.jsonc.
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const vars = Object.fromEntries(
	readFileSync(join(root, ".dev.vars"), "utf8")
		.split("\n")
		.filter((l) => l.includes("="))
		.map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\s*\/\/.*$/gm, ""));
const NAMESPACE = config.artifacts[0].namespace;
const APP = config.vars.PROJECT;
const arg = (n, d) => {
	const i = process.argv.indexOf(`--${n}`);
	return i > 0 ? process.argv[i + 1] : d;
};
const JURISDICTION = arg("jurisdiction", "us");
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], cwd: root, ...opts });
const wrangler = (...args) => sh("npx", ["wrangler", ...args]);

// The account and an API token from wrangler's own login.
const whoami = wrangler("whoami");
const account = /([0-9a-f]{32})/.exec(whoami)?.[1];
if (!account) throw new Error("wrangler is not logged in (run npx wrangler login)");
const tokenFile = join(process.env.HOME, ".wrangler/config/default.toml");
const oauth = /^oauth_token = "(.*)"$/m.exec(readFileSync(tokenFile, "utf8"))?.[1];

// 1. Namespace with a jurisdiction. Creating a repo would create the namespace too, but without one.
const namespaces = wrangler("artifacts", "namespaces", "list", "--json");
if (!namespaces.includes(`"${NAMESPACE}"`)) {
	const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/artifacts/namespaces`, {
		method: "POST",
		headers: { authorization: `Bearer ${oauth}`, "content-type": "application/json" },
		body: JSON.stringify({ namespace: NAMESPACE, jurisdiction: JURISDICTION }),
	});
	const out = await res.json();
	if (!out.success) throw new Error(`could not create namespace ${NAMESPACE}: ${JSON.stringify(out.errors)}`);
	console.log(`1. created namespace ${NAMESPACE} (${JURISDICTION})`);
} else console.log(`1. namespace ${NAMESPACE} exists`);

// 2. The app repo, seeded and tagged.
let created;
try {
	created = JSON.parse(wrangler("artifacts", "repos", "create", APP, "--namespace", NAMESPACE, "--default-branch", "main", "--description", "Larkspur Garden Co. accounts payable (fictional demo app)", "--json"));
	console.log(`2. created repo ${APP}`);
} catch {
	console.log(`2. repo ${APP} exists; pushing the seed only if it is empty`);
}
const write = JSON.parse(wrangler("artifacts", "repos", "issue-token", APP, "--namespace", NAMESPACE, "--scope", "write", "--ttl", "600", "--json")).plaintext;
const remote = created?.remote ?? JSON.parse(wrangler("artifacts", "repos", "get", APP, "--namespace", NAMESPACE, "--json")).remote;
const auth = ["-c", `http.extraHeader=Authorization: Bearer ${write}`];
const heads = sh("git", [...auth, "ls-remote", remote]);
const dir = mkdtempSync(join(tmpdir(), "steward-seed-"));
try {
	cpSync(join(root, "demo", APP), dir, { recursive: true, filter: (p) => !/node_modules|\.wrangler/.test(p) });
	if (!heads.includes("refs/heads/main")) {
		sh("git", ["init", "-q", "-b", "main"], { cwd: dir });
		sh("git", ["add", "-A"], { cwd: dir });
		sh("git", ["-c", "user.name=Steward setup", "-c", "user.email=setup@steward.invalid", "commit", "-q", "-m", "Larkspur AP: the demo app as seeded"], { cwd: dir });
		sh("git", ["tag", "seed"], { cwd: dir });
		sh("git", [...auth, "push", "-q", remote, "main", "refs/tags/seed"], { cwd: dir });
		console.log("   pushed the demo app to main and tagged it seed");
	}
	// 3. Deploy the app's Worker once (Workers Builds connects to an existing Worker, then deploys main itself).
	sh("npm", ["install", "--no-audit", "--no-fund"], { cwd: dir });
	sh("npx", ["wrangler", "deploy"], { cwd: dir });
	console.log(`3. deployed the ${APP} Worker`);
} finally {
	rmSync(dir, { recursive: true, force: true });
}

// 4. The decision record, through Steward.
const seeded = await fetch(`${vars.STEWARD_URL}/api/admin/seed-record`, { method: "POST", headers: { authorization: `Bearer ${vars.STEWARD_ADMIN_KEY}`, "content-type": "application/json" }, body: "{}" });
console.log(`4. record: ${JSON.stringify(await seeded.json())}`);
console.log(`
Next, once, in the Cloudflare dashboard: Workers & Pages > ${APP} > Settings > Builds > Connect, choose the
Artifacts namespace ${NAMESPACE} and the repo ${APP}, set the build command to "npm run build", save, and turn on
Builds for Preview branches. Until then, node scripts/preview-runner.mjs builds Previews from this machine.`);
