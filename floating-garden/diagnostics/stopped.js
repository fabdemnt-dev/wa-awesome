// Fixed diagnostic, not a console or game activation path. No URL/config overrides.
export const TARGET = Object.freeze({
  projectId: 'wa-awesome', region: 'asia-northeast1', name: 'floatingGardenGetSnapshot',
  epochId: 'public-production-20261023-v1',
  url: 'https://asia-northeast1-wa-awesome.cloudfunctions.net/floatingGardenGetSnapshot',
});
export const ATTEMPT_KEY = 'garden-stop-response-20261023-v1';
const ORIGIN = 'https://fabdemnt-dev.github.io';
const PAGE_PATH = '/wa-awesome/floating-garden/diagnostics/stopped.html';
const APP_NAME = 'floating-garden-stopped-diagnostic-20261023';
const CONFIG = Object.freeze({
  apiKey: 'AIzaSyBtb74uz6clsoc9uA_AkDHi7DdepEWn2dw',
  authDomain: 'wa-awesome.firebaseapp.com', projectId: 'wa-awesome',
  storageBucket: 'wa-awesome.firebasestorage.app', messagingSenderId: '1074804319870',
  appId: '1:1074804319870:web:923f0ec866812f98ae5a2f',
});
const SITE_KEY = '6LeU8sstAAAAAOEyP56nWLD633TiAWaLmvcskE6e';
const STAGES = new Set(['reserved', 'app-check', 'request-prepared', 'finished']);
const OUTCOMES = new Set(['pending', 'blocked', 'stopped_verified', 'unexpected', 'unknown']);
const REASONS = new Set(['public-disabled', 'storage-unavailable', 'app-check-unavailable', 'network-or-timeout', 'response-unexpected']);
const fixedError = () => new Error('diagnostic-unavailable');
function safeRecord(input) {
  if (!input || input.schemaVersion !== 1 || input.testId !== ATTEMPT_KEY ||
      !STAGES.has(input.stage) || !OUTCOMES.has(input.outcome) || typeof input.submitted !== 'boolean' ||
      !Number.isSafeInteger(input.startedAt) || input.startedAt < 0) throw fixedError();
  const result = {schemaVersion:1, testId:ATTEMPT_KEY, stage:input.stage,
    startedAt:input.startedAt, submitted:input.submitted, outcome:input.outcome};
  if (Number.isSafeInteger(input.finishedAt) && input.finishedAt >= input.startedAt) result.finishedAt = input.finishedAt;
  if (Number.isInteger(input.httpStatus) && input.httpStatus >= 100 && input.httpStatus <= 599) result.httpStatus = input.httpStatus;
  if (REASONS.has(input.reason)) result.reason = input.reason;
  return result;
}
export function createRecordStore(indexedDB) {
  if (!indexedDB?.open) throw fixedError();
  const opened = new Promise((resolve, reject) => {
    const request = indexedDB.open('floating-garden-stop-diagnostic', 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('attempts')) request.result.createObjectStore('attempts', {keyPath:'testId'});
    };
    request.onerror = request.onblocked = () => reject(fixedError());
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => db.close(); resolve(db); };
  });
  const transaction = async (mode, operation) => {
    const db = await opened;
    return new Promise((resolve, reject) => {
      let value, duplicate = false;
      const tx = db.transaction('attempts', mode, mode === 'readwrite' ? {durability:'strict'} : undefined);
      const request = operation(tx.objectStore('attempts'));
      request.onsuccess = () => { value = request.result; };
      request.onerror = event => {
        if (request.error?.name === 'ConstraintError') { duplicate = true; event.preventDefault(); event.stopPropagation(); }
      };
      tx.oncomplete = () => resolve({value, duplicate});
      tx.onerror = tx.onabort = () => reject(fixedError());
    });
  };
  return Object.freeze({
    async read() { const {value} = await transaction('readonly', store => store.get(ATTEMPT_KEY)); return value === undefined ? null : safeRecord(value); },
    async claim(record) { const {duplicate} = await transaction('readwrite', store => store.add(safeRecord(record))); return !duplicate; },
    async save(record) { await transaction('readwrite', store => store.put(safeRecord(record))); },
  });
}
export function classifyResponse(httpStatus, parsed) {
  const status = Number.isInteger(httpStatus) && httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null;
  if (status === 400 && parsed?.error?.status === 'FAILED_PRECONDITION' && parsed?.error?.details?.reason === 'public-disabled') {
    return {outcome:'stopped_verified', httpStatus:status, reason:'public-disabled'};
  }
  return {outcome:'unexpected', ...(status === null ? {} : {httpStatus:status}), reason:'response-unexpected'};
}
export function createOneShotPost(fetchImpl, timeoutMs = 15000) {
  let consumed = false;
  return async token => {
    if (consumed) throw fixedError();
    consumed = true;
    if (typeof token !== 'string' || !token || token.length > 16384) throw fixedError();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const response = await fetchImpl(TARGET.url, {
        method:'POST', credentials:'omit', redirect:'error', cache:'no-store', signal:abort.signal,
        headers:{'Content-Type':'application/json', 'X-Firebase-AppCheck':token},
        body:JSON.stringify({data:{epochId:TARGET.epochId}}),
      });
      // Bound the response; never store or render its raw text/error contents.
      if (!response.body?.getReader) throw fixedError();
      const reader = response.body.getReader(); const chunks = []; let length = 0;
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 8192) { await reader.cancel(); throw fixedError(); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length); let offset = 0;
      for (const part of chunks) { bytes.set(part, offset); offset += part.byteLength; }
      const body = JSON.parse(new TextDecoder().decode(bytes));
      return {status:response.status, body};
    } finally { clearTimeout(timer); token = null; }
  };
}
export async function runDiagnostic({store, getToken, send, now = Date.now, onUpdate = () => {}}) {
  let record = {schemaVersion:1, testId:ATTEMPT_KEY, stage:'reserved', startedAt:now(), submitted:false, outcome:'pending'};
  const notify = () => { try { onUpdate(safeRecord(record)); } catch { /* UI failure cannot authorize another request. */ } };
  const finish = async fields => {
    record = safeRecord({...record, ...fields, stage:'finished', finishedAt:now()});
    try { await store.save(record); } catch {
      // The original reservation remains; failure to save a result is not permission to retry.
      record = safeRecord({...record, outcome:record.submitted ? 'unknown' : 'blocked', reason:'storage-unavailable'});
    }
    notify(); return record;
  };
  try {
    if (!await store.claim(record)) {
      const existing = await store.read();
      if (!existing) throw fixedError();
      return safeRecord(existing);
    }
  } catch {
    record = safeRecord({...record, stage:'finished', outcome:'blocked', reason:'storage-unavailable', finishedAt:now()});
    notify(); return record;
  }
  notify(); let token = null;
  try {
    record.stage = 'app-check'; await store.save(record); notify();
  } catch { return finish({outcome:'blocked', reason:'storage-unavailable'}); }
  try {
    token = await getToken();
    if (typeof token !== 'string' || !token || token.length > 16384) throw fixedError();
  } catch { return finish({outcome:'blocked', reason:'app-check-unavailable'}); }
  // This durable marker means "submission possible", including a crash before/after fetch.
  record.stage = 'request-prepared'; record.submitted = true;
  try { await store.save(record); } catch { token = null; return finish({submitted:false, outcome:'blocked', reason:'storage-unavailable'}); }
  notify();
  try {
    const response = await send(token);
    return await finish(classifyResponse(response.status, response.body));
  } catch { return await finish({outcome:'unknown', reason:'network-or-timeout'}); }
  finally { token = null; }
}
function pageAllowed(page) {
  return page.location.origin === ORIGIN && page.location.pathname === PAGE_PATH &&
    page.location.href === `${ORIGIN}${PAGE_PATH}` &&
    !('FIREBASE_APPCHECK_DEBUG_TOKEN' in page) && !page.navigator.serviceWorker?.controller;
}
async function normalAppCheckToken(page) {
  if (!pageAllowed(page)) throw fixedError();
  const [apps, checks] = await Promise.all([
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js'),
    import('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-check.js'),
  ]);
  if (!pageAllowed(page) || apps.getApps().some(app => app.name === APP_NAME)) throw fixedError();
  const app = apps.initializeApp(CONFIG, APP_NAME);
  let check;
  try {
    check = checks.initializeAppCheck(app, {provider:new checks.ReCaptchaEnterpriseProvider(SITE_KEY), isTokenAutoRefreshEnabled:false});
    // Pinned public API: direct normal provider exchange, without getToken's persistent token cache.
    const result = await checks.getLimitedUseToken(check);
    if (!pageAllowed(page) || typeof result?.token !== 'string' || !result.token) throw fixedError();
    return result.token;
  } finally {
    if (check) checks.setTokenAutoRefreshEnabled(check, false);
    await apps.deleteApp(app);
  }
}
function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(fixedError()), milliseconds); })])
    .finally(() => clearTimeout(timer));
}
export async function mountDiagnostic(page) {
  const button = page.document.getElementById('run-check');
  const status = page.document.getElementById('status');
  const result = page.document.getElementById('result');
  let locked = false, store;
  button.disabled = true;
  const show = record => {
    result.textContent = JSON.stringify(safeRecord(record), null, 2);
    status.textContent = record.outcome === 'stopped_verified' ? '停止中の応答 public-disabled を確認しました。再送しません。' :
      record.stage !== 'finished' ? (record.submitted ? '送信開始を記録しました。結果が不明でも再送しません。' : '実行を予約しました。正規App Checkを確認しています。') :
      record.outcome === 'blocked' ? '試験を送信できませんでした。記録を保持し、再実行しません。' :
      '停止応答を確認できませんでした。結果を保持し、再送しません。';
  };
  try {
    if (!pageAllowed(page)) throw fixedError();
    store = createRecordStore(page.indexedDB);
    const previous = await store.read();
    if (previous) { show(previous); status.textContent = '保存された実行記録があります。結果不明の場合も再送しません。'; return; }
    button.disabled = false;
    status.textContent = '未実行です。ボタンを押すまでApp Check取得や試験送信は行いません。';
  } catch { status.textContent = 'この画面の配信元または保存機能を確認できないため、通信しません。'; return; }
  const post = createOneShotPost(page.fetch.bind(page));
  button.addEventListener('click', async () => {
    if (locked) return;
    locked = true; button.disabled = true;
    const record = await runDiagnostic({store,
      getToken:() => deadline(normalAppCheckToken(page), 30000),
      send:token => { if (!pageAllowed(page)) throw fixedError(); return post(token); },
      onUpdate:show,
    });
    show(record);
  });
}
if (typeof window !== 'undefined' && window.document?.getElementById('run-check')) {
  mountDiagnostic(window).catch(() => {
    const status = window.document.getElementById('status');
    if (status) status.textContent = '確認を開始できません。再実行せず記録を保持してください。';
  });
}
