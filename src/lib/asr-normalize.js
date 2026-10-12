/**
 * ASR segment normalisation — port of asr.py:85-149.
 * Ordinals keep their raw index (gaps allowed, never renumbered); overlaps are fatal.
 */
import { fail } from './errors.js';

function toMs(value, ordinal, field) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw fail.api('ASR_SEGMENT_INVALID', `ASR 片段 ${ordinal} 的 ${field} 不是有效时间。`);
  }
  return Math.round(n * 1000);
}

/**
 * @param {Array<{start:number,end:number,text:string,words?:Array}>} rows times in seconds
 * @returns {{segments:Array, dropped:object, rawSegmentCount:number}}
 */
export function normalizeAsrSegments(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw fail.api('ASR_NO_SEGMENTS', 'ASR 未返回任何带时间戳的片段。');
  }

  const segments = [];
  const dropped = {
    empty: [],
    nonPositive: [],
    unrepresentable: [],
  };

  let previousEndMs = -1;
  rows.forEach((row, ordinal) => {
    if (!row || typeof row !== 'object') return;
    if (typeof row.text !== 'string') return;
    const startMs = toMs(row.start, ordinal, 'start');
    const endMs = toMs(row.end, ordinal, 'end');

    if (endMs <= startMs) {
      dropped.nonPositive.push(ordinal);
      return;
    }
    if (previousEndMs >= 0 && startMs < previousEndMs - 1) {
      throw fail.api('ASR_SEGMENTS_OVERLAP', `ASR 片段在 ${ordinal} 处重叠。`);
    }
    if (!row.text.trim()) {
      dropped.empty.push(ordinal);
      return;
    }
    if (endMs <= startMs) {
      dropped.unrepresentable.push(ordinal);
      return;
    }
    segments.push({
      ordinal,
      startMs,
      endMs,
      text: row.text,
      words: Array.isArray(row.words) ? row.words.filter((w) => w && typeof w === 'object') : [],
    });
    previousEndMs = endMs;
  });

  if (!segments.length) {
    throw fail.api('ASR_EMPTY_TRANSCRIPT', 'ASR 返回的内容全部为空，无法生成报告。');
  }
  return { segments, dropped, rawSegmentCount: rows.length };
}

/**
 * Merge two chunk results onto the original timeline — port of paraformer.py:133-176.
 * Word timestamps are seconds, segment timestamps are milliseconds.
 */
export function mergeChunkResults(chunks) {
  const segments = [];
  const dropped = { empty: [], nonPositive: [], unrepresentable: [] };
  let rawCount = 0;

  for (const { offsetMs, result } of chunks) {
    for (const segment of result.segments) {
      segments.push({
        ...segment,
        ordinal: segment.ordinal + rawCount,
        startMs: segment.startMs + offsetMs,
        endMs: segment.endMs + offsetMs,
        words: segment.words.map((word) => ({
          ...word,
          start: word.start + offsetMs / 1000,
          end: word.end + offsetMs / 1000,
        })),
      });
    }
    for (const key of Object.keys(dropped)) {
      dropped[key].push(...(result.dropped[key] || []).map((value) => value + rawCount));
    }
    rawCount += result.rawSegmentCount;
  }

  segments.sort((a, b) => a.startMs - b.startMs);
  return { segments, dropped, rawSegmentCount: rawCount };
}
