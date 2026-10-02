import { AS_OF, INVOICES, VENDORS } from "./data.js";
import { decide } from "./rules.js";
import { BUILD } from "./build-info.js";

const ctx = { invoices: INVOICES, vendors: new Map(VENDORS.map((v) => [v.id, v])), asOf: AS_OF };

function decided() {
	return INVOICES.map((invoice) => ({
		...invoice,
		vendor: ctx.vendors.get(invoice.vendorId)?.name ?? invoice.vendorId,
		decision: decide(invoice, ctx),
	}));
}

const money = (n) => n.toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(env) {
	const rows = decided()
		.map((inv) => {
			const hold = inv.decision.action === "hold";
			const why = inv.decision.reasons.map((r) => `<li>${esc(r.message)}</li>`).join("");
			return `<tr class="${hold ? "hold" : "pay"}">
	<td class="id">${esc(inv.id)}</td>
	<td>${esc(inv.vendor)}<div class="sub">${esc(inv.vendorInvoiceNo)} · pays to ••${esc(inv.payToAccount)}</div></td>
	<td class="num">${money(inv.amount)}</td>
	<td><span class="tag">${hold ? "Hold" : "Pay"}</span>${why ? `<ul>${why}</ul>` : ""}</td>
</tr>`;
		})
		.join("\n");
	const holds = decided().filter((i) => i.decision.action === "hold").length;
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Larkspur Garden Co. · Invoices to pay</title>
<style>
	:root { --ink: #1f2a24; --muted: #5d6b63; --line: #dfe5e1; --hold: #9a3412; --hold-bg: #fff4ed; --pay: #166534; --pay-bg: #effaf2; }
	* { box-sizing: border-box; }
	body { margin: 0; font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color: var(--ink); background: #fbfcfb; }
	header { padding: 24px 32px 8px; display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 8px; }
	h1 { margin: 0; font-size: 22px; letter-spacing: -0.01em; }
	.build { font: 12px ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--muted); }
	.build b { color: var(--ink); font-weight: 600; }
	p.lead { margin: 4px 32px 16px; color: var(--muted); }
	table { width: calc(100% - 64px); margin: 0 32px 32px; border-collapse: collapse; background: #fff; border: 1px solid var(--line); }
	th, td { text-align: left; padding: 12px 14px; border-top: 1px solid var(--line); vertical-align: top; }
	th { font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); border-top: 0; }
	td.num { text-align: right; font-variant-numeric: tabular-nums; }
	td.id { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
	.sub { font-size: 12px; color: var(--muted); }
	.tag { display: inline-block; padding: 1px 8px; border-radius: 999px; font-size: 12px; font-weight: 600; }
	tr.pay .tag { color: var(--pay); background: var(--pay-bg); }
	tr.hold .tag { color: var(--hold); background: var(--hold-bg); }
	ul { margin: 6px 0 0; padding-left: 18px; color: var(--hold); font-size: 13px; }
</style>
</head>
<body>
<header>
	<h1>Larkspur Garden Co. · Invoices to pay</h1>
	<div class="build">${esc(env.ENVIRONMENT ?? "local")} · <b>${esc(BUILD.branch)}</b> @ ${esc(String(BUILD.commit).slice(0, 7))}</div>
</header>
<p class="lead">${INVOICES.length} invoices as of ${esc(AS_OF)}. ${holds} held for a person to look at.</p>
<table>
	<thead><tr><th>Invoice</th><th>Vendor</th><th class="num">Amount</th><th>Decision</th></tr></thead>
	<tbody>
${rows}
	</tbody>
</table>
</body>
</html>`;
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === "/api/health") {
			return Response.json({ ok: true, environment: env.ENVIRONMENT ?? "local", ...BUILD });
		}
		if (url.pathname === "/api/invoices") {
			return Response.json({ asOf: AS_OF, invoices: decided() });
		}
		const one = url.pathname.match(/^\/api\/invoices\/([A-Za-z0-9-]+)\/decision$/);
		if (one) {
			const invoice = INVOICES.find((i) => i.id === one[1]);
			if (!invoice) return Response.json({ error: "no such invoice" }, { status: 404 });
			return Response.json({ id: invoice.id, ...decide(invoice, ctx) });
		}
		if (url.pathname === "/") {
			return new Response(page(env), { headers: { "content-type": "text/html; charset=utf-8" } });
		}
		return new Response("Not found", { status: 404 });
	},
};
