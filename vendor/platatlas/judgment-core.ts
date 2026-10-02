// The judging core: the judgment types, the shared validation, TypeSafe System One over HTTP, the mock, and the
// engine-spec parser. It has no imports at all and uses only syntax --experimental-strip-types can erase (no
// parameter properties, enums or namespaces), so the Worker imports this file directly, the way it imports
// packages/controls/src/thresholds.ts, and hosted and CLI suggestions come from the same code. judgment.ts and
// engines.ts re-export everything here, so every existing importer is unchanged and `instanceof JudgmentError`
// is one class everywhere. Anything that needs a Node built-in, a child process or an SDK stays out of this file.
//
// Honesty canon: every result carries `generated_by` and is `inferred`, never `verified`.

export type JudgmentState = string | Record<string, unknown> | unknown[];

/** Pick one option from a closed set. `criteria` maps option → description. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: Record<string, string>;
}

/** Does a condition hold? Probability of yes. */
export interface NoulQuestion {
  type: "noul";
  instructions: string | Record<string, unknown> | unknown[];
  criteria?: { true: string; false: string };
}

/** Degree along an ordered dimension; 2–10 level descriptions. */
export interface ScoreQuestion {
  type: "score";
  instructions: string | Record<string, unknown> | unknown[];
  criteria: string[];
}

export type JudgmentQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export interface JudgmentRequest {
  state: JudgmentState;
  questions: Record<string, JudgmentQuestion>;
  /** Per-call model override; backends that serve one model ignore it. */
  model?: string;
  /** Few-shot technique: labeled past cases to show the model. Backends that cannot use them ignore them.
   *  When measuring, the case being judged must never be among its own exemplars. */
  exemplars?: { state: JudgmentState; label: string }[];
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface NoulAnswer {
  type: "noul";
  noul: number;
}
export interface ScoreAnswer {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
}
export type JudgmentAnswer = ChoiceAnswer | NoulAnswer | ScoreAnswer;

export interface JudgmentResult {
  /** The model that actually answered (as the backend reports it). */
  model: string;
  answers: Record<string, JudgmentAnswer>;
  /** cost_usd is the list-price equivalent of the call where the backend reports one (a subscription
   *  seat bills nothing per call); ms is wall time. Both exist to compare engines. */
  usage?: { input_tokens?: number; output_tokens?: number; cost_usd?: number; ms?: number };
  /** Honesty canon: who produced this. Always present; always `inferred`. probability_basis says
   *  whether the probabilities are a model's calibrated output or its own self-reported estimate. */
  generated_by: { backend: string; model: string; source: "inferred"; probability_basis?: "calibrated" | "self-reported" | "token-likelihood" | "upstream-score" };
}

export interface JudgmentBackend {
  readonly name: string;
  judge(req: JudgmentRequest): Promise<JudgmentResult>;
  /** Optional reachability probe; absent ⇒ treated as reachable. */
  health?(): Promise<boolean>;
}

/** Thrown when the service refuses or fails. `status` is the HTTP status when known. */
export class JudgmentError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = "JudgmentError";
    this.status = status;
    this.retryable = retryable;
  }
}

// ---------------------------------------------------------------------------
// Validation shared by every backend, so a malformed question never reaches the wire.

export function validateRequest(req: JudgmentRequest): void {
  if (req.state === undefined || req.state === null || req.state === "") throw new JudgmentError("state is required");
  const ids = Object.keys(req.questions ?? {});
  if (ids.length === 0) throw new JudgmentError("at least one question is required");
  for (const id of ids) {
    const q = req.questions[id]!;
    if (!q.instructions) throw new JudgmentError(`question ${id}: instructions are required`);
    if (q.type === "choice") {
      const n = Object.keys(q.criteria ?? {}).length;
      if (n < 2) throw new JudgmentError(`question ${id}: choice needs at least 2 options`);
      if (n > 255) throw new JudgmentError(`question ${id}: choice allows at most 255 options`);
    } else if (q.type === "score") {
      const n = q.criteria?.length ?? 0;
      if (n < 2 || n > 10) throw new JudgmentError(`question ${id}: score needs 2–10 levels`);
    } else if (q.type !== "noul") {
      throw new JudgmentError(`question ${id}: unknown type ${(q as { type: string }).type}`);
    }
  }
}

// ---------------------------------------------------------------------------
// TypeSafe System One over HTTP. Key from TYPESAFE_API_KEY; never logged.

/** TypeSafe's published price: $0.042 per million input tokens, output free (2026-09). */
export const TYPESAFE_PRICE_PER_M_INPUT = 0.042;

export interface TypeSafeConfig {
  apiKey: string;
  model?: string;               // default jev-latest
  baseUrl?: string;             // default https://api.typesafe.ai
  timeoutMs?: number;           // default 30s
  maxRetries?: number;          // on 429/529; default 3
  fetch?: typeof fetch;         // injectable for tests
  sleep?: (ms: number) => Promise<void>;
  /** Dollars per million input tokens for cost comparisons: TypeSafe's published 0.042; 0 for a self-hosted
   *  endpoint on the same contract (djev on Cloud Run bills by the hour, not the token). */
  pricePerMInput?: number;
  /** The name reports and generated_by carry: "typesafe", or "djev" for DiffusionGemma-Jev on the same contract. */
  name?: string;
}

export class TypeSafeJudgmentBackend implements JudgmentBackend {
  readonly name: string;
  private readonly cfg: Required<Omit<TypeSafeConfig, "apiKey" | "name">> & { apiKey: string };

  constructor(cfg: TypeSafeConfig) {
    if (!cfg.apiKey) throw new JudgmentError("TypeSafe backend needs an API key");
    this.name = cfg.name ?? "typesafe";
    this.cfg = {
      pricePerMInput: cfg.pricePerMInput ?? TYPESAFE_PRICE_PER_M_INPUT,
      apiKey: cfg.apiKey,
      model: cfg.model ?? "jev-latest",
      baseUrl: (cfg.baseUrl ?? "https://api.typesafe.ai").replace(/\/+$/, ""),
      timeoutMs: cfg.timeoutMs ?? 30_000,
      maxRetries: cfg.maxRetries ?? 3,
      // Never the bare global: `this.cfg.fetch(...)` would call it with `this` = cfg, which the Workers runtime refuses
      // ("Illegal invocation"). The arrow looks fetch up at call time and calls it on globalThis.
      fetch: cfg.fetch ?? ((i, init) => globalThis.fetch(i, init)),
      sleep: cfg.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    };
  }

  async judge(req: JudgmentRequest): Promise<JudgmentResult> {
    validateRequest(req);
    const body = JSON.stringify({ state: req.state, model: req.model ?? this.cfg.model, questions: req.questions });
    let attempt = 0;
    for (;;) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs);
      let res: Response;
      // Detached, so a caller who passes the bare global `fetch` is not called with `this` = cfg either.
      const send = this.cfg.fetch;
      try {
        res = await send(`${this.cfg.baseUrl}/v1/systemone`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${this.cfg.apiKey}` },
          body,
          signal: ctrl.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        throw new JudgmentError(`typesafe request failed: ${(e as Error).message}`, undefined, true);
      }
      clearTimeout(timer);
      if (res.ok) {
        const json = (await res.json()) as { model: string; answers: Record<string, JudgmentAnswer>; usage?: JudgmentResult["usage"] };
        return {
          model: json.model,
          answers: json.answers,
          // TypeSafe's published price: $0.042 per million input tokens, output free (2026-09). Kept here so
          // engines can be compared on cost; the bill is TypeSafe's.
          usage: { ...(json.usage ?? {}), cost_usd: json.usage?.cost_usd ?? Math.round(((json.usage?.input_tokens ?? 0) * this.cfg.pricePerMInput / 1e6) * 1e8) / 1e8 },
          generated_by: { backend: this.name, model: json.model, source: "inferred" },
        };
      }
      const retryable = res.status === 429 || res.status === 529;
      if (retryable && attempt < this.cfg.maxRetries) {
        await this.cfg.sleep(Math.min(8_000, 500 * 2 ** attempt));
        attempt++;
        continue;
      }
      const text = await res.text().catch(() => "");
      throw new JudgmentError(`typesafe ${res.status}: ${text.slice(0, 200)}`, res.status, retryable);
    }
  }

  async health(): Promise<boolean> {
    // No token spend: an unauthenticated-shape probe is not offered by the API, so a
    // cheap noul over a one-word state is the honest check. Callers can skip it.
    try {
      await this.judge({ state: "ping", questions: { ok: { type: "noul", instructions: "Is the state the word ping?" } } });
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Mock: deterministic and network-free so the demo and the tests run anywhere.
// Choice picks the option whose name (or criteria text) appears in the state,
// else the first option. Noul is 0.9 when the instructions' key words appear in the
// state, else 0.1. Score lands on the middle level. A `rules` override lets a test
// or the demo script pin exact answers per question id.

export type MockRule = (req: JudgmentRequest, id: string, q: JudgmentQuestion) => JudgmentAnswer | undefined;

function stateText(state: JudgmentState): string {
  return (typeof state === "string" ? state : JSON.stringify(state)).toLowerCase();
}

function words(x: unknown): string[] {
  const s = typeof x === "string" ? x : JSON.stringify(x);
  return s.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 4);
}

export class MockJudgmentBackend implements JudgmentBackend {
  readonly name = "mock";
  private readonly rules: MockRule[];
  constructor(rules: MockRule[] = []) {
    this.rules = rules;
  }

  async judge(req: JudgmentRequest): Promise<JudgmentResult> {
    validateRequest(req);
    const text = stateText(req.state);
    const answers: Record<string, JudgmentAnswer> = {};
    for (const [id, q] of Object.entries(req.questions)) {
      let a: JudgmentAnswer | undefined;
      for (const rule of this.rules) { a = rule(req, id, q); if (a) break; }
      answers[id] = a ?? this.defaultAnswer(q, text);
    }
    return { model: "mock", answers, usage: { input_tokens: 0, output_tokens: 0 }, generated_by: { backend: this.name, model: "mock", source: "inferred" } };
  }

  private defaultAnswer(q: JudgmentQuestion, text: string): JudgmentAnswer {
    if (q.type === "noul") {
      const hit = words(q.instructions).some((w) => text.includes(w));
      return { type: "noul", noul: hit ? 0.9 : 0.1 };
    }
    if (q.type === "choice") {
      const opts = Object.keys(q.criteria);
      const hit = opts.find((o) => text.includes(o.toLowerCase())) ?? opts.find((o) => words(q.criteria[o]).some((w) => text.includes(w)));
      const choice = hit ?? opts[0]!;
      const top = hit ? 0.9 : 0.5;
      const rest = (1 - top) / (opts.length - 1);
      const probabilities = Object.fromEntries(opts.map((o) => [o, o === choice ? top : rest]));
      return { type: "choice", choice, probabilities, confidence: top };
    }
    const n = q.criteria.length;
    const mid = Math.floor((n - 1) / 2);
    const probabilities = Object.fromEntries(q.criteria.map((_, i) => [String(i), i === mid ? 0.6 : 0.4 / (n - 1)]));
    const legend = Object.fromEntries(q.criteria.map((c, i) => [String(i), c]));
    return { type: "score", score: mid, legend, probabilities, confidence: 0.6 };
  }

  async health(): Promise<boolean> { return true; }
}

// ---------------------------------------------------------------------------
// Engine specs: the grammar lives in engines.ts's header. Parsing is here so the Worker can read a record's
// harness.toml [judgment] engine without loading the backends that need a local machine.

export type Technique = { kind: "zero" } | { kind: "few"; k: number };
export interface EngineSpec { backend: "mock" | "typesafe" | "claude" | "anthropic" | "anthropic-batch" | "ollama" | "recipe" | "field" | "djev" | "gliner2"; model?: string; technique: Technique; effort?: "low" | "medium" | "high"; text: string }

const BACKENDS = ["mock", "typesafe", "claude", "anthropic", "anthropic-batch", "ollama", "recipe", "field", "djev", "gliner2"];
const MODEL_BACKENDS = ["claude", "anthropic", "anthropic-batch", "ollama"];

export function parseEngineSpec(text: string): EngineSpec {
  const [backend = "", model, technique, effort] = text.trim().split(":").map((s) => s.trim());
  if (!BACKENDS.includes(backend)) throw new JudgmentError(`unknown engine backend "${backend}" in "${text}" (${BACKENDS.join(" | ")})`);
  let t: Technique = { kind: "zero" };
  if (technique && technique !== "zero") {
    const m = /^few-(\d{1,2})$/.exec(technique);
    if (!m || Number(m[1]) < 1) throw new JudgmentError(`unknown technique "${technique}" in "${text}" (zero | few-<k>)`);
    t = { kind: "few", k: Number(m[1]) };
  }
  if (effort && !["low", "medium", "high"].includes(effort)) throw new JudgmentError(`unknown effort "${effort}" in "${text}"`);
  if (!MODEL_BACKENDS.includes(backend) && (technique || effort)) throw new JudgmentError(`technique and effort apply to the claude and anthropic backends only ("${text}")`);
  return { backend: backend as EngineSpec["backend"], model: model || undefined, technique: t, effort: effort as EngineSpec["effort"], text: text.trim() };
}
