/**
 * DashScope / 百炼 Paraformer file transcription — browser port of paraformer.py.
 *
 * Four steps: get upload policy → OSS multipart → submit async task → poll → fetch result.
 * No retry on submit: a failed submit must not be silently re-submitted (double billing).
 */
import { fail } from './errors.js';
import { cloudAsrParameters } from './validate-settings.js';

export class AsrTaskSubmitted extends Error {
  constructor(taskId) {
    super('ASR 任务已提交，状态未知，未自动重新提交。');
    this.name = 'AsrTaskSubmitted';
    this.taskId = taskId;
  }
}

function redactText(value) {
  return String(value || '')
    .replace(/(?:https?:\/\/|oss:\/\/)[^\s"'<>]+/g, '[resource URL removed]')
    .replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/g, '[credential removed]');
}

async function parseError(response, stage, taskId) {
  let code = null;
  try {
    const body = await response.clone().json();
    if (body && typeof body.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,100}$/.test(body.code)
        && !body.code.startsWith('sk-')) {
      code = body.code;
    }
  } catch {
    /* body was not JSON */
  }
  const detail = code ? `HTTP ${response.status} / ${code}` : `HTTP ${response.status}`;
  return fail.api('ASR_SERVICE_ERROR', `语音识别失败（${stage}）：${detail}`, {
    stage, taskId, httpStatus: response.status, providerCode: code,
  });
}

/**
 * 所有对远端的第一步都是 `fetch`，而它失败时只给一句 "Failed to fetch"，
 * 既看不出是网络、地址还是主机权限。统一在这里换成能照着做的中文提示。
 */
async function fetchOrFail(url, init, stage, taskId = null) {
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const name = error?.name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw fail.api('ASR_SERVICE_ERROR', `语音识别请求超时（${stage}），稍后重试。`, {
        stage, taskId, cause: error?.message,
      });
    }
    throw fail.api(
      'ASR_SERVICE_ERROR',
      `连不上语音识别服务（${stage}）：${error?.message || 'Failed to fetch'}。`
        + '检查网络、接口地址，以及该域名是否已授予主机权限。',
      { stage, taskId, cause: error?.message },
    );
  }
  return response;
}

/** Step 1: upload policy. */
async function getPolicy({ baseUrl, apiKey, model }) {
  const url = new URL(`${baseUrl.replace(/\/+$/, '')}/uploads`);
  url.searchParams.set('action', 'getPolicy');
  url.searchParams.set('model', model);
  const response = await fetchOrFail(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(60000),
  }, 'upload');
  if (!response.ok) throw await parseError(response, 'upload');
  const body = await response.json();
  const policy = body?.data;
  if (!policy?.upload_host || !policy?.upload_dir) {
    throw fail.api('ASR_SERVICE_ERROR', '语音识别上传凭证不完整。', { stage: 'upload' });
  }
  return policy;
}

/**
 * Step 2: OSS multipart POST.
 * Field order is a hard requirement: `file` must be last, because the policy
 * signature only covers the fields that precede it.
 */
async function uploadToOss(policy, blob, filename) {
  const form = new FormData();
  form.append('OSSAccessKeyId', policy.oss_access_key_id);
  form.append('Signature', policy.signature);
  form.append('policy', policy.policy);
  form.append('x-oss-object-acl', policy.x_oss_object_acl);
  form.append('x-oss-forbid-overwrite', policy.x_oss_forbid_overwrite);
  form.append('key', `${policy.upload_dir}/${filename}`);
  form.append('success_action_status', '200');
  form.append('file', blob, filename);

  const response = await fetch(policy.upload_host, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(300000),
    // No Authorization header: the OSS policy carries its own credentials.
  });
  if (!response.ok) {
    let snippet = '';
    try {
      snippet = redactText((await response.text()).slice(0, 500));
    } catch {
      /* ignore */
    }
    throw fail.api('ASR_SERVICE_ERROR', `音频上传失败（HTTP ${response.status}）。`, {
      stage: 'upload', httpStatus: response.status, detail: snippet,
    });
  }
  return `${policy.upload_dir}/${filename}`;
}

/** Step 3: submit the async transcription task. */
async function submitTask({ baseUrl, apiKey, model, objectKey, parameters }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/services/audio/asr/transcription`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-Async': 'enable',
        'X-DashScope-OssResourceResolve': 'enable',
      },
      body: JSON.stringify({
        model,
        input: { file_urls: [`oss://${objectKey}`] },
        parameters,
      }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (error) {
    if (error instanceof Error && error.name !== 'AbortError') {
      // 提交这一步网络失败 = 任务可能已建也可能没建，绝不能自动重提（重复计费）。
      // 把原因带上，弹窗里才看得出是网络问题而不是服务拒了。
      const pending = new AsrTaskSubmitted(null);
      pending.message = `语音识别提交请求没发出去（${error?.message || 'Failed to fetch'}），未自动重新提交。`;
      throw pending;
    }
    throw error;
  }
  if (!response.ok) throw await parseError(response, 'submit');
  const body = await response.json();
  const taskId = body?.output?.task_id;
  if (!taskId) throw await parseError(response, 'submit');
  return taskId;
}

/** Step 4: poll until SUCCEEDED. Accepts PENDING / RUNNING. */
async function pollTask({ baseUrl, apiKey, taskId, pollSeconds, maxWaitSeconds, onTick }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/tasks/${taskId}`;
  const started = Date.now();
  for (;;) {
    const response = await fetchOrFail(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(60000),
    }, 'poll', taskId);
    if (!response.ok) throw await parseError(response, 'poll', taskId);
    const body = await response.json();
    const status = body?.output?.task_status;
    if (status === 'SUCCEEDED') return body;
    if (status !== 'PENDING' && status !== 'RUNNING') {
      throw fail.api('ASR_SERVICE_ERROR', `语音识别任务未成功：${status}`, {
        stage: 'poll', taskId, providerCode: status,
      });
    }
    const elapsed = (Date.now() - started) / 1000;
    if (elapsed >= maxWaitSeconds) {
      throw fail.api('ASR_SERVICE_ERROR', '语音识别超时；任务可能仍在云端运行。', {
        stage: 'poll', taskId,
      });
    }
    if (onTick) onTick({ taskId, status, elapsedSeconds: Math.round(elapsed) });
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(pollSeconds * 1000, (maxWaitSeconds - elapsed) * 1000));
    });
  }
}

/** Step 5: download the transcription result. No Authorization header. */
async function fetchResult(completed) {
  const result = completed?.output?.results?.[0];
  if (!result?.transcription_url) {
    throw fail.api('ASR_SERVICE_ERROR', '语音识别结果地址缺失。', { stage: 'result' });
  }
  if (result.subtask_status && result.subtask_status !== 'SUCCEEDED') {
    throw fail.api('ASR_SERVICE_ERROR', `语音识别子任务未成功：${result.subtask_status}`, {
      stage: 'result', providerCode: result.subtask_status,
    });
  }
  const response = await fetchOrFail(result.transcription_url, {
    signal: AbortSignal.timeout(120000),
  }, 'result', completed?.output?.task_id);
  if (!response.ok) throw await parseError(response, 'result', completed?.output?.task_id);
  const payload = await response.json();
  const transcript = (payload?.transcripts || []).find((item) => item.channel_id === 0)
    || payload?.transcripts?.[0];
  if (!transcript) {
    throw fail.api('ASR_SERVICE_ERROR', '语音识别结果中没有可用的转写。', { stage: 'result' });
  }
  const rows = (transcript.sentences || []).map((sentence) => ({
    start: Number(sentence.begin_time) / 1000,
    end: Number(sentence.end_time) / 1000,
    text: sentence.text || '',
    words: (sentence.words || []).map((word) => ({
      word: word.text,
      start: Number(word.begin_time) / 1000,
      end: Number(word.end_time) / 1000,
    })),
  }));
  return {
    rows,
    contentDurationMs: transcript.content_duration_in_milliseconds ?? null,
    serviceUsage: completed?.usage ?? null,
  };
}

/**
 * Run one audio file end to end.
 * `checkpoint` lets a restarted offscreen resume polling instead of re-uploading.
 */
export async function transcribeFile({
  baseUrl, apiKey, model, blob, filename,
  pollSeconds = 5, maxWaitSeconds = 1800,
  onProgress = () => {}, checkpoint = null,
}) {
  const parameters = cloudAsrParameters(model);
  if (!parameters) throw fail.input('ASR_MODEL_UNSUPPORTED', `不支持的文件转写模型：${model}`);

  let taskId = checkpoint?.taskId || null;
  let objectKey = checkpoint?.objectKey || null;

  if (!taskId) {
    onProgress({ stage: 'policy' });
    const policy = await getPolicy({ baseUrl, apiKey, model });
    onProgress({ stage: 'upload' });
    objectKey = await uploadToOss(policy, blob, filename);
    onProgress({ stage: 'submit' });
    taskId = await submitTask({ baseUrl, apiKey, model, objectKey, parameters });
    onProgress({ stage: 'submitted', taskId, objectKey });
  }

  onProgress({ stage: 'poll', taskId });
  const completed = await pollTask({
    baseUrl, apiKey, taskId, pollSeconds, maxWaitSeconds,
    onTick: (tick) => onProgress({ stage: 'poll', ...tick }),
  });

  onProgress({ stage: 'result', taskId });
  const result = await fetchResult(completed);
  return { ...result, taskId, objectKey };
}
