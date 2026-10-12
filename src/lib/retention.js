/**
 * Retention: prune large blobs from terminal runs.
 * Reports and transcripts live in IndexedDB and always survive; only OPFS
 * media (audio, PNG) is reclaimed, mirroring retention.py::cleanup_media.
 */
import * as db from './db.js';
import * as opfs from './opfs.js';
import { TERMINAL_STATES } from './protocol.js';

const DAY_MS = 86400000;

/** @returns {{pruned:number, kept:number, bytes:number}} */
export async function prune({ keepLast = 10, maxAgeDays = 7, keepAudio = false } = {}) {
  const runs = await db.listRuns();
  const terminal = runs
    .filter((run) => TERMINAL_STATES.includes(run.state))
    .sort((a, b) => (b.finishedAt || b.updatedAt) - (a.finishedAt || a.updatedAt));

  const cutoff = Date.now() - maxAgeDays * DAY_MS;
  let pruned = 0;
  let kept = 0;
  let bytes = 0;

  for (let index = 0; index < terminal.length; index += 1) {
    const run = terminal[index];
    if (!run) continue;
    const finished = run.finishedAt || run.updatedAt;
    const overCount = keepLast > 0 && index >= keepLast;
    const overAge = maxAgeDays > 0 && finished < cutoff;
    if (!overCount && !overAge) {
      kept += 1;
      continue;
    }
    bytes += Number(run.audioBytes || 0) + Number(run.imageBytes || 0);
    if (keepAudio) {
      await opfs.removeFile(run.id, 'report.png');
    } else {
      await opfs.removeRun(run.id);
    }
    await db.updateRun(run.id, {
      audioBytes: keepAudio ? Number(run.audioBytes || 0) : 0,
      imageBytes: 0,
      mediaPurged: true,
    });
    pruned += 1;
  }
  return { pruned, kept, bytes };
}

/** A cancelled run keeps its reusable inputs; everything else goes. */
export async function pruneCancelled(runId) {
  await opfs.removeFile(runId, 'report.png');
  return db.updateRun(runId, { imageBytes: 0 });
}

export async function estimateStorage() {
  if (!navigator.storage?.estimate) return { usage: 0, quota: 0 };
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usage, quota };
}
