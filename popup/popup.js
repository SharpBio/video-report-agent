/** Popup: start a run, watch its progress, open or export finished reports. */
import { send } from '../src/lib/bus.js';
import { MSG, STATE, TERMINAL_STATES } from '../src/lib/protocol.js';
import { loadSettings } from '../src/lib/settings.js';
import { validateSettings } from '../src/lib/validate-settings.js';
import { installErrorTrap, recordError, lastError, clearError, firstFrame } from '../src/lib/diag.js';

const $ = (id) => document.getElementById(id);
const els = {
  hint: $('page-hint'),
  url: $('url'),
  pasteTitle: $('paste-title'),
  pasteText: $('paste-text'),
  start: $('start'),
  cancel: $('cancel'),
  progress: $('progress'),
  fill: $('progress-fill'),
  status: $('progress-text'),
  list: $('run-list'),
  refresh: $('refresh'),
  settings: $('settings'),
};

let mode = 'url';
let activeRunId = null;

/* ---------------- diagnostics ---------------- */

// 弹窗一关控制台就没了，所以把错误连堆栈一起存起来，下次打开时显示。
installErrorTrap('popup');

async function showLastError() {
  const entry = await lastError().catch(() => null);
  if (!entry) return;
  setStatus(`上次出错（${entry.context}）：${entry.message}　${firstFrame(entry)}`);
}

showLastError();
els.list.addEventListener('dblclick', () => { clearError(); setStatus('已清除错误记录。'); });

/* ---------------- tabs ---------------- */

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    mode = tab.dataset.tab;
    for (const other of document.querySelectorAll('.tab')) {
      other.classList.toggle('active', other === tab);
    }
    $('pane-url').classList.toggle('hidden', mode !== 'url');
    $('pane-paste').classList.toggle('hidden', mode !== 'paste');
  });
}

function openHistory() {
  chrome.tabs.create({ url: chrome.runtime.getURL('src/history/history.html') });
}

$('history').addEventListener('click', (event) => { event.preventDefault(); openHistory(); });
$('history-all').addEventListener('click', (event) => { event.preventDefault(); openHistory(); });

// 浮层是「关掉弹窗之后还能看见进度」的小窗；这里手动叫它出来。
$('mini').addEventListener('click', (event) => {
  event.preventDefault();
  guard(send(MSG.MINI_OPEN, {}).then(() => setStatus('已打开浮层。')), '打开浮层失败：');
});

els.settings.addEventListener('click', (event) => {
  event.preventDefault();
  chrome.runtime.openOptionsPage();
});

/* ---------------- current page ---------------- */

/**
 * 探测必须带上具体的 tabId。
 * 不传的话 service worker 只能去猜「当前窗口是哪个」—— 插件弹窗打开时
 * 「最近聚焦窗口」未必是用户刚看的那个视频页，探测就会静默失败，
 * 任务列表里于是出现「（无标题）」，而且拿不到页面里已签名的流地址。
 */
let currentTabId = null;
let detectedUrl = '';

async function detectPage() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) {
      els.hint.textContent = '没有打开的标签页。';
      return;
    }
    currentTabId = tab.id || null;
    if (/^https:\/\/(www\.)?bilibili\.com\/video\/BV/.test(tab.url)) {
      // 多 P 视频要说清楚当前是第几个：说清楚了，做出来才发现拿错了的情况就少一半。
      const page = Number(new URL(tab.url).searchParams.get('p')) || 0;
      els.hint.textContent = page > 1
        ? `检测到视频页（第 ${page} 个分 P），直接生成即可。`
        : '检测到视频页，直接生成即可。';
      els.url.value = tab.url;
      detectedUrl = tab.url;
    } else if (/^https:\/\/(www\.)?bilibili\.com\//.test(tab.url)) {
      els.hint.textContent = '当前在 B 站但不是视频页，请打开视频或粘贴链接。';
    } else {
      els.hint.textContent = '当前不是 B 站页面，请粘贴视频链接。';
    }
  } catch {
    els.hint.textContent = '无法读取当前页面。';
  }
}

/* ---------------- run control ---------------- */

/**
 * 所有异步入口都必须经过这里。弹窗一关控制台就没了，
 * 任何一个没接住的 rejection 都会变成 chrome://extensions 里那句没有堆栈的
 * "Uncaught (in promise) Error: ..."，根本没法定位。
 */
function guard(promise, fallback = '操作失败。') {
  Promise.resolve(promise).catch((error) => {
    recordError('popup', error);
    setStatus(`${fallback} ${error?.message || ''}`.trim());
  });
  return undefined;
}

async function start() {
  // loadSettings 也要在 try 里：它在 await 上抛错时，下面那段 try 还进不去。
  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    recordError('popup', error);
    setStatus(error?.message || '读取设置失败。');
    return undefined;
  }
  const payload = {};
  if (mode === 'paste') {
    payload.transcriptText = els.pasteText.value;
    payload.title = els.pasteTitle.value.trim();
    if (!payload.transcriptText.trim()) {
      setStatus('请先粘贴转写文本。');
      return;
    }
    const check = validateSettings({ ...settings, asr: { ...settings.asr, enabled: false } });
    if (!check.ok) return openOptions(check.errors[0]);
  } else {
    payload.url = els.url.value.trim();
    // 只有地址还是探测到的那个页面时才带 tabId：用户手改过就不能拿那个页面去探测。
    if (currentTabId && payload.url === detectedUrl) payload.tabId = currentTabId;
    const check = validateSettings(settings);
    if (!check.ok) return openOptions(check.errors[0]);
  }

  els.start.disabled = true;
  els.cancel.classList.remove('hidden');
  els.progress.classList.remove('hidden');
  setStatus('排队中…');

  // 弹窗里的任何一步都可能是最后一次机会，出错要能看见。
  try {
    const { runId } = await send(MSG.RUN_START, payload);
    activeRunId = runId;
  } catch (error) {
    recordError('popup', error);
    setStatus(error?.message || '启动失败。');
    els.start.disabled = false;
    els.cancel.classList.add('hidden');
  }
  return undefined;
}

function openOptions(message) {
  setStatus(`${message} 请在设置里补全。`);
  chrome.runtime.openOptionsPage();
  return undefined;
}

function setStatus(text) {
  els.status.textContent = text;
}

els.start.addEventListener('click', () => { guard(start(), '启动失败：'); });
els.cancel.addEventListener('click', async () => {
  if (activeRunId) await send(MSG.RUN_CANCEL, { runId: activeRunId }).catch(() => {});
  els.cancel.classList.add('hidden');
  els.start.disabled = false;
});

/* ---------------- progress events ---------------- */

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.CAPTURE_PROGRESS) {
    const { done, total, stage } = message.payload || {};
    // 长图受 Chrome 配额限制（每秒最多 2 屏），十几屏要跑十几秒。
    // 没有这条反馈，用户只会看到「弹窗闪一下」，以为又失败了。
    if (stage === 'done') setStatus('长图已保存。');
    else if (stage === 'stitch') setStatus('正在拼图…');
    else setStatus(`正在生成长图… 第 ${done}/${total} 屏`);
    return;
  }
  if (message?.type !== MSG.RUN_EVENT) return;
  const { runId, state, progress, message: text } = message.payload || {};
  if (activeRunId && runId !== activeRunId) return;
  els.fill.style.width = `${Math.max(0, Math.min(100, progress || 0))}%`;
  setStatus(text || state);
  if (TERMINAL_STATES.includes(state)) {
    els.start.disabled = false;
    els.cancel.classList.add('hidden');
    if (state === STATE.RENDERED) activeRunId = null;
    guard(refreshRuns(), '刷新任务列表失败：');
  }
});

/* ---------------- run list ---------------- */

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

// 点击回调是同步的，里面的 promise 必须自己接住。
function click(promise, fallback) {
  return () => guard(promise(), fallback);
}

async function refreshRuns() {
  let runs = [];
  try {
    runs = await send(MSG.RUN_LIST);
  } catch (error) {
    recordError('popup', error);
    els.list.innerHTML = '<li class="empty">无法读取任务列表。</li>';
    return;
  }
  if (!Array.isArray(runs) || !runs.length) {
    els.list.innerHTML = '<li class="empty">还没有任务。</li>';
    return;
  }
  els.list.innerHTML = '';
  // 任务记录可能来自旧的/损坏的快照，跳掉空洞条目，别让 item.id 把整个列表渲染炸掉。
  for (const run of runs.slice(0, 8).filter(Boolean)) {
    const item = document.createElement('li');
    item.className = `run${run.state === STATE.FAILED ? ' error' : ''}`;

    const title = document.createElement('div');
    title.className = 'run-title';
    title.textContent = run.title || (run.state === STATE.RENDERED ? '报告' : '（无标题）');
    // 多 P 视频必须让人一眼看出处理的是哪一 P：不然做完也分不清是不是拿错了。
    if (run.pageCount > 1) {
      const tag = document.createElement('span');
      tag.className = 'run-page';
      tag.textContent = `P${run.pageNumber || 1}/${run.pageCount}`;
      title.appendChild(tag);
    }
    const state = document.createElement('div');
    state.className = 'run-state';
    state.textContent = STATE_LABEL[run.state] || run.state;

    const actions = document.createElement('div');
    actions.className = 'run-actions';
    if (run.state === STATE.RENDERED) {
      actions.appendChild(buttonFor('查看', () => openViewer(run.id)));
      actions.appendChild(buttonFor('导出 HTML', click(() => exportHtml(run.id), '导出失败：')));
      actions.appendChild(buttonFor('导出长图', click(() => exportPng(run.id), '长图失败：')));
    } else if (!TERMINAL_STATES.includes(run.state)) {
      actions.appendChild(buttonFor('取消', click(() => send(MSG.RUN_CANCEL, { runId: run.id }).then(refreshRuns), '取消失败：')));
    }
    if (run.videoUrl) {
      actions.appendChild(buttonFor('原视频', () => chrome.tabs.create({ url: run.videoUrl })));
    }
    actions.appendChild(buttonFor('删除', click(() => send(MSG.RUN_DELETE, { runId: run.id }).then(refreshRuns), '删除失败：')));

    item.append(title, state, actions);
    els.list.appendChild(item);
  }
}

function buttonFor(label, handler) {
  const element = document.createElement('button');
  element.textContent = label;
  element.addEventListener('click', handler);
  return element;
}

function openViewer(runId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/viewer/viewer.html?run=${encodeURIComponent(runId)}`) });
}

async function exportHtml(runId) {
  try {
    setStatus('正在导出 HTML…');
    await send(MSG.EXPORT_HTML, { runId });
    setStatus('HTML 已导出。');
  } catch (error) {
    setStatus(`导出失败：${error?.message || ''}`.trim());
  }
}

async function exportPng(runId) {
  // 长图要临时开一个窗口逐屏拍，Chrome 限每秒 2 屏，所以会跑十几秒 —— 进度靠广播回传。
  setStatus('正在生成长图…');
  try {
    const result = await send(MSG.CAPTURE_PNG, { runId });
    setStatus(`长图已保存：${Math.round((result.bytes / 1048576) * 10) / 10} MB，${result.height} px`);
  } catch (error) {
    setStatus(`长图失败：${error?.message || ''}`.trim());
  }
}

els.refresh.addEventListener('click', () => guard(refreshRuns(), '刷新失败：'));

/**
 * 弹窗关掉再打开时，正在跑的任务要接着显示 —— 不然用户会以为刚才那次已经中断了。
 * 任务本来就在后台跑，这里只是重新把进度条绑上去。
 */
async function resumeWatching() {
  const runs = await send(MSG.RUN_LIST).catch(() => []);
  const live = (Array.isArray(runs) ? runs : [])
    .filter(Boolean)
    .find((run) => !TERMINAL_STATES.includes(run.state));
  if (!live) return;
  activeRunId = live.id;
  els.progress.classList.remove('hidden');
  els.fill.style.width = `${Math.max(0, Math.min(100, live.progress || 0))}%`;
  setStatus(live.message || STATE_LABEL[live.state] || live.state);
  els.start.disabled = true;
  els.cancel.classList.remove('hidden');
}

guard(detectPage(), '页面检测失败：');
guard(refreshRuns().then(resumeWatching), '刷新失败：');
