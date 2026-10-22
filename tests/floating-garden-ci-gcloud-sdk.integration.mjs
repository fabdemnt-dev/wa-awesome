// Explicit offline SDK integration entry. Never reads credentials or calls cloud.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { prepareCiPacket } from '../scripts/prepare-floating-garden-ci-packet.mjs';
import { ciFunctionDeployArguments, GCLOUD_SOURCE_IGNORE } from '../scripts/floating-garden-ci-gcloud.mjs';
import { validateSourceArchive } from '../scripts/floating-garden-trial-cloud-adapter.mjs';
import { FUNCTION_NAMES } from '../scripts/prepare-floating-garden-trial.mjs';
import { ACTIVE_UPDATE_SCOPE as S } from '../scripts/floating-garden-active-update.mjs';
const sdk = process.env.GARDEN_TEST_GCLOUD_SDK_ROOT;
assert(sdk && resolve(sdk) === sdk, 'explicit official SDK root required');
const dir = await mkdtemp(join(tmpdir(), 'garden-real-gcloud-source-'));
try {
  const reviewPath = join(dir, 'review.json'), output = join(dir, 'output');
  await writeFile(reviewPath, JSON.stringify({ schemaVersion: 1, startsAtMillis: S.startsAtMillis, endsAtMillis: S.endsAtMillis,
    testerUids: ['SYNTHETIC_A', 'SYNTHETIC_B'], retainBuildArtifacts: false, allowInitialFunctionRecreate: false, approvePublicInvoker: false }), { mode: 0o600 });
  await prepareCiPacket({ reviewPath, output, now: () => S.startsAtMillis + 1000 });
  const packet = join(output, 'packet'), source = join(packet, 'game/functions'), ignore = join(dir, 'source.ignore');
  const manifest = JSON.parse(await readFile(join(packet, 'OPERATION-MANIFEST.json')));
  const expectedFiles = Object.fromEntries(Object.entries(manifest.files).filter(([p]) => p.startsWith('game/functions/')).map(([p, hash]) => [p.slice(15), hash]));
  // Explicit ignored decoys cover the production dependency layout and private
  // files. The immutable generated source inventory itself remains unchanged.
  await mkdir(join(source, 'node_modules'), { recursive: true });
  await writeFile(join(source, 'node_modules/SYNTHETIC_DEPENDENCY'), 'never upload');
  await writeFile(join(source, '.SYNTHETIC_PRIVATE'), 'never upload');
  await writeFile(join(source, 'firebase-debug.log'), 'never upload');
  await writeFile(ignore, GCLOUD_SOURCE_IGNORE, { mode: 0o600 });
  const argv = FUNCTION_NAMES.map(name => ciFunctionDeployArguments({
    name: `projects/${S.project}/locations/${S.region}/functions/${name}`, environment: 'GEN_2', state: 'ACTIVE',
    buildConfig: { entryPoint: name, runtime: 'nodejs22', serviceAccount: `projects/${S.project}/serviceAccounts/${S.projectNumber}-compute@developer.gserviceaccount.com` },
    serviceConfig: { serviceAccountEmail: `garden-trial-runtime@${S.project}.iam.gserviceaccount.com` },
  }, source, ignore));
  const captureZip = join(dir, 'official-sdk-upload.zip');
  const fixture = join(dir, 'argv.json'); await writeFile(fixture, JSON.stringify({ argv, expectedFiles, captureZip }), { mode: 0o600 });
  const result = execFileSync('python3', ['-I', fileURLToPath(new URL('./floating-garden-ci-gcloud-sdk.test.py', import.meta.url)), '--sdk-root', sdk, '--argv-fixture', fixture],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, maxBuffer: 8 * 1024 * 1024 });
  console.log(result.trim());
  const archive = await readFile(captureZip);
  const expected = Object.fromEntries(await Promise.all(Object.keys(expectedFiles).map(async p => [p, await readFile(join(source, p))])));
  assert.throws(() => validateSourceArchive(archive, expected), 'legacy archive guard remains directory-free');
  assert.deepEqual(validateSourceArchive(archive, expected, { allowDirectoryEntries: true }), { verified: true, fileCount: Object.keys(expectedFiles).length });
  assert.equal(Object.keys(expectedFiles).length > 5, true);
  console.log('REAL_GCLOUD_PACKET: production argv and exact generated NPC source bytes plus production archive readback verified offline; no cloud execution.');
} finally { await rm(dir, { recursive: true, force: true }); }
