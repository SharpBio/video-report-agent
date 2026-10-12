/** IndexedDB workspace. Mirrors the Python runs/<id>/ layout. */

const DB_NAME = 'video-report-extension';
const DB_VERSION = 1;

export const STORE = {
  RUNS: 'runs',
  INPUTS: 'inputs',
  TRANSCRIPTS: 'transcripts',
  ASR: 'asr',
  DRAFTS: 'drafts',
  PROMPTS: 'prompts',
  OUTPUTS: 'outputs',
  BLOBS: 'blobs',
  LOGS: 'logs',
  USAGE: 'usage',
  CACHE: 'cache',
};

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      const ensure = (name, options = { keyPath: 'runId' }) => {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, options);
      };
      ensure(STORE.RUNS, { keyPath: 'id' });
      ensure(STORE.INPUTS);
      ensure(STORE.TRANSCRIPTS);
      ensure(STORE.ASR);
      ensure(STORE.DRAFTS);
      ensure(STORE.PROMPTS);
      ensure(STORE.OUTPUTS);
      ensure(STORE.USAGE);
      ensure(STORE.CACHE, { keyPath: 'videoId' });
      if (!db.objectStoreNames.contains(STORE.BLOBS)) {
        db.createObjectStore(STORE.BLOBS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(STORE.LOGS)) {
        const logs = db.createObjectStore(STORE.LOGS, { keyPath: 'id', autoIncrement: true });
        logs.createIndex('runId', 'runId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function get(store, key) {
  return wrap((await tx(store, 'readonly')).get(key));
}

export async function getAll(store) {
  return wrap((await tx(store, 'readonly')).getAll());
}

export async function put(store, value) {
  return wrap((await tx(store, 'readwrite')).put(value));
}

export async function remove(store, key) {
  return wrap((await tx(store, 'readwrite')).delete(key));
}

export async function clear(store) {
  return wrap((await tx(store, 'readwrite')).clear());
}

export async function logsFor(runId) {
  const store = await tx(STORE.LOGS, 'readonly');
  return wrap(store.index('runId').getAll(runId));
}

/* ---------- run helpers ---------- */

export function newRunId() {
  return crypto.randomUUID().replace(/-/g, '');
}

export async function createRun(run) {
  const now = Date.now();
  const record = {
    id: run.id,
    createdAt: now,
    updatedAt: now,
    state: 'QUEUED',
    stage: 'QUEUED',
    progress: 0,
    reportMode: 'standard',
    transcriptMode: 'asr-only',
    ...run,
  };
  await put(STORE.RUNS, record);
  return record;
}

/** Partial update that always bumps updatedAt. */
export async function updateRun(runId, patch) {
  const current = (await get(STORE.RUNS, runId)) || { id: runId };
  const next = { ...current, ...patch, id: runId, updatedAt: Date.now() };
  await put(STORE.RUNS, next);
  return next;
}

export async function listRuns() {
  const runs = await getAll(STORE.RUNS);
  return runs.sort((a, b) => b.createdAt - a.createdAt);
}

export async function deleteRun(runId) {
  for (const store of [STORE.INPUTS, STORE.TRANSCRIPTS, STORE.ASR, STORE.DRAFTS,
    STORE.PROMPTS, STORE.OUTPUTS, STORE.USAGE]) {
    await remove(store, runId);
  }
  const logs = await logsFor(runId);
  for (const entry of logs) await remove(STORE.LOGS, entry.id);
  await remove(STORE.RUNS, runId);
}
