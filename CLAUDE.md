# Tattle — rules for working on this project

Start with `/init-context <task>`. Before editing a file, run
`python3 .claude/skills/init-context/scripts/manifest-query.py --root . --affects <path>` and read what it names.

## Test-driven development (mandatory for every change)

Every fix, feature, refactor, or config change is test-first:

1. **Red**: write or extend the test that states the behaviour (for a bug, a test that reproduces it) and run it: it must fail, for the reason you expect.
2. **Green**: make the smallest change that passes it.
3. **Refactor** with the suite green.
4. Before committing: `npm run typecheck && npm run test:coverage`; if you touched the web page, the Mac app, or the capture helper, also `npm run test:e2e` / `npm run test:swift`. `npm run test:all` runs everything (and is step 1 of every release).

Rules:

- Put each test in its layer (unit, DOM, end-to-end web, end-to-end Mac app, Swift) as described in [docs/testing.md](docs/testing.md); reuse the fakes in `tests/fakes/`.
- Tests never touch the network or real services, and never read or write the real `~/Library/Application Support/Tattle` or `sessions/`: pass tmp paths.
- Never delete, skip, or loosen a test to get green. A known bug not fixed yet is an `it.fails("BUG …")`, not a deleted test.
- Coverage thresholds in `vitest.config.ts` only go up. An exclusion (`/* v8 ignore … -- @preserve */`) needs a written reason and is only for code that needs real hardware, macOS permissions, or a signed build.
- Never run `npm run smoke`, `preflight`, or a real session as a test: they spend money.

## Also

- Conventional commits (`/git-commit`); after a feature or fix, `/update-doc`.
- Releases only through `/release-tattle`.
