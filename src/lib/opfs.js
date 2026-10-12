/** Origin Private File System: large blobs (audio, PNG) live outside IndexedDB. */

const ROOT = 'runs';

async function root() {
  return navigator.storage.getDirectory();
}

export async function ensureDir(parent, name) {
  // 这条防御是为了把一类很隐蔽的错改成一眼能懂的错：调用方少写一个 await，
  // 拿到的就是 Promise 而不是目录句柄，原生报错是
  // "parent.getDirectoryHandle is not a function"，完全指不到真凶。
  if (!parent || typeof parent.getDirectoryHandle !== 'function') {
    const what = parent && typeof parent.then === 'function'
      ? 'Promise（少写了 await）'
      : Object.prototype.toString.call(parent);
    throw new Error(`ensureDir 需要目录句柄，收到的是${what}。`);
  }
  return parent.getDirectoryHandle(name, { create: true });
}

export async function runDir(runId) {
  const top = await root();
  // 必须逐级 await：ensureDir 是 async，套着写会把 Promise 当句柄传进去。
  const base = await ensureDir(top, ROOT);
  return ensureDir(base, runId);
}

export async function writeFile(runId, name, streamFn) {
  const dir = await runDir(runId);
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await streamFn(writable);
  } finally {
    await writable.close();
  }
  return handle;
}

/** Append chunks as they arrive; keeps peak memory at one chunk. */
export async function appendChunks(runId, name, chunks) {
  return writeFile(runId, name, async (writable) => {
    for (const chunk of chunks) await writable.write(chunk);
  });
}

export async function writeBytes(runId, name, bytes) {
  return writeFile(runId, name, (writable) => writable.write(bytes));
}

export async function readFile(runId, name) {
  const dir = await runDir(runId);
  const handle = await dir.getFileHandle(name);
  return handle.getFile();
}

export async function fileSize(runId, name) {
  try {
    const file = await readFile(runId, name);
    return file.size;
  } catch {
    return 0;
  }
}

export async function removeFile(runId, name) {
  try {
    const dir = await runDir(runId);
    await dir.removeEntry(name);
  } catch {
    /* already gone */
  }
}

export async function removeRun(runId) {
  try {
    const top = await root();
    const base = await ensureDir(top, ROOT);
    await base.removeEntry(runId, { recursive: true });
  } catch {
    /* already gone */
  }
}

export async function requestPersistence() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
