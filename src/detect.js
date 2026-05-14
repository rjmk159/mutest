import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Detect the package manager from lockfiles. Order matters: pnpm > yarn > npm
 * because pnpm projects usually keep a package-lock.json around from history.
 */
export function detectPackageManager(projectRoot) {
  if (existsSync(path.join(projectRoot, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(path.join(projectRoot, 'yarn.lock'))) return 'yarn';
  if (existsSync(path.join(projectRoot, 'package-lock.json'))) return 'npm';

  // Fallback: respect packageManager field in package.json (Corepack standard).
  const pkgPath = path.join(projectRoot, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.packageManager) {
        const name = pkg.packageManager.split('@')[0];
        if (['pnpm', 'yarn', 'npm'].includes(name)) return name;
      }
    } catch { /* ignore parse errors */ }
  }

  return 'npm';
}

export function detectTypeScript(projectRoot) {
  return existsSync(path.join(projectRoot, 'tsconfig.json'));
}

/**
 * Detect Vitest config file. Vitest looks for these in order; we match that order
 * so the config we point Stryker at is the same one Vitest would pick up.
 */
export function detectVitestConfig(projectRoot) {
  const candidates = [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.cts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vitest.config.cjs',
    'vite.config.ts',
    'vite.config.js',
  ];
  for (const name of candidates) {
    if (existsSync(path.join(projectRoot, name))) return name;
  }
  return undefined;
}

/**
 * Look for React or React Testing Library in dependencies. If either is present
 * we know we need JSX-aware mutation; Stryker handles this automatically but
 * we use this to recommend the right `mutate` glob.
 */
export function detectReact(projectRoot) {
  const pkgPath = path.join(projectRoot, 'package.json');
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Boolean(
      allDeps.react ||
      allDeps['@testing-library/react'] ||
      allDeps['@testing-library/jest-dom']
    );
  } catch {
    return false;
  }
}

/**
 * Check that the user has the required Stryker packages installed.
 * Stryker is a peer dep — we don't bundle it.
 */
export function detectStrykerInstall(projectRoot) {
  const result = { core: false, vitest: false, tsChecker: false };
  const nm = path.join(projectRoot, 'node_modules', '@stryker-mutator');
  if (!existsSync(nm)) return result;
  result.core = existsSync(path.join(nm, 'core'));
  result.vitest = existsSync(path.join(nm, 'vitest-runner'));
  result.tsChecker = existsSync(path.join(nm, 'typescript-checker'));
  return result;
}

export function detectStack(projectRoot) {
  return {
    projectRoot,
    packageManager: detectPackageManager(projectRoot),
    typescript: detectTypeScript(projectRoot),
    vitestConfig: detectVitestConfig(projectRoot),
    react: detectReact(projectRoot),
    stryker: detectStrykerInstall(projectRoot),
  };
}
