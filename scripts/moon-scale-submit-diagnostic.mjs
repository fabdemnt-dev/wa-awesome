import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const attempts = Number(process.env.DIAGNOSTIC_ATTEMPTS);
if (!['10', '20'].includes(process.env.DIAGNOSTIC_ATTEMPTS)) {
  throw new Error('DIAGNOSTIC_ATTEMPTS must be 10 or 20');
}

const target = 'a normal outcome ends the game and rejects next-round readiness';
const command = `node --test --test-force-exit --test-name-pattern="${target}" tests/moon-scale-duel-online-integration.test.mjs`;
const args = ['--config', 'firebase.moon-scale-duel-emulator.json', 'emulators:exec', '--only', 'auth,firestore,database,functions', '--project', 'demo-moon-scale-duel', command];

function trial() {
  return new Promise((resolve) => {
    const child = spawn('node_modules/.bin/firebase', args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let exceeded = false;
    let timedOut = false;
    const collect = (data) => {
      // Never print raw emulator output: it may include test data or credentials.
      if (output.length < 2_000_000) output += data.toString();
      else exceeded = true;
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, 240_000);
    child.on('error', () => { clearTimeout(timer); resolve({ status: null, output, timedOut, exceeded }); });
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, output, timedOut, exceeded }); });
  });
}

let passed = 0;
for (let i = 1; i <= attempts; i++) {
  const start = performance.now();
  const { status, output, timedOut, exceeded } = await trial();
  const duration = ((performance.now() - start) / 1000).toFixed(1);
  const selected = output.includes(`- ${target}`) && /^# pass 1\s*$/m.test(output);
  const success = status === 0 && selected && /^# fail 0\s*$/m.test(output);
  const reproduced = /Transaction is invalid or closed\./i.test(output);
  const code = reproduced ? '3 INVALID_ARGUMENT' : (output.match(/\b(?:functions\/|[A-Z_]+\/)?(?:INVALID_ARGUMENT|invalid-argument)\b/i)?.[0] ?? 'unclassified');
  const errorName = reproduced ? 'Transaction is invalid or closed' : (timedOut ? 'timeout' : exceeded ? 'output-limit' : 'test-or-emulator-failure');
  console.log(`Trial ${i}/${attempts}: ${success ? 'PASS' : 'FAIL'}; ${duration}s${success ? '' : `; code=${code}; error=${errorName}`}`);
  if (success) { passed++; continue; }
  if (reproduced) console.log('Target error reproduced; stopping.');
  else console.log('Stopped on a failure; inspect separately before interpreting a reproduction rate.');
  process.exitCode = 1;
  break;
}
console.log(`Summary: ${passed} passed; ${passed < attempts ? 'stopped early' : `${attempts} trials completed`}.`);
