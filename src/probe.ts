// Done checks: the playbook says what "done" means as checks that pass or fail, and gate 1 runs them against the
// candidate's own Preview. A check is never "partly" passed; a probe that cannot be read fails.

import type { DoneCheck } from "./record/playbook";
import type { GateCheck } from "./board";

/** `reasons.0.code` style paths into parsed JSON. */
export function pick(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const part of path.split(".")) {
		if (cur === null || cur === undefined) return undefined;
		cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : (cur as Record<string, unknown>)[part];
	}
	return cur;
}

export async function runProbe(base: string, check: Extract<DoneCheck, { kind: "probe" }>, fetcher: typeof fetch = (i, init) => fetch(i, init)): Promise<GateCheck> {
	const url = base.replace(/\/+$/, "") + check.get;
	let res: Response;
	try {
		res = await fetcher(url, { headers: { "cache-control": "no-cache", accept: "application/json, text/html" }, signal: AbortSignal.timeout(15_000) });
	} catch (e) {
		return { name: check.name, ok: false, detail: `GET ${check.get} failed: ${(e as Error).message}` };
	}
	const text = await res.text();
	if (res.status !== check.status) return { name: check.name, ok: false, detail: `GET ${check.get} answered ${res.status}, expected ${check.status}` };
	if (check.contains !== undefined && !text.includes(check.contains)) return { name: check.name, ok: false, detail: `GET ${check.get} does not contain "${check.contains}"` };
	const fields = Object.entries(check.expect);
	if (fields.length) {
		let body: unknown;
		try {
			body = JSON.parse(text);
		} catch {
			return { name: check.name, ok: false, detail: `GET ${check.get} did not answer JSON` };
		}
		for (const [path, want] of fields) {
			const got = pick(body, path);
			if (String(got) !== want) return { name: check.name, ok: false, detail: `${path} is ${got === undefined ? "missing" : JSON.stringify(got)}, expected ${want}` };
		}
	}
	return { name: check.name, ok: true };
}

/** Words that make "done" not done: a summary that hedges has not claimed the work works. */
const HEDGES = /\b(should work|should be fine|i think|i believe|probably|hopefully|might|seems to|mostly|not sure|untested|haven't tested|have not tested|in theory|tbd|todo)\b/i;

export function hedged(summary: string | null | undefined): string | null {
	const m = summary ? HEDGES.exec(summary) : null;
	return m ? m[0] : null;
}
