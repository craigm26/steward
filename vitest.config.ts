import { defineConfig } from "vitest/config";

// Steward's own tests. The demo app under demo/ has its own node:test suite, run by its build, not by vitest.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
