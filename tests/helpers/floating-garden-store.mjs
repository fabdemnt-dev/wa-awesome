/** Minimal optimistic Firestore transaction fixture. No Firebase/network dependency. */
export function createMemoryStore() {
  const records = new Map();
  const listeners = new Map();
  let serial = 0;
  let conflictsToForce = 0;
  let transactionAttempts = 0;
  const clone = (value) => value === undefined ? undefined : structuredClone(value);
  function snapshot(path) {
    const value = records.get(path);
    return { exists: Boolean(value), ref: db.doc(path), data: () => clone(value?.data) };
  }
  function notify(paths) {
    for (const path of new Set(paths)) for (const fn of listeners.get(path) || []) queueMicrotask(() => fn(snapshot(path)));
  }
  const db = {
    doc(path) {
      if (typeof path !== 'string' || path.split('/').length % 2 || path.split('/').some((part) => !part)) throw new Error(`Invalid document path: ${path}`);
      return { path, id: path.split('/').at(-1), get: async () => snapshot(path) };
    },
    async runTransaction(body) {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        transactionAttempts += 1;
        const readVersions = new Map();
        const writes = [];
        const tx = {
          async get(ref) {
            if (writes.length) throw new Error('Firestore transactions require all reads before writes');
            readVersions.set(ref.path, records.get(ref.path)?.version || 0);
            return snapshot(ref.path);
          },
          create(ref, data) { writes.push({ kind: 'create', path: ref.path, data: clone(data) }); },
          set(ref, data) { writes.push({ kind: 'set', path: ref.path, data: clone(data) }); },
          update(ref, data) { writes.push({ kind: 'update', path: ref.path, data: clone(data) }); },
        };
        const result = await body(tx);
        if (conflictsToForce > 0) { conflictsToForce -= 1; continue; }
        if ([...readVersions].some(([path, version]) => (records.get(path)?.version || 0) !== version)) continue;
        // Validate every precondition before atomically committing any writes.
        for (const write of writes) {
          if (write.kind === 'create' && records.has(write.path)) throw new Error(`ALREADY_EXISTS ${write.path}`);
          if (write.kind === 'update' && !records.has(write.path)) throw new Error(`NOT_FOUND ${write.path}`);
        }
        for (const write of writes) {
          const data = write.kind === 'update' ? { ...records.get(write.path).data, ...write.data } : write.data;
          records.set(write.path, { version: ++serial, data });
        }
        notify(writes.map((write) => write.path));
        return clone(result);
      }
      throw new Error('ABORTED: fixture retry budget exhausted');
    },
    peek: (path) => clone(records.get(path)?.data),
    paths: () => [...records.keys()],
    entries: () => [...records].map(([path, value]) => [path, clone(value.data)]),
    set(path, data) { records.set(path, { version: ++serial, data: clone(data) }); notify([path]); },
    subscribe(path, fn) {
      if (!listeners.has(path)) listeners.set(path, new Set());
      listeners.get(path).add(fn);
      queueMicrotask(() => fn(snapshot(path)));
      return () => listeners.get(path)?.delete(fn);
    },
    forceConflicts(count = 1) { conflictsToForce = count; },
    get transactionAttempts() { return transactionAttempts; },
  };
  return db;
}
