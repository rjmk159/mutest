# mutest

Opinionated wrapper around [StrykerJS](https://stryker-mutator.io/) for **Vitest + React Testing Library + TypeScript** projects.

Stryker does the actual mutation testing. `mutest` adds:

- **Zero-config auto-detection** of your package manager, Vitest config, and TypeScript setup.
- **A Functions / Branches / Lines / Variations report** layered on top of Stryker's standard report — mapping mutators to coverage-tool categories so the output reads like familiar coverage output.
- **A single `--threshold N` flag** that gates CI on mutation efficacy (default 99%).
- **`--report-only`** mode that just re-renders the report from a previous Stryker run — useful in CI when you want the run and report in separate jobs.
- **A clean install/setup story** for pnpm, yarn, and npm.

It is genuinely Stryker underneath — same engine, same JSON schema, same HTML report. You can always drop back to running Stryker directly.

---

## Install

```bash
# pnpm
pnpm add -D mutest @stryker-mutator/core @stryker-mutator/vitest-runner
pnpm add -D @stryker-mutator/typescript-checker   # recommended for TS

# yarn
yarn add -D mutest @stryker-mutator/core @stryker-mutator/vitest-runner
yarn add -D @stryker-mutator/typescript-checker

# npm
npm install -D mutest @stryker-mutator/core @stryker-mutator/vitest-runner
npm install -D @stryker-mutator/typescript-checker
```

Stryker packages are peer dependencies — `mutest` doesn't bundle them, so you control the version.

## Run

```bash
# Default: auto-detect everything, fail if score < 99%
npx mutest

# Lower threshold while bootstrapping
npx mutest --threshold 80

# See what config would be used without running
npx mutest --dry-run

# Write a mutest.config.json with sensible defaults to customize from
npx mutest --init
```

Add to `package.json`:

```json
{
  "scripts": {
    "test:mutation": "mutest",
    "test:mutation:ci": "mutest --threshold 99"
  }
}
```

## What you'll see

```
mutest — detecting project stack…
  package manager:  pnpm
  typescript:       yes
  react detected:   yes
  vitest config:    vitest.config.ts
  stryker core:     installed
  vitest-runner:    installed
  ts-checker:       installed

Running Stryker…
[Stryker's own progress output]

━━━━━━━━━━━━━━━━━━━ Mutation Efficacy Report ━━━━━━━━━━━━━━━━━━━

Overall
  Mutation score:       73.33%  (target: 99%)
  Mutants generated:    15
  Killed              11
  Timeout             0
  Survived            3
  NoCoverage          1  (no test touches this code)

Categories
  Category          Score    Detected    Total    Survived    NoCov
  ─────────────────────────────────────────────────────────────────
  Functions         66.67%           2        3           0        1
  Branches          83.33%           5        6           1        0
  Lines             66.67%           4        6           2        0
  Variations       100.00%           0        0           0        0

Per file ...
Per mutator ...
Top survivors ...

✗ FAIL  73.33% < 99% threshold
```

Plus three artifacts written to `reports/mutation/`:

- `mutation.html` — Stryker's interactive HTML report (open in a browser, click into surviving mutants line-by-line)
- `mutation.json` — Stryker's machine-readable report
- `efficacy.json` — the structured Functions/Branches/Lines breakdown for CI consumption

## How the category mapping works

Mutation testing doesn't natively have a Functions/Branches/Lines split — that vocabulary is from line-coverage tools. `mutest` rolls Stryker's mutators into those buckets so the report reads naturally:

| Category | Mutators included | What a survivor means |
|---|---|---|
| **Functions** | `BlockStatement`, `MethodExpression`, `ArrowFunction` | Function is called but its effect isn't asserted on |
| **Branches** | `ConditionalExpression`, `EqualityOperator`, `LogicalOperator`, `BooleanLiteral`, `UnaryOperator` | A branch direction isn't distinguished by your tests |
| **Lines** | `ArithmeticOperator`, `AssignmentOperator`, `UpdateOperator`, `StringLiteral`, `Regex`, `ArrayDeclaration`, `ObjectLiteral`, `OptionalChaining` | A line is executed but its specific value/effect isn't checked |
| **Variations** | Anything else | Edge cases your tests don't probe |

Each individual mutant ends up in exactly one bucket based on its `mutatorName`. The mapping is in `src/efficacy-report.js` if you want to tweak it.

## Getting to 99%+ efficacy in practice

Real talk: 99% is very high. The path to that score, in order:

1. **Run once and read survivors top-down.** Each surviving mutant is a concrete test you're missing. Add an assertion, not a test file.
2. **Cover both branch directions, including boundaries.** If you test `age = 30` and `age = 10` for an `age >= 18` check, the mutation `>=` → `>` survives because both your test values are far from the boundary. Add `age = 18`.
3. **Assert on return values, not just on "it ran".** Tests like `expect(() => fn()).not.toThrow()` won't kill any return-value mutation.
4. **Use `excludedMutations` sparingly for genuinely equivalent mutants** — e.g. `StringLiteral` mutations of internal-only error messages. Add a comment explaining each exclusion.
5. **Use `// Stryker disable next-line` for code that genuinely can't be tested** (e.g. defensive `// istanbul ignore`-style guards).
6. **Accept some `NoCoverage`** for code that's intentionally not covered (e.g. polyfills, dev-only branches). Either delete that code or document why.

Some equivalent mutants (semantically identical to the original) will always survive — this is inherent to mutation testing. 100% is theoretically impossible on any non-trivial codebase. 99% is the practical ceiling.

## CLI reference

| Flag | Default | Notes |
|---|---|---|
| `--threshold N` | 99 | Score required to pass (0-100). Sets Stryker's `thresholds.break` too. |
| `--warn-only` | off | Don't exit non-zero on threshold breach. |
| `--mutate <glob>` | (auto) | Override the mutate glob. Repeatable. |
| `--config <path>` | `mutest.config.json` | Explicit config file. |
| `--concurrency <n>` | CPU-1 | Override worker count. |
| `--no-incremental` | off | Disable Stryker's incremental cache. |
| `--init` | — | Write `mutest.config.json` with detected defaults. |
| `--dry-run` | — | Print the resolved Stryker config and exit. |
| `--report-only <p>` | — | Skip the run, just regenerate the efficacy report from a previous `mutation.json`. |

## Config file

`mutest.config.json` (all keys optional):

```json
{
  "threshold": { "high": 99, "low": 90, "break": 99 },
  "mutate": [
    "src/**/*.{ts,tsx}",
    "!src/**/*.test.{ts,tsx}",
    "!src/**/*.stories.tsx"
  ],
  "excludedMutations": ["StringLiteral"],
  "incremental": true,
  "concurrency": 4,
  "dashboard": {
    "project": "github.com/your-org/your-repo",
    "version": "main"
  }
}
```

Any key not listed here can be added inside the config — it gets passed straight through to Stryker (see [the Stryker configuration reference](https://stryker-mutator.io/docs/stryker-js/configuration/) for the full list).

## CI

GitHub Actions example with caching for the incremental file:

```yaml
- uses: actions/cache@v4
  with:
    path: reports/mutation/stryker-incremental.json
    key: stryker-${{ github.ref }}-${{ hashFiles('src/**/*') }}
    restore-keys: stryker-${{ github.ref }}-

- run: pnpm test:mutation:ci
```

The first run is slow. Subsequent runs only re-test files that changed and any survivors — typically 5-10× faster.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | Passed (score ≥ threshold) |
| 1 | Below threshold (suppressed by `--warn-only`) |
| 2 | Configuration error |
| 3 | Stryker run itself failed |
