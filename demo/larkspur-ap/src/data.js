// Larkspur Garden Co. is fictional: a chain of nine garden centres paying its suppliers.
// Every vendor, account number and invoice below is made up for the demo.

// Decisions are made as of this date so that tests and previews agree.
export const AS_OF = "2026-10-02";

// The vendor master: who Larkspur pays, and the bank account on file for each.
// `bankChangedAt` is the date the account on file last changed (null = never since onboarding).
export const VENDORS = [
	{ id: "v-arbor", name: "Arbor Ridge Nursery", accountOnFile: "4417", bankChangedAt: null, previousAccount: null },
	{ id: "v-terrace", name: "Terracotta & Stone Supply", accountOnFile: "2290", bankChangedAt: null, previousAccount: null },
	{ id: "v-delta", name: "Delta Drip Irrigation", accountOnFile: "0067", bankChangedAt: "2026-09-27", previousAccount: "8812" },
	{ id: "v-meadow", name: "Meadowlark Seed Co.", accountOnFile: "5531", bankChangedAt: null, previousAccount: null },
	{ id: "v-coastal", name: "Coastal Soil & Compost", accountOnFile: "7720", bankChangedAt: "2026-06-02", previousAccount: "3301" },
	{ id: "v-summit", name: "Summit Greenhouse Glass", accountOnFile: "9104", bankChangedAt: null, previousAccount: null },
];

// Invoices waiting to be paid. `payToAccount` is the account printed on the invoice.
export const INVOICES = [
	{ id: "INV-1041", vendorId: "v-arbor", vendorInvoiceNo: "AR-2207", amount: 4860.0, payToAccount: "4417", po: "PO-5512", received: "2026-09-29" },
	{ id: "INV-1042", vendorId: "v-delta", vendorInvoiceNo: "DD-0913", amount: 12300.0, payToAccount: "0067", po: "PO-5520", received: "2026-09-30" },
	{ id: "INV-1043", vendorId: "v-terrace", vendorInvoiceNo: "TS-7781", amount: 31750.0, payToAccount: "2290", po: null, received: "2026-09-30" },
	{ id: "INV-1044", vendorId: "v-meadow", vendorInvoiceNo: "MS-1150", amount: 2140.5, payToAccount: "5531", po: "PO-5524", received: "2026-10-01" },
	{ id: "INV-1045", vendorId: "v-arbor", vendorInvoiceNo: "AR-2207", amount: 4860.0, payToAccount: "4417", po: "PO-5512", received: "2026-10-01" },
	{ id: "INV-1046", vendorId: "v-coastal", vendorInvoiceNo: "CS-4402", amount: 7410.0, payToAccount: "7720", po: "PO-5527", received: "2026-10-01" },
	{ id: "INV-1047", vendorId: "v-summit", vendorInvoiceNo: "SG-0388", amount: 18900.0, payToAccount: "9999", po: "PO-5531", received: "2026-10-02" },
];
