/**
 * Headless runner. Same cases as tests/dev.html, no browser needed.
 *
 *   node tests/run.mjs
 *   node tests/run.mjs --quiet     只打印汇总
 *
 * Exit code: 0 when every case passes, 1 otherwise.
 */
import { rows } from './dev.js';

const quiet = process.argv.includes('--quiet');

if (!rows.length) {
  console.error('没有收集到任何用例 —— dev.js 可能没有执行完。');
  process.exit(1);
}

if (!quiet) {
  const width = Math.max(...rows.map((r) => [...r.name].length));
  for (const row of rows) {
    const mark = row.pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const name = row.name + ' '.repeat(width - [...row.name].length);
    console.log(`${mark} ${name}  ${row.detail || ''}`);
  }
  console.log('');
}

const failed = rows.filter((row) => !row.pass);
console.log(`${rows.length} 个用例，${rows.length - failed.length} 通过，${failed.length} 失败。`);

if (failed.length) {
  console.log('');
  for (const row of failed) {
    console.log(`\x1b[31m✗ ${row.name}\x1b[0m\n  ${row.detail}`);
  }
  process.exit(1);
}
