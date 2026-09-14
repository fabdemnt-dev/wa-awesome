import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('diagnostic-artifacts');
const versions = ['current', 'candidate'];
const expectedCases = ['minimal-submit', 'promise-all', 'sequential', 'get-all', 'six-rounds', 'readiness'];
const cases = [];
for (const version of versions) {
  for (const name of await readdir(path.join(root, version)).catch(() => [])) {
    try { cases.push(JSON.parse(await readFile(path.join(root, version, name, 'case-summary.json'), 'utf8'))); } catch {}
  }
}
const readiness = Object.fromEntries(versions.map((version) => {
  const found = cases.filter((item) => item.version === version);
  const valid = expectedCases.every((name) => {
    const item = found.find((candidate) => candidate.case === name);
    return item?.cli_available && item?.cli_version_matches && item?.firestore_emulator_started
      && item?.functions_emulator_started && item?.function_definitions_loaded
      && item?.test_module_loaded && item?.diagnostic_started;
  });
  return [version, { valid, cases_found: found.length }];
}));
await writeFile(path.join(root, 'summary.json'), `${JSON.stringify({
  version_comparison_valid: readiness.current.valid && readiness.candidate.valid,
  readiness,
  cases,
}, null, 2)}\n`);
