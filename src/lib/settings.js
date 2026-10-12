/**
 * Settings storage.
 * Secrets stay in `chrome.storage.local` (never synced to the Google account);
 * everything else goes to `chrome.storage.sync`.
 */
export const DEFAULT_SETTINGS = {
  llm: {
    provider: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    apiKey: '',
    thinking: 'off',
    maxOutputTokens: 8192,
    timeoutMs: 600000,
    toolsMode: 'native',
  },
  asr: {
    enabled: true,
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
    model: 'paraformer-v2',
    apiKey: '',
    language: 'zh',
    pollSeconds: 5,
    maxWaitSeconds: 1800,
    maxAudioBytes: 250 * 1024 * 1024,
    maxDurationMs: 60 * 60 * 1000,
  },
  report: {
    mode: 'standard',
    review: true,
    sectionTime: 'computed',
    imageWidth: 920,
    maxSections: 12,
    footerUrl: 'https://github.com/SharpBio/video-report-agent',
    disableExecJs: false,
  },
  ingest: {
    prefer: 'page',
    referer: 'https://www.bilibili.com/',
    truncateTo60Min: false,
  },
  retention: {
    keepLast: 10,
    maxAgeDays: 7,
    keepAudio: false,
  },
  ui: {
    // 浮层：弹窗关掉之后，任务还在后台跑，用一个小窗继续显示进度。
    floating: true,
    // 任务跑完要不要自动关掉浮层（false = 留在原地显示结果，手动关）。
    floatingAutoClose: false,
    // 浮层位置（left/top/width/height），关窗时记住，下次原地打开。
    floatingRect: null,
  },
};

export const SECRET_KEYS = ['llm.apiKey', 'asr.apiKey', 'wbiKeys'];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function setPath(target, path, value) {
  const parts = path.split('.');
  let node = target;
  for (const part of parts.slice(0, -1)) {
    if (!node[part] || typeof node[part] !== 'object') node[part] = {};
    node = node[part];
  }
  node[parts.at(-1)] = value;
}

function getPath(target, path) {
  return path.split('.').reduce((node, part) => (node == null ? undefined : node[part]), target);
}

/** Deep-merge `patch` into a copy of DEFAULT_SETTINGS; unknown keys are dropped. */
function mergeDefaults(stored) {
  const result = clone(DEFAULT_SETTINGS);
  if (!stored || typeof stored !== 'object') return result;
  for (const section of Object.keys(DEFAULT_SETTINGS)) {
    const incoming = stored[section];
    if (!incoming || typeof incoming !== 'object') continue;
    for (const key of Object.keys(DEFAULT_SETTINGS[section])) {
      if (incoming[key] !== undefined) result[section][key] = incoming[key];
    }
  }
  return result;
}

/**
 * chrome.storage 不是所有上下文都有 —— offscreen 文档里就取不到。
 * 这里给出一句话说清原因，免得只看到 "reading 'local'" 这种莫名其妙的报错。
 */
function storageArea(name) {
  const store = typeof chrome !== 'undefined' ? chrome.storage?.[name] : null;
  if (!store) {
    throw new Error(
      `当前上下文没有 chrome.storage.${name}。offscreen 文档读不到 storage，设置必须由 service worker 通过任务载荷传入。`,
    );
  }
  return store;
}

export async function loadSettings() {
  const [local, sync] = await Promise.all([
    storageArea('local').get(null),
    storageArea('sync').get(null),
  ]);
  const settings = mergeDefaults(sync.settings);
  for (const path of SECRET_KEYS) {
    const value = getPath(local, path);
    if (value !== undefined) setPath(settings, path, value);
  }
  if (local.wbiKeys !== undefined) settings.wbiKeys = local.wbiKeys;
  return settings;
}

export async function saveSettings(settings) {
  const sync = clone(settings);
  const local = {};
  for (const path of SECRET_KEYS) {
    const value = getPath(settings, path);
    if (value !== undefined) {
      setPath(local, path, value);
      setPath(sync, path, undefined);
    }
  }
  delete sync.wbiKeys;
  await Promise.all([
    storageArea('sync').set({ settings: sync }),
    storageArea('local').set(local),
  ]);
}

export async function patchSettings(patch) {
  const current = await loadSettings();
  const next = clone(current);
  for (const [section, values] of Object.entries(patch)) {
    next[section] = { ...(next[section] || {}), ...values };
  }
  await saveSettings(next);
  return next;
}

export function onSettingsChanged(handler) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) handler();
    if (area === 'local' && SECRET_KEYS.some((key) => key in changes)) handler();
  });
}
