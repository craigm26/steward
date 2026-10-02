// thresholds.yaml — what the machine may decide alone, and what always goes to a person.
//
// This is the policy half of layer 3: a typed judgment (packages/inference) returns a
// label with a probability; this file's rules say whether that closes the case or lands
// it in a person's queue. The file lives in the system's record (harness-template/
// thresholds.yaml), is reviewed as a diff, and is read here — never from env.
//
// The parser covers the YAML subset the template uses (nested maps, lists of scalars,
// lists of one-level maps, comments, numbers, strings). It is deliberately not a YAML
// library: the shape is fixed, and a dependency-free reader is one less thing for the
// laptop install to carry. Anything outside the subset is an error, not a guess.

export interface Thresholds {
  labels: string[];
  act_alone: { label: string; min_probability: number }[];
  always_to_person: { label: string }[];
  sample: { fraction: number; min_per_week: number };
  measure: {
    weekly_miss_rate_over: "declared" | "all";
    full_validation_every_days: number;
    max_acceptable_miss_rate: number;
  };
}

export class ThresholdsError extends Error {
  constructor(message: string) { super(message); this.name = "ThresholdsError"; }
}

// ---------------------------------------------------------------------------
// Minimal YAML subset parser.

type Scalar = string | number | boolean | null;
type Node = Scalar | Node[] | { [k: string]: Node };

function scalar(raw: string): Scalar {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  // Double-quoted scalars take escapes (\" \\ \n \uXXXX), as YAML and JSON both define them; single-quoted
  // scalars double a quote to escape it. Without this, "Recorded as \"Paid\"" reached the model with its backslashes.
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) { try { return JSON.parse(s) as string; } catch { return s.slice(1, -1); } }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

function stripComment(line: string): string {
  // A '#' starts a comment unless inside quotes; the template never quotes a '#'.
  let inQ: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQ) { if (inQ === '"' && c === "\\") { i++; continue; } if (c === inQ) inQ = null; continue; }
    if (c === '"' || c === "'") { inQ = c; continue; }
    if (c === "#" && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
  }
  return line;
}

interface Line { indent: number; text: string; no: number }

function lines(src: string): Line[] {
  const out: Line[] = [];
  src.split(/\r?\n/).forEach((raw, i) => {
    const t = stripComment(raw).replace(/\s+$/, "");
    if (t.trim() === "") return;
    if (/\t/.test(t.slice(0, t.length - t.trimStart().length))) throw new ThresholdsError(`line ${i + 1}: tabs are not allowed for indentation`);
    out.push({ indent: t.length - t.trimStart().length, text: t.trim(), no: i + 1 });
  });
  return out;
}

function parseBlock(ls: Line[], i: number, indent: number): [Node, number] {
  if (i >= ls.length) return [null, i];
  if (ls[i]!.text.startsWith("- ")) return parseList(ls, i, indent);
  return parseMap(ls, i, indent);
}

function parseMap(ls: Line[], i: number, indent: number): [Node, number] {
  const out: { [k: string]: Node } = {};
  while (i < ls.length && ls[i]!.indent === indent) {
    const l = ls[i]!;
    if (l.text.startsWith("- ")) throw new ThresholdsError(`line ${l.no}: unexpected list item inside a map`);
    const m = /^([A-Za-z0-9_.-]+):(?:\s+(.*))?$/.exec(l.text);
    if (!m) throw new ThresholdsError(`line ${l.no}: expected "key: value"`);
    const key = m[1]!;
    if (key in out) throw new ThresholdsError(`line ${l.no}: duplicate key ${key}`);
    if (m[2] !== undefined && m[2] !== "") { out[key] = scalar(m[2]); i++; continue; }
    // nested block
    i++;
    if (i < ls.length && ls[i]!.indent > indent) {
      const [v, next] = parseBlock(ls, i, ls[i]!.indent);
      out[key] = v; i = next;
    } else if (i < ls.length && ls[i]!.indent === indent && ls[i]!.text.startsWith("- ")) {
      // YAML allows a list at the same indent as its key
      const [v, next] = parseList(ls, i, indent); out[key] = v; i = next;
    } else {
      out[key] = null;
    }
  }
  if (i < ls.length && ls[i]!.indent > indent) throw new ThresholdsError(`line ${ls[i]!.no}: bad indentation`);
  return [out, i];
}

function parseList(ls: Line[], i: number, indent: number): [Node, number] {
  const out: Node[] = [];
  while (i < ls.length && ls[i]!.indent === indent && ls[i]!.text.startsWith("- ")) {
    const l = ls[i]!;
    const body = l.text.slice(2).trim();
    const kv = /^([A-Za-z0-9_.-]+):\s+(.*)$/.exec(body);
    if (kv) {
      // "- key: value" opens a one-level map whose further keys sit at indent+2
      const item: { [k: string]: Node } = { [kv[1]!]: scalar(kv[2]!) };
      i++;
      while (i < ls.length && ls[i]!.indent === indent + 2 && !ls[i]!.text.startsWith("- ")) {
        const m = /^([A-Za-z0-9_.-]+):\s+(.*)$/.exec(ls[i]!.text);
        if (!m) throw new ThresholdsError(`line ${ls[i]!.no}: expected "key: value" in list item`);
        item[m[1]!] = scalar(m[2]!); i++;
      }
      out.push(item);
    } else {
      out.push(scalar(body)); i++;
    }
  }
  return [out, i];
}

export function parseYamlSubset(src: string): Node {
  const ls = lines(src);
  if (ls.length === 0) return {};
  const [node, next] = parseBlock(ls, 0, ls[0]!.indent);
  if (next < ls.length) throw new ThresholdsError(`line ${ls[next]!.no}: unexpected content`);
  return node;
}

// ---------------------------------------------------------------------------
// Validation into the typed shape.

function isObj(x: Node | undefined): x is { [k: string]: Node } { return typeof x === "object" && x !== null && !Array.isArray(x); }
function prob(x: Node | undefined, where: string): number {
  if (typeof x !== "number" || x < 0 || x > 1) throw new ThresholdsError(`${where}: expected a number in [0, 1]`);
  return x;
}
function posInt(x: Node | undefined, where: string): number {
  if (typeof x !== "number" || !Number.isInteger(x) || x <= 0) throw new ThresholdsError(`${where}: expected a positive integer`);
  return x;
}

export function validateThresholds(node: Node): Thresholds {
  if (!isObj(node)) throw new ThresholdsError("thresholds must be a map");
  const labelsN = node.labels;
  if (!Array.isArray(labelsN) || labelsN.length === 0 || !labelsN.every((l) => typeof l === "string" && l !== ""))
    throw new ThresholdsError("labels: expected a non-empty list of strings");
  const labels = labelsN as string[];
  if (new Set(labels).size !== labels.length) throw new ThresholdsError("labels: duplicates");
  const known = (l: Node | undefined, where: string): string => {
    if (typeof l !== "string" || !labels.includes(l)) throw new ThresholdsError(`${where}: label ${JSON.stringify(l)} is not in labels`);
    return l;
  };

  const actN = node.act_alone ?? [];
  if (!Array.isArray(actN)) throw new ThresholdsError("act_alone: expected a list");
  const act_alone = actN.map((it, i) => {
    if (!isObj(it)) throw new ThresholdsError(`act_alone[${i}]: expected a map`);
    return { label: known(it.label, `act_alone[${i}].label`), min_probability: prob(it.min_probability, `act_alone[${i}].min_probability`) };
  });

  const personN = node.always_to_person ?? [];
  if (!Array.isArray(personN)) throw new ThresholdsError("always_to_person: expected a list");
  const always_to_person = personN.map((it, i) => {
    if (!isObj(it)) throw new ThresholdsError(`always_to_person[${i}]: expected a map`);
    return { label: known(it.label, `always_to_person[${i}].label`) };
  });

  const both = act_alone.map((a) => a.label).filter((l) => always_to_person.some((p) => p.label === l));
  if (both.length) throw new ThresholdsError(`labels in both act_alone and always_to_person: ${both.join(", ")}`);

  if (!isObj(node.sample)) throw new ThresholdsError("sample: expected a map");
  const sample = { fraction: prob(node.sample.fraction, "sample.fraction"), min_per_week: posInt(node.sample.min_per_week, "sample.min_per_week") };

  if (!isObj(node.measure)) throw new ThresholdsError("measure: expected a map");
  const over = node.measure.weekly_miss_rate_over;
  if (over !== "declared" && over !== "all") throw new ThresholdsError("measure.weekly_miss_rate_over: expected declared | all");
  const measure: Thresholds["measure"] = {
    weekly_miss_rate_over: over,
    full_validation_every_days: posInt(node.measure.full_validation_every_days, "measure.full_validation_every_days"),
    max_acceptable_miss_rate: prob(node.measure.max_acceptable_miss_rate, "measure.max_acceptable_miss_rate"),
  };

  return { labels, act_alone, always_to_person, sample, measure };
}

export function parseThresholds(src: string): Thresholds {
  return validateThresholds(parseYamlSubset(src));
}

/** Read and validate a thresholds.yaml from disk. Node-only; the browser console gets the text another way. */
export async function loadThresholds(path: string): Promise<Thresholds> {
  const { readFile } = await import("node:fs/promises");
  return parseThresholds(await readFile(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Routing: the one decision this file exists to make.

export interface Judgment { label: string; probability: number }

export type Route =
  | { decision: "act_alone"; label: string; probability: number; min_probability: number; sampled: boolean }
  | { decision: "to_person"; label: string; probability: number; reason: "always_to_person" | "below_threshold" | "no_rule" | "unknown_label" };

/** Route a judgment by the record's thresholds. Anything not explicitly allowed to
 *  act alone goes to a person: an unknown label, a label with no rule, a probability
 *  under the bar. `sampleKey` (a stable id for the case) makes the review sample
 *  deterministic so the same case is never sampled twice by accident. */
export function route(t: Thresholds, j: Judgment, sampleKey?: string): Route {
  if (!t.labels.includes(j.label)) return { decision: "to_person", label: j.label, probability: j.probability, reason: "unknown_label" };
  if (t.always_to_person.some((p) => p.label === j.label)) return { decision: "to_person", label: j.label, probability: j.probability, reason: "always_to_person" };
  const rule = t.act_alone.find((a) => a.label === j.label);
  if (!rule) return { decision: "to_person", label: j.label, probability: j.probability, reason: "no_rule" };
  if (!(j.probability >= rule.min_probability)) return { decision: "to_person", label: j.label, probability: j.probability, reason: "below_threshold" };
  return { decision: "act_alone", label: j.label, probability: j.probability, min_probability: rule.min_probability, sampled: sampleKey !== undefined && shouldSample(t, sampleKey) };
}

/** Deterministic sampling: hash the key into [0, 1) and compare with sample.fraction.
 *  The weekly floor (min_per_week) is enforced by whoever runs the loop, since it
 *  needs a count this function does not have. */
export function shouldSample(t: Thresholds, key: string): boolean {
  if (t.sample.fraction <= 0) return false;
  if (t.sample.fraction >= 1) return true;
  // FNV-1a 32-bit — stable across platforms, no crypto needed.
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h / 0x100000000 < t.sample.fraction;
}
