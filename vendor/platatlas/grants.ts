// Grants: the steward's permission for an AI agent to answer one kind of request on its own, and every rule about it.
//
// A person's signature is a person's. A grant lets an agent answer one label in a situation the steward names ("Sorter
// may answer read-later when its probability is 0.95 or above and the sender is the newsletter, until 2026-12-31"). The
// agent's answer is its own kind (signature "agent"): it names the agent and the grant, never a person, and it is never
// an eval row, so the model is never graded on its own answers.
//
// This is the one copy of those rules. The CLI (scripts/rail-grants.ts, reading files) and the Worker (reading the
// playbook repo and D1) both call it, so it takes text and parsed objects, never paths, and imports nothing but
// ./thresholds.ts. The `.ts` specifier is deliberate: the Worker's --experimental-strip-types runner resolves only that,
// and it imports this file directly, never through index.ts.
//
// preferences/grants.jsonl is append-only: grant, revoke, suspend and overrule events. The FIRST grant event for an id
// wins; a later one with the same id is ignored and marks the grant tampered, so a line re-appended by hand can never
// rewrite its terms or bring a stopped grant back.

import { shouldSample, type Thresholds } from "./thresholds.ts";

export const MIN_EVIDENCE = 5;
export const MAX_DAYS = 180;
/** The least share of an agent's answers that still goes to a person, whatever thresholds.yaml says. */
export const SAMPLE_FLOOR = 0.10;

export interface Grant {
  id: string; at: string; by: string;
  agent: string;                         // the agent's display name, e.g. "Sorter" (every legacy local grant says "Atlas")
  /** The agents: entry in people.yaml it names. Absent on a legacy local grant, which is never active on hosted. */
  agent_key?: string;
  /** The people: key of the steward who gave it, where the writer knows it. */
  by_key?: string;
  engine: string;                        // the backend whose judgment it trusts (the check's engine when granted)
  label: string; min_probability: number;
  when: { [field: string]: string };     // the situation: every field must equal (case-insensitive); empty = any case
  until: string;                         // YYYY-MM-DD, inclusive, to the end of that day in UTC
  note: string;
  /** What it rested on. `model` pins the model behind the engine: a judgment from another model never matches. */
  evidence: { would_sign: number; wrong: number; measured_at: string; blind?: number; model?: string };
}
export type GrantStatus = "active" | "expired" | "revoked" | "suspended";
export interface GrantState extends Grant {
  status: GrantStatus; reason?: string; ended_at?: string; ended_by?: string;
  /** A second grant line with this id was found and ignored. */
  tampered?: boolean;
}
export type GrantEvent =
  | ({ kind: "grant" } & Grant)
  | { kind: "revoke" | "suspend" | "overrule"; id: string; at: string; by?: string; reason: string; case?: string };

/** An agents: entry as the people.yaml readers return it (the Worker's people-yaml.ts, the CLI's rail-surfaces.ts). */
export interface AgentLike { key: string; name?: string; stage?: string | null; steward?: string | null; unreadable?: boolean; no_steward?: boolean }
/** The part of a measure report a grant reads: each past case's answer and the machine's, and which engine ran. */
export interface GrantReport {
  at?: string;
  generated_by?: { backend?: string; model?: string } | null;
  detail: { id: string; expected: string; got: string; probability: number }[];
}
type Judged = { judgment: { label: string; probability: number } | null; generated_by?: { backend?: string; model?: string } | null };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
/** A calendar date as the start of that day in UTC, or NaN (a date like 2026-02-30 is not rolled into March). */
function dayStart(d: unknown): number {
  if (typeof d !== "string" || !DAY.test(d)) return NaN;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d ? t : NaN;
}
/** `now` is an instant (ISO) or a calendar date (read as the start of that day, UTC). */
const instant = (now: string): number => DAY.test(now) ? dayStart(now) : Date.parse(now);

/** Is the grant over at `now`? It runs to the end of its `until` day in UTC. Fails closed: an unreadable date is over. */
export function untilPassed(until: unknown, now: string): boolean {
  const start = dayStart(until), t = instant(now);
  if (!Number.isFinite(start) || !Number.isFinite(t)) return true;
  return t >= start + 864e5;
}

/** Fold the grant events into each grant's state at `now`. Revoked, suspended and overruled beat expired; nothing turns
 *  a grant that has stopped active again. A line that is not JSON throws, naming it, rather than being skipped: a
 *  skipped revoke would leave a grant running. */
export function foldGrants(src: string | readonly unknown[], now: string): GrantState[] {
  const events: unknown[] = typeof src !== "string" ? [...src] : src.split(/\r?\n/).map((l, i) => {
    if (!l.trim()) return null;
    try { return JSON.parse(l); } catch { throw new Error(`preferences/grants.jsonl line ${i + 1} cannot be read`); }
  });
  const out = new Map<string, GrantState>();
  for (const e of events) {
    if (!isObj(e) || typeof e.id !== "string" || !e.id) continue;
    const known = out.get(e.id);
    if (e.kind === "grant") {
      if (known) { known.tampered = true; continue; }                    // the first grant line wins
      const { kind: _k, ...g } = e as unknown as { kind: string } & Grant;
      out.set(g.id, { ...g, status: "active" });
    } else if ((e.kind === "revoke" || e.kind === "suspend" || e.kind === "overrule") && known?.status === "active") {
      Object.assign(known, { status: e.kind === "revoke" ? "revoked" : "suspended", reason: typeof e.reason === "string" ? e.reason : "",
        ended_at: typeof e.at === "string" ? e.at : "", ...(typeof e.by === "string" ? { ended_by: e.by } : {}) });
    }
  }
  for (const g of out.values()) if (g.status === "active" && untilPassed(g.until, now)) g.status = "expired";
  return [...out.values()];
}

/** Does a case fit the grant's situation? Every field must equal, ignoring case. A text case (not an object) never fits
 *  a situation, and a `when` that is not a map of fields fits nothing. */
export function situationMatches(when: unknown, c: unknown): boolean {
  if (!isObj(when)) return false;
  const pairs = Object.entries(when);
  if (!pairs.length) return true;
  if (!isObj(c)) return false;
  return pairs.every(([k, v]) => typeof v === "string" && String(c[k] ?? "").toLowerCase() === v.toLowerCase());
}

/** Would this grant's terms answer this judgment? Label, bar, engine, the model pin and the situation; not status. */
function termsFit(g: Grant, j: { label: string; probability: number } | null | undefined, by: Judged["generated_by"], c: unknown): boolean {
  if (!j || j.label !== g.label || !(j.probability >= g.min_probability)) return false;
  if (!by || g.engine !== by.backend) return false;
  if (g.evidence?.model && g.evidence.model !== by.model) return false;
  return situationMatches(g.when, c);
}

/** The grant that lets an agent answer this judgment, or null. `grants` is foldGrants' result at the case's time;
 *  `caseState` is the parsed case (a string for a text case). A grant naming an agent needs that agents: entry readable,
 *  at stage suggest and with a steward. A legacy grant (no agent_key) works locally as it always has and never on
 *  hosted, and neither does one whose line was re-appended. The Worker adds its own checks on top (D1, AGENT_SIGNING). */
export function grantFor(e: Judged, grants: readonly GrantState[], agents: readonly AgentLike[],
  opts: { hosted: boolean; caseState?: unknown; thresholds?: Pick<Thresholds, "always_to_person"> }): GrantState | null {
  if (!e.judgment) return null;
  if (opts.thresholds?.always_to_person.some((a) => a.label === e.judgment!.label)) return null;
  for (const g of grants) {
    if (g.status !== "active" || !termsFit(g, e.judgment, e.generated_by, opts.caseState)) continue;
    if (!g.agent_key) { if (opts.hosted) continue; return g; }
    if (opts.hosted && g.tampered) continue;
    const a = agents.find((x) => x.key === g.agent_key);
    if (!a || a.unreadable || a.no_steward || !a.steward || a.stage !== "suggest") continue;
    return g;
  }
  return null;
}

/** What a grant would have done on a check: past cases it would have answered, and which of those were wrong.
 *  `caseStateOf(id)` gives a past case's parsed state; a case it cannot give (undefined, or it throws) is left out. */
export function reportEvidence(rep: GrantReport | null, g: Pick<Grant, "label" | "min_probability" | "when">, caseStateOf: (id: string) => unknown = () => undefined): { would_sign: number; wrong: number; wrong_ids: string[] } {
  if (!rep) return { would_sign: 0, wrong: 0, wrong_ids: [] };
  let would_sign = 0; const wrong_ids: string[] = [];
  for (const d of rep.detail) {
    if (d.got !== g.label || !(d.probability >= g.min_probability)) continue;
    if (!isObj(g.when) || Object.keys(g.when).length) { let c: unknown; try { c = caseStateOf(d.id); } catch { continue; } if (!situationMatches(g.when, c)) continue; }
    would_sign++; if (d.expected !== g.label) wrong_ids.push(d.id);
  }
  return { would_sign, wrong: wrong_ids.length, wrong_ids };
}

export interface LiveRow { id: string; source: "blind" | "shown"; guess: string; probability: number; answer: string; wrong: boolean }
export interface LiveEvidence { blind: { of: number; same: number }; shown: { of: number; agreed: number; differed: number }; wrong_ids: string[]; rows: LiveRow[] }

/** The agent's record in the people's own answers (queue/signed.jsonl lines), one row per case.
 *  Blind: the person answered while the agent's guess was sealed and unreadable (a `shadow` the Worker opened in that
 *  person's sign commit). A row counts as blind only when `verifyShadow(line)` says so; the Worker checks shadow.check's
 *  HMAC with Web Crypto first (async) and passes the result here as a lookup. With no verifier, blind is always 0.
 *  Shown: the agent's guess was in the line in plain text (on screen or in the repo), so it may have steered the answer;
 *  shown rows are displayed and never count as blind. A shadow that does not verify counts as nothing.
 *  A case wrong in either source is wrong. `scope` keeps only the cases a grant's terms would have answered. */
export function liveEvidence(signedLines: readonly unknown[], agentKey: string, verifyShadow?: (line: unknown) => boolean,
  scope?: { label: string; min_probability: number; when?: Grant["when"]; caseStateOf?: (id: string) => unknown }): LiveEvidence {
  const byId = new Map<string, LiveRow>();
  for (const l of signedLines) {
    if (!isObj(l) || typeof l.id !== "string" || typeof l.label !== "string") continue;
    if (l.signature === "agent" || (isObj(l.actor) && l.actor.kind === "agent")) continue;   // an agent's own answer is not evidence
    let row: LiveRow | null = null;
    const sh = l.shadow;
    if (isObj(sh) && sh.agent === agentKey && isObj(sh.judgment) && verifyShadow?.(l) === true) {
      row = { id: l.id, source: "blind", guess: String(sh.judgment.label), probability: Number(sh.judgment.probability), answer: l.label, wrong: false };
    } else if (isObj(l.judgment) && isObj(l.generated_by) && l.generated_by.agent === agentKey) {
      row = { id: l.id, source: "shown", guess: String(l.judgment.label), probability: Number(l.judgment.probability), answer: l.label, wrong: false };
    }
    if (!row) continue;
    if (scope) {
      if (row.guess !== scope.label || !(row.probability >= scope.min_probability)) continue;
      if (scope.when && Object.keys(scope.when).length) { let c: unknown; try { c = scope.caseStateOf?.(row.id); } catch { continue; } if (!situationMatches(scope.when, c)) continue; }
    }
    row.wrong = row.answer !== row.guess;
    const had = byId.get(row.id);
    if (!had) { byId.set(row.id, row); continue; }
    if (row.source === "blind") had.source = "blind";
    had.wrong ||= row.wrong;
  }
  const rows = [...byId.values()];
  const blind = rows.filter((r) => r.source === "blind"), shown = rows.filter((r) => r.source === "shown");
  return { blind: { of: blind.length, same: blind.filter((r) => !r.wrong).length },
    shown: { of: shown.length, agreed: shown.filter((r) => !r.wrong).length, differed: shown.filter((r) => r.wrong).length },
    wrong_ids: rows.filter((r) => r.wrong).map((r) => r.id), rows };
}

export type GrantRefusal =
  | { ok: false; code: "measure_first" | "always_to_person" | "unknown_label" | "bad_bar" | "bad_until" | "too_far" | "past" }
  | { ok: false; code: "when_field_unknown"; field: string }
  | { ok: false; code: "too_few" | "too_few_blind"; n: number }
  | { ok: false; code: "wrong"; n: number; of: number; ids: string[] };
export type GrantCheck = GrantRefusal | { ok: true; min_probability: number; when: Grant["when"]; evidence: { would_sign: number; blind?: number } };

/** May the steward give this grant? The record's own evidence decides, never the asker: the check (`report`) must show
 *  at least MIN_EVIDENCE past cases the grant would have answered, none wrong. `engine`/`model`, when given, must be the
 *  report's (another engine's check is no evidence). `live`, when given (hosted), must hold no wrong answer in scope and
 *  at least MIN_EVIDENCE blind ones. `whenFields`, when given, lists the fields a situation may name. Returns a code;
 *  each caller words it. */
export function checkNewGrant(input: {
  thresholds: Pick<Thresholds, "labels" | "always_to_person">;
  terms: { label: string; min_probability: unknown; when?: unknown; until: unknown };
  at: string;
  report: GrantReport | null;
  caseStateOf?: (id: string) => unknown;
  engine?: string; model?: string;
  live?: LiveEvidence;
  whenFields?: readonly string[];
}): GrantCheck {
  const { thresholds: t, terms } = input;
  if (!t.labels.includes(terms.label)) return { ok: false, code: "unknown_label" };
  if (t.always_to_person.some((a) => a.label === terms.label)) return { ok: false, code: "always_to_person" };
  const bar = Number(terms.min_probability);
  if (!(bar >= 0.5 && bar <= 1)) return { ok: false, code: "bad_bar" };
  const end = dayStart(terms.until);
  if (!Number.isFinite(end)) return { ok: false, code: "bad_until" };
  const days = (end - dayStart(input.at.slice(0, 10))) / 864e5;
  if (!(days >= 0)) return { ok: false, code: "past" };
  if (days > MAX_DAYS) return { ok: false, code: "too_far" };
  const when = Object.fromEntries(Object.entries(isObj(terms.when) ? terms.when : {}).map(([k, v]) => [String(k).trim(), String(v ?? "").trim()]).filter(([k, v]) => k && v));
  const unknownField = input.whenFields ? Object.keys(when).find((k) => !input.whenFields!.includes(k)) : undefined;
  if (unknownField !== undefined) return { ok: false, code: "when_field_unknown", field: unknownField };
  const rep = input.report;
  if (!rep) return { ok: false, code: "measure_first" };
  if (input.engine !== undefined && rep.generated_by?.backend !== input.engine) return { ok: false, code: "measure_first" };
  if (input.model !== undefined && rep.generated_by?.model !== input.model) return { ok: false, code: "measure_first" };
  const ev = reportEvidence(rep, { label: terms.label, min_probability: bar, when }, input.caseStateOf);
  if (ev.wrong) return { ok: false, code: "wrong", n: ev.wrong, of: ev.would_sign, ids: ev.wrong_ids };
  if (ev.would_sign < MIN_EVIDENCE) return { ok: false, code: "too_few", n: ev.would_sign };
  if (input.live) {
    if (input.live.wrong_ids.length) return { ok: false, code: "wrong", n: input.live.wrong_ids.length, of: input.live.rows.length, ids: input.live.wrong_ids };
    if (input.live.blind.of < MIN_EVIDENCE) return { ok: false, code: "too_few_blind", n: input.live.blind.of };
  }
  return { ok: true, min_probability: bar, when, evidence: { would_sign: ev.would_sign, ...(input.live ? { blind: input.live.blind.of } : {}) } };
}

export type SuspendLine = { kind: "suspend"; id: string; at: string; by?: string; reason: string };

/** After every check: a grant whose situation now holds a wrong answer, or fewer than MIN_EVIDENCE cases it would have
 *  answered (a flag can take cases out), is suspended until the steward gives it again. A check from another engine,
 *  or another model than the one the grant was given on, says nothing about it and is skipped. */
export function reviewReport(grants: readonly GrantState[], rep: GrantReport, caseStateOf?: (id: string) => unknown, at = new Date().toISOString()): SuspendLine[] {
  const out: SuspendLine[] = [];
  for (const g of grants) {
    if (g.status !== "active") continue;
    if (!rep.generated_by || rep.generated_by.backend !== g.engine) continue;
    if (g.evidence?.model && rep.generated_by.model !== g.evidence.model) continue;
    const ev = reportEvidence(rep, g, caseStateOf);
    if (ev.wrong) out.push({ kind: "suspend", id: g.id, at, reason: `the measure of ${at.slice(0, 10)}: ${ev.wrong} of ${ev.would_sign} past cases it would have signed were wrong (${ev.wrong_ids.slice(0, 5).join(", ")})` });
    else if (ev.would_sign < MIN_EVIDENCE) out.push({ kind: "suspend", id: g.id, at, reason: `the measure of ${at.slice(0, 10)}: it would have signed only ${ev.would_sign} past cases in that situation, and a grant needs at least ${MIN_EVIDENCE}` });
  }
  return out;
}

/** A person answered a case. Every active grant that would have answered it differently (from the suggestion on the
 *  line, or the agent's opened hidden guess) is suspended, in that person's commit. */
export function reviewOnAnswer(entry: Judged & { id: string; shadow?: unknown }, label: string, grants: readonly GrantState[],
  opts: { by: string; at?: string; caseState?: unknown; hosted?: boolean }): SuspendLine[] {
  const at = opts.at ?? new Date().toISOString();
  const sh = isObj(entry.shadow) ? entry.shadow : null;
  const guesses: [Judged["judgment"], Judged["generated_by"]][] = [[entry.judgment, entry.generated_by]];
  if (sh && isObj(sh.judgment)) guesses.push([sh.judgment as Judged["judgment"], (isObj(sh.generated_by) ? sh.generated_by : null) as Judged["generated_by"]]);
  const out: SuspendLine[] = [];
  for (const g of grants) {
    if (g.status !== "active" || g.label === label || (opts.hosted && !g.agent_key)) continue;
    if (!guesses.some(([j, by]) => termsFit(g, j, by, opts.caseState))) continue;
    out.push({ kind: "suspend", id: g.id, at, by: opts.by, reason: `${opts.by} answered ${entry.id} as ${label}, where this permission would have answered ${g.label}` });
  }
  return out;
}

/** The share of an agent's answers a person checks: sample.fraction, never under SAMPLE_FLOOR. */
export const sampleFraction = (t: Pick<Thresholds, "sample">): number => Math.max(t.sample.fraction, SAMPLE_FLOOR);

/** Must a person check this one, rather than the agent answering it? Deterministic by `key` at sampleFraction.
 *  `recentPersonChecks` (grant cases that reached a person in the last 7 days), when the caller counts them, also
 *  forces a case to a person while it is under sample.min_per_week. */
export function mustSample(t: Thresholds, key: string, recentPersonChecks?: number | null): boolean {
  if (typeof recentPersonChecks === "number" && recentPersonChecks < t.sample.min_per_week) return true;
  return shouldSample({ ...t, sample: { ...t.sample, fraction: sampleFraction(t) } }, key);
}

/** The sentence on a line sampled from an agent's answers for a person to check: no grant id, no machine words. The
 *  share is "at least 1 in n" (n rounded up, so it never claims more than it samples). */
export function sampledWhy(name: string, fraction: number): string {
  return `${name} could have answered this one on its own. At least 1 in ${Math.max(1, Math.ceil(1 / fraction - 1e-9))} of those come to a person to check, and this is one.`;
}

/** The agent's answer as it lands in queue/signed.jsonl: its own kind, naming the agent and the grant, and the actor
 *  block readers decide on. It is never an eval row, and it carries no note and nothing presented (no person saw it). */
export function agentSignedLine<E extends { id: string; judgment: { label: string; probability: number } }>(entry: E, g: Grant, at: string, agent?: Pick<AgentLike, "key" | "steward">) {
  return { ...entry, signed_by: `${g.agent} (agent, under grant ${g.id} from ${g.by})`, signed_at: at, label: entry.judgment.label, agreed: true as const,
    signature: "agent" as const, via: { surface: "agent", identity: g.id },
    actor: { kind: "agent" as const, key: agent?.key ?? g.agent_key ?? null, steward: agent?.steward ?? g.by_key ?? null },
    grant: { id: g.id, by: g.by, min_probability: g.min_probability, when: g.when, until: g.until } };
}

/** A case the agent could have answered, sampled for a person to check: the pending line and its fixed reason. */
export function sampledPendingLine<E extends object>(entry: E, g: Grant, t: Pick<Thresholds, "sample">, name = g.agent) {
  return { ...entry, review: { kind: "sampled" as const, grant: g.id, agent_key: g.agent_key ?? null, why: sampledWhy(name, sampleFraction(t)) } };
}
