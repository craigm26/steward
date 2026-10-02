// The project as the record repo describes it: steward.yaml, thresholds.yaml and every playbook, read at one
// commit and cached briefly per isolate.

import { parsePlaybook, parseProject, parseThresholds, type Playbook, type ProjectConfig, type Thresholds } from "./record/playbook";
import { RecordStore } from "./record/store";
import type { ArtifactsEnv } from "./artifacts";

export interface Project {
	head: string | null;
	config: ProjectConfig;
	thresholds: Thresholds;
	playbooks: Record<string, Playbook>;
	grants: string;
}

let cache: { at: number; repo: string; project: Project } | null = null;
const TTL_MS = 15_000;

export async function loadProject(env: ArtifactsEnv & { RECORD_REPO: string }, fresh = false): Promise<Project> {
	if (!fresh && cache && cache.repo === env.RECORD_REPO && Date.now() - cache.at < TTL_MS) return cache.project;
	const store = new RecordStore(env, env.RECORD_REPO);
	const names = (await store.list("playbooks")).filter((e) => e.type === "blob" && e.name.endsWith(".yaml")).map((e) => e.name);
	const snap = await store.snapshot(["steward.yaml", "thresholds.yaml", "preferences/grants.jsonl", ...names.map((n) => `playbooks/${n}`)]);
	if (!snap.files["steward.yaml"]) throw new Error(`${env.RECORD_REPO} has no steward.yaml; seed the record first`);
	const playbooks: Record<string, Playbook> = {};
	for (const n of names) {
		const pb = parsePlaybook(snap.files[`playbooks/${n}`] ?? "", `playbooks/${n}`);
		playbooks[pb.path] = pb;
	}
	const project: Project = {
		head: snap.head,
		config: parseProject(snap.files["steward.yaml"]!),
		thresholds: parseThresholds(snap.files["thresholds.yaml"] ?? ""),
		playbooks,
		grants: snap.files["preferences/grants.jsonl"] ?? "",
	};
	cache = { at: Date.now(), repo: env.RECORD_REPO, project };
	return project;
}

export function forgetProject() {
	cache = null;
}
