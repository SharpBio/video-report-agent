/**
 * 历史记录页。列表的筛选/排序/统计都在 lib/history-query.js 里（纯函数，可测），
 * 这一页只负责把数据画出来、把点击变成一次消息调用。
 */
import { send, setErrorContext } from '../lib/bus.js';
import { MSG, STATE } from '../lib/protocol.js';
import { installErrorTrap } from '../lib/diag.js';
import {
  filterRuns, statsFor, formatBytes, formatDuration, relativeTime, formatTokens, STATE_LABEL, ACTIVE,
} from '../lib/history-query.js';

installErrorTrap('history');
// 这一页读不到 chrome.storage 之外的诊断，先声明上下文，落盘的堆栈才认得出出处。
setErrorContext('history');

const $ = (id) => document.getElementById(id);
const els = {
  stats: $('stats'),
  q: $('q'),
  status: $('status'),
  sort: $('sort'),
  list: $('list'),
  empty: $('empty'),
  summary: $('summary'),
  selectAll: $('select-all'),
  deleteSelected: $('delete-selected'),
  toast: $('toast'),
};

const store = {
  runs: [],
  storage: null,
  selected: new Set(),
  expanded: new Set(),
  details: new Map(),
};

let toastTimer = null;
function toast(text) {
  els.toast.textContent = text;
  els.toast.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => els.toast.classList.add('hidden'), 2400);
}

/* ---------------- 数据 ---------------- */

async function load() {
  const [runs, storage] = await Promise.all([
    send(MSG.RUN_LIST).catch(() => []),
    send(MSG.STORAGE_STATS).catch(() => null),
  ]);
  store.runs = Array.isArray(runs) ? runs.filter(Boolean) : [];
  store.storage = storage || null;
  store.selected.clear();
  els.selectAll.checked = false;
  render();
}

function visible() {
  return filterRuns(store.runs, {
    query: els.q.value,
    status: els.status.value,
    sort: els.sort.value,
  });
}

/* ---------------- 渲染 ---------------- */

function render() {
  renderStats();
  const rows = visible();
  const stats = statsFor(rows);
  els.summary.textContent = rows.length
    ? `显示 ${rows.length} 条（共 ${store.runs.length} 条）· 合计 ${formatDuration(stats.totalDurationMs)} · ${formatTokens(stats.totalTokens)} token`
    : `共 ${store.runs.length} 条`;

  els.list.innerHTML = '';
  els.empty.classList.toggle('hidden', rows.length > 0);
  for (const run of rows) els.list.appendChild(rowFor(run));
  updateSelectionUi();
}

function renderStats() {
  const stats = statsFor(store.runs);
  const cards = [
    { k: '总任务', v: String(stats.total) },
    { k: '已完成', v: String(stats.done), cls: 'good' },
    { k: '失败', v: String(stats.failed), cls: 'bad' },
    { k: '进行中', v: String(stats.active), cls: 'busy' },
    { k: '累计时长', v: formatDuration(stats.totalDurationMs) },
    { k: '占用', v: formatBytes(store.storage?.usage || stats.totalBytes) },
  ];
  els.stats.innerHTML = '';
  for (const card of cards) {
    const box = document.createElement('div');
    box.className = `stat${card.cls ? ` ${card.cls}` : ''}`;
    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = card.k;
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = card.v;
    box.append(k, v);
    els.stats.appendChild(box);
  }
}

function badgeFor(state) {
  const cls = state === STATE.RENDERED ? 'done'
    : (state === STATE.FAILED ? 'failed' : (ACTIVE.includes(state) ? 'active' : ''));
  const el = document.createElement('span');
  el.className = `badge${cls ? ` ${cls}` : ''}`;
  el.textContent = STATE_LABEL[state] || state;
  return el;
}

function rowFor(run) {
  const item = document.createElement('li');
  const done = run.state === STATE.RENDERED;
  const active = ACTIVE.includes(run.state);
  item.className = `item${done ? ' done' : (run.state === STATE.FAILED ? ' failed' : (active ? ' active' : ''))}`;
  item.dataset.runId = run.id;

  const row = document.createElement('div');
  row.className = 'row';

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'pick';
  pick.checked = store.selected.has(run.id);
  pick.addEventListener('change', () => {
    if (pick.checked) store.selected.add(run.id);
    else store.selected.delete(run.id);
    updateSelectionUi();
  });

  const main = document.createElement('div');
  main.className = 'main';

  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = run.title || '（无标题）';
  title.title = '点击展开详情';
  title.addEventListener('click', () => toggleDetail(run.id, item));

  const meta = document.createElement('div');
  meta.className = 'meta';
  meta.appendChild(badgeFor(run.state));
  // 多 P 视频要标明处理的是哪一 P：做完一堆报告，不然分不清哪个是哪个。
  if (run.pageCount > 1) {
    const page = span(`第 ${run.pageNumber || 1}/${run.pageCount} 个分 P`);
    page.className = 'page-tag';
    page.title = run.pageTitle || '';
    meta.appendChild(page);
  }
  if (run.bvid) {
    const bvid = document.createElement('a');
    bvid.className = 'bvid';
    bvid.textContent = run.bvid;
    bvid.href = '#';
    bvid.addEventListener('click', (event) => {
      event.preventDefault();
      if (run.videoUrl) chrome.tabs.create({ url: run.videoUrl });
    });
    meta.appendChild(bvid);
  }
  meta.appendChild(span(relativeTime(run.createdAt)));
  if (run.durationMs) meta.appendChild(span(`时长 ${formatDuration(run.durationMs)}`));
  if (run.unitCount) meta.appendChild(span(`${run.unitCount} 个来源单元`));
  if (run.usage?.totalTokens) meta.appendChild(span(`${formatTokens(run.usage.totalTokens)} token`));
  if (run.outputBytes) meta.appendChild(span(`报告 ${formatBytes(run.outputBytes)}`));
  if (run.state === STATE.FAILED && run.error?.message) meta.appendChild(span(`失败：${run.error.message}`));

  main.append(title, meta);

  const acts = document.createElement('div');
  acts.className = 'acts';
  if (done) {
    acts.appendChild(act('查看', () => openViewer(run.id)));
    acts.appendChild(act('HTML', () => exportHtml(run)));
    acts.appendChild(act('长图', () => exportPng(run)));
    acts.appendChild(act('转写', () => exportTranscript(run)));
  } else if (active) {
    acts.appendChild(act('取消', () => cancelRun(run.id)));
    if (run.progress) acts.appendChild(span(`${Math.round(run.progress)}%`));
  } else if (run.state === STATE.FAILED) {
    acts.appendChild(act('重试', () => resumeRun(run.id)));
  }
  if (run.videoUrl) acts.appendChild(act('原视频', () => chrome.tabs.create({ url: run.videoUrl })));
  acts.appendChild(act('重命名', () => renameRun(run)));
  acts.appendChild(act('删除', () => deleteRun(run), 'danger'));

  row.append(pick, main, acts);
  item.appendChild(row);
  if (store.expanded.has(run.id)) item.appendChild(detailBox(run.id));
  return item;
}

function span(text) {
  const el = document.createElement('span');
  el.textContent = text;
  return el;
}

function act(label, handler, cls = '') {
  const button = document.createElement('button');
  button.textContent = label;
  if (cls) button.classList.add(cls);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    handler();
  });
  return button;
}

function updateSelectionUi() {
  const count = store.selected.size;
  els.deleteSelected.disabled = count === 0;
  els.deleteSelected.textContent = count ? `删除选中（${count}）` : '删除选中';
}

/* ---------------- 详情 ---------------- */

function detailBox(runId) {
  const box = document.createElement('div');
  box.className = 'detail';
  box.dataset.detailFor = runId;

  const cached = store.details.get(runId);
  if (!cached) {
    box.textContent = '加载中…';
    send(MSG.RUN_DETAIL, { runId })
      .then((detail) => {
        store.details.set(runId, detail);
        if (box.isConnected) renderDetail(box, detail);
      })
      .catch((error) => { box.textContent = `读取失败：${error?.message || error}`; });
    return box;
  }
  renderDetail(box, cached);
  return box;
}

function renderDetail(box, detail) {
  box.innerHTML = '';
  const { run, logs, usage, output, transcript } = detail;

  const kv = document.createElement('div');
  kv.className = 'kv';
  const pairs = [
    ['任务号', run.id],
    ['状态', `${STATE_LABEL[run.state] || run.state}${run.errorStage ? `（${run.errorStage}）` : ''}`],
    ['创建', new Date(run.createdAt || 0).toLocaleString('zh-CN')],
    ['完成', run.finishedAt ? new Date(run.finishedAt).toLocaleString('zh-CN') : '—'],
    ['视频时长', formatDuration(run.durationMs)],
    ['来源单元', run.unitCount ? `${run.unitCount} 个` : '—'],
    ['模式', `${run.reportMode}${run.transcriptMode ? ` / ${run.transcriptMode}` : ''}`],
    ['报告', output ? `${output.sectionCount || 0} 章 · ${formatBytes(output.bytes)}` : '—'],
  ];
  if (usage) {
    pairs.push(['Token', `${formatTokens(usage.totalTokens)}（入 ${formatTokens(usage.promptTokens)} / 出 ${formatTokens(usage.completionTokens)}）`]);
    pairs.push(['请求数', String(usage.requests || 0)]);
  }
  if (transcript?.source) pairs.push(['来源', `${transcript.source}${transcript.attribution ? ` · ${transcript.attribution}` : ''}`]);
  for (const [key, value] of pairs) {
    const line = document.createElement('div');
    line.append(span(`${key}：`), document.createTextNode(String(value)));
    kv.appendChild(line);
  }
  box.appendChild(kv);

  if (run.error?.message) {
    const h = document.createElement('h4');
    h.textContent = `失败原因（${run.error.code || 'UNCLASSIFIED'} / ${run.error.category || '—'}）`;
    const pre = document.createElement('div');
    pre.className = 'logs';
    pre.textContent = run.error.message;
    box.append(h, pre);
  }

  const h = document.createElement('h4');
  h.textContent = `日志（${(logs || []).length} 条）`;
  const logBox = document.createElement('div');
  logBox.className = 'logs';
  for (const entry of (logs || []).slice(-60)) {
    const line = document.createElement('div');
    line.className = `lv-${entry.level || 'info'}`;
    const stamp = new Date(entry.at || 0).toLocaleTimeString('zh-CN', { hour12: false });
    line.textContent = `${stamp} [${entry.stage}] ${entry.message}`;
    logBox.appendChild(line);
  }
  if (!(logs || []).length) logBox.textContent = '没有日志 —— 说明任务在派发出去之前就结束了。';
  box.append(h, logBox);

  const findings = output?.findings || [];
  if (findings.length) {
    const fh = document.createElement('h4');
    fh.textContent = `检查发现（${findings.length}）`;
    const ul = document.createElement('ul');
    ul.className = 'findings';
    for (const finding of findings.slice(0, 20)) {
      const li = document.createElement('li');
      li.textContent = `[${finding.kind}] ${finding.detail}`;
      ul.appendChild(li);
    }
    box.append(fh, ul);
  }
}

function toggleDetail(runId, item) {
  if (store.expanded.has(runId)) {
    store.expanded.delete(runId);
  } else {
    store.expanded.add(runId);
  }
  const box = item.querySelector('.detail');
  if (box) box.remove();
  else item.appendChild(detailBox(runId));
}

/* ---------------- 操作 ---------------- */

function openViewer(runId) {
  chrome.tabs.create({ url: chrome.runtime.getURL(`src/viewer/viewer.html?run=${encodeURIComponent(runId)}`) });
}

async function exportHtml(run) {
  try {
    await send(MSG.EXPORT_HTML, { runId: run.id });
    toast('HTML 已导出。');
  } catch (error) {
    toast(`导出失败：${error?.message || error}`);
  }
}

async function exportTranscript(run) {
  try {
    await send(MSG.EXPORT_TRANSCRIPT, { runId: run.id });
    toast('转写已导出。');
  } catch (error) {
    toast(`导出失败：${error?.message || error}`);
  }
}

async function exportPng(run) {
  toast('正在生成长图…');
  try {
    const result = await send(MSG.CAPTURE_PNG, { runId: run.id });
    toast(`长图已保存：${result.height} px`);
  } catch (error) {
    toast(`长图失败：${error?.message || error}`);
  }
}

async function cancelRun(runId) {
  await send(MSG.RUN_CANCEL, { runId }).catch(() => {});
  toast('已请求取消。');
  setTimeout(load, 600);
}

async function resumeRun(runId) {
  await send(MSG.RUN_RESUME, { runId }).catch(() => {});
  toast('已重新排队。');
  setTimeout(load, 600);
}

async function renameRun(run) {
  const next = window.prompt('新的标题', run.title || '');
  if (next === null) return;
  try {
    await send(MSG.RUN_RENAME, { runId: run.id, title: next });
    run.title = next.trim();
    toast('已重命名。');
    render();
  } catch (error) {
    toast(`重命名失败：${error?.message || error}`);
  }
}

async function deleteRun(run) {
  if (!window.confirm(`删除「${run.title || '（无标题）'}」？报告和音频会一起清掉。`)) return;
  await send(MSG.RUN_CLEAR, { ids: [run.id] }).catch(() => {});
  toast('已删除。');
  await load();
}

/* ---------------- 工具栏 ---------------- */

els.q.addEventListener('input', render);
els.status.addEventListener('change', render);
els.sort.addEventListener('change', render);
$('refresh').addEventListener('click', () => { load().catch(() => toast('刷新失败。')); });
$('mini').addEventListener('click', async () => {
  await send(MSG.MINI_OPEN, {}).catch(() => toast('打开失败。'));
});

els.selectAll.addEventListener('change', () => {
  const rows = visible();
  if (els.selectAll.checked) for (const run of rows) store.selected.add(run.id);
  else for (const run of rows) store.selected.delete(run.id);
  render();
});

els.deleteSelected.addEventListener('click', async () => {
  const ids = [...store.selected];
  if (!ids.length) return;
  if (!window.confirm(`删除 ${ids.length} 个任务？报告和音频会一起清掉。`)) return;
  await send(MSG.RUN_CLEAR, { ids }).catch(() => {});
  toast(`已删除 ${ids.length} 个。`);
  await load();
});

$('clear-done').addEventListener('click', async () => {
  if (!window.confirm('清空所有已完成任务？进行中的任务会保留。')) return;
  const result = await send(MSG.RUN_CLEAR, { scope: 'completed' }).catch(() => null);
  toast(`已清空 ${result?.deleted || 0} 个。`);
  await load();
});

$('clear-all').addEventListener('click', async () => {
  if (!window.confirm('清空全部历史？此操作不可撤销。')) return;
  const result = await send(MSG.RUN_CLEAR, { scope: 'all' }).catch(() => null);
  toast(`已清空 ${result?.deleted || 0} 个。`);
  await load();
});

/* ---------------- 实时更新 ---------------- */

// 正在跑的任务要跟着动，但每帧整表重画会打断搜索框输入，所以节流。
let reloadTimer = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.CAPTURE_PROGRESS) {
    const { done, total, stage } = message.payload || {};
    // 长图受 Chrome 每秒 2 屏的配额限制，十几屏要十几秒；不报进度就像卡死了。
    if (stage === 'done') toast('长图已保存。');
    else if (stage === 'stitch') toast('正在拼图…');
    else toast(`正在生成长图… 第 ${done}/${total} 屏`);
    return undefined;
  }
  if (message?.type !== MSG.RUN_EVENT) return undefined;
  store.details.delete(message.payload?.runId);
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => load().catch(() => {}), 500);
  return undefined;
});

load().catch((error) => toast(`加载失败：${error?.message || error}`));
