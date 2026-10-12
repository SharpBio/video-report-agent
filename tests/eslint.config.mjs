/**
 * ESLint flat config，只用来跑两条规则：
 *
 *   no-undef        抓「用了但没声明」——典型事故：popup.js 里调 recordError() 但忘了 import。
 *                   这在 ES 模块里是 ReferenceError，node --check 抓不到，
 *                   而且会被 router 吞成 {ok:false}，chrome://extensions 上只留一句没堆栈的报错。
 *   no-unused-vars  只是提示（warn），用来发现写了一半的代码。
 *
 * 运行（在 extension 目录）：
 *   node tests/eslint.mjs        # 本目录的包装脚本：自动找 eslint，找不到就跳过
 *
 * 说明：globals 直接内联，不依赖 globals 包，这样仓库里不用留 node_modules。
 */

const BROWSER = [
  'window', 'self', 'globalThis', 'document', 'console', 'navigator', 'location',
  'history', 'screen', 'alert', 'confirm', 'prompt', 'localStorage', 'sessionStorage',
  'fetch', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File', 'FileReader',
  'AbortController', 'AbortSignal', 'ReadableStream', 'WritableStream', 'TransformStream',
  'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder', 'crypto', 'performance',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate',
  'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
  'Image', 'ImageBitmap', 'OffscreenCanvas', 'HTMLCanvasElement', 'HTMLImageElement',
  'CanvasRenderingContext2D', 'DOMParser', 'XMLSerializer', 'XMLHttpRequest',
  'MutationObserver', 'ResizeObserver', 'IntersectionObserver', 'CustomEvent', 'Event',
  'MessageChannel', 'MessagePort', 'Worker', 'BroadcastChannel', 'CSS',
  'DOMRect', 'Node', 'Element', 'HTMLElement', 'NodeList', 'Range', 'Selection',
  'structuredClone', 'atob', 'btoa', 'devicePixelRatio', 'matchMedia', 'name', 'top',
  'origin', 'caches', 'indexedDB', 'IDBKeyRange', 'webkitRequestFileSystem',
  'Path2D', 'ImageData', 'AudioContext', 'OfflineAudioContext',
  'DOMException', 'getComputedStyle', 'createImageBitmap', 'requestIdleCallback',
];

const NODE = ['process', 'Buffer', 'require', 'module', '__dirname', '__filename', 'URL'];

const EXTENSION = ['chrome', 'browser'];

export default [
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: Object.fromEntries(
        [...BROWSER, ...NODE, ...EXTENSION].map((k) => [k, 'readonly']),
      ),
    },
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', varsIgnorePattern: '^_' }],
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-dupe-args': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-self-assign': 'error',
      'no-sparse-arrays': 'error',
      'no-cond-assign': 'error',
      'no-empty': 'off',
    },
  },
  {
    // 测试桩里本来就会用到一堆 Node 全局
    files: ['tests/**/*.js', 'tests/**/*.mjs'],
    languageOptions: { globals: { chrome: 'writable', window: 'writable' } },
  },
];
