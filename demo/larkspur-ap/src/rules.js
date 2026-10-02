// Payment rules. Each rule looks at one invoice and returns a hold reason, or null to let it through.
// An invoice is paid only when no rule holds it.

export const APPROVAL_LIMIT = 25000;

/** Large invoices need a purchase order before anyone pays them. */
export function approvalLimit(invoice) {
	if (invoice.amount > APPROVAL_LIMIT && !invoice.po) {
		return {
			code: "over-approval-limit",
			message: `Over $${APPROVAL_LIMIT.toLocaleString("en-US")} with no purchase order`,
		};
	}
	return null;
}

/** The same vendor invoice number must not be paid twice. */
export function duplicateInvoice(invoice, ctx) {
	const earlier = ctx.invoices.find(
		(other) =>
			other.id !== invoice.id &&
			other.vendorId === invoice.vendorId &&
			other.vendorInvoiceNo === invoice.vendorInvoiceNo &&
			other.received <= invoice.received,
	);
	if (earlier) {
		return {
			code: "duplicate-invoice",
			message: `Same vendor invoice number as ${earlier.id}`,
		};
	}
	return null;
}

export const RULES = [approvalLimit, duplicateInvoice];

/** Decide one invoice: pay it, or hold it with every reason that applies. */
export function decide(invoice, ctx) {
	const reasons = RULES.map((rule) => rule(invoice, ctx)).filter(Boolean);
	return { action: reasons.length ? "hold" : "pay", reasons };
}
