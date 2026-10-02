// Gate 1's verdict from a candidate's checks and what its agent said. Shared by the gate (after checking) and the
// API (when "done" arrives after the checks finished), so both reach the same answer.

import type { GateCheck } from "./board";
import { hedged } from "./probe";

export type Verdict = { status: "passed" | "bounced" | "working"; note: string | null };

export function gateVerdict(checks: GateCheck[], done: boolean, summary: string | null): Verdict {
	const failing = checks.filter((c) => !c.ok);
	const allPass = checks.length > 0 && failing.length === 0;
	const hedge = hedged(summary);
	if (allPass && done && !hedge) return { status: "passed", note: null };
	if (done && !allPass) return { status: "bounced", note: `Claimed done, but ${failing.length} check(s) failed: ${failing.map((c) => c.name).join("; ")}. Bounced before anyone saw it.` };
	if (done && hedge) return { status: "working", note: `A hedged summary counts as not done ("${hedge}"). Say what works, or keep going.` };
	if (allPass) return { status: "working", note: "Every check passes. Call done when the work is finished." };
	return { status: "working", note: `${failing.length} check(s) failing: ${failing.map((c) => c.name).join("; ")}.` };
}
