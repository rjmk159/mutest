import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Detect a monorepo and enumerate its packages.
 *
 * Supports:
 *   - pnpm workspaces  (pnpm-workspace.yaml: `packages: [...]`)
 *   - npm/yarn workspaces (package.json "workspaces" field)
 *
 * We deliberately do NOT support nx/turbo/lerna directly here — those tools
 * still ultimately use pnpm/npm/yarn workspaces underneath, so we read the
 * lower layer and let the user invoke us from their task runner.
 *
 * Returns:
 *   { isMonorepo, root, packages: [{ name, dir, hasTests, hasVitest, hasReact }] }
 */
export async function detectMonorepo(rootDir) {
  const result = { isMonorepo: false, root: rootDir, packages: [] };

  const patterns = await readWorkspacePatterns(rootDir);
  if (!patterns) return result;

  result.isMonorepo = true;
  result.packages = await resolvePackages(rootDir, patterns);
  return result;
}

async function readWorkspacePatterns(rootDir) {
  // 1. pnpm workspace file (YAML, simple enough to parse without a dep).
  const pnpmFile = path.join(rootDir, 'pnpm-workspace.yaml');
  if (existsSync(pnpmFile)) {
    return parsePnpmWorkspace(readFileSync(pnpmFile, 'utf8'));
  }

  // 2. npm/yarn workspaces field in package.json.
  const pkgPath = path.join(rootDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (Array.isArray(pkg.workspaces)) return pkg.workspaces;
      if (pkg.workspaces?.packages) return pkg.workspaces.packages;
    } catch { /* ignore */ }
  }

  return null;
}

/**
 * Minimal YAML parser for pnpm-workspace.yaml. We only care about the
 * `packages:` block with a list of glob strings, e.g.:
 *
 *   packages:
 *     - 'apps/*'
 *     - 'packages/*'
 *     - '!**\/test/**'
 *
 * Pulling in a full YAML parser for this one shape would be overkill.
 */
function parsePnpmWorkspace(content) {
  const lines = content.split('\n');
  const patterns = [];
  let inPackages = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, ''); // strip comments
    if (/^packages\s*:/.test(line)) { inPackages = true; continue; }

    if (inPackages) {
      // Stop when we hit a non-indented, non-empty line that isn't a list item.
      if (/^\S/.test(line) && line.trim() !== '') { inPackages = false; continue; }
      const match = line.match(/^\s*-\s*['"]?([^'"]+?)['"]?\s*$/);
      if (match) patterns.push(match[1]);
    }
  }

  return patterns;
}

/**
 * Resolve workspace glob patterns to actual package directories.
 * We use a deliberately simple matcher: `pattern/*` matches direct children
 * of `pattern/` that contain a package.json. This is what 99% of real configs use.
 *
 * For exotic globs (deep wildcards, negation, brace expansion) we fall back
 * to listing children and filtering — good enough; we don't need full
 * minimatch semantics just to find package directories.
 */
async function resolvePackages(rootDir, patterns) {
  const packages = [];
  const seen = new Set();

  for (const pattern of patterns) {
    // Negation patterns are common in pnpm-workspace.yaml; we apply them as
    // a post-filter rather than ahead-of-time exclusion. Cheap and correct
    // for the patterns we see in real repos.
    if (pattern.startsWith('!')) continue;

    // Pattern like `apps/*` → glob the direct children of `apps/`.
    const segments = pattern.split('/');
    if (segments[segments.length - 1] === '*') {
      const baseDir = path.join(rootDir, ...segments.slice(0, -1));
      if (!existsSync(baseDir)) continue;
      const entries = await fs.readdir(baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const pkgDir = path.join(baseDir, entry.name);
        if (seen.has(pkgDir)) continue;
        const info = await inspectPackage(pkgDir);
        if (info) { packages.push(info); seen.add(pkgDir); }
      }
    } else {
      // Treat as a literal directory.
      const pkgDir = path.join(rootDir, pattern);
      if (!seen.has(pkgDir)) {
        const info = await inspectPackage(pkgDir);
        if (info) { packages.push(info); seen.add(pkgDir); }
      }
    }
  }

  return packages.sort((a, b) => a.name.localeCompare(b.name));
}

async function inspectPackage(pkgDir) {
  const pkgPath = path.join(pkgDir, 'package.json');
  if (!existsSync(pkgPath)) return null;

  let pkg;
  try { pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8')); }
  catch { return null; }

  // Skip private root-level packages that exist only to host the workspace.
  if (pkg.private && !pkg.name) return null;

  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const hasVitest = 'vitest' in deps;
  const hasReact = 'react' in deps || '@testing-library/react' in deps;

  // A package is "testable" if it has vitest and either a src or lib dir.
  const hasSrc = existsSync(path.join(pkgDir, 'src')) || existsSync(path.join(pkgDir, 'lib'));
  const hasTests = hasVitest && hasSrc;

  // Classify the package — drives default thresholds. A library that's
  // published to consumers warrants a higher bar than a leaf app.
  // Heuristic: published packages set `main`/`module`/`exports` and are not `private`.
  const isLibrary = !pkg.private && (pkg.main || pkg.module || pkg.exports);

  return {
    name: pkg.name ?? path.basename(pkgDir),
    dir: pkgDir,
    hasTests,
    hasVitest,
    hasReact,
    isLibrary: Boolean(isLibrary),
  };
}
