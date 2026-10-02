// Moments in a candidate's life that touch more than the board: closing a fork, and handing a settled decision to
// the judge.

import { getRepo } from "./artifacts";
import type { Env } from "./index";
import { boardFor } from "./board";

/** Revokes every write token on a fork, so the agent can no longer push. The fork and its history stay. */
export async function closeFork(env: Env, forkRepo: string): Promise<number> {
	try {
		using repo = await getRepo(env, forkRepo);
		const { tokens } = await repo.listTokens();
		const live = tokens.filter((t) => t.scope === "write" && t.state === "active");
		await Promise.all(live.map((t) => repo.revokeToken(t.id)));
		return live.length;
	} catch (e) {
		console.error("closeFork", forkRepo, (e as Error).message);
		return 0;
	}
}

/**
 * When every candidate in a decision has settled (passed, bounced, over budget or withdrawn), start the decide
 * Workflow for it: the judge proposes, the referee objects, then either auto-merge or the steward. Only one caller
 * wins: the board moves the decision from open to judging once.
 */
export async function maybeDecide(env: Env, decisionId: string | null, force = false): Promise<"started" | "waiting" | "empty" | "none"> {
	if (!decisionId) return "none";
	const board = boardFor(env);
	const verdict = await board.readyToJudge(decisionId, force);
	if (verdict !== "judge") return verdict;
	const instance = `${decisionId}-${Date.now().toString(36)}`;
	try {
		await env.DECIDE.create({ id: instance, params: { decision: decisionId } });
	} catch (e) {
		// Never leave a decision stuck in judging with nobody judging it.
		await board.advanceDecision(decisionId, ["judging"], "open", {}, { text: `Decision ${decisionId}: the judge could not start (${(e as Error).message}); back to open` });
		throw e;
	}
	await board.setDecisionWorkflow(decisionId, instance);
	return "started";
}
