import { describe, expect, test } from "vitest";
import { diffLines, unified } from "../src/diff";
import { globMatch, parsePlaybook, parseProject, parseThresholds } from "../src/record/playbook";
import { RULES_PLAYBOOK, STEWARD_YAML, THRESHOLDS_YAML, UI_PLAYBOOK, demoHistory } from "../src/demo/record";
import { ClefJudgmentBackend, backendFor, judge, judgeRequest, rubricBackend } from "../src/judge";
import { hedged, pick, runProbe } from "../src/probe";
import { forkName, candidateBranch, previewName, slug } from "../src/artifacts";

import { parseFork, parsePush } from "../src/push";

describe("diff", () => {
	test("a one-line change is one delete and one add", () => {
		const ops = diffLines(["a", "b", "c"], ["a", "B", "c"]);
		expect(ops.map((o) => o.kind)).toEqual(["same", "del", "add", "same"]);
	});
	test("insertions at both ends", () => {
		const ops = diffLines(["x"], ["w", "x", "y"]);
		expect(ops.filter((o) => o.kind === "add").map((o) => o.line)).toEqual(["w", "y"]);
	});
	test("unified counts lines and marks new files", () => {
		const u = unified("src/a.js", null, "one\ntwo\n");
		expect(u.added).toBe(2);
		expect(u.patch).toContain("--- /dev/null");
		expect(u.patch).toContain("+two");
	});
	test("identical files have no patch", () => {
		expect(unified("a", "x\n", "x\n").patch).toBe("");
	});
});

describe("globs and names", () => {
	test("globs", () => {
		expect(globMatch("src/rules.js", "src/rules.js")).toBe(true);
		expect(globMatch("src/rules/**", "src/rules/bank.js")).toBe(true);
		expect(globMatch("src/rules/**", "src/rules/deep/x.js")).toBe(true);
		expect(globMatch("test/**", "test/rules.test.js")).toBe(true);
		expect(globMatch("src/*.js", "src/index.js")).toBe(true);
		expect(globMatch("src/*.js", "src/rules/bank.js")).toBe(false);
		expect(globMatch("src/rules.js", "src/rules.jsx")).toBe(false);
	});
	test("fork names, branches and previews line up", () => {
		expect(forkName("larkspur-ap", "t1", "Ada")).toBe("larkspur-ap--t1--ada");
		expect(candidateBranch("t1", "ada")).toBe("cand/t1/ada");
		expect(previewName("cand/t-spike/spike")).toBe("cand-t-spike-spike");
		expect(() => slug("!!!")).toThrow();
	});
});

describe("record files", () => {
	test("the demo playbooks, project and thresholds parse", () => {
		const rules = parsePlaybook(RULES_PLAYBOOK, "rules");
		expect(rules.path).toBe("rules");
		expect(rules.done.filter((d) => d.kind === "probe")).toHaveLength(4);
		expect(rules.auto_merge).toEqual({ mode: "earn", min_probability: 0.8, until_days: 30 });
		const ui = parsePlaybook(UI_PLAYBOOK, "ui");
		expect(ui.done.find((d) => d.kind === "probe" && d.contains)).toBeTruthy();
		expect(parseProject(STEWARD_YAML).stewards[0]!.name).toBe("Dana");
		expect(parseThresholds(THRESHOLDS_YAML).labels).toEqual(["ship", "pass"]);
	});
	test("a playbook outside the subset is an error, not a guess", () => {
		expect(() => parsePlaybook("path: x\ntitle: y\nsteward: z\nglobs: [a, b]\ndone:\n  - name: b\n    kind: build\ntaste:\n  - t\n")).toThrow();
	});
});

describe("the judge's rubric (mock engine)", () => {
	test("on the rules history it picks the steward's choice, confidently", async () => {
		const h = demoHistory(new Date("2026-10-02T00:00:00Z"));
		const rules = h.records.filter((r) => r.state.path.id === "rules");
		for (const r of rules) {
			const v = await judge(rubricBackend(), r.state);
			expect(v.pick).toBe(r.steward!.pick);
			expect(v.probability).toBeGreaterThanOrEqual(0.8);
			expect(v.generated_by.source).toBe("inferred");
		}
	});
	test("on the ui history the steward overruled it three times", async () => {
		const h = demoHistory(new Date("2026-10-02T00:00:00Z"));
		let differ = 0;
		for (const r of h.records.filter((r) => r.state.path.id === "ui")) {
			const v = await judge(rubricBackend(), r.state);
			if (v.pick !== r.steward!.pick) differ++;
		}
		expect(differ).toBe(3);
	});
	test("Clef's answers become a verdict: its pick, its probabilities, the rule it named", async () => {
		const h = demoHistory(new Date("2026-10-02T00:00:00Z"));
		const state = h.records.find((r) => r.state.path.id === "rules")!.state;
		const { options } = judgeRequest(state);
		const [first, second] = [...options.keys()];
		const calls: { model: string; inputs: { model: string; questions: Record<string, unknown> } }[] = [];
		const runner = {
			run: async (model: string, inputs: unknown) => {
				calls.push({ model, inputs: inputs as never });
				return { model: "clef", answers: { pick: { type: "choice", choice: second, probabilities: { [first!]: 0.2, [second!]: 0.8 }, confidence: 0.6 }, rule: { type: "choice", choice: "r2", probabilities: { r1: 0.3, r2: 0.7 }, confidence: 0.4 } }, usage: { input_tokens: 900, output_tokens: 0 } };
			},
		};
		const v = await judge(new ClefJudgmentBackend(runner), state);
		expect(calls[0]!.model).toBe("@cf/cloudflare/clef");
		expect(Object.keys(calls[0]!.inputs.questions)).toEqual(["pick", "rule"]);
		expect(v.pick).toBe(options.get(second!));
		expect(v.probability).toBe(0.8);
		expect(v.ruleText).toBe(state.path.taste[1]);
		expect(v.generated_by).toMatchObject({ backend: "clef", model: "clef", source: "inferred", probability_basis: "calibrated" });
	});
	test("the clef engines need Workers AI, and say so", () => {
		expect(() => backendFor("clef", {})).toThrow(/AI binding/);
		expect(backendFor("clef-flash", { AI: { run: async () => ({}) } }).name).toBe("clef");
	});
	test("only gate-1 survivors are options", () => {
		const h = demoHistory();
		const state = structuredClone(h.records[0]!.state);
		state.candidates[0]!.gate1.passed = false;
		const { options } = judgeRequest(state);
		expect([...options.values()]).not.toContain(state.candidates[0]!.id);
	});
});

describe("done checks", () => {
	test("dotted paths reach into arrays", () => {
		expect(pick({ reasons: [{ code: "x" }] }, "reasons.0.code")).toBe("x");
		expect(pick({}, "a.b")).toBeUndefined();
	});
	test("a probe passes only when every field matches", async () => {
		const fake = (async () => new Response(JSON.stringify({ action: "hold", reasons: [{ code: "bank-details-changed" }] }))) as unknown as typeof fetch;
		const ok = await runProbe("https://p.example", { name: "held", kind: "probe", get: "/x", expect: { action: "hold", "reasons.0.code": "bank-details-changed" }, status: 200 }, fake);
		expect(ok.ok).toBe(true);
		const bad = await runProbe("https://p.example", { name: "held", kind: "probe", get: "/x", expect: { action: "pay" }, status: 200 }, fake);
		expect(bad.ok).toBe(false);
		expect(bad.detail).toContain("expected pay");
	});
	test("hedged summaries are caught", () => {
		expect(hedged("I think this should work for most cases.")).toBeTruthy();
		expect(hedged("Holds INV-1042 and INV-1047; tests cover both; INV-1046 still pays.")).toBeNull();
	});
});

describe("push events", () => {
	test("the gate reads the envelope Artifacts sends", () => {
		const raw = { id: "be0a", type: "cf.artifacts.repo.pushed", source: { namespace: "steward", repoName: "larkspur-ap--t-spike--spike" }, payload: { ref: "refs/heads/main", before: "e2ac", after: "4bc8", commits: [{ id: "4bc8", message: "Spike", author: { email: "spike@steward.invalid" } }] } };
		const push = parsePush(raw)!;
		expect(push).toMatchObject({ repo: "larkspur-ap--t-spike--spike", ref: "refs/heads/main", after: "4bc8", author: "spike@steward.invalid" });
		expect(parseFork(push.repo)).toEqual({ app: "larkspur-ap", task: "t-spike", agent: "spike" });
		expect(parseFork("larkspur-ap")).toBeNull();
		expect(parsePush({ nothing: true })).toBeNull();
	});
});

describe("model agents", () => {
	test("file blocks and the summary come out of a reply, fences or not", async () => {
		const { parseReply } = await import("../src/agents/reply");
		const r = parseReply("Sure.\n=== FILE: src/rules.js ===\n```js\nexport const A = 1;\n```\n=== END ===\n=== FILE: test/rules.test.js ===\nimport x from 'y';\n=== END ===\nSUMMARY: Holds the bank-change invoices.\nextra");
		expect(r.files.map((f) => f.path)).toEqual(["src/rules.js", "test/rules.test.js"]);
		expect(r.files[0]!.content).toBe("export const A = 1;\n");
		expect(r.summary).toBe("Holds the bank-change invoices.");
	});
	test("a block with no END line still counts", async () => {
		const { parseReply } = await import("../src/agents/reply");
		const r = parseReply("=== FILE: src/rules.js ===\nexport const B = 2;\n=== FILE: test/a.test.js ===\ntest();\nSUMMARY: done.");
		expect(r.files.map((f) => [f.path, f.content])).toEqual([["src/rules.js", "export const B = 2;\n"], ["test/a.test.js", "test();\n"]]);
	});
});

describe("the scale run's translations", () => {
	test("the clean and wordy variants pass the file check; the broken ones fail it, each for its reason", async () => {
		const { translation } = await import("../src/demo/locales");
		const { runFileCheck } = await import("../src/probe");
		const { readFileSync } = await import("node:fs");
		const en = readFileSync(new URL("../demo/larkspur-ap/locales/en.json", import.meta.url), "utf8");
		const check = { name: "fr", kind: "file" as const, file: "locales/fr.json", like: "locales/en.json" };
		const run = (variant: Parameters<typeof translation>[1]) => runFileCheck(async (p) => (p === "locales/en.json" ? en : translation("fr", variant)), check);
		expect((await run("good")).ok).toBe(true);
		expect((await run("wordy")).ok).toBe(true);
		expect((await run("missing")).detail).toContain("missing held_note");
		expect((await run("empty")).detail).toContain("empty decision");
		expect((await run("invalid")).detail).toContain("not valid JSON");
	});
	test("the rubric prefers the shorter wording on the locales history", async () => {
		const h = demoHistory(new Date("2026-10-02T00:00:00Z"));
		for (const r of h.records.filter((x) => x.state.path.id === "locales")) {
			const v = await judge(rubricBackend(), r.state);
			expect(v.pick).toBe(r.steward!.pick);
			expect(v.probability).toBeGreaterThanOrEqual(0.8);
		}
	});
});
