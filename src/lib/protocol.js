/** Message protocol: the single source of truth for cross-context calls. */

export const MSG = {
  PING: 'ping',
  ENSURE_OFFSCREEN: 'offscreen/ensure',
  OFFSCREEN_TASK: 'offscreen/task',
  OFFSCREEN_RESULT: 'offscreen/result',

  RUN_START: 'run/start',
  RUN_CANCEL: 'run/cancel',
  RUN_RESUME: 'run/resume',
  RUN_EVENT: 'run/event',
  RUN_LIST: 'run/list',
  RUN_DELETE: 'run/delete',
  // 历史页：单条详情、改名、按条件清空、存储占用。
  RUN_DETAIL: 'run/detail',
  RUN_RENAME: 'run/rename',
  RUN_CLEAR: 'run/clear',
  STORAGE_STATS: 'storage/stats',

  EXPORT_HTML: 'export/html',
  EXPORT_TRANSCRIPT: 'export/transcript',
  VIEWER_LOAD: 'viewer/load',
  CAPTURE_PROGRESS: 'capture/progress',

  // 后台浮层小窗：弹窗关掉之后还能看见进度。
  MINI_OPEN: 'mini/open',
  MINI_CLOSE: 'mini/close',
  MINI_STATE: 'mini/state',

  PROBE_PAGE: 'page/probe',
  AUDIO_FETCH: 'page/audio-fetch',
  AUDIO_CHUNK: 'page/audio-chunk',

  VIEWER_READY: 'viewer/ready',
  CAPTURE_PNG: 'capture/png',
  CAPTURE_STRIP: 'capture/strip',
  CAPTURE_DONE: 'capture/done',
  PAGE_CHECK: 'viewer/page-check',

  SETTINGS_CHANGED: 'settings/changed',
  SETTINGS_GET: 'settings/get',
  REQUEST_PERMISSION: 'permissions/request',
  TEST_CONNECTION: 'settings/test-connection',

  // 诊断通道：拿不到 chrome.storage 的上下文（offscreen）把错误转给 SW 落盘。
  DIAG_ERROR: 'diag/error',
  SELFTEST: 'selftest',
};

/** Terminal states are never renamed or resumed. */
export const STATE = {
  QUEUED: 'QUEUED',
  DOWNLOADING: 'DOWNLOADING',
  TRANSCRIBING: 'TRANSCRIBING',
  GENERATING: 'GENERATING',
  REVISING: 'REVISING',
  POSTPROCESSING: 'POSTPROCESSING',
  RENDERING: 'RENDERING',
  RENDERED: 'RENDERED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

export const TERMINAL_STATES = [STATE.RENDERED, STATE.FAILED, STATE.CANCELLED];
export const ACTIVE_STATES = [
  STATE.QUEUED, STATE.DOWNLOADING, STATE.TRANSCRIBING,
  STATE.GENERATING, STATE.REVISING, STATE.POSTPROCESSING, STATE.RENDERING,
];

/** Error categories mirror pipeline.py so failures stay comparable with the Python baseline. */
export const CATEGORY = {
  INPUT_REJECTED: 'INPUT_REJECTED',
  EXTERNAL_API_FAILURE: 'EXTERNAL_API_FAILURE',
  EXTERNAL_MODEL_FAILURE: 'EXTERNAL_MODEL_FAILURE',
  ENVIRONMENT_FAILURE: 'ENVIRONMENT_FAILURE',
  IMPLEMENTATION_FAILURE: 'IMPLEMENTATION_FAILURE',
  EXECUTION_TIMEOUT: 'EXECUTION_TIMEOUT',
};
