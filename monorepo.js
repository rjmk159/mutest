import path from 'node:path';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import kleur from 'kleur';

/**
 * Run mutest sequentially in each package. We do NOT parallelize across
 * packages because each package's Stryker run is already heavily parallelized
 * internally (worker pool over CPU cores). Running two Stryker runs at once
 * just causes them to fight over the same CPUs and the same Vitest's vmThreads.
 */
export async function runMonorepo({ packages, thresholds, rootDir, warnOnly }) {
  const results = [];

  for (const pkg of packages) {
    if (!pkg.hasTests) {
      console.log(kleur.dim(`▢ ${pkg.name}  ${kleur.italic('skipped (no vitest or no src/)')}`));
      results.push({ pkg, skipped: true, reason: 'no vitest or no src/' });
      continue;
    }

    const threshold = pickThreshold(pkg, thresholds);
    console.log('');
    console.log(kleur.bold().cyan(`▶ ${pkg.name}`) + kleur.dim(`  threshold: ${threshold}%${pkg.isLibrary ? ' (library)' : ''}`));

    const exitCode = await runMutestInPackage(pkg.dir, threshold, { warnOnly });
    const efficacyPath = path.join(pkg.dir, 'reports/mutation/efficacy.json');
    let efficacy = null;
    if (existsSync(efficacyPath)) {
      try { efficacy = JSON.parse(await fs.readFile(efficacyPath, 'utf8')); }
      catch { /* leave null */ }
    }

    results.push({
      pkg,
      skipped: false,
      threshold,
      exitCode,
      passed: efficacy ? efficacy.overallScore >= threshold : false,
      score: efficacy?.overallScore ?? null,
      categories: efficacy?.categories ?? null,
      survivors: efficacy?.survivors?.length ?? null,
    });
  }

  return results;
}

/**
 * Per-package threshold. Library packages get the higher (`libraries`)
 * threshold; everything else gets `apps`. The defaults reflect the reality
 * that a published library has a wider blast radius for any bug.
 */
function pickThreshold(pkg, thresholds) {
  if (pkg.isLibrary) return thresholds.libraries ?? thresholds.apps ?? 80;
  return thresholds.apps ?? 80;
}

function runMutestInPackage(pkgDir, threshold, { warnOnly }) {
  return new Promise((resolve) => {
    // We invoke our own bin via node so that the child inherits no shell
    // weirdness. We resolve the bin relative to this file.
    const binPath = path.resolve(new URL('../bin/mutest.js', import.meta.url).pathname);

    const args = [binPath, '--threshold', String(threshold)];
    if (warnOnly) args.push('--warn-only');

    const child = spawn(process.execPath, args, {
      cwd: pkgDir,
      stdio: 'inherit',
      env: { ...process.env, MUTEST_MONOREPO: '1' },
    });
    child.on('close', (code) => resolve(code ?? 0));
  });
}

/**
 * Aggregate the per-package efficacy reports into a single roll-up.
 * We average scores weighted by mutant count, because a 10-mutant package
 * at 100% should not balance out a 1000-mutant package at 50%.
 */
export function aggregateResults(results) {
  let totalMutants = 0, totalDetected = 0;
  const categoryTotals = { functions: { total: 0, detected: 0 }, branches: { total: 0, detected: 0 }, lines: { total: 0, detected: 0 }, variations: { total: 0, detected: 0 } };

  for (const r of results) {
    if (r.skipped || !r.categories) continue;
    for (const cat of ['functions', 'branches', 'lines', 'variations']) {
      categoryTotals[cat].total += r.categories[cat]?.total ?? 0;
      categoryTotals[cat].detected += r.categories[cat]?.detected ?? 0;
    }
    // Recover the package's mutant total from its categories.
    const pkgTotal = Object.values(r.categories).reduce((s, c) => s + (c?.total ?? 0), 0);
    const pkgDetected = Object.values(r.categories).reduce((s, c) => s + (c?.detected ?? 0), 0);
    totalMutants += pkgTotal;
    totalDetected += pkgDetected;
  }

  return {
    totalMutants,
    totalDetected,
    overallScore: totalMutants === 0 ? 100 : (totalDetected / totalMutants) * 100,
    categories: Object.fromEntries(
      Object.entries(categoryTotals).map(([k, v]) => [k, {
        ...v,
        score: v.total === 0 ? 100 : (v.detected / v.total) * 100,
      }])
    ),
  };
}

function colorScore(score) {
  if (score >= 99) return kleur.bold().green(score.toFixed(2) + '%');
  if (score >= 90) return kleur.green(score.toFixed(2) + '%');
  if (score >= 75) return kleur.yellow(score.toFixed(2) + '%');
  return kleur.red(score.toFixed(2) + '%');
}

export function printMonorepoSummary(results, aggregate) {
  console.log('');
  console.log(kleur.bold().cyan('━━━━━━━━━━━━━━━━━━━ Monorepo Summary ━━━━━━━━━━━━━━━━━━━'));
  console.log('');

  const pad = (s, n) => String(s).padEnd(n);
  const padL = (s, n) => String(s).padStart(n);

  // Per-package table
  console.log('  ' + pad('Package', 32) + pad('Type', 10) + padL('Score', 11) + padL('Threshold', 12) + padL('Status', 10));
  console.log('  ' + kleur.dim('─'.repeat(75)));
  for (const r of results) {
    if (r.skipped) {
      console.log('  ' + pad(r.pkg.name, 32) + pad('—', 10) + padL('—', 11) + padL('—', 12) + padL(kleur.dim('skipped'), 10 + 10));
      continue;
    }
    const status = r.passed ? kleur.green('PASS') : kleur.red('FAIL');
    const scoreText = r.score === null ? kleur.red('(no report)') : colorScore(r.score);
    console.log(
      '  ' + pad(r.pkg.name, 32) +
      pad(r.pkg.isLibrary ? 'library' : 'app', 10) +
      padL(scoreText, 11 + 10) +
      padL(r.threshold + '%', 12) +
      padL(status, 10 + 10)
    );
  }

  // Aggregate
  console.log('');
  console.log(kleur.bold('Aggregate (weighted by mutant count)'));
  console.log(`  Overall:    ${colorScore(aggregate.overallScore)}  (${aggregate.totalDetected}/${aggregate.totalMutants})`);
  console.log(`  Functions:  ${colorScore(aggregate.categories.functions.score)}  (${aggregate.categories.functions.detected}/${aggregate.categories.functions.total})`);
  console.log(`  Branches:   ${colorScore(aggregate.categories.branches.score)}  (${aggregate.categories.branches.detected}/${aggregate.categories.branches.total})`);
  console.log(`  Lines:      ${colorScore(aggregate.categories.lines.score)}  (${aggregate.categories.lines.detected}/${aggregate.categories.lines.total})`);
  console.log(`  Variations: ${colorScore(aggregate.categories.variations.score)}  (${aggregate.categories.variations.detected}/${aggregate.categories.variations.total})`);

  const anyFailed = results.some(r => !r.skipped && !r.passed);
  console.log('');
  if (anyFailed) {
    console.log(kleur.bold().red('✗ One or more packages failed their threshold.'));
  } else {
    console.log(kleur.bold().green('✓ All packages passed their thresholds.'));
  }
  console.log('');

  return { anyFailed };
}
