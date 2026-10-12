/**
 * Reads a Bilibili watch page from inside the page itself (content script).
 *
 * Why the page and not the API: `window.__playinfo__` is already signed by the
 * page's own session, so no wbi signing and no cookie plumbing is needed. It is
 * also the only path that works for pages the API refuses.
 *
 * Everything here must be serialisable — it crosses into the background worker.
 */

/**
 * 从分 P 列表里挑出第 N 个。
 *
 * 不能写 `pages[n - 1]`：列表要按 `page` 字段找。B 站偶尔会给出缺项或乱序的
 * 分 P 列表，按下标取就会张冠李戴（要 P3 结果给了 P2 的 cid）。
 * 找不到就退回最后一 P，再由调用方决定怎么用。
 *
 * @returns {object|null}
 */
export function pickPage(pages, pageNumber) {
  const list = (Array.isArray(pages) ? pages : []).filter(Boolean);
  const wanted = Math.max(1, Math.floor(Number(pageNumber) || 1));
  const hit = list.find((item) => Number(item?.page) === wanted);
  if (hit) return hit;
  if (!list.length) return null;
  const clamped = Math.min(wanted, list.length);
  return list.find((item) => Number(item?.page) === clamped) || list[clamped - 1] || list[0];
}

/**
 * 探测到的页面是不是用户要处理的那一个（同一个 BV 号、同一个分 P）。
 *
 * 探测拿到的是**当前打开的那一页**。用户在看 P1、却粘贴了 P3 的链接时，
 * 以前会无脑用探测结果顶上 —— 表现就是「粘贴了分 P 链接也拿不到对应视频」。
 */
export function probeMatches(probe, source) {
  if (!probe?.ok || !probe?.video?.bvid || !source?.bvid) return false;
  if (String(probe.video.bvid) !== String(source.bvid)) return false;
  return Number(probe.video.pageNumber || 1) === Number(source.pageNumber || 1);
}

/**
 * 当前是第几个分 P。
 *
 * B 站切换分 P 时 **URL 会带上 `?p=N`**，但 `__INITIAL_STATE__` 里并没有可靠的
 * 当前分 P 字段（老版本有 `state.p`，新版早就没有了）。只信 state 的话永远算成 1，
 * 于是多 P 视频一律拿到第一个 —— 这就是「有分 P 就无法自动获取」的根因。
 * 所以：URL 的 `p` 优先，state 只是兜底。
 */
function pageFromUrl(win) {
  try {
    const raw = new URLSearchParams(win.location?.search || '').get('p');
    const value = Number(raw);
    return Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
  } catch {
    return 0;
  }
}

function currentPageOf(win, state, data) {
  return pageFromUrl(win)
    || Math.floor(Number(state?.p) || 0)
    || Math.floor(Number(data?.p) || 0)
    || 1;
}

export function readInitialState(win = window) {
  const state = win.__INITIAL_STATE__;
  if (!state || typeof state !== 'object') return null;
  const data = state.videoData || state.videoInfo || null;
  if (!data) return null;
  const pages = Array.isArray(data.pages) ? data.pages : [];
  const currentPage = currentPageOf(win, state, data);
  const page = pickPage(pages, currentPage) || {};
  const owner = data.owner || {};
  return {
    bvid: data.bvid || data.BVid || '',
    aid: Number(data.aid || 0),
    cid: Number(page.cid || data.cid || 0),
    pageNumber: Number(page.page || currentPage || 1),
    pageCount: pages.length || 1,
    pageTitle: String(page.part || '').trim(),
    title: String(data.title || '').trim(),
    uploader: String(owner.name || '').trim(),
    description: String(data.desc || data.description || '').trim(),
    durationMs: Number(page.duration ?? data.duration ?? 0) * 1000,
    publishedAt: Number.isFinite(Number(data.pubdate)) ? Number(data.pubdate) * 1000 : null,
    pages: pages.map((item) => ({
      page: item.page, cid: item.cid, durationMs: Number(item.duration || 0) * 1000,
    })),
  };
}

export function readPlayInfo(win = window) {
  const info = win.__playinfo__;
  if (!info || typeof info !== 'object') return null;
  const data = info.data || info;
  const dash = data.dash || null;
  const audio = (dash?.audio || []).map((track) => ({
    url: track.baseUrl || track.base_url || '',
    backup: (track.backup_url || []).filter(Boolean),
    bandwidth: Number(track.bandwidth || 0),
    codecs: track.codecs || '',
  })).sort((a, b) => b.bandwidth - a.bandwidth);
  const video = (dash?.video || []).map((track) => ({
    url: track.baseUrl || track.base_url || '',
    backup: (track.backup_url || []).filter(Boolean),
    bandwidth: Number(track.bandwidth || 0),
    width: Number(track.width || 0),
    height: Number(track.height || 0),
  })).sort((a, b) => b.bandwidth - a.bandwidth);
  const durl = (data.durl || []).map((item) => ({
    url: item.url || '',
    backup: (item.backup_url || []).filter(Boolean),
    size: Number(item.size || 0),
  }));
  return { audio, video, durl, quality: data.quality || null, durationMs: Number(data.timelength || 0) };
}

/** True when the page is a watch page we can read without asking anything else. */
export function isWatchPage(win = window) {
  return /^https:\/\/(www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}/.test(win.location.href);
}

export function pageCanonicalUrl(win = window) {
  const match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(win.location.href);
  const page = new URLSearchParams(win.location.search).get('p');
  const base = `https://www.bilibili.com/video/${match ? match[1] : ''}/`;
  return page && /^[0-9]+$/.test(page) && page !== '1' ? `${base}?p=${page}` : base;
}

/**
 * Self-contained probe for `chrome.scripting.executeScript` (world: 'MAIN').
 * Chrome serialises only this function's own source, so every helper it needs
 * must be defined inside it.
 */
export function probePage() {
  const win = window;
  const state = win.__INITIAL_STATE__;
  const data = state && (state.videoData || state.videoInfo);

  // 分 P 只能信 URL 的 ?p=：__INITIAL_STATE__ 里没有可靠的当前分 P 字段。
  // 少了这一段，多 P 视频永远拿到第一个。
  function wantedPage() {
    const raw = new URLSearchParams(win.location.search).get('p');
    const fromUrl = Number(raw);
    if (Number.isFinite(fromUrl) && fromUrl >= 1) return Math.floor(fromUrl);
    const fromState = Math.floor(Number((state && state.p) || 0));
    if (fromState >= 1) return fromState;
    const fromData = Math.floor(Number((data && data.p) || 0));
    return fromData >= 1 ? fromData : 1;
  }
  // 按 page 字段找，不要按下标取：分 P 列表可能缺项或乱序。
  function pickPage(list, wanted) {
    const items = (Array.isArray(list) ? list : []).filter(Boolean);
    const hit = items.filter((item) => Number(item.page) === wanted)[0];
    if (hit) return hit;
    if (!items.length) return null;
    const clamped = Math.min(wanted, items.length);
    return items.filter((item) => Number(item.page) === clamped)[0]
      || items[clamped - 1] || items[0];
  }

  let video = null;
  if (data) {
    const pages = Array.isArray(data.pages) ? data.pages : [];
    const currentPage = wantedPage();
    const page = pickPage(pages, currentPage) || {};
    const owner = data.owner || {};
    video = {
      bvid: data.bvid || data.BVid || '',
      aid: Number(data.aid || 0),
      cid: Number(page.cid || data.cid || 0),
      pageNumber: Number(page.page || currentPage || 1),
      pageCount: pages.length || 1,
      pageTitle: String(page.part || '').trim(),
      title: String(data.title || '').trim(),
      uploader: String(owner.name || '').trim(),
      description: String(data.desc || data.description || '').trim(),
      durationMs: Number(page.duration ?? data.duration ?? 0) * 1000,
      publishedAt: Number.isFinite(Number(data.pubdate)) ? Number(data.pubdate) * 1000 : null,
      pages: pages.map((item) => ({
        page: item.page,
        cid: item.cid,
        durationMs: Number(item.duration || 0) * 1000,
      })),
    };
  }

  let streams = null;
  const info = win.__playinfo__;
  if (info) {
    const payload = info.data || info;
    const dash = payload.dash || null;
    const audio = (dash && dash.audio ? dash.audio : []).map((track) => ({
      url: track.baseUrl || track.base_url || '',
      backup: (track.backup_url || []).filter(Boolean),
      bandwidth: Number(track.bandwidth || 0),
      codecs: track.codecs || '',
    })).sort((a, b) => b.bandwidth - a.bandwidth);
    const videoTracks = (dash && dash.video ? dash.video : []).map((track) => ({
      url: track.baseUrl || track.base_url || '',
      backup: (track.backup_url || []).filter(Boolean),
      bandwidth: Number(track.bandwidth || 0),
      width: Number(track.width || 0),
      height: Number(track.height || 0),
    })).sort((a, b) => b.bandwidth - a.bandwidth);
    const durl = (payload.durl || []).map((item) => ({
      url: item.url || '',
      backup: (item.backup_url || []).filter(Boolean),
      size: Number(item.size || 0),
    }));
    streams = { audio, video: videoTracks, durl, quality: payload.quality || null };
  }

  /**
   * 页面里的 `__playinfo__` 可能是**上一个分 P** 的：切分 P 时播放器要重新请求，
   * 在它写回 window 之前，读到的还是旧的。拿时长对一下就能发现 —— 差得多就别用。
   */
  let streamsStale = false;
  if (streams && video) {
    const pageMs = Number(video.durationMs || 0);
    // payload 定义在上面的 if 块里，这里拿不到，重新取一次。
    const fresh = win.__playinfo__;
    const streamMs = Number((fresh && (fresh.data || fresh).timelength) || 0);
    if (pageMs > 0 && streamMs > 0 && Math.abs(pageMs - streamMs) > 5000) streamsStale = true;
  }

  const href = win.location.href;
  const match = /\/video\/(BV[0-9A-Za-z]{10})/.exec(href);
  const pageParam = new URLSearchParams(win.location.search).get('p');
  const canonicalUrl = match
    ? `https://www.bilibili.com/video/${match[1]}/`
      + (pageParam && /^[0-9]+$/.test(pageParam) && pageParam !== '1' ? `?p=${pageParam}` : '')
    : '';

  return {
    ok: Boolean(video && video.bvid && video.cid),
    isWatchPage: /^https:\/\/(www\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}/.test(href),
    url: href,
    canonicalUrl,
    video,
    streams,
    streamsStale,
    hasAudio: Boolean(streams && (streams.audio.length || streams.durl.length)),
  };
}

/** One probe using the shared helpers below — for callers already in the page. */
export function probe(win = window) {
  const state = readInitialState(win);
  const playInfo = readPlayInfo(win);
  return {
    ok: Boolean(state?.bvid && state?.cid),
    isWatchPage: isWatchPage(win),
    url: win.location.href,
    canonicalUrl: pageCanonicalUrl(win),
    video: state,
    streams: playInfo,
    hasAudio: Boolean(playInfo?.audio?.length || playInfo?.durl?.length),
  };
}
