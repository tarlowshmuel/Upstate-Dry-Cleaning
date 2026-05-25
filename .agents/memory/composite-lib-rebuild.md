---
name: Composite lib rebuild before consumer typecheck
description: lib/db (and any other composite library in this monorepo) emits .d.ts via tsc --build. Leaf artifacts cannot see new exports until the lib is rebuilt.
---

After editing `lib/db/src/schema/*` (new table, new column, new export from `index.ts`), running `pnpm --filter @workspace/api-server run typecheck` will fail with `has no exported member` errors even though the source is correct.

**Why:** api-server consumes lib/db through its emitted declaration files, not through source. The composite build is only refreshed by `tsc --build`.

**How to apply:** Always run `pnpm run typecheck:libs` (or `pnpm run typecheck`, which chains it) after schema edits, before checking consumer artifacts. Editor/LSP may show green because tsserver uses project references; trust the CLI.
