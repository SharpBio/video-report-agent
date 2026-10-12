/**
 * Watchdog. The service worker can be killed at any moment, so a run that stops
 * heartbeating is resumed from its last durable checkpoint instead of being lost.
 */

export const ALARM_NAME = 'vra-supervisor';
const PERIOD_MINUTES = 1;
const STALE_MS = 3 * 60 * 1000;

export async function ensureAlarm() {
  if (!chrome.alarms) return;
  const existing = await chrome.alarms.get(ALARM_NAME);
  if (!existing) {
    await chrome.alarms.create(ALARM_NAME, { periodInMinutes: PERIOD_MINUTES });
  }
}

export function onAlarm(handler) {
  if (!chrome.alarms?.onAlarm) return;
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_NAME) handler();
  });
}

/**
 * @param {object} deps
 * @param {() => Promise<Array>} deps.listActiveRuns
 * @param {(runId:string) => Promise<void>} deps.resumeRun
 * @param {(runId:string, reason:string) => Promise<void>} deps.failRun
 */
export async function sweep({ listActiveRuns, resumeRun, failRun }) {
  const now = Date.now();
  const runs = await listActiveRuns();
  const summary = { resumed: 0, failed: 0, healthy: 0 };
  for (const run of runs) {
    if (!run) continue;
    const beat = run.heartbeatAt || run.updatedAt || run.createdAt;
    if (beat && now - beat < STALE_MS) {
      summary.healthy += 1;
      continue;
    }
    if ((run.resumeAttempts || 0) >= 3) {
      await failRun(run.id, 'EXECUTION_TIMEOUT', '任务长时间没有进展，已停止。');
      summary.failed += 1;
      continue;
    }
    try {
      await resumeRun(run.id);
      summary.resumed += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
