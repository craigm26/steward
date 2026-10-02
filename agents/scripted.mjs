#!/usr/bin/env node
// Scripted agents: deterministic stand-ins that exercise the whole loop (claims, forks, gate 1, the decision)
// without a model. They are labeled scripted everywhere they appear. Each writes one known variant of the demo task
// "hold any invoice whose vendor bank details changed" and pushes it to its own fork.
//
//   node agents/scripted.mjs --task t1 --agents ada:small,brook:module,cole:wrong
//
// Variants: small (a rule in rules.js plus a test), module (a new rules/bank.js with a window setting plus a test),
// wrong (holds every bank change, however old, and claims done anyway: gate 1 bounces it), hedge (correct, but its
// summary hedges). Reads STEWARD_URL and STEWARD_ADMIN_KEY from .dev.vars to register the agents.
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { client, cloneFork } from "./steward-agent.mjs";

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
const TASK = arg("task");
const SPECS = arg("agents", "ada:small,brook:module,cole:wrong").split(",").map((s) => s.split(":"));
const SELFTEST = process.argv.includes("--selftest");
if (!TASK && !SELFTEST) throw new Error("--task is required");

const BANK_RULE_SMALL = `
/** Pay only the account on file, and not while a bank change is fresh: both are how invoice fraud starts. */
export const BANK_CHANGE_WINDOW_DAYS = 30;

export function bankDetailsChanged(invoice, ctx) {
	const vendor = ctx.vendors.get(invoice.vendorId);
	if (!vendor) return null;
	if (invoice.payToAccount !== vendor.accountOnFile) {
		return { code: "bank-details-changed", message: \`Pays to ••\${invoice.payToAccount}, but the account on file is ••\${vendor.accountOnFile}\` };
	}
	if (vendor.bankChangedAt) {
		const days = (Date.parse(ctx.asOf) - Date.parse(vendor.bankChangedAt)) / 86400000;
		if (days <= BANK_CHANGE_WINDOW_DAYS) {
			return { code: "bank-details-changed", message: \`The account on file changed from ••\${vendor.previousAccount} to ••\${vendor.accountOnFile} on \${vendor.bankChangedAt}\` };
		}
	}
	return null;
}
`;

const SMALL_TEST = `
test("an invoice to a recently changed bank account is held", () => {
	assert.equal(decision("INV-1042").action, "hold");
	assert.ok(codes("INV-1042").includes("bank-details-changed"));
});

test("an invoice that pays a different account from the one on file is held", () => {
	assert.equal(decision("INV-1047").action, "hold");
});

test("a bank change older than the window is not held for it", () => {
	assert.equal(decision("INV-1046").action, "pay");
});
`;

const MODULE_FILE = `// Bank-detail checks: the classic invoice fraud is a vendor's account quietly swapped for someone else's.

/** How long after a vendor's bank details change its invoices wait for a person. */
export const SETTINGS = { windowDays: 30 };

function daysBetween(from, to) {
	return Math.floor((Date.parse(to) - Date.parse(from)) / 86400000);
}

/** Hold an invoice whose bank details changed: a fresh change on the vendor, or a pay-to account not on file. */
export function bankDetailsChanged(invoice, ctx, settings = SETTINGS) {
	const vendor = ctx.vendors.get(invoice.vendorId);
	if (!vendor) {
		return { code: "bank-details-changed", message: "Vendor not found in the vendor master" };
	}
	const onFile = vendor.accountOnFile;
	if (invoice.payToAccount !== onFile) {
		return {
			code: "bank-details-changed",
			message: \`Invoice asks to pay ••\${invoice.payToAccount}; the vendor master says ••\${onFile}\`,
		};
	}
	if (vendor.bankChangedAt) {
		const age = daysBetween(vendor.bankChangedAt, ctx.asOf);
		if (age >= 0 && age <= settings.windowDays) {
			return {
				code: "bank-details-changed",
				message: \`Bank details changed \${age} day(s) ago (••\${vendor.previousAccount} to ••\${onFile}); confirm by phone before paying\`,
			};
		}
	}
	return null;
}
`;

const MODULE_TEST = `import { bankDetailsChanged, SETTINGS } from "../src/rules/bank.js";

test("bank rule: a fresh change holds, an old one does not", () => {
	assert.equal(decision("INV-1042").action, "hold");
	assert.equal(decision("INV-1046").action, "pay");
});

test("bank rule: a pay-to account not on file holds", () => {
	assert.ok(codes("INV-1047").includes("bank-details-changed"));
});

test("bank rule: the window is a setting", () => {
	const inv = INVOICES.find((i) => i.id === "INV-1046");
	assert.ok(bankDetailsChanged(inv, ctx, { windowDays: 365 }));
	assert.equal(SETTINGS.windowDays, 30);
});
`;

const WRONG_RULE = `
export function bankDetailsChanged(invoice, ctx) {
	const vendor = ctx.vendors.get(invoice.vendorId);
	if (vendor && vendor.bankChangedAt) return { code: "bank-details-changed", message: "Bank details changed" };
	return null;
}
`;

function addToRules(src, fnSrc, importLine) {
	let out = src.replace("export const RULES = [approvalLimit, duplicateInvoice];", "export const RULES = [approvalLimit, duplicateInvoice, bankDetailsChanged];");
	if (importLine) out = importLine + "\n" + out;
	else out = out.replace("export const RULES =", fnSrc.trim() + "\n\nexport const RULES =");
	return out;
}

const VARIANTS = {
	small: {
		files: ["src/rules.js", "test/rules.test.js"],
		apply(dir) {
			const rules = join(dir, "src/rules.js");
			writeFileSync(rules, addToRules(readFileSync(rules, "utf8"), BANK_RULE_SMALL));
			const t = join(dir, "test/rules.test.js");
			writeFileSync(t, readFileSync(t, "utf8") + SMALL_TEST);
		},
		summary: "Holds INV-1042 (account changed 5 days ago) and INV-1047 (pays an account not on file) with reason bank-details-changed; INV-1046's 120-day-old change still pays. Three tests cover the cases; all tests pass.",
	},
	module: {
		files: ["src/rules.js", "src/rules/bank.js", "test/rules.test.js"],
		apply(dir) {
			mkdirSync(join(dir, "src/rules"), { recursive: true });
			writeFileSync(join(dir, "src/rules/bank.js"), MODULE_FILE);
			const rules = join(dir, "src/rules.js");
			writeFileSync(rules, addToRules(readFileSync(rules, "utf8"), "", 'import { bankDetailsChanged } from "./rules/bank.js";'));
			const t = join(dir, "test/rules.test.js");
			const src = readFileSync(t, "utf8");
			writeFileSync(t, src.replace('import { decide } from "../src/rules.js";', 'import { decide } from "../src/rules.js";\n' + MODULE_TEST.split("\n")[0]) + MODULE_TEST.split("\n").slice(1).join("\n"));
		},
		summary: "New rules/bank.js holds an invoice when the vendor's bank details changed within a 30-day window (a setting) or the pay-to account is not on file; the hold message names both accounts. Tests cover INV-1042, INV-1046 and INV-1047.",
	},
	wrong: {
		files: ["src/rules.js"],
		apply(dir) {
			const rules = join(dir, "src/rules.js");
			writeFileSync(rules, addToRules(readFileSync(rules, "utf8"), WRONG_RULE));
		},
		summary: "Done: invoices from any vendor whose bank details changed are held.",
	},
	hedge: {
		files: ["src/rules.js", "test/rules.test.js"],
		apply(dir) {
			VARIANTS.small.apply(dir);
		},
		summary: "I think this should work for most cases: bank changes are held.",
	},
};

function plan(agent, variant, status) {
	return `# Plan: ${agent} (scripted, variant ${variant})\n\n- [x] Read src/rules.js and the vendor data\n- [x] Add the bank-details rule\n- [${variant === "wrong" ? " " : "x"}] Add tests\n\nStatus: ${status}\n`;
}

if (SELFTEST) {
	// Apply each variant to a local copy of the demo app; run its tests and print the four probed decisions.
	const app = new URL("../demo/larkspur-ap/", import.meta.url).pathname;
	for (const [variant, v] of Object.entries(VARIANTS)) {
		const dir = mkdtempSync(join(tmpdir(), `steward-selftest-${variant}-`));
		execFileSync("cp", ["-r", join(app, "src"), join(app, "test"), join(app, "package.json"), dir]);
		v.apply(dir);
		let tests = "pass";
		try {
			execFileSync("node", ["--test"], { cwd: dir, stdio: "pipe" });
		} catch (e) {
			tests = "FAIL: " + String(e.stdout).split("\n").filter((l) => l.startsWith("not ok")).join("; ");
		}
		const probe = execFileSync("node", ["--input-type=module", "-e", `
			import { AS_OF, INVOICES, VENDORS } from "${dir}/src/data.js";
			import { decide } from "${dir}/src/rules.js";
			const ctx = { invoices: INVOICES, vendors: new Map(VENDORS.map((v) => [v.id, v])), asOf: AS_OF };
			console.log(["INV-1041","INV-1042","INV-1046","INV-1047"].map((id) => { const d = decide(INVOICES.find((i) => i.id === id), ctx); return id + "=" + d.action + (d.reasons[0] ? "(" + d.reasons[0].code + ")" : ""); }).join(" "));
		`], { encoding: "utf8" }).trim();
		console.log(`${variant.padEnd(7)} tests ${tests}\n        ${probe}`);
		rmSync(dir, { recursive: true, force: true });
	}
	process.exit(0);
}

const admin = client({ url: vars.STEWARD_URL, key: vars.STEWARD_ADMIN_KEY });
const work = mkdtempSync(join(tmpdir(), "steward-scripted-"));
const results = await Promise.all(
	SPECS.map(async ([name, variant]) => {
		const v = VARIANTS[variant];
		if (!v) throw new Error(`unknown variant ${variant}`);
		const { key } = await admin.register(name, "scripted");
		const me = client({ url: vars.STEWARD_URL, key });
		const claim = await me.claim(TASK, v.files, plan(name, variant, "working"));
		const dir = cloneFork(claim, join(work, name), { name: `${name} (scripted agent)`, email: `${name}@agents.steward.invalid` });
		v.apply(dir);
		writeFileSync(join(dir, ".steward/PLAN.md"), plan(name, variant, "done"));
		execFileSync("git", ["add", "-A"], { cwd: dir });
		execFileSync("git", ["commit", "-q", "-m", `${name}: hold invoices whose bank details changed (${variant})`], { cwd: dir });
		execFileSync("git", ["push", "-q", "origin", "HEAD:main"], { cwd: dir });
		const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
		const done = await me.done(TASK, v.summary, 20000 + Math.floor(Math.random() * 30000));
		return { name, variant, fork: claim.fork, rivals: claim.rivals.map((r) => r.agent), commit: commit.slice(0, 7), gate: done.gate };
	}),
);
console.table(results);
rmSync(work, { recursive: true, force: true });
