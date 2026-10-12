/**
 * 跑 ESLint（主要是 no-undef）。
 *
 *   node tests/eslint.mjs
 *
 * 为什么要它：ES 模块是严格模式，「用了但没 import」会变成 ReferenceError，
 * `node --check` 抓不到；而这个错误常常被 router 吞成 {ok:false}，
 * 在 chrome://extensions 上只留一句没有堆栈的 message。
 * 真实案例：popup.js 调 recordError() 但忘了 import，4 处全炸。
 *
 * ESLint 不随仓库分发（不留 node_modules）。按以下顺序查找，都找不到就跳过
 * （没装工具不算检查失败）：
 *   1. 环境变量 VRA_ESLINT 指向 eslint/bin/eslint.js
 *   2. 仓库本目录 node_modules 里的 eslint
 *   3. 常见全局安装路径
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const CANDIDATES = [
  process.env.VRA_ESLINT,
  path.join(ROOT, 'node_modules', 'eslint', 'bin', 'eslint.js'),
  '/usr/lib/node_modules/eslint/bin/eslint.js',
  '/usr/local/lib/node_modules/eslint/bin/eslint.js',
  '/opt/homebrew/lib/node_modules/eslint/bin/eslint.js',
].filter(Boolean);

const bin = CANDIDATES.find((p) => fs.existsSync(p));

if (!bin) {
  console.log('[eslint] 没找到 eslint。安装后重试：');
  console.log('  npm install eslint@9');
  console.log('  或设置环境变量 VRA_ESLINT 指向 eslint/bin/eslint.js');
  process.exit(0); // 没装工具不算测试失败
}

const result = spawnSync(process.execPath, [
  bin,
  '--config', path.join(HERE, 'eslint.config.mjs'),
  ...process.argv.slice(2),
  '.',
], { cwd: ROOT, stdio: 'inherit' });

process.exit(result.status ?? 1);
