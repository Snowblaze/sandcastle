---
"@ai-hero/sandcastle": patch
---

Refactor AgentProvider to runtime-only factory pattern. `run()` now requires `agent: claudeCode("model")` instead of `model: "..."`. The `claudeCode` factory and `AgentProvider` type are now exported from the package. Removed: `getAgentProvider`, `parseStreamJsonLine`, `formatToolCall`, `DEFAULT_MODEL` from public API.
