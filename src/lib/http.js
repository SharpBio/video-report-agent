/**
 * 扩展上下文里发跨域请求的唯一入口。
 *
 * 为什么必须有这一层：Chrome 靠 host_permissions 给扩展的 **CORS 豁免不覆盖
 * 带凭证的请求**。一旦设了 `credentials: 'include'`，就要服务器为
 * `chrome-extension://<id>` 这个 origin 返回 `Access-Control-Allow-Origin`
 * 和 `Access-Control-Allow-Credentials: true`。B 站不会给，于是请求在网络层
 * 就被拒 —— 拿不到状态码，只剩一句 `TypeError: Failed to fetch`。
 * 同一个 URL 用 omit 发就正常（自检里 dashscope / 大模型那两项都是 omit，所以一直是绿的）。
 *
 * 所以默认 omit。只有 omit 明确失败时才退回试一次 include，并且在报错里
 * 把每种模式的原因都列出来 —— 「Failed to fetch」这种话是没法排错的。
 */

/** omit 先走：它是扩展上下文里唯一稳的。include 只是给少数确实要 cookie 的域名兜底。 */
export const CREDENTIAL_LADDER = ['omit', 'include'];

function combineSignals(signal, timeoutMs) {
  const timer = AbortSignal.timeout(timeoutMs);
  if (!signal) return timer;
  // Chrome 116+ 才有 AbortSignal.any；没有就只能用超时那个，取消功能降级。
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timer]);
  return timer;
}

/**
 * @param {string} url
 * @param {{headers?:object, credentials?:string|null, timeoutMs?:number,
 *          signal?:AbortSignal, fetchFn?:Function}} [options]
 * @returns {Promise<{response:Response, credentials:string}>}
 * @throws {Error} 所有模式都失败时抛出，message 里带每种模式的原因；
 *                 超时（AbortError）不降级，直接抛。
 */
export async function fetchWithLadder(url, options = {}) {
  const {
    headers = {},
    credentials = null,
    timeoutMs = 30000,
    signal = null,
    fetchFn = null,
  } = options;
  const doFetch = fetchFn || ((...args) => fetch(...args));
  const modes = credentials ? [credentials] : CREDENTIAL_LADDER;
  const abort = combineSignals(signal, timeoutMs);
  const failures = [];

  for (const mode of modes) {
    try {
      const response = await doFetch(url, {
        method: 'GET',
        credentials: mode,
        headers: { Accept: 'application/json', ...headers },
        signal: abort,
      });
      return { response, credentials: mode };
    } catch (error) {
      // 超时和主动取消不再试下一种模式：重试只会再等一遍，没有意义。
      if (error?.name === 'AbortError') throw error;
      failures.push(`${mode} ${error?.name || 'Error'}: ${error?.message || '未知'}`);
    }
  }

  const error = new Error(`请求失败（${failures.join('；')}）`);
  error.name = 'FetchFailed';
  error.failures = failures;
  error.url = String(url).replace(/([?&](?:w_rid|wts)=)[^&]*/g, '$1…');
  throw error;
}
