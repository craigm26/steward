// The hosted check's report, in the shape `rail measure --record` writes (scripts/rail-judge.ts MeasureReport and
// recordMeasure), so every local reader of measure/last-report.json and measure/history.jsonl reads it unchanged:
// `rail status`, `rail advise`, rail-grants' evidence, and the agent's row on platatlas.com (src/suggest/evidence.ts).
//
//   buildCheckReport(o)  → { at, full, ...MeasureReport, ran_on: 'platatlas.com' }, per-row detail kept
//   historyLine(report)  → the measure/history.jsonl line (MeasureHistoryEntry: the report without its rows)
//
// No imports: scripts/tests/hosted-report-shape.test.ts loads this file from vitest, next to the CLI's own readers.
// Every guess in a report is model output: generated_by says which engine and model made it, and it is inferred.

/** One past answer, and the engine's guess at it. A call that failed is a miss with got "(error)", as the CLI counts it. */
export interface CheckRow {
  id: string; expected: string; got: string; probability: number; miss: boolean;
  probabilities?: Record<string, number>; error?: string;
}
export interface CheckGeneratedBy { backend: string; model: string; source: 'inferred'; probability_basis?: string }
export interface CheckReport {
  at: string;
  /** Every trusted past answer was checked (none left out for the size cap). */
  full: boolean;
  over: 'declared' | 'all';
  rows: number; judged: number; misses: number; miss_rate: number; max_acceptable_miss_rate: number; pass: boolean;
  by_label: Record<string, { n: number; misses: number }>;
  generated_by: CheckGeneratedBy | null;
  engine?: string;
  usage: { input_tokens: number; output_tokens: number; cost_usd: number; ms: number };
  errors?: number;
  flagged?: { excluded: number; corrected: number };
  /** Where it ran: platatlas.com, on the platform's key, not on someone's computer. */
  ran_on: 'platatlas.com';
  detail: CheckRow[];
}

/** The report for these rows, counted the way rail-judge.ts measure() counts them. `rows` is every row of
 *  eval/examples.csv; `detail` the rows checked, in order. */
export function buildCheckReport(o: {
  at: string; full: boolean; over: 'declared' | 'all'; rows: number; max_acceptable_miss_rate: number; detail: CheckRow[];
  generated_by: CheckGeneratedBy | null; engine?: string;
  usage?: Partial<CheckReport['usage']>; flagged?: { excluded: number; corrected: number };
}): CheckReport {
  const by_label: CheckReport['by_label'] = {};
  for (const d of o.detail) { const b = (by_label[d.expected] ??= { n: 0, misses: 0 }); b.n++; if (d.miss) b.misses++; }
  const judged = o.detail.length, misses = o.detail.filter((d) => d.miss).length, errors = o.detail.filter((d) => d.error !== undefined).length;
  const miss_rate = judged ? misses / judged : 0;
  const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : 0);
  return {
    at: o.at, full: o.full, over: o.over, rows: o.rows, judged, misses, miss_rate, max_acceptable_miss_rate: o.max_acceptable_miss_rate,
    pass: judged > 0 && miss_rate <= o.max_acceptable_miss_rate, by_label, generated_by: o.generated_by,
    ...(o.engine ? { engine: o.engine } : {}),
    usage: { input_tokens: n(o.usage?.input_tokens), output_tokens: n(o.usage?.output_tokens), cost_usd: Math.round(n(o.usage?.cost_usd) * 1e6) / 1e6, ms: n(o.usage?.ms) },
    ...(errors ? { errors } : {}),
    ...(o.flagged && (o.flagged.excluded || o.flagged.corrected) ? { flagged: o.flagged } : {}),
    ran_on: 'platatlas.com',
    detail: o.detail,
  };
}

/** The line appended to measure/history.jsonl: recordMeasure's MeasureHistoryEntry, with where it ran. */
export function historyLine(r: CheckReport) {
  return {
    at: r.at, over: r.over, judged: r.judged, misses: r.misses, miss_rate: r.miss_rate, max_acceptable_miss_rate: r.max_acceptable_miss_rate,
    pass: r.pass, full_validation: r.full, generated_by: r.generated_by, ran_on: r.ran_on,
  };
}
