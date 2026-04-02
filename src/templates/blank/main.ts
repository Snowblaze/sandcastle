import { run, codex } from "@ai-hero/sandcastle";

// Blank template: customize this to build your own orchestration.
// Run this with: npx tsx .sandcastle/main.ts
// Or add to package.json scripts: "sandcastle": "npx tsx .sandcastle/main.ts"

await run({
  agent: codex("gpt-5.3-codex"),
  promptFile: "./.sandcastle/prompt.md",
});
