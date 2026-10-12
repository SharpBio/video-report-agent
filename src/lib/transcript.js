/**
 * Build and parse transcript.md. The line format mirrors pipeline.py:197-205 exactly:
 *   [unit-000001 | 0.090–3.790s] text
 * The separator is U+2013; we also accept U+2014 and ASCII '-' when parsing user input.
 */

const DASHES = '[\\u2013\\u2014-]';
const UNIT_LINE = new RegExp(
  `^\\[(unit-\\d{6})\\s*\\|\\s*([0-9]+(?:\\.[0-9]+)?)${DASHES}([0-9]+(?:\\.[0-9]+)?)s\\]\\s*(.*)$`,
);

export function unitId(index) {
  return `unit-${String(index).padStart(6, '0')}`;
}

export function formatUnitLine(unit) {
  return `[${unit.unitId} | ${(unit.startMs / 1000).toFixed(3)}–${(unit.endMs / 1000).toFixed(3)}s] ${unit.text}`;
}

export function buildTranscript({ title, attribution, units }) {
  const header = [`# ${title}`, attribution, ''];
  const lines = units.map(formatUnitLine);
  return [...header, ...lines].join('\n');
}

/**
 * Parse a transcript.md produced by the pipeline or pasted by the user.
 * Header line 1 is `# title`, line 2 is the attribution string, line 3 blank.
 */
export function parseTranscript(text) {
  const raw = String(text || '').replace(/^﻿/, '');
  const lines = raw.split(/\r?\n/);
  let title = '';
  let attribution = '';
  let cursor = 0;

  if (lines[0]?.startsWith('# ')) {
    title = lines[0].slice(2).trim();
    cursor = 1;
    if (lines[1] && !UNIT_LINE.test(lines[1]) && lines[1].trim()) {
      attribution = lines[1].trim();
      cursor = 2;
    }
  }

  const units = [];
  for (let i = cursor; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    const match = UNIT_LINE.exec(line);
    if (!match) continue;
    const [, id, start, end, body] = match;
    units.push({
      unitId: id,
      index: units.length + 1,
      startMs: Math.round(Number(start) * 1000),
      endMs: Math.round(Number(end) * 1000),
      text: body,
    });
  }

  return { title, attribution, units, lineCount: lines.length, skipped: lines.length - cursor - units.length };
}

/** Units built straight from ASR sentences — this project is asr-only. */
export function unitsFromSegments(segments) {
  return segments.map((segment, index) => ({
    unitId: unitId(index + 1),
    index: index + 1,
    startMs: segment.startMs,
    endMs: segment.endMs,
    text: segment.text,
    ordinal: segment.ordinal,
  }));
}

/** Compact index shown to the model in the planning pass. */
export function unitIndex(units, previewChars = 30) {
  return units.map((unit) => {
    const preview = unit.text.length > previewChars
      ? `${unit.text.slice(0, previewChars)}…`
      : unit.text;
    return `${unit.unitId} ${formatClock(unit.startMs)}-${formatClock(unit.endMs)} ${preview}`;
  });
}

export function formatClock(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(h > 0 ? m : m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${String(h).padStart(2, '0')}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Section time from the units it actually uses — deterministic, never guessed.
 * Start rounds down, end rounds up; genuinely disjoint ranges are joined with a
 * Chinese semicolon, and more than three of them collapse to one span so the
 * heading stays readable.
 */
const MERGE_GAP_MS = 15000;
const MAX_RANGES = 3;

export function sectionTimeFor(units, { hours }) {
  if (!units.length) return '';
  const sorted = [...units].sort((a, b) => a.startMs - b.startMs);
  const ranges = [];
  let start = sorted[0].startMs;
  let end = sorted[0].endMs;
  for (const unit of sorted.slice(1)) {
    if (unit.startMs <= end + MERGE_GAP_MS) {
      end = Math.max(end, unit.endMs);
    } else {
      ranges.push([start, end]);
      start = unit.startMs;
      end = unit.endMs;
    }
  }
  ranges.push([start, end]);

  const shown = ranges.length > MAX_RANGES
    ? [[ranges[0][0], ranges.at(-1)[1]]]
    : ranges;
  return shown
    .map(([from, to]) => `${formatClock(Math.floor(from / 1000) * 1000)}–${formatClock(Math.ceil(to / 1000) * 1000)}`)
    .join('；');
}
