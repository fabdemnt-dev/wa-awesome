import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

if (!['10', '20'].includes(process.env.DIAGNOSTIC_ATTEMPTS)) {
  throw new Error('DIAGNOSTIC_ATTEMPTS must be 10 or 20');
}
const attempts = Number(process.env.DIAGNOSTIC_ATTEMPTS);

const target = 'a normal outcome ends the game and rejects next-round readiness';
const command = `node --test --test-force-exit --test-name-pattern="${target}" tests/moon-scale-duel-online-integration.test.mjs`;
const args = ['--config', 'firebase.moon-scale-duel-emulator.json', 'emulators:exec', '--only', 'auth,firestore,database,functions', '--project', 'demo-moon-scale-duel', command];

function trial() {
  return new Promise((resolve) => {
    const child = spawn('node_modules/.bin/firebase', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let exceeded = false;
    let timedOut = false;
    let spawnFailed = false;
    const collect = (data) => {
      // Never print raw emulator output: it may include test data or credentials.
      if (output.length < 2_000_000) output += data.toString();
      else exceeded = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240_000);
    child.on('error', () => { spawnFailed = true; });
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      resolve({ status, signal, output, timedOut, exceeded, spawnFailed });
    });
  });
}

// Interpret child output privately. Only fixed labels and booleans reach Actions logs.
function observe(output, result) {
  const emulatorReady = /All emulators ready!|All emulators ready\./i.test(output);
  const firestoreReady = emulatorReady && /(?:│|\|)\s*Firestore\s*(?:│|\|)/i.test(output);
  const functionsReady = emulatorReady && /(?:│|\|)\s*Functions\s*(?:│|\|)/i.test(output);
  const testLaunched = /emulators: Running script:/i.test(output);
  const targetReported = output.includes(`- ${target}`);
  const testPassed = targetReported && /^# pass 1\s*$/m.test(output) && /^# fail 0\s*$/m.test(output);
  const transactionError = /Transaction is invalid or closed\./i.test(output);
  const firestoreError = /(?:Error|Failed|Could not|Unable).*firestore|firestore.*(?:Error|Failed|Could not|Unable)/i.test(output);
  const functionsError = /(?:Error|Failed|Could not|Unable).*functions emulator|functions emulator.*(?:Error|Failed|Could not|Unable)/i.test(output);
  let category = 'unknown';
  if (result.timedOut) category = 'timeout';
  else if (transactionError) category = 'transaction-invalid-or-closed';
  else if (firestoreError && !firestoreReady) category = 'firestore-emulator-start-failure';
  else if (functionsError && !functionsReady) category = 'functions-emulator-start-failure';
  else if (emulatorReady && !testLaunched) category = 'test-start-failure';
  else if (testLaunched && targetReported) category = 'test-failure';
  return { firestoreReady, functionsReady, testLaunched, targetReported, testPassed, category };
}

let passed = 0;
for (let i = 1; i <= attempts; i++) {
  console.log(`Trial ${i}/${attempts}: start; firebase-emulator-start`);
  const start = performance.now();
  const result = await trial();
  const { status, signal, output, timedOut, exceeded, spawnFailed } = result;
  const duration = ((performance.now() - start) / 1000).toFixed(1);
  const observed = observe(output, result);
  const success = status === 0 && observed.testPassed && !timedOut && !exceeded && !spawnFailed;
  console.log(`Trial ${i}: firestore-ready=${observed.firestoreReady}; functions-ready=${observed.functionsReady}; test-process-launched=${observed.testLaunched}; target-test-reported=${observed.targetReported}`);
  console.log(`Trial ${i}: ${success ? 'PASS' : 'FAIL'}; ${duration}s; exit-code=${status === null ? 'none' : status}; signal=${signal ? 'terminated' : 'none'}; timeout=${timedOut}; output-limit=${exceeded}; spawn-failure=${spawnFailed}; category=${success ? 'none' : observed.category}`);
  if (success) { passed++; continue; }
  if (observed.category === 'transaction-invalid-or-closed') console.log('Target error reproduced; stopping.');
  else console.log('Stopped on a failure; inspect separately before interpreting a reproduction rate.');
  process.exitCode = 1;
  break;
}
console.log(`Summary: ${passed} passed; ${passed < attempts ? 'stopped early' : `${attempts} trials completed`}.`);
