---
"@ai-hero/sandcastle": patch
---

Migrate from npm to pnpm across the project (issue #168).

- Added `packageManager: "pnpm@10.7.0"` to `package.json`
- Generated `pnpm-lock.yaml` (replaces `package-lock.json`)
- Updated CI and release workflows to use `pnpm/action-setup` and `pnpm` commands
- Updated all template `main.ts` files to use `pnpm install` in `onSandboxReady` hooks
- Updated all prompt files (`.sandcastle/` and `src/templates/`) to reference `pnpm run typecheck` and `pnpm run test`
- Updated `README.md` development and hooks examples to use pnpm
- Updated `InitService.ts` next-steps text to reference pnpm
