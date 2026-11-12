// Isolated synthetic markers only. No imports, network, SDK or existing-key enumeration.
export const KEY = 'wa-awesome:storage-isolation-probe:20261112-v1';
export const DB = 'wa-awesome-storage-isolation-probe-20261112-v1';
const STORE = 'self-created-markers';
const ROW = 'seat';
const valid = value => value === null || value === 'A' || value === 'B';

export function markerStore(local, indexed) {
  function database() {
    return new Promise((resolve, reject) => {
      let done = false;
      const req = indexed.open(DB, 1);
      const timer = setTimeout(() => { done = true; reject(new Error('UNAVAILABLE')); }, 3000);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onerror = () => { clearTimeout(timer); reject(new Error('UNAVAILABLE')); };
      req.onblocked = () => { clearTimeout(timer); done = true; reject(new Error('UNAVAILABLE')); };
      req.onsuccess = () => {
        clearTimeout(timer);
        if (done) req.result.close(); else resolve(req.result);
      };
    });
  }
  async function idb(mode, value) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const store = tx.objectStore(STORE);
        const request = store.get(ROW);
        let result = null;
        request.onsuccess = () => {
          result = request.result === undefined ? null : request.result;
          if (!valid(result)) { tx.abort(); return; }
          if (mode === 'readwrite') {
            if (result !== null) { tx.abort(); return; }
            store.add(value, ROW);
            result = value;
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(new Error('UNAVAILABLE'));
      });
    } finally { db.close(); }
  }
  return {
    async read() {
      const l = local.getItem(KEY);
      if (!valid(l)) throw new Error('UNAVAILABLE');
      const i = await idb('readonly');
      return { local: l, indexed: i };
    },
    async write(seat) {
      if (seat !== 'A' && seat !== 'B') throw new Error('INVALID_SEAT');
      const before = await this.read();
      if (before.local !== null || before.indexed !== null) throw new Error('NOT_EMPTY');
      await idb('readwrite', seat);
      // Do not overwrite any marker that appeared while IndexedDB was pending.
      if (local.getItem(KEY) !== null) throw new Error('NOT_EMPTY');
      local.setItem(KEY, seat);
      return await this.read();
    }
  };
}

export function classify(state) {
  if (!state || !valid(state.local) || !valid(state.indexed)) return 'unknown';
  if (state.local === null && state.indexed === null) return 'empty';
  if (state.local === 'A' && state.indexed === 'A') return 'A';
  if (state.local === 'B' && state.indexed === 'B') return 'B';
  return 'mismatch';
}

export function mount(root, store) {
  const doc = root.ownerDocument;
  const result = doc.createElement('p');
  result.setAttribute('role', 'status');
  result.textContent = '未確認。ボタンを押すまで保存にはアクセスしません。';
  const labels = {
    empty:'両方の自己マーカーなし。ここだけでは独立性は未確認です。',
    A:'localStorage・IndexedDB ともに A の自己マーカー。',
    B:'localStorage・IndexedDB ともに B の自己マーカー。',
    mismatch:'保存結果が一致しません。上書きせず、この検証を停止してください。',
    unknown:'保存を確認できません。上書き・再試行をせず、この検証を停止してください。'
  };
  let busy = false;
  const buttons = [];
  const run = async action => {
    if (busy) return;
    busy = true; buttons.forEach(b => b.disabled = true);
    result.textContent = '確認中…';
    try { result.textContent = labels[classify(await action())]; }
    catch { result.textContent = labels.unknown; }
    finally { busy = false; buttons.forEach(b => b.disabled = false); }
  };
  for (const [label, action] of [
    ['自己マーカーを確認', () => store.read()],
    ['空の A にだけ A を記入', () => store.write('A')],
    ['空の B にだけ B を記入', () => store.write('B')]
  ]) {
    const b = doc.createElement('button'); b.type = 'button'; b.textContent = label;
    b.addEventListener('click', () => run(action)); buttons.push(b);
  }
  root.replaceChildren(...buttons, result);
  const invalidate = () => { result.textContent = '表示は古い可能性があります。自己マーカーを再確認してください。'; };
  doc.defaultView?.addEventListener('storage', e => { if (e.key === KEY || e.key === null) invalidate(); });
  doc.defaultView?.addEventListener('pagehide', invalidate);
}
