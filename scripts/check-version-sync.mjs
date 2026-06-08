#!/usr/bin/env node
/**
 * check-version-sync — fails if the version string has drifted across the files
 * that must agree. CLAUDE.md calls this out explicitly: openapi.json's version
 * "drifts easily" on release. This is the durable gate that makes the drift loud
 * instead of silent.
 *
 * Sources of truth that MUST match:
 *   - package.json            -> .version
 *   - src/version.ts          -> export const VERSION = '...'
 *   - openapi.json            -> .info.version
 *
 * Exit 0 when all agree; exit 1 with a diff when they don't. No dependencies,
 * no build step — plain Node ESM so CI can run it with `node`.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a file, or throw a clear error naming the missing path. */
function read(rel) {
  try {
    return readFileSync(join(root, rel), 'utf8');
  } catch (e) {
    throw new Error(`Cannot read ${rel}: ${e.message}`);
  }
}

const sources = [];

// package.json -> .version
{
  const pkg = JSON.parse(read('package.json'));
  sources.push({ file: 'package.json', version: pkg.version });
}

// src/version.ts -> export const VERSION = 'X.Y.Z'
{
  const txt = read('src/version.ts');
  const m = txt.match(/export\s+const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
  sources.push({ file: 'src/version.ts', version: m ? m[1] : undefined });
}

// openapi.json -> .info.version
{
  const spec = JSON.parse(read('openapi.json'));
  sources.push({ file: 'openapi.json', version: spec?.info?.version });
}

const missing = sources.filter((s) => !s.version);
if (missing.length > 0) {
  console.error('✖ version-sync: could not extract a version from:');
  for (const m of missing) console.error(`    - ${m.file}`);
  process.exit(1);
}

const unique = [...new Set(sources.map((s) => s.version))];
if (unique.length > 1) {
  console.error('✖ version-sync: version strings disagree across files:');
  for (const s of sources) console.error(`    ${s.version.padEnd(12)}  ${s.file}`);
  console.error('\n  Fix: set all three to the same version before releasing.');
  console.error('  (package.json, src/version.ts, openapi.json — see CLAUDE.md Release Process.)');
  process.exit(1);
}

console.log(`✓ version-sync: all sources agree on ${unique[0]}`);
process.exit(0);
