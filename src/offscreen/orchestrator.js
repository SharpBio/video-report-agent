/**
 * The pipeline. One function, many durable checkpoints.
 *
 * Every stage writes its result before the next one starts, so a service worker
 * death, a browser restart or a cancelled tab resumes at the last checkpoint
 * instead of restarting the whole run — and never re-uploads audio to ASR.
 */
import * as db from '../lib/db.js';
import * as opfs from '../lib/opfs.js';
import { log, span } from '../lib/log.js';
import { fail, asRunError } from '../lib/errors.js';
import { recordError } from '../lib/diag.js';
import { STATE, MSG } from '../lib/protocol.js';
import { broadcast } from '../lib/bus.js';
import { buildSystem, verifyResources } from '../lib/prompts.js';
import { createExecutor } from '../lib/tools.js';
import { assembleReport } from '../lib/assemble.js';
import { fillVideoDescription, applyFooter, syncTitle } from '../lib/postprocess.js';
import { validateReport, revisionWorthy } from '../lib/validate.js';
import { addUsage, emptyUsage } from '../lib/usage.js';
import { buildTranscriptFor, AUDIO_NAME } from './ingest.js';
import { runPlan } from './passes/plan.js';
import { runSection, pendingSections } from './passes/section.js';
import { runRevise } from './passes/revise.js';

const active = new Map(); // runId → AbortController

export function cancelRun(runId) {
  const controller = active.get(runId);
  if (controller) controller.abort();
  else active.set(runId, { aborted: true, abort() {} });
}

export function isCancelled(runId) {
  return Boolean(active.get(runId)?.signal?.aborted || active.get(runId)?.aborted);
}

/* ---------------- progress ---------------- */

async function emit(runId, state, progress, message, extra = {}) {
  await db.updateRun(runId, { state, progress, message, heartbeatAt: Date.now(), ...extra });
  broadcast(MSG.RUN_EVENT, { runId, state, progress, message, ...extra });
}

async function beat(runId) {
  await db.updateRun(runId, { heartbeatAt: Date.now() });
}

/* ---------------- main ---------------- */

/**
 * @param {string} runId
 * @param {object} settings
 * @param {boolean} [resumed]
 */
export async function executeRun(runId, settings, { resumed = false } = {}) {
  const controller = new AbortController();
  active.set(runId, controller);
  const signal = controller.signal;
  const usage = emptyUsage();

  const input = await db.get(db.STORE.INPUTS, runId);
  if (!input) throw fail.impl('RUN_NOT_FOUND', '找不到该任务的输入。');

  // 配置摘要进日志（不记密钥）：baseUrl 为空时 fetch 会退化成请求
  // chrome-extension://<id>/uploads，报错同样是 "Failed to fetch" —— 没有这条日志
  // 就只能靠猜。
  await log(runId, 'info', 'settings', '任务拿到的配置', {
    asrEnabled: Boolean(settings?.asr?.enabled),
    asrBaseUrl: settings?.asr?.baseUrl || '（空）',
    asrModel: settings?.asr?.model || '（空）',
    llmBaseUrl: settings?.llm?.baseUrl || '（空）',
    llmModel: settings?.llm?.model || '（空）',
    reportMode: settings?.report?.mode || '（空）',
    hasAsrKey: Boolean(settings?.asr?.apiKey),
    hasLlmKey: Boolean(settings?.llm?.apiKey),
    hasProbe: Boolean(input.probe?.ok),
    hasUrl: Boolean(input.url),
  });

  try {
    /* 0 — 打包资源先自查。
     * 资源不在包里时 fetch 直接 reject，只有一句 "Failed to fetch"，
     * 若不单独设一跳，它就会被算进 plan 的账上，看起来像模型/联网挂了。 */
    const assets = await span(runId, 'assets', () => verifyResources());
    const missing = (assets || []).filter((item) => !item.ok);
    if (missing.length) {
      throw fail.impl('ASSET_MISSING',
        `打包资源读不到：${missing.map((item) => item.label).join('、')}`
        + `（${missing[0].error || ''}）`);
    }

    /* 1 — transcript */
    let record = await db.get(db.STORE.TRANSCRIPTS, runId);
    if (!record) {
      await emit(runId, STATE.TRANSCRIBING, 5, '获取来源与转写');
      record = await buildTranscriptFor(runId, input, settings, signal, (progress) => {
        emit(runId, STATE.TRANSCRIBING, 5 + Math.min(25, (progress.received || 0) / 1024 / 64), stageMessage(progress));
      });
      await db.put(db.STORE.TRANSCRIPTS, { runId, ...record });
      await db.updateRun(runId, { unitCount: record.units.length, durationMs: record.durationMs });
    }
    const units = record.units;
    if (!units.length) throw fail.input('TRANSCRIPT_EMPTY', '转写为空，无法生成报告。');
    if (isCancelled(runId)) throw fail.input('RUN_CANCELLED', '已取消。');
    await log(runId, 'info', 'transcript', `${units.length} 个来源单元，来自 ${record.source}`);

    /* 2 — draft + plan */
    let draft = (await db.get(db.STORE.DRAFTS, runId)) || { meta: {}, sections: [], plan: null };
    // 旧快照可能被截断或含空洞，先清洗，后面所有 item.id 的读取才安全。
    draft.sections = (Array.isArray(draft.sections) ? draft.sections : []).filter(Boolean);
    if (draft.plan) draft.plan.sections = (Array.isArray(draft.plan.sections) ? draft.plan.sections : []).filter(Boolean);
    if (!draft.plan) {
      await emit(runId, STATE.GENERATING, 32, '规划结构');
      const planned = await span(runId, 'plan', () => runPlan({
        settings,
        units,
        title: record.title,
        attribution: record.attribution,
        durationMs: record.durationMs,
        signal,
      }));
      addUsage(usage, planned.usage, 'plan');
      draft.plan = planned.plan;
      draft.meta = {
        title: planned.plan.title || record.title,
        subtitle: planned.plan.subtitle || '',
        lead: planned.plan.lead || '',
        attribution: record.attribution,
      };
      draft.sections = draft.sections || [];
      await db.put(db.STORE.DRAFTS, { runId, ...draft });
      await log(runId, 'info', 'plan', `规划出 ${draft.plan.sections.length} 章`, {
        fallback: Boolean(planned.fallback),
        profile: draft.plan.profile_primary,
      });
    }

    const system = await buildSystem({
      profiles: [draft.plan.profile_primary, draft.plan.profile_secondary],
    });

    /* 3 — chapters */
    const pending = pendingSections(draft.plan, draft);
    if (pending.length) {
      await emit(runId, STATE.GENERATING, 38, `写正文（0/${draft.plan.sections.length}）`);
    }
    let written = draft.plan.sections.length - pending.length;
    for (const section of pending) {
      if (isCancelled(runId)) throw fail.input('RUN_CANCELLED', '已取消。');
      await db.updateRun(runId, { cursor: { sectionId: section.id, inflightAt: Date.now() } });
      const result = await span(runId, `section:${section.id}`, () => runSection({
        settings, system, plan: draft.plan, section, units, draft,
        totalDurationMs: record.durationMs, signal,
      }));
      addUsage(usage, result.usage, 'section');
      await db.put(db.STORE.DRAFTS, { runId, ...draft });
      written += 1;
      await emit(
        runId, STATE.GENERATING,
        38 + Math.round(42 * written / Math.max(1, draft.plan.sections.length)),
        `写正文（${written}/${draft.plan.sections.length}）`,
      );
      await beat(runId);
    }

    if (!draft.sections.filter((item) => (item.html || '').trim()).length) {
      throw fail.model('EMPTY_REPORT', '模型没有写出任何章节。');
    }

    /* 4 — assemble */
    await emit(runId, STATE.POSTPROCESSING, 84, '装配报告');
    const template = (await import('../lib/prompts.js')).resource;
    const templateText = await template.template();
    let html = assemble({
      templateText, draft, record, settings,
    });

    /* 5 — revise */
    const validIds = new Set(units.map((unit) => unit.unitId));
    const findings = validateReport(html, validIds);
    if (settings.report.review && revisionWorthy(findings).length) {
      await emit(runId, STATE.REVISING, 90, `修订（${revisionWorthy(findings).length} 项）`);
      const revised = await runRevise({
        settings, system, findings: revisionWorthy(findings), html, units, draft, signal,
      });
      addUsage(usage, revised.usage, 'revise');
      if (revised.changed) {
        await db.put(db.STORE.DRAFTS, { runId, ...draft });
        html = assemble({ templateText, draft, record, settings });
      }
      await log(runId, 'info', 'revise', revised.changed ? '已修订' : '无需修订');
    }

    /* 6 — postprocess owned by the runtime */
    html = fillVideoDescription(html, record.description);
    html = applyFooter(html, settings.report.footerUrl);
    html = syncTitle(html, draft.meta?.title);

    /* 7 — persist */
    await db.put(db.STORE.OUTPUTS, {
      runId,
      html,
      // 大小在这里顺手记下来：历史页要显示它，事后读整份 html 只为拿个长度太亏。
      bytes: html.length,
      sectionCount: draft.sections.length,
      findings,
      savedAt: Date.now(),
    });
    await db.put(db.STORE.USAGE, { runId, ...usage });
    await emit(runId, STATE.RENDERED, 100, '完成', {
      finishedAt: Date.now(),
      usage,
      sectionCount: draft.sections.length,
      outputBytes: html.length,
      cursor: null,
    });
    return { runId, state: STATE.RENDERED };
  } catch (error) {
    const runError = asRunError(error);
    // 存消息之外还要存堆栈：任务失败时 run.message 只有一句（常常是
    // "Failed to fetch"），光看它根本不知道是哪一跳。落盘后弹窗能显示到行号。
    await recordError('offscreen-run', error).catch(() => {});
    if (runError.code === 'RUN_CANCELLED') {
      await emit(runId, STATE.CANCELLED, 100, '已取消', {
        finishedAt: Date.now(), cursor: null,
      });
      return { runId, state: STATE.CANCELLED };
    }
    // 「死在哪一跳」比错误本身更重要：一句 "Failed to fetch" 不知道出处，
    // 加上最后一个日志阶段就能直接定位到 metadata / download / asr / 某一轮 pass。
    const stage = await lastStage(runId).catch(() => '');
    const message = stage ? `[${stage}] ${runError.message}` : runError.message;
    const withStage = { ...runError.toJSON(), stage };
    await db.put(db.STORE.OUTPUTS, {
      runId,
      error: withStage,
      savedAt: Date.now(),
    }).catch(() => {});
    await emit(runId, STATE.FAILED, 100, message, {
      finishedAt: Date.now(),
      error: withStage,
      errorCategory: runError.category,
      errorStage: stage,
      cursor: null,
    });
    await log(runId, 'error', 'run', message, withStage);
    return { runId, state: STATE.FAILED, error: runError.toJSON() };
  } finally {
    active.delete(runId);
    if (!settings.retention?.keepAudio) {
      await opfs.removeFile(runId, AUDIO_NAME).catch(() => {});
    }
  }
}

/** 最后一个日志阶段。失败时它告诉你是哪一跳出的事。 */
async function lastStage(runId) {
  const logs = await db.logsFor(runId);
  const list = (Array.isArray(logs) ? logs : []).filter(Boolean);
  if (!list.length) return '';
  list.sort((a, b) => (a.at || 0) - (b.at || 0));
  return String(list.at(-1)?.stage || '');
}

function assemble({ templateText, draft, record, settings }) {
  return assembleReport({
    template: templateText,
    meta: {
      ...draft.meta,
      attribution: draft.meta?.attribution || record.attribution,
    },
    description: record.description,
    sections: draft.sections,
    sourcesHtml: draft.meta?.sourcesHtml || '',
    footerUrl: settings.report.footerUrl,
    units: record.units,
    totalDurationMs: record.durationMs,
    computedTime: settings.report.sectionTime !== 'model',
  });
}

function stageMessage(progress) {
  if (progress.stage === 'download') {
    const mb = ((progress.received || 0) / 1048576).toFixed(1);
    return `下载音频 ${mb} MB`;
  }
  if (progress.stage === 'asr') return '语音识别中';
  if (progress.stage === 'poll') return '等待识别结果';
  if (progress.stage === 'upload') return '上传音频';
  if (progress.stage === 'submit') return '提交识别任务';
  return '处理中';
}

/** Runs that were interrupted and can be picked up again. */
export async function resumableRuns() {
  const runs = await db.listRuns();
  return runs.filter((run) => [STATE.QUEUED, STATE.TRANSCRIBING, STATE.GENERATING,
    STATE.REVISING, STATE.POSTPROCESSING].includes(run.state));
}

export { createExecutor };
