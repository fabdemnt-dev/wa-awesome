'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const functionsRoot = path.resolve(__dirname, '..', 'functions');
const packageJson = require(path.join(functionsRoot, 'node_modules', '@google-cloud', 'firestore', 'package.json'));
if (packageJson.version !== '7.11.6') {
  throw new Error(`Expected @google-cloud/firestore 7.11.6, found ${packageJson.version}`);
}

const target = path.join(functionsRoot, 'node_modules', '@google-cloud', 'firestore', 'build', 'src', 'transaction.js');
let source = fs.readFileSync(target, 'utf8');

function replaceOnce(before, after, label) {
  const first = source.indexOf(before);
  if (first < 0 || source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Expected exactly one SDK location for ${label}`);
  }
  source = source.replace(before, after);
}

replaceOnce(
  'const trace_util_1 = require("./telemetry/trace-util");\n',
  `const trace_util_1 = require("./telemetry/trace-util");
const diagnostic_crypto = require("node:crypto");
const transactionDiagnosticEnabled = process.env.MOON_SCALE_DUEL_TRANSACTION_DIAGNOSTIC === '1';
function transactionIdHash(value) {
    if (!value)
        return null;
    return diagnostic_crypto.createHash('sha256').update(Buffer.from(value)).digest('hex').slice(0, 12);
}
function transactionDiagnostic(requestTag, event, fields = {}) {
    if (!transactionDiagnosticEnabled)
        return;
    console.log(\`FIRESTORE_SDK_TRANSACTION_DIAGNOSTIC \${JSON.stringify({ requestTag, event, ...fields })}\`);
}
`,
  'diagnostic helper',
);

replaceOnce(
  `            await this._writeBatch._commit({
                transactionId,
                requestTag: this._requestTag,
            });
            this._transactionIdPromise = undefined;`,
  `            transactionDiagnostic(this._requestTag, 'commit_start', { transactionId: transactionIdHash(transactionId) });
            try {
                await this._writeBatch._commit({
                    transactionId,
                    requestTag: this._requestTag,
                });
                transactionDiagnostic(this._requestTag, 'commit_success', { transactionId: transactionIdHash(transactionId) });
            }
            catch (error) {
                transactionDiagnostic(this._requestTag, 'commit_error', { transactionId: transactionIdHash(transactionId), code: error === null || error === void 0 ? void 0 : error.code, message: error === null || error === void 0 ? void 0 : error.message });
                throw error;
            }
            this._transactionIdPromise = undefined;`,
  'commit lifecycle',
);

replaceOnce(
  `            if (!this._transactionIdPromise || !this._writeBatch) {
                return;
            }`,
  `            if (!this._transactionIdPromise || !this._writeBatch) {
                transactionDiagnostic(this._requestTag, 'rollback_skipped');
                return;
            }`,
  'rollback skipped',
);

replaceOnce(
  `                this._transactionIdPromise = undefined;
                return;
            }
            const request = {`,
  `                this._transactionIdPromise = undefined;
                transactionDiagnostic(this._requestTag, 'rollback_skipped_missing_transaction_id');
                return;
            }
            const request = {`,
  'rollback missing ID',
);

replaceOnce(
  `            this._prevTransactionId = transactionId;
            // We don't need to wait for rollback to completed before continuing.`,
  `            this._prevTransactionId = transactionId;
            transactionDiagnostic(this._requestTag, 'rollback_start', { transactionId: transactionIdHash(transactionId) });
            // We don't need to wait for rollback to completed before continuing.`,
  'rollback start',
);

replaceOnce(
  `                .request('rollback', request, this._requestTag)
                .catch(err => {`,
  `                .request('rollback', request, this._requestTag)
                .then(() => transactionDiagnostic(this._requestTag, 'rollback_success', { transactionId: transactionIdHash(transactionId) }))
                .catch(err => {
                transactionDiagnostic(this._requestTag, 'rollback_error', { transactionId: transactionIdHash(transactionId), code: err === null || err === void 0 ? void 0 : err.code, message: err === null || err === void 0 ? void 0 : err.message });`,
  'rollback result',
);

replaceOnce(
  `            for (let attempt = 0; attempt < this._maxAttempts; ++attempt) {
                span.setAttributes({`,
  `            for (let attempt = 0; attempt < this._maxAttempts; ++attempt) {
                transactionDiagnostic(this._requestTag, 'attempt_start', { attempt: attempt + 1, previousTransactionId: transactionIdHash(this._prevTransactionId), previousErrorCode: lastError === null || lastError === void 0 ? void 0 : lastError.code, previousErrorMessage: lastError === null || lastError === void 0 ? void 0 : lastError.message });
                span.setAttributes({`,
  'attempt start',
);

replaceOnce(
  `                catch (err) {
                    lastError = err;
                    if (!isRetryableTransactionError(err)) {
                        break;
                    }
                }`,
  `                catch (err) {
                    lastError = err;
                    const retryable = isRetryableTransactionError(err);
                    transactionDiagnostic(this._requestTag, 'attempt_error', { attempt: attempt + 1, code: err === null || err === void 0 ? void 0 : err.code, message: err === null || err === void 0 ? void 0 : err.message, retryable });
                    if (!retryable) {
                        break;
                    }
                }`,
  'attempt error',
);

replaceOnce(
  `                const resultPromise = resultFn.call(this, param, opts);
                // Ensure the _transactionIdPromise is set synchronously`,
  `                transactionDiagnostic(this._requestTag, 'initial_read_start', { rpc: resultFn.name, retryTransaction: transactionIdHash(opts.readWrite === null || opts.readWrite === void 0 ? void 0 : opts.readWrite.retryTransaction) });
                const resultPromise = resultFn.call(this, param, opts);
                // Ensure the _transactionIdPromise is set synchronously`,
  'initial read start',
);

replaceOnce(
  `                    return r.transaction;
                });
                return resultPromise.then(r => r.result);`,
  `                    transactionDiagnostic(this._requestTag, 'transaction_id_received', { transactionId: transactionIdHash(r.transaction), retryTransaction: transactionIdHash(opts.readWrite === null || opts.readWrite === void 0 ? void 0 : opts.readWrite.retryTransaction) });
                    return r.transaction;
                });
                return resultPromise.then(r => r.result).catch(error => {
                    transactionDiagnostic(this._requestTag, 'initial_read_error', { rpc: resultFn.name, retryTransaction: transactionIdHash(opts.readWrite === null || opts.readWrite === void 0 ? void 0 : opts.readWrite.retryTransaction), code: error === null || error === void 0 ? void 0 : error.code, message: error === null || error === void 0 ? void 0 : error.message });
                    throw error;
                });`,
  'initial read result',
);

fs.writeFileSync(target, source);
console.log(`Instrumented @google-cloud/firestore ${packageJson.version}: ${target}`);
