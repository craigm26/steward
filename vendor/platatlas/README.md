# Vendored from PlatAtlas

These four files are copied unchanged from PlatAtlas/rail at commit 8f85ce1 (origin/main, 2026-10-01).
They keep their MIT License (LICENSE in this folder). Steward imports them as they are: no edits, so a diff
against the source stays empty.

| File | Source path | What Steward uses it for |
| --- | --- | --- |
| `judgment-core.ts` | `packages/inference/src/judgment-core.ts` | The judge contract, the TypeSafe (Jev) backend and the mock |
| `thresholds.ts` | `packages/controls/src/thresholds.ts` | `thresholds.yaml`, the YAML-subset reader for playbooks, sampling |
| `grants.ts` | `packages/controls/src/grants.ts` | Auto-merge as a grant: earned on evidence, suspended on drift |
| `report.ts` | `apps/platatlas-worker/src/suggest/report.ts` | The check's report and history line |
