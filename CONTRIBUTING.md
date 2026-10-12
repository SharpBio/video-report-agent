# 贡献指南

感谢愿意为这个项目出力。提交 Issue 或 Pull Request 前，请先读这份说明；
交流时请遵守[行为准则](CODE_OF_CONDUCT.md)，报告安全漏洞请读
[安全政策](SECURITY.md)，不要建公开 Issue。

## 这个仓库是什么

B站视频总结：一个纯浏览器实现的 Chrome / Edge 扩展（MV3），把公开 Bilibili 视频
变成自包含 HTML 精读报告并导出长图。没有 Python、没有 Node 运行时、没有远端服务。

## 本地环境

- Node.js 22（仅用于跑静态检查；Chrome 不读 `package.json`）
- Chrome / Edge 用于加载与手动验证：`chrome://extensions` → 开发者模式 →
  加载已解压的扩展程序 → 选择本仓库根目录

## 提交前必跑的检查

```sh
npm run check
```

一次跑完四条（无浏览器即可）：

| 检查 | 命令 | 抓什么 |
| --- | --- | --- |
| 用例 | `node tests/run.mjs` | 76 个纯函数用例（与浏览器自检页同源） |
| 静态扫描 | `node tests/lint.mjs` | 未声明就赋值、SW 里禁止的动态 `import()`、注入函数引用模块作用域、`captureVisibleTab` 节流与权限一致性 |
| ESLint | `node tests/eslint.mjs` | `no-undef`：抓「用了但没 import」（本机没装 eslint 会自动跳过） |
| 装配检查 | `node tests/links.mjs` | manifest / HTML 引用的文件在不在、import 的名字有没有导出 |

四条全绿再提交。改长图 / 截图链路前，先读 README 里记录的已知坑，不要退回已修复的实现。

## 提交信息

格式：`类型: 简述`，简述用中文，一个提交只做一件事。

类型取值：`feat`（新功能）、`fix`（修 bug）、`docs`（文档）、`refactor`、
`test`（测试）、`chore`（构建 / 杂项）。

```text
fix: 分 P 视频按 page 字段匹配，修复粘贴链接落到第一个视频
```

## Pull Request 要求

- 说明**动机**与**改动内容**，关联对应 Issue（如有）。
- 附上测试证据：四条检查的输出，或手动验证的步骤与结果。
- 不夹带敏感信息：API Key、Token、个人邮箱 / 手机号、本机绝对路径一律不要进仓库。
- 涉及报告结构、模板或提示词（`skills/video-report/`、`prompts/`）时，更新相关文档
  （README 的对应章节）。
- 报告模板的页脚链接等对外标识如需调整，请同步 `src/lib/settings.js` 的默认值与
  `tests/dev.js` 的断言。
