/**
 * dev.html 的加载提示。用经典脚本（非模块）有两个原因：
 *   1. 扩展页 CSP 是 script-src 'self'，内联脚本会被拦 —— 必须是外部文件；
 *   2. dev.js 是 ES 模块，加载失败时它自己什么都做不了，只能靠这里兜底提示。
 */
(function () {
  function show(id) {
    var el = document.getElementById(id);
    if (el) el.classList.add('on');
  }

  if (location.protocol === 'file:') show('file-warn');

  setTimeout(function () {
    var summary = document.getElementById('summary');
    if (!summary || !summary.textContent.length) show('load-warn');
  }, 1500);
})();
