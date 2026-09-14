import { readFile, writeFile } from 'node:fs/promises';

const artifactRoot = 'diagnostic-artifacts/runtime';
const rawOutput = await readFile('diagnostic-work/runtime-integration.log', 'utf8').catch(() => '');
const eventText = await readFile(`${artifactRoot}/transaction-events.jsonl`, 'utf8').catch(() => '');
const events = eventText.split(/\r?\n/).filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)]; } catch { return []; }
});

function callableSummary(callable) {
  const selected = events.filter((event) => event.callable === callable);
  const byId = new Map();
  for (const event of selected) {
    const list = byId.get(event.diagnosticId) || [];
    list.push(event);
    byId.set(event.diagnosticId, list);
  }
  const invocations = [...byId.values()];
  const attempts = invocations.map((items) => Math.max(0, ...items.map((item) => Number(item.attempt) || 0)));
  return {
    invocation_count: invocations.length,
    callback_1_attempt: attempts.filter((count) => count === 1).length,
    callback_2_attempts: attempts.filter((count) => count === 2).length,
    callback_3_attempts_or_more: attempts.filter((count) => count >= 3).length,
    max_attempt: Math.max(0, ...attempts),
    run_transaction_successes: invocations.filter((items) => items.some((item) => item.stage === 'run_transaction_success')).length,
    run_transaction_failures: invocations.filter((items) => items.some((item) => item.stage === 'run_transaction_error')).length,
    max_elapsed_ms: Math.max(0, ...selected.map((event) => Number(event.elapsed_ms) || 0)),
    invalid_closed_count: invocations.filter((items) => items.some((item) => String(item.message || '').includes('Transaction is invalid or closed'))).length,
  };
}

function lastNumber(pattern) {
  const matches = [...rawOutput.matchAll(pattern)];
  return matches.length ? Number(matches.at(-1)[1]) : null;
}

const firestoreEvents = await readFile(`${artifactRoot}/firestore-transaction-events.log`, 'utf8').catch(() => '');
const summary = {
  diagnostic_mode: true,
  integration: {
    started: /tests\/moon-scale-duel-online-integration\.test\.mjs|# Subtest:|ℹ tests \d+/.test(rawOutput),
    total: lastNumber(/(?:ℹ|#) tests\s+(\d+)/g),
    passed: lastNumber(/(?:ℹ|#) pass\s+(\d+)/g),
    failed: lastNumber(/(?:ℹ|#) fail\s+(\d+)/g),
    skipped: lastNumber(/(?:ℹ|#) skipped\s+(\d+)/g),
    exit_code: Number.parseInt(await readFile('diagnostic-artifacts/runtime-integration-exit-code.txt', 'utf8').catch(() => '-1'), 10),
  },
  callables: {
    moonScaleDuelSubmitCard: callableSummary('moonScaleDuelSubmitCard'),
    moonScaleDuelReadyNextRound: callableSummary('moonScaleDuelReadyNextRound'),
  },
  lock_timeout_count: firestoreEvents.split('WARNING: Operation failed: Transaction lock timeout.').length - 1,
  invalid_closed_event_count: events.filter((event) => String(event.message || '').includes('Transaction is invalid or closed')).length,
};

await writeFile(`${artifactRoot}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
