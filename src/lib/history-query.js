/**
 * 历史页的筛选 / 排序 / 统计。
 *
 * 抽成纯函数是因为列表逻辑最容易在 UI 里写死、然后悄悄错：关键字该匹配哪些字段、
 * 「进行中」到底包含哪些状态、空标题怎么排 —— 这些都必须能脱离浏览器断言。
 */
export const STATE_LABEL = {
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

export const ACTIVE = ['QUEUED', 'DOWNLOADING', 'TRANSCRIBING', 'GENERATING', 'REVISING', 'POSTPROCESSING', 'RENDERING'];
export const DONE = ['RENDERED'];
export const FAILED = ['FAILED'];
export const CANCELLED = ['CANCELLED'];

function matchesQuery(run, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  const haystack = [
    run.title, run.bvid, run.url, run.message,
    STATE_LABEL[run.state] || run.state,
  ].filter(Boolean).join(' ').toLowerCase();
  return haystack.includes(needle);
}

function matchesStatus(run, status) {
  switch (status) {
    case 'active': return ACTIVE.includes(run.state);
    case 'done': return DONE.includes(run.state);
    case 'failed': return FAILED.includes(run.state);
    case 'cancelled': return CANCELLED.includes(run.state);
    default: return true;
  }
}

const SORTERS = {
  'created-desc': (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
  'created-asc': (a, b) => (a.createdAt || 0) - (b.createdAt || 0),
  'finished-desc': (a, b) => (b.finishedAt || 0) - (a.finishedAt || 0),
  'duration-desc': (a, b) => (b.durationMs || 0) - (a.durationMs || 0),
  'title-asc': (a, b) => String(a.title || '（无标题）').localeCompare(String(b.title || '（无标题）'), 'zh-CN'),
};

export function filterRuns(runs, { query = '', status = 'all', sort = 'created-desc' } = {}) {
  const list = (Array.isArray(runs) ? runs : []).filter(Boolean)
    .filter((run) => matchesQuery(run, query) && matchesStatus(run, status));
  return list.sort(SORTERS[sort] || SORTERS['created-desc']);
}

export function statsFor(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter(Boolean);
  const stats = {
    total: list.length,
    done: 0,
    failed: 0,
    cancelled: 0,
    active: 0,
    totalDurationMs: 0,
    totalTokens: 0,
    totalBytes: 0,
  };
  for (const run of list) {
    if (DONE.includes(run.state)) stats.done += 1;
    else if (FAILED.includes(run.state)) stats.failed += 1;
    else if (CANCELLED.includes(run.state)) stats.cancelled += 1;
    else stats.active += 1;
    stats.totalDurationMs += Number(run.durationMs || 0);
    stats.totalTokens += Number(run.usage?.totalTokens || 0);
    stats.totalBytes += Number(run.outputBytes || 0) + Number(run.imageBytes || 0);
  }
  return stats;
}

export function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!value) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1073741824) return `${(value / 1048576).toFixed(1)} MB`;
  return `${(value / 1073741824).toFixed(2)} GB`;
}

/** 视频时长按「分:秒 / 时:分:秒」显示，和历史页里「跑了多久」不是一回事。 */
export function formatDuration(ms) {
  const total = Math.round((Number(ms) || 0) / 1000);
  if (!total) return '—';
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function relativeTime(timestamp, now = Date.now()) {
  const at = Number(timestamp || 0);
  if (!at) return '—';
  const diff = Math.max(0, now - at);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export function formatTokens(count) {
  const value = Number(count || 0);
  if (!value) return '—';
  if (value < 10000) return String(value);
  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1000000).toFixed(2)}M`;
}
