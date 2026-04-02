---
"@ai-hero/sandcastle": patch
---

Replace top-level `branch` option on `RunOptions` with a `worktree` discriminated union that explicitly models two workspace modes: `{ mode: 'temp-branch' }` (default) and `{ mode: 'branch', branch: string }`. This is a breaking change — the old `branch` field is removed.
