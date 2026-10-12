/**
 * Deterministic assembly: draft → report.html.
 *
 * The model writes section bodies only. Everything structural — numbering,
 * section ids, section-time, the nav, the head fields, the footer — is produced
 * here so two runs of the same draft always yield byte-identical structure.
 * This is the extension's replacement for the Pi agent writing report.html itself.
 */
import { formatClock, sectionTimeFor } from './transcript.js';

const START = '<!-- VIDEO_DESCRIPTION_START -->';
const END = '<!-- VIDEO_DESCRIPTION_END -->';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Remove every template comment except the owned video-description boundary. */
export function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, (match) => {
    if (match.includes('VIDEO_DESCRIPTION_START') || match.includes('VIDEO_DESCRIPTION_END')) {
      return match;
    }
    return '';
  });
}

export function renderVideoDescription(description) {
  const text = String(description || '').trim();
  if (!text) return '';
  return `${START}\n<details><summary>视频简介（展开）</summary>`
    + `<div class="video-description-text">${escapeHtml(text)}</div></details>\n${END}`;
}

function navHtml(sections) {
  const links = sections
    .map((section, index) => {
      const label = section.nav || section.title;
      return `<a href="#s${index + 1}">${label}</a>`;
    })
    .join('');
  return `<nav class="report-nav" aria-label="章节导航"><span class="report-nav-title">目录</span>${links}</nav>`;
}

function sectionHtml(section, index, { time }) {
  const id = `s${index + 1}`;
  const parts = [`<section id="${id}">`];
  const head = [`<span class="num">${index + 1}</span>`,
    `<span class="section-title">${section.title}</span>`];
  if (time) head.push(`<span class="section-time">${time}</span>`);
  parts.push(`<h2>${head.join('')}</h2>`);
  parts.push(section.html || '');
  parts.push('</section>');
  return parts.join('\n');
}

/**
 * @param {object} args
 * @param {string} args.template  raw report-template.html
 * @param {object} args.meta      {title, subtitle, lead, attribution}
 * @param {string} [args.description]
 * @param {Array}  args.sections  draft.sections, already sorted by order
 * @param {string} [args.sourcesHtml]
 * @param {string} [args.footerUrl]
 * @param {Array}  args.units     transcript units, for computed section-time
 * @param {number} args.totalDurationMs
 * @param {boolean} [args.computedTime]
 */
export function assembleReport({
  template,
  meta = {},
  description = '',
  sections = [],
  sourcesHtml = '',
  footerUrl = '',
  units = [],
  totalDurationMs = 0,
  computedTime = true,
}) {
  const title = String(meta.title || '').trim();
  const subtitle = String(meta.subtitle || '').trim();
  const lead = String(meta.lead || '').trim();
  const attribution = String(meta.attribution || '').trim();

  const ordered = [...sections].sort((a, b) => (a.order || 0) - (b.order || 0));
  const hours = totalDurationMs >= 3600000;

  const bodies = ordered.map((section, index) => {
    const time = computedTime
      ? timeForSection(section, units, hours)
      : (section.time || '');
    return sectionHtml(section, index, { time });
  });

  const withNav = ordered.length >= 3 ? `${navHtml(ordered)}\n\n` : '';
  const body = withNav + bodies.join('\n\n');

  let html = template;
  html = html.replace(/\{\{TITLE\}\}/g, escapeHtml(title));
  html = html.replace(/\{\{LEAD\}\}/g, lead);
  html = html.replace(/\{\{ATTRIBUTION\}\}/g, attribution);
  html = html.replace(/\{\{BODY\}\}/g, body);
  html = html.replace(/\{\{SOURCES\}\}/g, sourcesHtml || '');
  html = html.replace(/\{\{VIDEO_DESCRIPTION\}\}/g, renderVideoDescription(description));

  // An empty subtitle must remove the element, not leave an empty paragraph.
  if (subtitle) {
    html = html.replace(/\{\{SUBTITLE\}\}/g, subtitle);
  } else {
    html = html.replace(/<p class="subtitle">\{\{SUBTITLE\}\}<\/p>\n?/g, '');
    html = html.replace(/\{\{SUBTITLE\}\}/g, '');
  }

  if (footerUrl) {
    html = html.replace(/<a class="footer-link" href=":\)">:\)<\/a>/g,
      `<a class="footer-link" href="${escapeHtml(footerUrl)}">${escapeHtml(footerUrl.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</a>`);
  }

  // The bundled template is CRLF; normalise before collapsing blank runs.
  return stripComments(html).replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

/** Section time comes from the units a section actually cites, never from the model. */
export function timeForSection(section, units, hours) {
  const ids = new Set(Array.isArray(section.sourceUnits) ? section.sourceUnits : []);
  let selected = units.filter((unit) => ids.has(unit.unitId));
  if (!selected.length) {
    const range = Array.isArray(section.unitRange) ? section.unitRange : [];
    if (range.length === 2) {
      selected = units.slice(Math.max(0, range[0] - 1), Math.min(units.length, range[1]));
    }
  }
  return sectionTimeFor(selected, { hours });
}

/**
 * Split assembled HTML back into draft sections so a revision pass can rewrite
 * only a chapter instead of the whole document.
 */
export function splitReport(html) {
  const sections = [];
  const pattern = /<section id="(s\d+)">([\s\S]*?)<\/section>/g;
  for (const match of html.matchAll(pattern)) {
    const inner = match[2];
    const heading = /<h2>([\s\S]*?)<\/h2>/.exec(inner);
    const title = heading
      ? (/<span class="section-title">([\s\S]*?)<\/span>/.exec(heading[1])?.[1] || '').trim()
      : '';
    sections.push({
      id: match[1],
      title,
      html: heading ? inner.slice(heading[0].length).trim() : inner.trim(),
    });
  }
  return sections;
}

export { escapeHtml, formatClock };
