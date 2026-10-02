// Playbooks: one per path of the app, plain YAML in the record repo. Each names the path's steward, the files it
// covers, what "done" means as checks that pass or fail, each fork's budget, the taste rules the judge applies, and
// whether auto-merge may be earned. Parsed with PlatAtlas's YAML-subset reader, so anything outside the subset is
// an error, not a guess.

import { parseThresholds, parseYamlSubset, type Thresholds } from "../../vendor/platatlas/thresholds.ts";

export type DoneCheck =
	| { name: string; kind: "build" }
	| { name: string; kind: "probe"; get: string; expect: Record<string, string>; contains?: string; status: number };

export interface Playbook {
	path: string;
	title: string;
	globs: string[];
	steward: string;
	done: DoneCheck[];
	budget: { minutes: number; tokens: number };
	taste: string[];
	auto_merge: { mode: "off" | "earn"; min_probability: number; until_days: number };
	max_agents: number;
}

export interface Steward {
	key: string;
	name: string;
	role?: string;
}

export interface ProjectConfig {
	app: string;
	worker: string;
	title: string;
	stewards: Steward[];
	judge: { engine: string; agent: string };
}

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const str = (x: unknown, where: string): string => {
	if (typeof x !== "string" || !x.trim()) throw new Error(`${where}: expected text`);
	return x.trim();
};
const num = (x: unknown, where: string, min = 0): number => {
	if (typeof x !== "number" || !Number.isFinite(x) || x < min) throw new Error(`${where}: expected a number of at least ${min}`);
	return x;
};
const strings = (x: unknown, where: string): string[] => {
	if (!Array.isArray(x) || !x.every((s) => typeof s === "string" && s.trim())) throw new Error(`${where}: expected a list of text`);
	return x.map((s) => (s as string).trim());
};

/** `expect: action=hold` or `expect: action=hold, reasons.0.code=bank-details-changed` */
function parseExpect(raw: unknown, where: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of str(raw, where).split(",")) {
		const eq = part.indexOf("=");
		if (eq < 1) throw new Error(`${where}: expected field=value pairs`);
		out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

/** One done check from a parsed map (a playbook's `done:` item, or a task's check sent as JSON). */
export function parseDoneCheck(d: unknown, where: string): DoneCheck {
	if (!isObj(d)) throw new Error(`${where}: expected a map`);
	const name = str(d.name, `${where}.name`);
	if (d.kind === "build") return { name, kind: "build" };
	if (d.kind === "probe" || d.kind === undefined) {
		const get = str(d.get, `${where}.get`);
		if (!get.startsWith("/")) throw new Error(`${where}.get: expected a path starting with /`);
		if (d.expect === undefined && d.contains === undefined) throw new Error(`${where}: a probe needs expect or contains`);
		const expect = d.expect === undefined ? {} : isObj(d.expect) ? Object.fromEntries(Object.entries(d.expect).map(([k, v]) => [k, String(v)])) : parseExpect(d.expect, `${where}.expect`);
		return {
			name,
			kind: "probe",
			get,
			expect,
			...(d.contains === undefined ? {} : { contains: str(d.contains, `${where}.contains`) }),
			status: d.status === undefined ? 200 : num(d.status, `${where}.status`, 100),
		};
	}
	throw new Error(`${where}.kind: expected build or probe`);
}

export function parsePlaybook(text: string, file = "playbook"): Playbook {
	const node = parseYamlSubset(text);
	if (!isObj(node)) throw new Error(`${file}: expected a map`);
	const doneN = node.done;
	if (!Array.isArray(doneN) || !doneN.length) throw new Error(`${file}: done needs at least one check`);
	const done: DoneCheck[] = doneN.map((d, i) => parseDoneCheck(d, `${file} done[${i}]`));
	const budget = isObj(node.budget) ? node.budget : {};
	const am = isObj(node.auto_merge) ? node.auto_merge : {};
	const mode = am.mode ?? "off";
	if (mode !== "off" && mode !== "earn") throw new Error(`${file} auto_merge.mode: expected off or earn`);
	return {
		path: str(node.path, `${file} path`),
		title: str(node.title, `${file} title`),
		globs: strings(node.globs, `${file} globs`),
		steward: str(node.steward, `${file} steward`),
		done,
		budget: { minutes: num(budget.minutes ?? 45, `${file} budget.minutes`, 1), tokens: num(budget.tokens ?? 400000, `${file} budget.tokens`, 1) },
		taste: strings(node.taste, `${file} taste`),
		auto_merge: { mode, min_probability: num(am.min_probability ?? 0.8, `${file} auto_merge.min_probability`), until_days: num(am.until_days ?? 30, `${file} auto_merge.until_days`, 1) },
		max_agents: num(node.max_agents ?? 6, `${file} max_agents`, 1),
	};
}

export function parseProject(text: string): ProjectConfig {
	const node = parseYamlSubset(text);
	if (!isObj(node)) throw new Error("steward.yaml: expected a map");
	const stewardsN = node.stewards;
	if (!Array.isArray(stewardsN) || !stewardsN.length) throw new Error("steward.yaml: stewards needs at least one person");
	const stewards = stewardsN.map((s, i) => {
		if (!isObj(s)) throw new Error(`steward.yaml stewards[${i}]: expected a map`);
		return { key: str(s.key, `stewards[${i}].key`), name: str(s.name, `stewards[${i}].name`), ...(typeof s.role === "string" ? { role: s.role } : {}) };
	});
	const judge = isObj(node.judge) ? node.judge : {};
	return {
		app: str(node.app, "steward.yaml app"),
		worker: str(node.worker ?? node.app, "steward.yaml worker"),
		title: str(node.title ?? node.app, "steward.yaml title"),
		stewards,
		judge: { engine: str(judge.engine ?? "mock", "steward.yaml judge.engine"), agent: str(judge.agent ?? "judge", "steward.yaml judge.agent") },
	};
}

export { parseThresholds, type Thresholds };

/** Does a repo path fall under a glob? Supports `*` (within one folder), `**` (any depth) and plain paths. */
export function globMatch(glob: string, path: string): boolean {
	const re = glob
		.split("/")
		.map((seg) => (seg === "**" ? "(?:.*)" : seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]")))
		.join("/")
		.replace(/\/\(\?:\.\*\)\//g, "(?:/.*/|/)")
		.replace(/^\(\?:\.\*\)\//, "(?:.*/)?")
		.replace(/\/\(\?:\.\*\)$/, "(?:/.*)?");
	return new RegExp(`^${re}$`).test(path);
}
