#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import kleur from 'kleur';
import { detectStack } from '../src/detect.js';
import { buildStrykerConfig } from '../src/config-builder.js';
import { runStryker, quickSummary } from '../src/runner.js';
import { generateEfficacyReport } from '../src/efficacy-report.js';
import { detectMonorepo } from '../src/workspace.js';
import { runMonorepo, aggregateResults, printMonorepoSummary } from '../src/monorepo.js';

const HELP = `
${kleur.bold('mutest')} — mutation testing for Vitest + React + TS projects

${kleur.bold('Usage')}
  mutest                            Auto-detect and run
  mutest --threshold 99             Fail if score < 99%
  mutest --init                     Write mutest.config.json with detected defaults
  mutest --dry-run                  Show config that would be used, don't run
  mutest --mutate "src/foo/**"      Override mutate glob (repeatable)
  mutest --config path/to.json      Use an explicit config file

${kleur.bold('Options')}
  --threshold <n>        Mutation score required to pass (default: 99)
  --threshold-apps <n>   In a monorepo, threshold for non-library packages
  --threshold-libs <n>   In a monorepo, threshold for library packages
  --filter <name>        In a monorepo, only run for matching package names (repeatable)
  --no-monorepo          Force single-package mode even if workspaces are detected
  --warn-only            Don't exit non-zero on threshold breach
  --concurrency <n>      Override worker count (default: CPU-1)
  --no-incremental       Disable incremental cache
  --report-only <p>      Skip Stryker, just regenerate report from existing JSON
  --help, -h             Show this help

${kleur.bold('Exit codes')}
  0   passed
  1   below threshold (unless --warn-only)
  2   configuration error
  3   Stryker run failed
`;

async function main() {
  const { values } = parseArgs({
    options: {
      help: { type: 'boolean', short: 'h' },
      init: { type: 'boolean' },
      'dry-run': { type: 'boolean' },
      'warn-only': { type: 'boolean' },
      'no-incremental': { type: 'boolean' },
      'no-monorepo': { type: 'boolean' },
      threshold: { type: 'string' },
      'threshold-apps': { type: 'string' },
      'threshold-libs': { type: 'string' },
      filter: { type: 'string', multiple: true },
      concurrency: { type: 'string' },
      mutate: { type: 'string', multiple: true },
      config: { type: 'string' },
      'report-only': { type: 'string' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const projectRoot = process.cwd();

  // ------------------------------------------------------------------
  // Monorepo branch: detect workspaces and dispatch to the orchestrator.
  // We skip this when invoked from inside a package by the orchestrator
  // itself (MUTEST_MONOREPO env var is set in the spawned children).
  // ------------------------------------------------------------------
  if (!values['no-monorepo'] && !process.env.MUTEST_MONOREPO) {
    const monorepo = await detectMonorepo(projectRoot);
    if (monorepo.isMonorepo && monorepo.packages.length > 0) {
      console.log(kleur.bold().cyan('mutest') + kleur.dim(`  monorepo detected at ${projectRoot}`));
      let packages = monorepo.packages;
      if (values.filter && values.filter.length > 0) {
        packages = packages.filter(p =>
          values.filter.some(f => p.name === f || p.name.includes(f))
        );
        if (packages.length === 0) {
          console.error(kleur.red(`No packages matched --filter: ${values.filter.join(', ')}`));
          return 2;
        }
      }
      const thresholds = {
        apps: values['threshold-apps'] ? Number(values['threshold-apps'])
            : values.threshold ? Number(values.threshold) : 80,
        libraries: values['threshold-libs'] ? Number(values['threshold-libs'])
            : values.threshold ? Number(values.threshold) : 80,
      };
      console.log(kleur.dim(`  packages: ${packages.length}  (${packages.map(p => p.name).join(', ')})`));
      console.log(kleur.dim(`  thresholds:  apps=${thresholds.apps}%  libraries=${thresholds.libraries}%`));

      const results = await runMonorepo({
        packages,
        thresholds,
        rootDir: projectRoot,
        warnOnly: values['warn-only'],
      });
      const aggregate = aggregateResults(results);
      const { anyFailed } = printMonorepoSummary(results, aggregate);

      // Write a top-level aggregate report.
      const aggPath = path.join(projectRoot, 'reports/mutation/monorepo-efficacy.json');
      await fs.mkdir(path.dirname(aggPath), { recursive: true });
      await fs.writeFile(aggPath, JSON.stringify({
        aggregate,
        packages: results.map(r => ({
          name: r.pkg.name,
          isLibrary: r.pkg.isLibrary,
          skipped: r.skipped,
          threshold: r.threshold ?? null,
          score: r.score ?? null,
          passed: r.passed ?? null,
        })),
        timestamp: new Date().toISOString(),
      }, null, 2));
      console.log(kleur.dim(`Aggregate report: ${path.relative(projectRoot, aggPath)}`));

      return anyFailed && !values['warn-only'] ? 1 : 0;
    }
  }

  // ------------------------------------------------------------------
  // Single-package branch (also used by each child in a monorepo run).
  // ------------------------------------------------------------------
  const stack = detectStack(projectRoot);

  console.log(kleur.bold().cyan('mutest') + kleur.dim(' — detecting project stack…'));
  console.log(kleur.dim(`  package manager:  ${stack.packageManager}`));
  console.log(kleur.dim(`  typescript:       ${stack.typescript ? 'yes' : 'no'}`));
  console.log(kleur.dim(`  react detected:   ${stack.react ? 'yes' : 'no'}`));
  console.log(kleur.dim(`  vitest config:    ${stack.vitestConfig ?? '(auto-discover)'}`));
  console.log(kleur.dim(`  stryker core:     ${stack.stryker.core ? 'installed' : kleur.red('MISSING')}`));
  console.log(kleur.dim(`  vitest-runner:    ${stack.stryker.vitest ? 'installed' : kleur.red('MISSING')}`));
  if (stack.typescript) {
    console.log(kleur.dim(`  ts-checker:       ${stack.stryker.tsChecker ? 'installed' : kleur.yellow('not installed (recommended for TS)')}`));
  }

  // --report-only short-circuits: just regenerate the efficacy report from
  // an existing mutation.json. Useful for CI where the run happened separately.
  if (values['report-only']) {
    const threshold = values.threshold ? Number(values.threshold) : 99;
    const result = await generateEfficacyReport(values['report-only'], { threshold });
    return result.passed || values['warn-only'] ? 0 : 1;
  }

  // ---- Build user options ----
  const userOpts = {};
  if (values.threshold) {
    const t = Number(values.threshold);
    if (Number.isNaN(t) || t < 0 || t > 100) {
      console.error(kleur.red(`Invalid --threshold: ${values.threshold}`));
      return 2;
    }
    userOpts.threshold = { high: t, low: Math.max(0, t - 10), break: t };
  }
  if (values.concurrency) userOpts.concurrency = Number(values.concurrency);
  if (values['no-incremental']) userOpts.incremental = false;
  if (values.mutate) userOpts.mutate = values.mutate;

  // Merge in any user config file. Order: detected stack + flags first, then
  // a config file overrides flags (config file wins on conflict).
  let fileConfig = null;
  const configPath = values.config ?? path.join(projectRoot, 'mutest.config.json');
  if (existsSync(configPath)) {
    try {
      fileConfig = JSON.parse(readFileSync(configPath, 'utf8'));
      console.log(kleur.dim(`  loaded user config: ${path.relative(projectRoot, configPath)}`));
    } catch (err) {
      console.error(kleur.red(`Failed to parse config file ${configPath}: ${err.message}`));
      return 2;
    }
  }

  const strykerConfig = buildStrykerConfig(stack, { ...userOpts, ...(fileConfig ?? {}) });

  // ---- --init: write the resolved config and exit ----
  if (values.init) {
    const outPath = path.join(projectRoot, 'mutest.config.json');
    if (existsSync(outPath)) {
      console.error(kleur.yellow(`${outPath} already exists. Remove it first to re-init.`));
      return 2;
    }
    // Write just the user-overridable surface, not every default.
    const initContent = {
      threshold: { high: 99, low: 90, break: 99 },
      mutate: strykerConfig.mutate,
      excludedMutations: [],
      incremental: true,
    };
    writeFileSync(outPath, JSON.stringify(initContent, null, 2) + '\n');
    console.log(kleur.green(`✓ wrote ${path.relative(projectRoot, outPath)}`));
    return 0;
  }

  // ---- --dry-run: print the Stryker config and exit ----
  if (values['dry-run']) {
    console.log('');
    console.log(kleur.bold('Resolved Stryker config:'));
    console.log(JSON.stringify(strykerConfig, null, 2));
    return 0;
  }

  // ---- Verify peer deps ----
  if (!stack.stryker.core || !stack.stryker.vitest) {
    console.error('');
    console.error(kleur.red('Required Stryker packages not found.'));
    const cmd = installCommand(stack.packageManager);
    console.error(kleur.dim(`Install with: `) + kleur.bold(`${cmd} -D @stryker-mutator/core @stryker-mutator/vitest-runner`));
    if (stack.typescript) {
      console.error(kleur.dim(`For TypeScript projects, also recommended: `) + kleur.bold(`${cmd} -D @stryker-mutator/typescript-checker`));
    }
    return 2;
  }

  // ---- Run Stryker ----
  console.log('');
  console.log(kleur.bold().cyan('Running Stryker…'));
  let runResult;
  try {
    runResult = await runStryker(strykerConfig, projectRoot);
  } catch (err) {
    console.error('');
    console.error(kleur.red('✗ Stryker run failed:'));
    console.error(err.stack || err.message);
    return 3;
  }

  quickSummary(runResult.results);

  // ---- Generate efficacy report ----
  const threshold = strykerConfig.thresholds?.break ?? 99;
  const efficacy = await generateEfficacyReport(runResult.jsonReportPath, { threshold });

  console.log(kleur.dim(`HTML report: ${path.relative(projectRoot, path.join(projectRoot, strykerConfig.htmlReporter.fileName))}`));
  console.log('');

  if (!efficacy.passed && !values['warn-only']) {
    return 1;
  }
  return 0;
}

function installCommand(pm) {
  return pm === 'pnpm' ? 'pnpm add' : pm === 'yarn' ? 'yarn add' : 'npm install';
}

main().then(
  (code) => process.exit(code ?? 0),
  (err) => {
    console.error(kleur.red('Unexpected error:'), err);
    process.exit(3);
  }
);
