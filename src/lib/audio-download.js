/**
 * Stream downloading. Audio goes straight to OPFS so a 60-minute stream never
 * has to sit in memory; only the chunk in flight is resident.
 */
import * as opfs from './opfs.js';
import { fail } from './errors.js';

const CHUNK_PROGRESS_EVERY = 4 * 1024 * 1024;

/**
 * Download one URL into OPFS.
 * @returns {{bytes:number, contentType:string, url:string}}
 */
export async function downloadToOpfs({
  runId, name, url, headers = {}, maxBytes = 0, signal = null, onProgress = () => {},
}) {
  let response;
  try {
    response = await fetch(url, { method: 'GET', headers, signal, credentials: 'omit' });
  } catch (error) {
    if (signal?.aborted) throw fail.input('RUN_CANCELLED', '已取消。');
    throw fail.api('DOWNLOAD_ERROR', '下载失败，请检查网络或稍后重试。', {
      cause: error?.message,
    });
  }
  if (!response.ok) {
    throw fail.api('DOWNLOAD_ERROR', `媒体服务器返回 HTTP ${response.status}。`, {
      http_status: response.status,
    });
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const contentType = response.headers.get('content-type') || '';

  let bytes = 0;
  let lastReport = 0;
  await opfs.writeFile(runId, name, async (writable) => {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw fail.input('RUN_CANCELLED', '已取消。');
        bytes += value.byteLength;
        if (maxBytes && bytes > maxBytes) {
          throw fail.input(
            'AUDIO_TOO_LARGE',
            `音频超过 ${Math.round(maxBytes / 1024 / 1024)} MB，已停止下载。`,
            { bytes },
          );
        }
        await writable.write(value);
        if (bytes - lastReport >= CHUNK_PROGRESS_EVERY || !total) {
          lastReport = bytes;
          onProgress({ received: bytes, total });
        }
      }
    } finally {
      reader.releaseLock?.();
    }
  });
  onProgress({ received: bytes, total: total || bytes });
  return { bytes, contentType, url };
}

/** Try each candidate URL until one succeeds. */
export async function downloadFirstAvailable({ candidates, ...options }) {
  const errors = [];
  for (const url of candidates.filter(Boolean)) {
    try {
      const result = await downloadToOpfs({ ...options, url });
      return result;
    } catch (error) {
      if (error?.code === 'RUN_CANCELLED' || error?.code === 'AUDIO_TOO_LARGE') throw error;
      errors.push({ url: url.slice(0, 120), code: error?.code, message: error?.message });
    }
  }
  throw fail.api('DOWNLOAD_ERROR', '所有候选下载地址都失败了。', { attempts: errors });
}

/** Read a run file back as a File (what the ASR upload needs). */
export async function opfsFile(runId, name, fallbackName = name) {
  const file = await opfs.readFile(runId, name);
  if (file.name === fallbackName) return file;
  return new File([await file.arrayBuffer()], fallbackName, { type: file.type || 'audio/mp4' });
}
