/**
 * 后台浮层。弹窗关掉之后，任务还在 offscreen 里跑，这里是唯一能看见进度的地方。
 *
 * 进度不是轮询来的：流水线每一步都会广播 RUN_EVENT，这里只负责接住并渲染。
 * 所以即便 service worker 已经休眠，只要 offscreen 还活着，浮层就一直在动。
 */
import { send, onMessage, setErrorContext } from '../lib/bus.js';
import { MSG, STATE, TERMINAL_STATES } from '../lib/protocol.js';
import { loadSettings } from '../lib/settings.js';
import { installErrorTrap } from '../lib/diag.js';

installErrorTrap('mini');
setErrorContext('mini');

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const runId = params.get('run') || '';

const STATE_LABEL = {
  QUEUED: '排队中',
  DOWNLOADING: '下载音频',
  TRANSCRIBING: '转写',
  GENERATING: '生成正文',
  REVISING: '修订',
  POSTPROCESSING: '装配',
  RENDERING: '渲染长图',
  RENDERED: '已完成',
  FAILED: '失败',
  CANCELLED: '已取消',
};

const state = {
  runId,
  title: '',
  videoUrl: '',
  startedAt: Date.now(),
  finishedAt: 0,
  terminal: false,
  autoClose: false,
};

/* ---------------- 拖动 ---------------- */

/**
 * 无边框的 popup 窗口默认拖不动，所以自己实现：
 * 按住顶栏时按位移调用 chrome.windows.update 挪窗口。
 */
(function makeDraggable() {
  const grip = $('grip');
  let dragging = false;
  let origin = null;
  let pending = null;

  grip.addEventListener('mousedown', (event) => {
    if (event.target === $('close')) return;
    dragging = true;
    origin = { x: event.screenX, y: event.screenY };
    chrome.windows.getCurrent((win) => { origin.left = win.left; origin.top = win.top; });
  });

  window.addEventListener('mousemove', (event) => {
    if (!dragging || !origin || origin.left === undefined) return;
    const next = {
      left: origin.left + (event.screenX - origin.x),
      top: origin.top + (event.screenY - origin.y),
    };
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = null;
      chrome.windows.update(chrome.windows.WINDOW_ID_CURRENT, next).catch(() => {});
    });
  });

  window.addEventListener('mouseup', () => { dragging = false; });
})();

/* ---------------- 渲染 ---------------- */

function render({ progress, label, kind = '', note = '', stage = '' }) {
  if (label) {
    $('badge').textContent = label;
    $('badge').className = `badge${kind ? ` ${kind}` : ''}`;
    $('dot').className = `dot${kind ? ` ${kind}` : ''}`;
    $('fill').className = `fill${kind ? ` ${kind}` : ''}`;
  }
  if (progress !== undefined) {
    const value = Math.max(0, Math.min(100, Math.round(progress || 0)));
    $('fill').style.width = `${value}%`;
    $('pct').textContent = `${value}%`;
  }
  if (stage) $('stage').textContent = stage;
  const noteEl = $('note');
  noteEl.textContent = note || '';
  noteEl.classList.toggle('hidden', !note);
}

function tick() {
  if (!state.startedAt) return;
  const end = state.finishedAt || Date.now();
  const seconds = Math.max(0, Math.round((end - state.startedAt) / 1000));
  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  $('elapsed').textContent = `${mm}:${ss}`;
  if (!state.terminal) setTimeout(tick, 1000);
}

function finish(eventState, note = '') {
  state.terminal = true;
  state.finishedAt = Date.now();
  const done = eventState === STATE.RENDERED;
  const kind = done ? 'done' : (eventState === STATE.FAILED ? 'bad' : '');
  render({
    progress: 100,
    label: STATE_LABEL[eventState] || eventState,
    kind,
    note,
    stage: done ? '完成' : (note ? '失败' : '已结束'),
  });
  $('cancel').classList.add('hidden');
  $('open').disabled = !done;
  if (done && state.autoClose) setTimeout(() => window.close(), 1800);
}

/* ---------------- 消息 ---------------- */

onMessage(MSG.RUN_EVENT, (payload) => {
  if (!payload || payload.runId !== state.runId) return false;
  const { state: runState, progress, message } = payload;
  render({ progress, label: STATE_LABEL[runState] || runState, stage: message || '' });
  if (TERMINAL_STATES.includes(runState)) finish(runState, runState === STATE.FAILED ? (message || '') : '');
  return true;
});

// 长图是逐屏截图，没有这一条浮层会长时间停在同一个百分比上。
onMessage(MSG.CAPTURE_PROGRESS, (payload) => {
  if (!payload || payload.runId !== state.runId) return false;
  const { done, total, stage } = payload;
  render({
    progress: total ? (done / total) * 100 : 100,
    label: '渲染长图',
    stage: stage === 'done' ? '长图已保存' : `截图 ${done}/${total}`,
  });
  return true;
});

/* ---------------- 操作 ---------------- */

$('close').addEventListener('click', () => window.close());

$('open').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/viewer/viewer.html?run=${encodeURIComponent(state.runId)}`) });
});

$('video').addEventListener('click', () => {
  if (!state.videoUrl) return;
  chrome.tabs.create({ url: state.videoUrl });
});

$('cancel').addEventListener('click', async () => {
  $('cancel').disabled = true;
  await send(MSG.RUN_CANCEL, { runId: state.runId }).catch(() => {});
});

/* ---------------- boot ---------------- */

async function boot() {
  const settings = await loadSettings().catch(() => null);
  state.autoClose = Boolean(settings?.ui?.floatingAutoClose);

  const runs = await send(MSG.RUN_LIST).catch(() => []);
  const run = (Array.isArray(runs) ? runs : []).find((item) => item?.id === state.runId);
  if (run) {
    state.title = run.title || '';
    state.videoUrl = run.videoUrl || run.url || '';
    state.startedAt = run.createdAt || Date.now();
    $('title').textContent = run.title || '（无标题）';
    $('video').disabled = !state.videoUrl;
    render({
      progress: run.progress || 0,
      label: STATE_LABEL[run.state] || run.state,
      stage: run.message || '',
    });
    if (TERMINAL_STATES.includes(run.state)) finish(run.state, run.error?.message || '');
  } else {
    $('title').textContent = '任务已不存在。';
    render({ progress: 0, label: '已结束', stage: '' });
  }
  tick();
}

boot().catch((error) => {
  $('title').textContent = error?.message || '加载失败。';
});
