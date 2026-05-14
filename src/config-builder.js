/**
 * Build a Stryker config object. The shape matches stryker.config.json exactly,
 * so we can either feed this to Stryker's Node API or write it to disk for
 * inspection / debugging.
 *
 * Reference: https://stryker-mutator.io/docs/stryker-js/configuration/
 *
 * Design choices baked in:
 *  - testRunner: vitest                 (we only target Vitest in this wrapper)
 *  - coverageAnalysis: perTest          (forced by vitest-runner anyway; explicit for docs)
 *  - reporters: json + html + progress  (json is what our efficacy reporter post-processes)
 *  - disableTypeChecks: true            (Stryker default; prevents TS errors from mutants)
 *  - incremental: true                  (cache survivors between runs; massive speedup)
 */
export function buildStrykerConfig(stack, userOpts = {}) {
  const {
    threshold = { high: 99, low: 90, break: 99 },
    mutate,                       // optional override: array of globs
    excludedMutations = [],       // tighten/loosen mutator set
    concurrency,                  // undefined = Stryker's default (n-1 cores)
    incremental = true,
    dashboard,                    // { project, version, module } if pushing to stryker dashboard
  } = userOpts;

  // Default mutate glob:
  //  - JS/TS/JSX/TSX under src/ or lib/
  //  - Exclude .test, .spec, __tests__, .stories, .d.ts, type-only files
  const defaultMutate = [
    '{src,lib}/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
    '!{src,lib}/**/*.{test,spec}.{js,mjs,cjs,jsx,ts,mts,cts,tsx}',
    '!{src,lib}/**/*.stories.{js,jsx,ts,tsx}',
    '!{src,lib}/**/*.d.ts',
    '!{src,lib}/**/__tests__/**/*',
    '!{src,lib}/**/__mocks__/**/*',
  ];

  const config = {
    $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
    packageManager: stack.packageManager,
    testRunner: 'vitest',
    coverageAnalysis: 'perTest',
    mutate: mutate ?? defaultMutate,
    reporters: ['progress', 'clear-text', 'html', 'json'],
    htmlReporter: { fileName: 'reports/mutation/mutation.html' },
    jsonReporter: { fileName: 'reports/mutation/mutation.json' },
    clearTextReporter: {
      allowColor: true,
      reportTests: true,
      reportMutants: true,
      reportScoreTable: true,
      skipFull: false,
      maxTestsToLog: 3,
    },
    thresholds: threshold,
    incremental,
    incrementalFile: 'reports/mutation/stryker-incremental.json',
    timeoutMS: 60_000,
    timeoutFactor: 1.5,
    cleanTempDir: true,
  };

  if (concurrency !== undefined) {
    config.concurrency = concurrency;
  }

  // TypeScript: install the type checker if available — it pre-validates mutants
  // and skips ones that produce type errors before they hit the test runner.
  // This is the single biggest performance win on TS projects.
  if (stack.typescript && stack.stryker.tsChecker) {
    config.checkers = ['typescript'];
    config.tsconfigFile = 'tsconfig.json';
  }
  // Even without the checker plugin, we still want type errors disabled in
  // mutated files so they don't fail at compile time.
  config.disableTypeChecks = true;

  // Vitest plugin config (matches the shape from vitest-runner docs).
  config.vitest = {
    // If we found a Vitest config, point at it. Otherwise let Vitest auto-discover.
    ...(stack.vitestConfig ? { configFile: stack.vitestConfig } : {}),
    // Vitest's --related: only run tests that import the mutated file.
    // Safe default for unit tests; turn off if you have integration tests
    // that go through HTTP/IPC and don't import source directly.
    related: true,
  };

  if (excludedMutations.length > 0) {
    config.mutator = { excludedMutations };
  }

  // Dashboard push (optional).
  if (dashboard?.project) {
    config.dashboard = dashboard;
    if (!config.reporters.includes('dashboard')) {
      config.reporters.push('dashboard');
    }
  }

  return config;
}
