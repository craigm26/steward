// Records the commit being built in src/build-info.js. Workers Builds sets WORKERS_CI_COMMIT_SHA and
// WORKERS_CI_BRANCH; outside it, git is asked instead.
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

function git(args) {
	try {
		return execSync(`git ${args}`, { encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

const build = {
	commit: process.env.WORKERS_CI_COMMIT_SHA || git("rev-parse HEAD") || "dev",
	branch: process.env.WORKERS_CI_BRANCH || git("rev-parse --abbrev-ref HEAD") || "dev",
	builtAt: new Date().toISOString(),
};

writeFileSync(
	new URL("../src/build-info.js", import.meta.url),
	"// Rewritten by scripts/build-info.mjs during each Workers Build, so a preview can say which commit it serves.\n" +
		`export const BUILD = ${JSON.stringify(build)};\n`,
);
console.log(`build-info: ${build.branch} @ ${build.commit}`);
