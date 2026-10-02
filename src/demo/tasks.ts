// The demo's tasks, each with its own acceptance checks (the path's checks run too).

export interface DemoTask {
	id: string;
	title: string;
	description: string;
	path: string;
	done: { name: string; get: string; expect?: string; contains?: string }[];
}

export const DEMO_TASKS: Record<string, DemoTask> = {
	bank: {
		id: "t1",
		title: "Hold invoices whose vendor bank details changed",
		description:
			"Hold any invoice whose vendor bank details changed in the last 30 days, or whose pay-to account differs from the account on file. Use the reason code bank-details-changed and say what changed. A change older than 30 days is not a reason to hold.",
		path: "rules",
		done: [
			{ name: "An invoice to a recently changed bank account is held", get: "/api/invoices/INV-1042/decision", expect: "action=hold, reasons.0.code=bank-details-changed" },
			{ name: "An invoice whose pay-to account differs from the one on file is held", get: "/api/invoices/INV-1047/decision", expect: "action=hold" },
			{ name: "A bank change older than 30 days is not held for it", get: "/api/invoices/INV-1046/decision", expect: "action=pay" },
		],
	},
	terms: {
		id: "t2",
		title: "Hold invoices with unusual payment terms",
		description:
			"Larkspur pays on net 30. Hold any invoice whose terms are longer than 60 days, with the reason code unusual-terms, and say what the terms are. Terms up to 60 days are fine.",
		path: "rules",
		done: [
			{ name: "An invoice on net 90 is held for its terms", get: "/api/invoices/INV-1044/decision", expect: "action=hold, reasons.0.code=unusual-terms" },
			{ name: "An invoice on net 45 is not held for its terms", get: "/api/invoices/INV-1046/decision", expect: "action=pay" },
		],
	},
};
