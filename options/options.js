/** Options page: every setting, inline validation, and a connection probe. */
import { loadSettings, saveSettings } from '../src/lib/settings.js';
import { validateSettings, ASR_MODELS } from '../src/lib/validate-settings.js';
import { presetFor } from '../src/lib/providers.js';
import { send } from '../src/lib/bus.js';
import { MSG, STATE } from '../src/lib/protocol.js';
import * as db from '../src/lib/db.js';
import { lastError, firstFrame } from '../src/lib/diag.js';

const $ = (id) => document.getElementById(id);
const MB = 1048576;

const FIELDS = {
  'llm.provider': ['llm-provider', 'string'],
  'llm.baseUrl': ['llm-baseUrl', 'string'],
  'llm.model': ['llm-model', 'string'],
  'llm.apiKey': ['llm-apiKey', 'string'],
  'llm.thinking': ['llm-thinking', 'string'],
  'llm.toolsMode': ['llm-toolsMode', 'string'],
  'llm.maxOutputTokens': ['llm-maxOutputTokens', 'number'],
  'llm.timeoutMs': ['llm-timeoutMs', 'number'],
  'asr.enabled': ['asr-enabled', 'bool'],
  'asr.model': ['asr-model', 'string'],
  'asr.baseUrl': ['asr-baseUrl', 'string'],
  'asr.apiKey': ['asr-apiKey', 'string'],
  'asr.pollSeconds': ['asr-pollSeconds', 'number'],
  'asr.maxWaitSeconds': ['asr-maxWaitSeconds', 'number'],
  'report.mode': ['report-mode', 'string'],
  'report.review': ['report-review', 'bool'],
  'report.sectionTime': ['report-sectionTime', 'string'],
  'report.imageWidth': ['report-imageWidth', 'number'],
  'report.maxSections': ['report-maxSections', 'number'],
  'report.footerUrl': ['report-footerUrl', 'string'],
  'report.disableExecJs': ['report-execJs', 'boolInverted'],
  'ingest.prefer': ['ingest-prefer', 'string'],
  'ingest.truncateTo60Min': ['ingest-truncate', 'bool'],
  'retention.keepLast': ['retention-keepLast', 'number'],
  'retention.maxAgeDays': ['retention-maxAgeDays', 'number'],
  'retention.keepAudio': ['retention-keepAudio', 'bool'],
  'ui.floating': ['ui-floating', 'bool'],
  'ui.floatingAutoClose': ['ui-floating-auto', 'bool'],
};

let settings = await loadSettings();
let suppressPreset = false;

function fillModelOptions() {
  const select = $('asr-model');
  select.innerHTML = '';
  for (const model of ASR_MODELS) {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  }
}

function toForm() {
  for (const [path, [id, kind]] of Object.entries(FIELDS)) {
    const value = path.split('.').reduce((node, part) => node?.[part], settings);
    const element = $(id);
    if (!element) continue;
    if (path === 'asr.maxAudioBytes') continue;
    if (kind === 'bool') element.value = value ? 'true' : 'false';
    else if (kind === 'boolInverted') element.value = value ? 'true' : 'false';
    else element.value = value ?? '';
  }
  $('asr-maxAudioMB').value = Math.round((settings.asr.maxAudioBytes || 0) / MB);
}

function fromForm() {
  for (const [path, [id, kind]] of Object.entries(FIELDS)) {
    const element = $(id);
    if (!element) continue;
    const raw = element.value;
    const [section, key] = path.split('.');
    settings[section] = settings[section] || {};
    if (kind === 'number') settings[section][key] = Number(raw);
    else if (kind === 'bool') settings[section][key] = raw === 'true';
    else if (kind === 'boolInverted') settings[section][key] = raw === 'true';
    else settings[section][key] = raw;
  }
  settings.asr.maxAudioBytes = Math.round(Number($('asr-maxAudioMB').value || 0) * MB);
  settings.report.disableExecJs = $('report-execJs').value === 'true';
}

function showProblems() {
  const check = validateSettings(settings);
  $('problems').textContent = check.ok ? '' : check.errors.join('\n');
  return check;
}

/* Provider presets keep the base URL and model in sync, but never overwrite a
   base URL the user has deliberately edited. */
$('llm-provider').addEventListener('change', () => {
  const provider = $('llm-provider').value;
  const preset = presetFor(provider);
  if (!preset || provider === 'custom') return;
  suppressPreset = true;
  $('llm-baseUrl').value = preset.baseUrl;
  if (!$('llm-model').value.trim()) $('llm-model').value = preset.model;
  suppressPreset = false;
  fromForm();
  showProblems();
});

$('save').addEventListener('click', async () => {
  fromForm();
  const check = showProblems();
  if (!check.ok) {
    $('saved').textContent = '有错误，未保存。';
    return;
  }
  await saveSettings(settings);
  await send(MSG.SETTINGS_CHANGED, {}).catch(() => {});
  $('saved').textContent = '已保存。';
  setTimeout(() => { $('saved').textContent = ''; }, 2500);
});

$('test-llm').addEventListener('click', async () => {
  fromForm();
  const out = $('test-llm-out');
  out.textContent = '测试中…';
  try {
    await saveSettings(settings);
    const result = await send(MSG.TEST_CONNECTION, { target: 'llm' });
    out.textContent = result.ok ? `可用（${result.model || settings.llm.model}）` : '不可用';
  } catch (error) {
    out.textContent = error?.message || '失败';
  }
});

$('test-asr').addEventListener('click', async () => {
  fromForm();
  const out = $('test-asr-out');
  out.textContent = '测试中…';
  try {
    await saveSettings(settings);
    const result = await send(MSG.TEST_CONNECTION, { target: 'asr' });
    out.textContent = result.ok ? `密钥已接受（HTTP ${result.status}）` : `被拒绝（HTTP ${result.status}）`;
  } catch (error) {
    out.textContent = error?.message || '失败';
  }
});

$('request').addEventListener('click', async () => {
  const origins = [settings.llm.baseUrl, settings.asr.baseUrl]
    .map((u) => {
      try {
        return new URL(u).origin + '/*';
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  if (!origins.length) {
    $('saved').textContent = '接口地址无效，无法授权。';
    return;
  }
  let granted = false;
  // 必须在用户手势上下文里直接申请；服务 worker 不是手势上下文，只作兜底。
  if (chrome.permissions?.request) {
    try {
      granted = await chrome.permissions.request({ origins });
    } catch {
      granted = false;
    }
  }
  if (!granted) {
    const fallback = await send(MSG.REQUEST_PERMISSION, { origins }).catch(() => ({ granted: false }));
    granted = Boolean(fallback?.granted);
  }
  $('saved').textContent = granted ? '已授权。' : '未授权或被拒绝。';
});

$('selftest').addEventListener('click', async () => {
  const out = $('selftest-out');
  const list = $('selftest-list');
  out.textContent = '运行中…';
  list.innerHTML = '';
  try {
    const report = await send(MSG.SELFTEST);
    const items = (Array.isArray(report?.items) ? report.items : []).filter(Boolean);
    for (const item of items) {
      const li = document.createElement('li');
      li.className = `check ${item.ok ? 'pass' : 'fail'}`;
      const mark = document.createElement('span');
      mark.className = 'mark';
      mark.textContent = item.ok ? '✓' : '✕';
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      const detail = document.createElement('span');
      detail.className = 'detail';
      detail.textContent = item.detail;
      li.append(mark, name, detail);
      list.appendChild(li);
    }
    const failed = items.filter((item) => item && !item.ok).length;
    out.textContent = failed ? `${failed} 项未通过。` : `全部 ${items.length} 项通过。`;
    out.className = failed ? 'out bad' : 'out good';
  } catch (error) {
    out.textContent = error?.message || '自检失败。';
    out.className = 'out bad';
  }
});

$('mini-now').addEventListener('click', async () => {
  const out = $('mini-out');
  out.textContent = '正在打开…';
  try {
    await send(MSG.MINI_OPEN, { reason: 'manual' });
    out.textContent = '已打开浮层。';
  } catch (error) {
    out.textContent = error?.message || '打开失败。';
  }
  setTimeout(() => { out.textContent = ''; }, 2500);
});

$('prune').addEventListener('click', async () => {
  fromForm();
  await saveSettings(settings);
  await send(MSG.ENSURE_OFFSCREEN, {}).catch(() => {});
  $('saved').textContent = '已请求清理。';
});

/* ---------------- 上次失败诊断 ---------------- */

/**
 * 任务失败时 store 里只有一句 message，而它常常是 "Failed to fetch" —— 没有出处。
 * 这里把三样东西拼在一起：失败那一跳的前后日志、run 上记的阶段、以及落盘的堆栈。
 */
async function buildDiagnostics() {
  const lines = [];
  const runs = await db.listRuns().catch(() => []);
  const failed = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && run.state === STATE.FAILED)
    .sort((a, b) => (b.finishedAt || b.createdAt || 0) - (a.finishedAt || a.createdAt || 0))[0];

  if (!failed) return '没有失败过的任务。';

  lines.push(`任务 ${failed.id}`);
  lines.push(`标题：${failed.title || '（无标题）'}`);
  lines.push(`地址：${failed.url || failed.canonicalUrl || '（无）'}`);
  lines.push(`失败于：${failed.errorStage || failed.error?.stage || '（未记录阶段）'}`);
  lines.push(`消息：${failed.message || ''}`);
  if (failed.error) {
    lines.push(`错误：${failed.error.code || ''} / ${failed.error.category || ''} / ${failed.error.message || ''}`);
    if (failed.error.diagnostics) {
      lines.push(`诊断：${JSON.stringify(failed.error.diagnostics)}`);
    }
  }

  const logs = await db.logsFor(failed.id).catch(() => []);
  const list = (Array.isArray(logs) ? logs : []).filter(Boolean)
    .sort((a, b) => (a.at || 0) - (b.at || 0));
  if (list.length) {
    lines.push('');
    lines.push(`日志（最后 ${Math.min(12, list.length)} 条 / 共 ${list.length} 条）：`);
    for (const entry of list.slice(-12)) {
      const stamp = new Date(entry.at || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
      lines.push(`  ${stamp} [${entry.level}] ${entry.stage} — ${entry.message}`);
    }
  } else {
    lines.push('');
    lines.push('日志：一条都没有 —— 说明失败发生在流水线启动之前（任务创建 / 派发给 offscreen 那一段）。');
  }

  const entry = await lastError().catch(() => null);
  if (entry) {
    lines.push('');
    lines.push(`落盘堆栈（${entry.context}，${new Date(entry.at || Date.now()).toLocaleString('zh-CN')}）：`);
    lines.push(`  ${entry.message}`);
    for (const line of String(entry.stack || '').split('\n').slice(0, 8)) {
      lines.push(`  ${line.trim()}`);
    }
    lines.push(`  首帧：${firstFrame(entry)}`);
  } else {
    lines.push('');
    lines.push('落盘堆栈：无。');
  }

  return lines.join('\n');
}

let diagText = '';

async function loadDiagnostics() {
  const out = $('diag-out');
  const body = $('diag-body');
  try {
    diagText = await buildDiagnostics();
    body.textContent = diagText;
    out.textContent = '已加载';
  } catch (error) {
    diagText = '';
    body.textContent = `读取失败：${error?.message || String(error)}`;
    out.textContent = '读取失败';
  }
}

$('diag-reload').addEventListener('click', () => { loadDiagnostics(); });
$('diag-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(diagText || $('diag-body').textContent || '');
    $('diag-out').textContent = '已复制';
  } catch {
    $('diag-out').textContent = '复制失败，请手动选中下方文本';
  }
});

/* ---------------- boot ---------------- */

fillModelOptions();
toForm();
showProblems();
loadDiagnostics(); // 打开设置页就看到上次为什么失败，不用再翻 DevTools

for (const element of document.querySelectorAll('input, select')) {
  element.addEventListener('change', () => {
    if (suppressPreset) return;
    fromForm();
    showProblems();
  });
}
