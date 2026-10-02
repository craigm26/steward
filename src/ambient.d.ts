// vendor/platatlas/thresholds.ts keeps a Node-only loader behind a lazy import that Steward never calls.
declare module "node:fs/promises" {
	export function readFile(path: string, encoding: string): Promise<string>;
}
