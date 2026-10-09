#!/usr/bin/env node
/** Exact-byte staging: the canonical browser rules remain the only authored rules. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'functions/floating-garden-online/core');
const check = process.argv.includes('--check');
const files = ['engine.js', 'match-engine.js', 'cpu.js'];
const esmPackage = `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`;
if (!check) await mkdir(output, { recursive: true });
for (const name of [...files, 'package.json']) {
  const expected = name === 'package.json' ? Buffer.from(esmPackage) : await readFile(path.join(root, 'lab/floating-garden', name));
  const destination = path.join(output, name);
  if (check) {
    let actual;
    try { actual = await readFile(destination); } catch { throw new Error(`Missing staged core: ${name}; run node scripts/prepare-floating-garden-core.mjs`); }
    if (!actual.equals(expected)) throw new Error(`Staged ${name} differs from canonical rules; run node scripts/prepare-floating-garden-core.mjs`);
  } else await writeFile(destination, expected);
}
console.log(check ? 'Floating Garden staged core matches canonical files exactly.' : 'Staged Floating Garden canonical ESM core.');
