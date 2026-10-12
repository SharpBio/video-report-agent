/** Settings validation. Rules mirror media_config.resolve_media_config and ingest.py. */

export const ASR_MODELS = [
  'paraformer-v2',
  'fun-asr',
  'fun-asr-2025-08-25',
  'fun-asr-2025-11-07',
  'fun-asr-mtl',
  'fun-asr-mtl-2025-08-25',
];

const PARAFORMER_PARAMETERS = {
  channel_id: [0],
  language_hints: ['zh', 'en'],
  timestamp_alignment_enabled: true,
  disfluency_removal_enabled: false,
};

const FUN_ASR_PARAMETERS = {
  channel_id: [0],
  language_hints: ['zh'],
};

export function cloudAsrParameters(model) {
  if (model === 'paraformer-v2') return { ...PARAFORMER_PARAMETERS };
  if (ASR_MODELS.includes(model) && model.startsWith('fun-asr')) return { ...FUN_ASR_PARAMETERS };
  return null;
}

/**
 * A base URL must be credential-free HTTPS with no query or fragment.
 * Mirrors media_config.py:57-66.
 */
export function validateBaseUrl(value, { allowInsecureLocalhost = false } = {}) {
  const raw = String(value || '').trim();
  if (!raw) return { ok: false, message: '接口地址不能为空。' };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, message: '接口地址不是合法的 URL。' };
  }
  if (url.username || url.password) {
    return { ok: false, message: '接口地址不能包含用户名或密码。' };
  }
  if (url.search || url.hash) {
    return { ok: false, message: '接口地址不能包含查询参数或片段。' };
  }
  const isLocalhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(allowInsecureLocalhost && isLocalhost)) {
    return { ok: false, message: '接口地址必须使用 https。' };
  }
  return { ok: true, origin: url.origin };
}

function numberRule(value, min, max, label) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) {
    return `${label} 需在 ${min} 到 ${max} 之间。`;
  }
  return null;
}

/** Returns { ok, errors: string[] }. Empty errors means the settings are usable. */
export function validateSettings(settings) {
  const errors = [];
  const s = settings || {};

  const llm = validateBaseUrl(s.llm?.baseUrl);
  if (!llm.ok) errors.push(`模型接口地址：${llm.message}`);
  if (!String(s.llm?.model || '').trim()) errors.push('请填写模型名称。');
  if (!String(s.llm?.apiKey || '').trim()) errors.push('请填写模型 API Key。');

  const tokenError = numberRule(s.llm?.maxOutputTokens, 1024, 32768, '单次最大输出 token');
  if (tokenError) errors.push(tokenError);
  const timeoutError = numberRule(s.llm?.timeoutMs, 30000, 900000, '请求超时（毫秒）');
  if (timeoutError) errors.push(timeoutError);
  if (!['native', 'text'].includes(s.llm?.toolsMode)) {
    errors.push('工具调用模式只能是 native 或 text。');
  }

  if (s.asr?.enabled) {
    const asr = validateBaseUrl(s.asr?.baseUrl);
    if (!asr.ok) errors.push(`语音识别接口地址：${asr.message}`);
    if (!String(s.asr?.apiKey || '').trim()) errors.push('请填写语音识别 API Key。');
    if (!ASR_MODELS.includes(s.asr?.model)) {
      errors.push(`语音识别模型必须是以下之一：${ASR_MODELS.join('、')}。`);
    }
    const bytesError = numberRule(s.asr?.maxAudioBytes, 1024 * 1024, 900 * 1024 * 1024, '音频大小上限（字节）');
    if (bytesError) errors.push(bytesError);
  }

  if (s.report?.mode !== 'standard') errors.push('本版本仅支持 standard 模式。');
  const sectionError = numberRule(s.report?.maxSections, 1, 24, '最大章节数');
  if (sectionError) errors.push(sectionError);

  const keepError = numberRule(s.retention?.keepLast, 0, 200, '保留运行数');
  if (keepError) errors.push(keepError);
  const ageError = numberRule(s.retention?.maxAgeDays, 0, 365, '保留天数');
  if (ageError) errors.push(ageError);

  return { ok: errors.length === 0, errors };
}

/** Origins that are not already granted and must be requested at runtime. */
export async function missingOrigins(settings) {
  const origins = new Set();
  for (const base of [settings?.llm?.baseUrl, settings?.asr?.baseUrl]) {
    const check = validateBaseUrl(base);
    if (!check.ok) continue;
    origins.add(`${check.origin}/*`);
  }
  if (!origins.size) return [];
  const missing = [];
  for (const origin of origins) {
    const granted = await chrome.permissions.contains({ origins: [origin] });
    if (!granted) missing.push(origin);
  }
  return missing;
}
