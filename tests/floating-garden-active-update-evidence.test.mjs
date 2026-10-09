import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, lstat, chmod, symlink, link, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createPrivateEvidence, preservationDifference } from '../scripts/floating-garden-active-update-evidence.mjs';
const roots = [];
async function root() { const p = await mkdtemp(join(tmpdir(), 'garden-private-evidence-')); roots.push(p); return p; }
test.after(async () => { for (const p of roots) await rm(p, { force: true, recursive: true }); });
test('durable evidence holds no raw values, credentials, user IDs, URLs or arbitrary keys', async () => {
  const dir = await root(), sink = await createPrivateEvidence(dir);
  const value = { settings: { auth: { password: 'PASSWORD_SECRET', apiKey: 'API_KEY_SECRET', PRIVATE_DYNAMIC_KEY: 'TOKEN_SECRET' } },
    data: { testers: ['PRIVATE_UID'] }, proof: { run: { uri: 'https://private.invalid/SECRET' } } };
  await sink.append('baseline', value); await sink.append('preservation-failure', value);
  const files = await readdir(join(dir, 'PRIVATE-EVIDENCE')); assert.equal(files.length, 2);
  const a = await readFile(join(dir, 'PRIVATE-EVIDENCE', files[0]), 'utf8');
  for (const secret of ['PASSWORD_SECRET', 'API_KEY_SECRET', 'PRIVATE_DYNAMIC_KEY', 'TOKEN_SECRET', 'PRIVATE_UID', 'https://private.invalid/SECRET', 'password', 'apiKey']) assert(!a.includes(secret));
  const b = JSON.parse(await readFile(join(dir, 'PRIVATE-EVIDENCE', files[1]), 'utf8'));
  assert.equal(JSON.parse(a).captureCommitment, b.captureCommitment);
  assert.equal((await lstat(join(dir, 'PRIVATE-EVIDENCE', files[0]))).mode & 0o777, 0o600);
  assert.equal((await lstat(join(dir, 'PRIVATE-EVIDENCE'))).mode & 0o777, 0o700);
  const other = await root(), independent = await createPrivateEvidence(other); await independent.append('baseline', value);
  assert.notEqual(JSON.parse(await readFile(join(other, 'PRIVATE-EVIDENCE', '0000.json'))).captureCommitment, b.captureCommitment);
});
test('evidence refuses overwrite, symlink parents, open permissions and replaced capture directory', async () => {
  const dir = await root(); await createPrivateEvidence(dir); await assert.rejects(createPrivateEvidence(dir));
  const unsafe = await root(); await chmod(unsafe, 0o755); await assert.rejects(createPrivateEvidence(unsafe));
  const links = await root(), target = await root(); await symlink(target, join(links, 'alias')); await assert.rejects(createPrivateEvidence(join(links, 'alias')));
  const replace = await root(), sink = await createPrivateEvidence(replace);
  await rm(join(replace, 'PRIVATE-EVIDENCE'), { recursive: true }); await symlink(target, join(replace, 'PRIVATE-EVIDENCE'));
  await assert.rejects(sink.append('baseline', {}));
});
test('preexisting hardlink cannot be overwritten and failed evidence sink never retries', async () => {
  const dir = await root(), sink = await createPrivateEvidence(dir), target = join(dir, 'untouched');
  await writeFile(target, 'original', { mode: 0o600 }); await link(target, join(dir, 'PRIVATE-EVIDENCE', '0000.json'));
  await assert.rejects(sink.append('baseline', {})); assert.equal(await readFile(target, 'utf8'), 'original');
  await rm(join(dir, 'PRIVATE-EVIDENCE', '0000.json')); await assert.rejects(sink.append('baseline', {}));
});
test('fixed field paths report unknown keys without leaking them or values; strict equality remains external', () => {
  const diagnostic = preservationDifference({ run: { lastModifier: 'BEFORE_SECRET', PRIVATE_KEY: 1 } }, { run: { lastModifier: 'AFTER_SECRET', PRIVATE_KEY: 2 } }, 'functions');
  assert(diagnostic.paths.includes('functions.run.lastModifier')); assert(diagnostic.paths.includes('functions.run.$unknown')); assert(diagnostic.unknown);
  assert(!JSON.stringify(diagnostic).includes('PRIVATE_KEY')); assert(!JSON.stringify(diagnostic).includes('SECRET'));
  assert.throws(() => preservationDifference({}, {}, 'PRIVATE_CATEGORY'));
  const deepA = {}, deepB = {}; let a = deepA, b = deepB;
  for (let i = 0; i < 40; i++) { a = a.run = {}; b = b.run = {}; } a.state = 1; b.state = 2;
  assert.equal(preservationDifference(deepA, deepB, 'functions').truncated, true);
});
test('post-fsync path, hardlink, permissions and content substitution invalidate the saved claim', async () => {
  for (const mode of ['path', 'hardlink', 'mode', 'content']) {
    const dir = await root(), target = join(dir, 'PRIVATE-EVIDENCE', '0000.json');
    const sink = await createPrivateEvidence(dir, { syncFile: async file => {
      await file.sync();
      if (mode === 'path') { await rm(target); await writeFile(target, 'replacement', { mode: 0o600 }); }
      if (mode === 'hardlink') await link(target, join(dir, 'alias'));
      if (mode === 'mode') await chmod(target, 0o644);
      if (mode === 'content') await writeFile(target, 'replaced bytes');
    } });
    await assert.rejects(sink.append('baseline', { state: 'secret' }), mode);
    await assert.rejects(sink.append('baseline', { state: 'secret' }), 'no retry after uncertain persistence');
  }
});
