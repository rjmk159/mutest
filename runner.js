import path from 'node:path';
import { promises as fs } from 'node:fs';
import kleur from 'kleur';

/**
 * Run Stryker programmatically via its Node API rather than shelling out.
 *
 * Why the Node API?
 *  - We get back the array of MutantResult objects directly. No subprocess
 *    output parsing, no exit-code games.
 *  - We can pass our config object straight in (no temp file gymnastics).
 *  - Errors from Stryker become regular JS errors with stack traces.
 *
 * Stryker's API exports a `Stryker` class; calling `runMutationTest()` returns
 * a promise of mutant results. We don't strictly need those results because
 * Stryker also writes the JSON report to disk (per our config) and our
 * efficacy reporter reads that. But we use the returned array as the canonical
 * source for the run summary that follows.
 *
 * Reference: https://stryker-mutator.io/docs/stryker-js/api/
 */
export async function runStryker(strykerConfig, projectRoot) {
  // Dynamic import so that mutest itself doesn't fail to load when @stryker-mutator/core
  // isn't installed — the CLI checks for the peer dep first and gives a clean error.
  let StrykerCtor;
  try {
    const mod = await import('@stryker-mutator/core');
    StrykerCtor = mod.Stryker;
  } catch (err) {
    throw new Error(
      'Failed to load @stryker-mutator/core. Install it as a dev dependency: ' +
      'pnpm add -D @stryker-mutator/core @stryker-mutator/vitest-runner\n' +
      'Underlying error: ' + err.message
    );
  }

  // The Stryker constructor takes the partial config + an optional injector.
  // We resolve relative paths against the project root so that running mutest
  // from a different cwd doesn't break the config.
  const resolvedConfig = {
    ...strykerConfig,
  };

  // Make sure the output directories exist; Stryker creates them but we want
  // a stable place to write efficacy.json into even if the run aborts early.
  const reportDir = path.dirname(strykerConfig.jsonReporter?.fileName ?? 'reports/mutation/mutation.json');
  await fs.mkdir(path.join(projectRoot, reportDir), { recursive: true });

  const originalCwd = process.cwd();
  process.chdir(projectRoot);

  try {
    const stryker = new StrykerCtor(resolvedConfig);
    const results = await stryker.runMutationTest();
    return { results, jsonReportPath: path.join(projectRoot, strykerConfig.jsonReporter.fileName) };
  } finally {
    process.chdir(originalCwd);
  }
}

/**
 * Pretty-print a short summary directly from the in-memory MutantResult[].
 * This runs before the efficacy report so the user sees something quickly.
 */
export function quickSummary(results) {
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0, Pending: 0 };
  for (const r of results) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
  }
  console.log(kleur.dim(`Stryker completed: ${results.length} mutants — ` +
    `${counts.Killed} killed, ${counts.Survived} survived, ${counts.NoCoverage} no-coverage, ` +
    `${counts.Timeout} timeout, ${counts.CompileError} compile-error.`));
  return counts;
}
