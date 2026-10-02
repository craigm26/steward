import { test } from "node:test";
import assert from "node:assert/strict";
import { AS_OF, INVOICES, VENDORS } from "../src/data.js";
import { decide } from "../src/rules.js";

const ctx = { invoices: INVOICES, vendors: new Map(VENDORS.map((v) => [v.id, v])), asOf: AS_OF };
const decision = (id) => decide(INVOICES.find((i) => i.id === id), ctx);
const codes = (id) => decision(id).reasons.map((r) => r.code);

test("an ordinary invoice with a purchase order is paid", () => {
	assert.equal(decision("INV-1041").action, "pay");
	assert.equal(decision("INV-1044").action, "pay");
});

test("a large invoice with no purchase order is held", () => {
	assert.equal(decision("INV-1043").action, "hold");
	assert.ok(codes("INV-1043").includes("over-approval-limit"));
});

test("a second invoice with the same vendor invoice number is held", () => {
	assert.equal(decision("INV-1045").action, "hold");
	assert.ok(codes("INV-1045").includes("duplicate-invoice"));
});

test("every hold says why", () => {
	for (const invoice of INVOICES) {
		const d = decide(invoice, ctx);
		if (d.action === "hold") assert.ok(d.reasons.every((r) => r.code && r.message), invoice.id);
	}
});
