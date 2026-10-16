# AGENTS.md

Guidelines for AI agents and contributors working in this repository.

## What this repo is

Pioneer (`@vastward/pioneer`) is a CLI and programmatic generator that turns
Buf protobuf sources into typed npm SDK packages. Layout:

- `src/generator/` — generation pipeline (protobuf, protoc, emit, React hooks, REST, typecheck).
- `src/runtime/` — runtime code shipped with generated packages (`src/runtime` is in `files`).
- `src/release.mjs` — release helper used by the release workflow.
- `scripts/gen.ts` — CLI entry point (`pioneer` bin, built to `dist/cli.js`).
- `tests/unit/` — `bun:test` unit tests; `tests/fixtures/` — offline fixtures.
- `dist/` and `gen/` are build/generated output. Do not hand-edit them.

`README.md` is the authoritative reference for the generation pipeline and
verification details. Read the "Tool development and verification" section
before changing generator behavior.

## Toolchain

- Bun (`1.4.3` in CI) is the package manager and test runner. Node `>=20.19.0`
  is required; CI uses Node `24.22.0`.
- Install with the frozen lockfile and without lifecycle scripts:
  `bun --no-env-file --no-install install --frozen-lockfile --ignore-scripts`
  (plain `bun install` also works locally, but keep `bun.lock` unchanged unless
  you are intentionally changing dependencies).
- Scripts in `package.json` already pass `--no-env-file`. Keep that flag.

## Commands

```sh
bun run lint          # biome check (format + lint + import organization)
bun run lint:fix      # apply safe fixes
bun run typecheck     # tsc --noEmit
bun run build         # rolldown bundle + declaration emit into dist/
bun run test:unit     # bun test tests/unit
```

Before reporting work as done, run at least `lint`, `typecheck`, and
`test:unit`. Run `build` too when you touch `src/`, `scripts/`, or the
bundling config. CI runs the same set in this order.

## Code style

- Biome is the single source of truth for formatting and linting. Don't fight it.
- Tabs for indentation in `src/`, `tests/`, and `scripts/`.
- Double quotes, no semicolons (ASI style), no trailing commas.
- Match the surrounding file's idioms and comment density. Keep changes minimal
  and scoped to the task.
- ESM only (`"type": "module"`). Use `node:`-prefixed built-in imports.
- Relative imports in TypeScript use the `.js` extension (e.g. `./emit.js`).
- Don't add dependencies without a clear reason. Code under `src/runtime` ships
  to consumers, so keep it free of dev-only imports.

## Commits and pull requests

- Use Conventional Commits, enforced by commitlint on `commit-msg`. Scopes
  used in this repo include `general`, e.g. `feat(general): add --license flag`.
  Common types: `feat`, `fix`, `perf`, `build`, `docs`, `test`, `refactor`, `chore`.
- The `prepare-commit-msg` hook offers an interactive commitizen prompt; that is fine for humans.
- Pre-commit runs `lint-staged` (Biome fixes on staged `src/` files).
- Pre-push runs `bun lint`. Don't bypass hooks with `--no-verify`.
- Keep PRs focused on one change. Describe what changed and how you verified it.
- Target branch is `main`.

## Secrets and safety

- Never commit `.env`, `.env.*`, or `.npmrc`. CI fails the build if any of
  them are present in the tree. Don't read their values into chat or logs.
- Don't add credentials, mnemonics, or live API keys to fixtures or tests.
  Tests use mocked transports and offline fixtures.
- Don't run commands that submit transactions or touch live networks as part
  of routine verification.
- Generation writes are atomic per run: a failed check leaves output untouched.
  The strict type check runs without `skipLibCheck`; keep it that way.

## Working in generated output

- Don't hand-edit files under a generated package's output directory. Change
  the generator or templates in `src/generator/` and regenerate instead.
- Keep handwritten code outside generator output directories. Generation
  rejects unmanaged files rather than deleting them.
