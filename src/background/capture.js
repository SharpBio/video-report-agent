/**
 * Full-page PNG: scroll-and-capture in a dedicated popup window, stitch in the
 * offscreen document. This replaces Playwright's `full_page=True` screenshot.
 *
 * 为什么只能这么干：
 *   - `captureVisibleTab` 只拍「可见」的那一屏，所以要一个专属窗口把报告铺开逐屏拍；
 *   - 目标页面是 `chrome-extension://` 自己的页面，它同样要求 `<all_urls>` 或
 *     `activeTab`（不给就抛 "Either the '<all_urls>' or 'activeTab' permission is
 *     required."），所以 manifest 里必须声明 `<all_urls>`；
 *   - 试过「把报告塞进 SVG foreignObject 再画到 canvas」那条无权限路线，Chrome 会
 *     因为 foreignObject 把画布标记为 **tainted**，`convertToBlob()` 直接抛
 *     `Tainted "OffscreenCanvas" may not be exported` —— 浏览器层面就堵死了。
 */
import { sendToTab, broadcast } from '../lib/bus.js';
import { MSG } from '../lib/protocol.js';
import { runTask } from './offscreen-host.js';
import { fail } from '../lib/errors.js';

/**
 * 算出每一屏要滚到哪。
 *
 * 必须保证两条性质，漏掉任何一条长图就会重影：
 *   1. **严格递增**。旧实现把「最后一屏」直接 push 到数组末尾，内容高度不是视口
 *      高度的整数倍时数组会变成 [0, 900, 1800, 1100] —— 顺序是乱的，1800 那屏
 *      画上去又被 1100 那屏盖掉一块，看起来就是内容叠在一起。
 *   2. **不超过页面真能滚到的距离**。滚不到的位置拍回来跟上一屏一模一样，
 *      再画一遍就是纯粹的重影。
 *
 * 抽成纯函数是为了能在用例里断言这两条：真机上的表现只是「图有点重影」，
 * 光看结果根本定位不到是这里算错了。
 *
 * @param {number} contentHeight 整份内容高度（scrollHeight）
 * @param {number} viewportHeight 一屏的高度
 * @param {number|null} [maxScroll] 页面真实能滚到的最大偏移
 * @returns {number[]} 递增、去重、不超过 maxScroll 的偏移列表
 */
export function planStrips(contentHeight, viewportHeight, maxScroll = null) {
  const vh = Math.max(1, Math.floor(viewportHeight));
  const total = Math.max(vh, Math.floor(contentHeight));
  let last = Math.max(0, total - vh);
  if (Number.isFinite(maxScroll)) {
    last = Math.min(last, Math.max(0, Math.floor(maxScroll)));
  }
  const positions = [];
  for (let top = 0; top < last; top += vh) positions.push(top);
  positions.push(last);
  return [...new Set(positions)].sort((a, b) => a - b);
}

/**
 * Chrome 对 `captureVisibleTab` 有硬性配额：**每秒最多 2 次**
 * （超了抛 `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.`）。
 * 长图要连着拍十几屏，不节流的话第 3 屏就炸 —— 表现为窗口闪一下就没了，什么都没存。
 */
const SHOT_MAX = 2;
const SHOT_WINDOW_MS = 1000;
const SHOT_MARGIN_MS = 150;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 距离下一次允许截图还要等多少毫秒（0 表示可以立刻拍）。
 *
 * 抽成纯函数是为了能直接在用例里断言 —— 配额这种事只有真机才暴露，
 * 而真机失败了只是「窗口闪一下」，没有任何线索。
 *
 * @param {number[]} times 已经发生的截图时间戳（旧的在前）
 */
export function nextShotDelay(times, now = Date.now(), {
  max = SHOT_MAX, windowMs = SHOT_WINDOW_MS, marginMs = SHOT_MARGIN_MS,
} = {}) {
  const span = windowMs + marginMs;
  const recent = (times || []).filter((t) => now - t < span);
  if (recent.length < max) return 0;
  const oldest = Math.min(...recent);
  return Math.max(0, span - (now - oldest) + 20);
}

const shotTimes = [];

/** 拍一屏，自带节流；撞上配额就退避重试，而不是把整个长图任务丢掉。 */
async function shoot(windowId, format = 'png') {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const waitMs = nextShotDelay(shotTimes);
    if (waitMs) await sleep(waitMs);
    shotTimes.push(Date.now());
    try {
      return await chrome.tabs.captureVisibleTab(windowId, { format });
    } catch (error) {
      lastError = error;
      // 只有配额错误值得重试；其余（权限、窗口已关）重来也一样。
      if (!/quota|MAX_CAPTURE/i.test(String(error?.message || ''))) throw error;
      await sleep(SHOT_WINDOW_MS + SHOT_MARGIN_MS);
    }
  }
  throw lastError || new Error('截图失败。');
}

function waitFor(type, timeoutMs, match = () => true) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(fail.env('CAPTURE_TIMEOUT', '截图窗口没有就绪，请重试。'));
    }, timeoutMs);
    function listener(message, sender) {
      if (message?.type !== type || !match(message.payload || {})) return;
      clearTimeout(timer);
      chrome.runtime.onMessage.removeListener(listener);
      // 连 sender 一起带出去：报告页的 tabId 只能从消息来源拿，
      // windows.create 的返回值里没有（Chrome 不支持 Firefox 那个 populate，
      // 传了还会直接抛 Unexpected property）。
      resolve({ payload: message.payload, sender });
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

/** sender 没带 tab 时的兜底：直接问这个窗口里有哪些标签。 */
async function firstTabIdOf(windowId) {
  const tabs = await chrome.tabs.query({ windowId }).catch(() => []);
  return tabs?.[0]?.id || null;
}

/**
 * @param {string} runId
 * @param {{width?:number, height?:number, onProgress?:Function}} [options]
 * @returns {{bytes:number, width:number, height:number}}
 */
export async function captureReport(runId, {
  width = 920, height = 1080, download = false, title = '', onProgress = () => {},
} = {}) {
  const url = chrome.runtime.getURL(`src/viewer/viewer.html?run=${encodeURIComponent(runId)}&capture=1`);
  // focused 必须给 true：对未获得焦点的窗口截图可能得到空白或报错。
  // 高度故意给大一点，Chrome 会按屏幕高度收敛，屏数越少越快。
  const win = await chrome.windows.create({
    url,
    type: 'popup',
    width,
    height,
    focused: true,
  });
  const windowId = win?.id;
  if (!windowId) {
    throw fail.env('CAPTURE_FAILED', '截图窗口创建失败，请重试。');
  }
  try {
    const { payload: ready, sender } = await waitFor(
      MSG.VIEWER_READY, 30000, (payload) => payload.runId === runId,
    );
    if (!ready?.ok) throw fail.env('CAPTURE_FAILED', ready?.message || '报告页面没有就绪。');

    const tabId = sender?.tab?.id || await firstTabIdOf(windowId);
    if (!tabId) throw fail.env('CAPTURE_FAILED', '拿不到报告页的标签，请重试。');
    // 窗口刚拿到焦点时第一帧可能还没画稳，先让它落地再拍。
    await sleep(200);

    const contentHeight = ready.height;
    const viewportHeight = ready.viewportHeight || height - 40;
    const viewportWidth = ready.viewportWidth || width;
    const positions = planStrips(contentHeight, viewportHeight, ready.maxScroll);
    const strips = [];
    let previousTop = -1;

    for (let i = 0; i < positions.length; i += 1) {
      const requested = positions[i];
      const reply = await sendToTab(tabId, MSG.CAPTURE_STRIP, { top: requested });
      // 用**实际**停下来的位置，不要用请求的：滚不到位（到底了、页面高度变了、
      // 平滑滚动没走完）时两者不一样，按请求位置去画就等于把上一屏内容又画一遍。
      const top = Number.isFinite(reply?.top) ? reply.top : requested;
      if (strips.length && top <= previousTop) {
        // 真的滚不动了。继续拍只会得到一叠一模一样的屏，直接收工出图。
        console.warn('[capture] 页面没有滚到指定位置，停止截图',
          { requested, actual: top, previousTop });
        break;
      }
      previousTop = top;

      const dataUrl = await shoot(windowId);
      // 只能传 data URL：Blob 会被 runtime 消息的序列化吃成空对象（见 stitch.js）。
      strips.push({
        dataUrl,
        top,
        width: viewportWidth,
        height: Math.min(viewportHeight, contentHeight - top),
      });
      onProgress({ done: i + 1, total: positions.length });
    }
    if (!strips.length) throw fail.env('CAPTURE_FAILED', '一屏都没拍到，请重试。');

    // 屏都拍完了，接下来是拼图 + 下载；这一段没有屏数可报，但同样要让用户知道还在动。
    broadcast(MSG.CAPTURE_PROGRESS, { runId, done: 0, total: 0, stage: 'stitch' });
    const result = await runTask({
      kind: 'stitch',
      runId,
      title,
      download,
      strips: strips.map(({ dataUrl, top, width: w, height: h }) => ({ dataUrl, top, width: w, height: h })),
      width: viewportWidth,
      height: contentHeight,
    });
    await sendToTab(tabId, MSG.CAPTURE_DONE, {}).catch(() => {});
    return {
      bytes: result.bytes,
      width: result.width,
      height: result.height,
      strips: strips.length,
    };
  } finally {
    await chrome.windows.remove(windowId).catch(() => {});
  }
}
