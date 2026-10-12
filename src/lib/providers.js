/** LLM provider presets. Only OpenAI-compatible /chat/completions is supported. */
import { fail } from './errors.js';

export const PROVIDERS = {
  deepseek: {
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    /** deepseek-reasoner returns reasoning_content that must be fed back on multi-turn. */
    supportsReasoning: true,
  },
  zhipu: {
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    supportsReasoning: true,
  },
  dashscope: {
    label: '阿里云百炼（兼容模式）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    supportsReasoning: false,
  },
  moonshot: {
    label: 'Moonshot Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-128k',
    supportsReasoning: false,
  },
  siliconflow: {
    label: 'SiliconFlow 硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-72B-Instruct',
    supportsReasoning: false,
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    supportsReasoning: false,
  },
};

export function presetFor(provider) {
  return PROVIDERS[provider] || PROVIDERS.custom;
}

/** Trim trailing slashes; never add a path. Callers append /chat/completions. */
export function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function chatEndpoint(baseUrl) {
  const base = normalizeBaseUrl(baseUrl);
  if (!base) throw fail.input('LLM_BASE_URL_MISSING', '请填写模型接口地址。');
  return `${base}/chat/completions`;
}

/**
 * Pull assistant content out of a chat completion message.
 * Some providers put reasoning in a sibling field; we keep the visible text only.
 */
export function assistantText(message) {
  if (!message) return '';
  if (typeof message.content === 'string') return message.content;
  if (Array.isArray(message.content)) {
    return message.content
      .filter((part) => part && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}
