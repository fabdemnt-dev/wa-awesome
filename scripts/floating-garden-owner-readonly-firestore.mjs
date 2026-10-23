// A deliberately small REST facade: no commit, write, batchWrite or read-write
// transaction method exists. Transaction/query tokens remain memory-only.
import { ownerNeed as need, ownerGuard } from './floating-garden-owner-readonly-policy.mjs';
import { ACTIVE_UPDATE_SCOPE as S } from './floating-garden-active-update.mjs';
export const OWNER_ROOTS = Object.freeze(['floatingGardenTrial','floatingGardenTrialTesters','floatingGardenRooms','floatingGardenActionRequests','floatingGardenInvites','floatingGardenRateLimits']);
export const OWNER_GROUPS = Object.freeze(['members','serverGames']);
const BASE = `https://firestore.googleapis.com/v1/projects/${S.project}/databases/(default)/documents`;
class ExactTimestamp {
  constructor(seconds, nanos) { this._seconds = seconds; this._nanoseconds = nanos; Object.freeze(this); }
  toMillis() { return this._seconds * 1000 + this._nanoseconds / 1e6; }
  toDate() { return new Date(this.toMillis()); }
}
export function decodeOwnerFirestoreValue(value, depth = 0) {
  need(depth <= 32 && value && Object.getPrototypeOf(value) === Object.prototype && Object.keys(value).length === 1);
  const [type] = Object.keys(value), x = value[type];
  switch (type) {
    case 'nullValue': need(x === null || x === 'NULL_VALUE'); return null;
    case 'booleanValue': need(typeof x === 'boolean'); return x;
    case 'stringValue': need(typeof x === 'string'); return x;
    case 'integerValue': {
      need(typeof x === 'string' && /^-?(0|[1-9][0-9]*)$/.test(x)); const n = Number(x); need(Number.isSafeInteger(n) && String(n) === x); return n;
    }
    case 'doubleValue': need(typeof x === 'number' && Number.isFinite(x)); return x;
    case 'timestampValue': {
      need(typeof x === 'string'); const m = x.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/); need(m);
      const ms = Date.parse(`${m[1]}Z`); need(Number.isFinite(ms) && new Date(ms).toISOString().slice(0,19) === m[1]);
      return new ExactTimestamp(ms / 1000, Number((m[2] || '').padEnd(9,'0')));
    }
    case 'arrayValue': need(x && Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).every(k => k === 'values') && (x.values === undefined || Array.isArray(x.values))); return (x.values || []).map(v => decodeOwnerFirestoreValue(v, depth + 1));
    case 'mapValue': need(x && Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).every(k => k === 'fields')); return decodeOwnerFirestoreFields(x.fields || {}, depth + 1);
    default: throw ownerGuard(); // Never coerce bytes, references, geo points or nonfinite numbers.
  }
}
export function decodeOwnerFirestoreFields(fields, depth = 0) {
  need(depth <= 32 && fields && Object.getPrototypeOf(fields) === Object.prototype && Object.keys(fields).length <= 10000);
  return Object.fromEntries(Object.entries(fields).map(([k,v]) => [k, decodeOwnerFirestoreValue(v, depth + 1)]));
}
export function createOwnerReadonlyFirestore(send) {
  need(typeof send === 'function'); const queries = new WeakMap(); let busy = false, transactionCount = 0, closed = false;
  const collection = (id, group) => {
    need((group ? OWNER_GROUPS : OWNER_ROOTS).includes(id));
    return Object.freeze({ limit(count) { need(count === 10001); const q = Object.freeze({}); queries.set(q, { id, group, count }); return q; } });
  };
  const call = async (method, body) => {
    need(!closed); const response = await send(`${BASE}:${method}`, body); return response;
  };
  return Object.freeze({
    collection: id => collection(id, false), collectionGroup: id => collection(id, true),
    async listCollections() {
      need(!busy); const value = await call('listCollectionIds', { pageSize: 100 });
      need(value && Array.isArray(value.collectionIds) && value.collectionIds.length <= OWNER_ROOTS.length && !value.nextPageToken &&
        new Set(value.collectionIds).size === value.collectionIds.length && value.collectionIds.every(id => OWNER_ROOTS.includes(id)));
      return value.collectionIds.map(id => ({ id }));
    },
    async runTransaction(body, options) {
      need(!busy && !closed && transactionCount++ < 4 && typeof body === 'function' && options && Object.keys(options).length === 1 && options.readOnly === true);
      busy = true; let token, error;
      try {
        const begin = await call('beginTransaction', { options: { readOnly: {} } });
        need(begin && Object.keys(begin).length === 1 && typeof begin.transaction === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(begin.transaction) && begin.transaction.length <= 4096);
        token = begin.transaction; const used = new Set();
        const tx = Object.freeze({ async get(query) {
          const q = queries.get(query); need(q && !used.has(`${q.group}:${q.id}`) && used.size < 8); used.add(`${q.group}:${q.id}`);
          const rows = await call('runQuery', { structuredQuery: { from: [{ collectionId: q.id, allDescendants: q.group }], limit: q.count }, transaction: token });
          need(Array.isArray(rows) && rows.length <= 10002); const docs = [], names = new Set();
          for (const row of rows) {
            need(row && Object.keys(row).every(k => ['document','readTime','transaction','skippedResults','done'].includes(k)) && !row.skippedResults &&
              (row.transaction === undefined || row.transaction === token));
            if (!row.document) continue;
            const doc = row.document; need(typeof doc.name === 'string' && doc.name.startsWith(BASE.slice('https://firestore.googleapis.com/v1/'.length) + '/') && !names.has(doc.name)); names.add(doc.name);
            const path = doc.name.slice(BASE.slice('https://firestore.googleapis.com/v1/'.length).length + 1), parts = path.split('/');
            need(parts.every(p => p && p !== '.' && p !== '..' && !/[\x00-\x1f]/.test(p) && Buffer.byteLength(p) <= 1500));
            need(q.group ? parts.length === 4 && parts[0] === 'floatingGardenRooms' && parts[2] === q.id : parts.length === 2 && parts[0] === q.id);
            const decoded = decodeOwnerFirestoreFields(doc.fields || {});
            docs.push(Object.freeze({ ref: Object.freeze({ path }), data: () => decoded }));
          }
          need(docs.length <= 10001); return { docs };
        } });
        return await body(tx);
      } catch { error = ownerGuard(); throw error; }
      finally {
        try { if (token) { const result = await call('rollback', { transaction: token }); need(result && Object.keys(result).length === 0); } }
        catch { closed = true; if (!error) throw ownerGuard(); }
        finally { token = undefined; busy = false; if (error) closed = true; }
      }
    },
  });
}
