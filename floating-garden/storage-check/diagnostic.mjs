// Standalone read-only diagnostic; no game or SDK imports.
export const ORIGIN = 'https://fabdemnt-dev.github.io';
export const KEY = 'floating-garden-public:wa-awesome:public-production-20261023-v1:floating-garden-online-recovery-v1';
export const ARCHIVE = KEY + ':floating-garden-online-retained-rooms-v1';
export const KEYS = Object.freeze([KEY, ARCHIVE]);
const unknown = () => null;
export const FLAGS = Object.freeze(['activeRoom','pending','parked','retained']);
const obj = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const text = x => typeof x === 'string' && x.length > 0;
const allowed = (x, keys) => obj(x) && Object.keys(x).every(k => keys.includes(k));
function require(ok) { if (!ok) throw new Error('UNVERIFIED'); }
// JSON.parse alone silently accepts duplicate keys. Walk its JSON tokens first.
function parse(raw) {
  require(typeof raw === 'string' && raw.length > 0 && raw.length <= 262144);
  let i = 0;
  const ws = () => { while (/\s/.test(raw[i] || '') && i < raw.length) i++; };
  function string() {
    const start = i++; while (i < raw.length) { if (raw[i] === '\\') { i += 2; continue; } if (raw[i++] === '"') return JSON.parse(raw.slice(start, i)); }
    throw new Error('UNVERIFIED');
  }
  function value(depth = 0) {
    require(depth < 40); ws();
    if (raw[i] === '"') { string(); return; }
    if (raw[i] === '{') {
      i++; ws(); const seen = new Set(); if (raw[i] === '}') { i++; return; }
      for (;;) { ws(); require(raw[i] === '"'); const k = string(); require(!seen.has(k)); seen.add(k); ws(); require(raw[i++] === ':'); value(depth + 1); ws(); const c = raw[i++]; if (c === '}') return; require(c === ','); }
    }
    if (raw[i] === '[') {
      i++; ws(); if (raw[i] === ']') { i++; return; }
      for (;;) { value(depth + 1); ws(); const c = raw[i++]; if (c === ']') return; require(c === ','); }
    }
    const m = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i)); require(m); i += m[0].length;
  }
  value(); ws(); require(i === raw.length); return JSON.parse(raw);
}
function record(v, uid, archived = false) {
  require(allowed(v, ['version','uid','roomId','pending','inviteCode',...(archived ? [] : ['parked'])]));
  require(v.version === 1 && text(v.uid) && (uid === undefined || uid === v.uid));
  require(v.roomId === null || text(v.roomId));
  require(v.inviteCode === undefined || v.inviteCode === null || typeof v.inviteCode === 'string');
  require(Object.hasOwn(v, 'pending') || archived);
  if (archived) require(text(v.roomId) && (v.pending === undefined || v.pending === null));
  else if (v.pending !== null) {
    const p = v.pending;
    require(allowed(p, ['kind','uid','payload']) && ['create','join','start','submit'].includes(p.kind) && p.uid === v.uid && obj(p.payload) && text(p.payload.requestId));
    if (['start','submit'].includes(p.kind)) require(text(v.roomId) && p.payload.roomId === v.roomId);
  }
  const ids = new Set();
  if (v.parked !== undefined) {
    require(Array.isArray(v.parked) && v.parked.length <= 20);
    for (const raw of v.parked) { const old = parse(raw); record(old, v.uid, true); require(old.roomId !== v.roomId && !ids.has(old.roomId)); ids.add(old.roomId); }
  }
  return {uid:v.uid, roomId:v.roomId, ids, present:!!v.roomId || v.pending != null || ids.size > 0};
}
export function inspect(storage) {
  // Only these two exact keys, repeated to detect a change during observation.
  // No key enumeration, getItem of other namespaces, writes, removals or output values.
  try {
    const a = storage.getItem(KEY), b = storage.getItem(ARCHIVE);
    require(a === storage.getItem(KEY) && b === storage.getItem(ARCHIVE));
    const value = a === null ? null : parse(a);
    const active = a === null ? null : record(value);
    let retained = false;
    if (b !== null) {
      const archive = parse(b);
      require(allowed(archive,['version','uid','rooms']) && archive.version === 1 && text(archive.uid) && (!active || active.uid === archive.uid) && Array.isArray(archive.rooms) && archive.rooms.length <= 21);
      const seen = new Set(), combined = new Set(active?.ids || []);
      for (const raw of archive.rooms) { const old=parse(raw); record(old,archive.uid,true); require(!seen.has(old.roomId)); seen.add(old.roomId); if(old.roomId!==active?.roomId)combined.add(old.roomId); }
      require(combined.size <= 20); retained = seen.size > 0;
    }
    return {activeRoom:!!active?.roomId, pending:active !== null && value.pending !== null, parked:(active?.ids.size || 0) > 0, retained};
  } catch { return unknown(); }
}
function browserRead() {
  try { if (globalThis.location.origin !== ORIGIN) return unknown(); return inspect(globalThis.localStorage); }
  catch { return unknown(); }
}
const labels = Object.freeze({activeRoom:'現在の部屋参照',pending:'未確定操作',parked:'旧保存の部屋参照',retained:'別キーの保留部屋参照'});
function validFlags(value) {
  return obj(value) && Object.keys(value).length === FLAGS.length && FLAGS.every(k => Object.hasOwn(value,k) && typeof value[k] === 'boolean');
}
export function mount(root, read = browserRead) {
  const doc=root.ownerDocument;
  const button=doc.createElement('button');button.type='button';button.textContent='保存の有無を確認';
  const result=doc.createElement('div');result.setAttribute('role','status');
  const rows=Object.fromEntries(FLAGS.map(key=>{const row=doc.createElement('p');row.dataset.flag=key;result.append(row);return [key,row];}));
  const show=(value,initial=false)=>{const valid=validFlags(value);for(const key of FLAGS)rows[key].textContent=labels[key]+'：'+(initial?'未確認':valid?(value[key]?'あり':'なし'):'確認できない');};
  show(null,true);
  const note=doc.createElement('p');note.textContent='この端末・ブラウザーの指定された庭園保存だけを読みます。値は表示・送信せず、保存を変更しません。4項目が「なし」でも試験開始の許可や、他の保存・認証・サーバー状態の確認にはなりません。';
  const run=()=>{let value=null;try{value=read();if(!validFlags(value))value=null;}catch{value=null;}show(value);};
  const invalidate=()=>show(null);
  const onStorage=e=>{if(e.key===null || KEYS.includes(e.key))invalidate();};
  button.addEventListener('click',run);root.replaceChildren(note,button,result);
  doc.defaultView?.addEventListener('pagehide',invalidate);doc.defaultView?.addEventListener('storage',onStorage);
  return ()=>{button.removeEventListener('click',run);doc.defaultView?.removeEventListener('pagehide',invalidate);doc.defaultView?.removeEventListener('storage',onStorage);};
}
