import { promises as fs } from 'node:fs';
import path from 'node:path';
import kleur from 'kleur';

/**
 * Stryker emits a JSON report following the mutation-testing-elements schema:
 * https://github.com/stryker-mutator/mutation-testing-elements/tree/master/packages/report-schema
 *
 * Top-level shape (simplified):
 *   {
 *     schemaVersion: "1.x",
 *     thresholds: { high, low },
 *     files: {
 *       "src/foo.ts": {
 *         language: "typescript",
 *         source: "...source code...",
 *         mutants: [
 *           {
 *             id, mutatorName, status, replacement,
 *             location: { start: {line,column}, end: {line,column} },
 *             ...
 *           }
 *         ]
 *       }
 *     }
 *   }
 *
 * status is one of: Killed, Survived, NoCoverage, Timeout, CompileError,
 *                   RuntimeError, Ignored, Pending.
 *
 * We roll mutators into four buckets so users get a coverage-tool-style view
 * alongside the standard mutation score.
 */

// Mutator-to-category mapping. Categories are not exclusive at the *mutator*
// level, but at the *mutant* level each mutant goes to exactly one bucket
// based on its mutatorName. The rationale:
//
//   FUNCTIONS  — mutations that hollow out a function/method body. If these
//                survive, the function is effectively untested even if covered.
//   BRANCHES   — mutations that change which branch a conditional takes.
//                Survivors here mean a path isn't asserted on.
//   LINES      — mutations that change a single line's behavior (string/number
//                literal swap, arithmetic, array methods). Survivors mean the
//                line is executed but its effect isn't checked.
//   VARIATIONS — anything else: object literals, regex, optional chaining etc.
//                These are the "did you handle the weird case" mutations.
//
// Names come from the Stryker supported mutators page:
// https://stryker-mutator.io/docs/mutation-testing-elements/supported-mutators/
const MUTATOR_CATEGORIES = {
  // FUNCTIONS — body-level removal
  BlockStatement: 'functions',
  MethodExpression: 'functions',
  ArrowFunction: 'functions',

  // BRANCHES — conditionals & boolean logic
  ConditionalExpression: 'branches',
  EqualityOperator: 'branches',
  LogicalOperator: 'branches',
  BooleanLiteral: 'branches',
  UnaryOperator: 'branches',

  // LINES — statement-level expression mutations
  ArithmeticOperator: 'lines',
  AssignmentOperator: 'lines',
  UpdateOperator: 'lines',
  StringLiteral: 'lines',
  Regex: 'lines',
  ArrayDeclaration: 'lines',
  ObjectLiteral: 'lines',
  OptionalChaining: 'lines',
};

function categorize(mutatorName) {
  return MUTATOR_CATEGORIES[mutatorName] ?? 'variations';
}

/**
 * A mutant is "detected" (i.e. caught by tests) if its status is one of:
 *   - Killed     (tests failed — perfect)
 *   - Timeout    (mutant caused infinite loop, treated as detected)
 *
 * It is "valid" (counts toward the score denominator) if status is NOT one of:
 *   - CompileError  (mutant didn't even compile — skip)
 *   - RuntimeError  (something blew up unrelated to assertions)
 *   - Ignored       (user-excluded via config or comments)
 *   - Pending       (not yet run)
 *
 * NoCoverage and Survived both count as "not detected" — your tests didn't
 * catch the mutation. NoCoverage is a stronger signal: not even one test
 * touched that code path.
 *
 * This matches Stryker's own mutation score formula.
 */
const DETECTED_STATUSES = new Set(['Killed', 'Timeout']);
const UNDETECTED_STATUSES = new Set(['Survived', 'NoCoverage']);
const EXCLUDED_STATUSES = new Set(['CompileError', 'RuntimeError', 'Ignored', 'Pending']);

function isDetected(status) { return DETECTED_STATUSES.has(status); }
function isValid(status) { return !EXCLUDED_STATUSES.has(status); }

function emptyBucket() {
  return { total: 0, detected: 0, killed: 0, survived: 0, noCoverage: 0, timeout: 0 };
}

function emptyCategories() {
  return {
    functions: emptyBucket(),
    branches: emptyBucket(),
    lines: emptyBucket(),
    variations: emptyBucket(),
  };
}

/**
 * Walk every mutant in the Stryker JSON report and build:
 *   - overall: aggregate counts across all files
 *   - categories: per-category breakdown (functions/branches/lines/variations)
 *   - byFile: per-file overall + per-category breakdown
 *   - byMutator: per-mutator breakdown (e.g. how is EqualityOperator doing?)
 *   - survivorsByFile: array of survivor mutants for surfacing in the report
 */
export function buildEfficacyReport(strykerReport) {
  const overall = emptyBucket();
  const categories = emptyCategories();
  const byMutator = new Map();
  const byFile = new Map();
  const survivors = [];

  for (const [filePath, fileData] of Object.entries(strykerReport.files ?? {})) {
    const fileBucket = emptyBucket();
    const fileCategories = emptyCategories();

    for (const mutant of fileData.mutants ?? []) {
      const { status, mutatorName } = mutant;
      const category = categorize(mutatorName);

      // Skip excluded — they don't count toward anything.
      if (!isValid(status)) continue;

      const detected = isDetected(status);
      const buckets = [overall, fileBucket, categories[category], fileCategories[category]];
      for (const b of buckets) {
        b.total++;
        if (detected) b.detected++;
        if (status === 'Killed') b.killed++;
        else if (status === 'Survived') b.survived++;
        else if (status === 'NoCoverage') b.noCoverage++;
        else if (status === 'Timeout') b.timeout++;
      }

      // Mutator-level aggregation (across all files).
      if (!byMutator.has(mutatorName)) byMutator.set(mutatorName, emptyBucket());
      const m = byMutator.get(mutatorName);
      m.total++;
      if (detected) m.detected++;
      if (status === 'Killed') m.killed++;
      else if (status === 'Survived') m.survived++;
      else if (status === 'NoCoverage') m.noCoverage++;
      else if (status === 'Timeout') m.timeout++;

      // Capture survivors for the actionable list.
      if (status === 'Survived' || status === 'NoCoverage') {
        survivors.push({
          file: filePath,
          line: mutant.location?.start?.line,
          column: mutant.location?.start?.column,
          mutator: mutatorName,
          status,
          replacement: mutant.replacement,
          category,
        });
      }
    }

    byFile.set(filePath, { overall: fileBucket, categories: fileCategories });
  }

  return { overall, categories, byMutator, byFile, survivors };
}

// score = detected / total. Returns 100 when total === 0 so an empty bucket
// doesn't poison the average. Stryker's own formula matches this.
function pct(bucket) {
  return bucket.total === 0 ? 100 : (bucket.detected / bucket.total) * 100;
}

function colorScore(score) {
  if (score >= 99) return kleur.bold().green(score.toFixed(2) + '%');
  if (score >= 90) return kleur.green(score.toFixed(2) + '%');
  if (score >= 75) return kleur.yellow(score.toFixed(2) + '%');
  return kleur.red(score.toFixed(2) + '%');
}

function pad(s, n) { return String(s).padEnd(n); }
function padL(s, n) { return String(s).padStart(n); }

export function printEfficacyReport(report, opts = {}) {
  const { threshold = 99 } = opts;

  console.log('');
  console.log(kleur.bold().cyan('━━━━━━━━━━━━━━━━━━━ Mutation Efficacy Report ━━━━━━━━━━━━━━━━━━━'));

  // ---------- Overall ----------
  const overallScore = pct(report.overall);
  console.log('');
  console.log(kleur.bold('Overall'));
  console.log(`  Mutation score:       ${colorScore(overallScore)}  (target: ${threshold}%)`);
  console.log(`  Mutants generated:    ${report.overall.total}`);
  console.log(`  ${kleur.green('Killed')}              ${report.overall.killed}`);
  console.log(`  ${kleur.yellow('Timeout')}             ${report.overall.timeout}`);
  console.log(`  ${kleur.red('Survived')}            ${report.overall.survived}`);
  console.log(`  ${kleur.magenta('NoCoverage')}          ${report.overall.noCoverage}  ${kleur.dim('(no test touches this code)')}`);

  // ---------- Categories: Functions / Branches / Lines / Variations ----------
  console.log('');
  console.log(kleur.bold('Categories'));
  console.log('  ' + pad('Category', 14) + padL('Score', 9) + padL('Detected', 12) + padL('Total', 9) + padL('Survived', 12) + padL('NoCov', 9));
  console.log('  ' + kleur.dim('─'.repeat(65)));
  for (const cat of ['functions', 'branches', 'lines', 'variations']) {
    const b = report.categories[cat];
    const score = pct(b);
    console.log(
      '  ' +
      pad(cat.charAt(0).toUpperCase() + cat.slice(1), 14) +
      padL(colorScore(score), 9 + 10) + // +10 fudges for ansi codes
      padL(b.detected, 12) +
      padL(b.total, 9) +
      padL(b.survived, 12) +
      padL(b.noCoverage, 9)
    );
  }

  // ---------- Per-file ----------
  if (report.byFile.size > 0) {
    console.log('');
    console.log(kleur.bold('Per file'));
    console.log('  ' + pad('File', 50) + padL('Score', 9) + padL('Mutants', 10));
    console.log('  ' + kleur.dim('─'.repeat(75)));
    const entries = [...report.byFile.entries()].sort((a, b) => pct(a[1].overall) - pct(b[1].overall));
    for (const [file, data] of entries) {
      const score = pct(data.overall);
      const displayFile = file.length > 48 ? '…' + file.slice(-47) : file;
      console.log('  ' + pad(displayFile, 50) + padL(colorScore(score), 9 + 10) + padL(data.overall.total, 10));
    }
  }

  // ---------- Per-mutator ----------
  if (report.byMutator.size > 0) {
    console.log('');
    console.log(kleur.bold('Per mutator'));
    console.log('  ' + pad('Mutator', 28) + padL('Score', 9) + padL('Killed', 9) + padL('Survived', 11) + padL('Total', 8));
    console.log('  ' + kleur.dim('─'.repeat(67)));
    const entries = [...report.byMutator.entries()].sort((a, b) => pct(a[1]) - pct(b[1]));
    for (const [name, b] of entries) {
      const score = pct(b);
      console.log(
        '  ' + pad(name, 28) +
        padL(colorScore(score), 9 + 10) +
        padL(b.killed, 9) +
        padL(b.survived, 11) +
        padL(b.total, 8)
      );
    }
  }

  // ---------- Top survivors ----------
  if (report.survivors.length > 0) {
    console.log('');
    const shown = report.survivors.slice(0, 10);
    console.log(kleur.bold().red(`Top survivors (${report.survivors.length} total, showing ${shown.length})`));
    for (const s of shown) {
      const loc = `${s.file}:${s.line}:${s.column}`;
      const tag = s.status === 'NoCoverage' ? kleur.magenta('NoCov') : kleur.red('Surv ');
      console.log(`  ${tag}  ${kleur.dim(loc)}  ${kleur.yellow(s.mutator)}  ${kleur.dim('→')} ${truncate(s.replacement, 50)}`);
    }
    if (report.survivors.length > shown.length) {
      console.log(kleur.dim(`  …and ${report.survivors.length - shown.length} more. Open the HTML report for full details.`));
    }
  }

  // ---------- Verdict ----------
  console.log('');
  if (overallScore >= threshold) {
    console.log(kleur.bold().green(`✓ PASS  ${overallScore.toFixed(2)}% ≥ ${threshold}% threshold`));
  } else {
    console.log(kleur.bold().red(`✗ FAIL  ${overallScore.toFixed(2)}% < ${threshold}% threshold`));
  }
  console.log('');

  return { overallScore, passed: overallScore >= threshold };
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/**
 * Read Stryker's mutation.json from disk and produce the report.
 * This is the entry point the CLI calls after Stryker finishes.
 */
export async function generateEfficacyReport(jsonReportPath, opts) {
  const raw = await fs.readFile(jsonReportPath, 'utf8');
  const strykerReport = JSON.parse(raw);
  const efficacy = buildEfficacyReport(strykerReport);
  const result = printEfficacyReport(efficacy, opts);

  // Also write the structured report next to mutation.json for CI consumption.
  const outDir = path.dirname(jsonReportPath);
  const outPath = path.join(outDir, 'efficacy.json');
  await fs.writeFile(outPath, JSON.stringify({
    overall: efficacy.overall,
    categories: efficacy.categories,
    byMutator: Object.fromEntries(efficacy.byMutator),
    byFile: Object.fromEntries([...efficacy.byFile].map(([k, v]) => [k, v])),
    survivors: efficacy.survivors,
    overallScore: result.overallScore,
    threshold: opts?.threshold ?? 99,
    passed: result.passed,
  }, null, 2));
  console.log(kleur.dim(`Structured report written to ${outPath}`));

  return result;
}
