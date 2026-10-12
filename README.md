# B站视频总结

把公开 Bilibili 视频（或一段已有转写）变成一份自包含的 HTML 精读报告，并导出全页长图 PNG。
**纯浏览器实现**：没有 Python、没有 Node、没有本地代理，也没有远端服务——整条流水线
（下载 → 语音识别 → 多轮写作 → 装配 → 导出）都跑在一个 Chrome / Edge 扩展里。

## 功能

- **两条取音频路径**：在 B 站视频页直接读 `window.__playinfo__`；不在视频页时粘贴链接，
  用 wbi 签名的公开接口取流；直连失败自动回退到「在 B 站标签页里下载」。
- **分 P 全程正确**：链接里的 `?p=N` 全程有效，弹窗会显示「第 N 个分 P」，任务列表和历史里带
  `P3/12` 标记，「跳回原视频」跳到对应分 P 而不是第 1 个。
- **语音识别**：百炼 Paraformer 直传原始 `.m4a`（取 Policy → OSS 上传 → 提交任务 → 轮询 →
  取结果），也支持直接粘贴一份已有转写，跳过识别。
- **多轮报告生成**：P0 只输出结构契约（profile、题头、章节与来源单元区间），P1..N 一章一轮
  且只读本章来源，最后由程序装配（序号、章节 id、section-time、目录、页尾全部由代码生成），
  再由静态检查结果驱动最多重写 2 章。同一份草稿两次装配结果完全一致。
- **断点续跑**：每个阶段写完就落盘，服务被杀掉、浏览器重启、页面关闭都能从最后一个检查点
  继续，**不会重复上传音频**（ASR 任务 id 会存下来，恢复时只轮询）。
- **后台运行 + 浮层**：关掉弹窗任务照跑（offscreen 文档承载，弹窗只是发起入口）；可拖动小窗
  显示当前阶段、进度条、已用时间，以及「查看报告 / 原视频 / 取消」。
- **历史记录**：统计（总任务 / 完成 / 失败 / 进行中 / 累计时长 / 占用空间）、搜索、状态筛选、
  五种排序、批量删除、详情（阶段日志 / token 用量 / 报告章节）、跳回原视频、重命名、重试。
- **导出**：HTML 报告、全页长图 PNG、转写文本。

## 安装

1. Chrome / Edge 打开 `chrome://extensions`，开启「开发者模式」。
2. 「加载已解压的扩展程序」→ 选择**本仓库根目录**。
3. 点插件图标 → 「设置」，填写语音识别（百炼 DashScope）与大模型的 API Key。
4. 打开一个 B 站视频页，点插件图标 → 「生成报告」。

自检页：`chrome-extension://<扩展 id>/tests/dev.html`（76 个纯函数用例）。

## 数据放在哪

- 密钥：`chrome.storage.local`（永不参与账号同步）。
- 其它设置：`chrome.storage.sync`。
- 运行记录、草稿、日志、用量：IndexedDB `video-report-extension`。
- 音频、长图：OPFS（不占内存，也不会被 IndexedDB 限额卡住）。
- 完成后默认删除音频；保留策略在设置里（保留最近 N 次 / 媒体保留天数）。

## 后台运行、浮层与历史

**关掉弹窗任务不会停。** 任务始终跑在 offscreen 文档里，弹窗只是一个发起入口；
点旁边让它消失，流水线照旧往下走，也不会重复消耗 ASR。

**浮层**（设置 → 界面 → 后台浮层，默认开）：开跑时弹出可拖动小窗，显示当前阶段、进度条、
已用时间。它订阅流水线广播的 `RUN_EVENT`，不需要 service worker 一直醒着。位置会被记住，
下次原地打开；跑完想让它自动消失，把「跑完以后」设成自动关闭即可。

**历史记录**（弹窗右上角「历史」）是独立页面，比弹窗里那几行完整得多：勾选后可批量删除，
另有「清空已完成」「清空全部」（都要二次确认）；失败的可重试，进行中的可取消；
删除会连同 OPFS 里的音频一起清掉，不只是删记录。

**导出为什么有时像「点了没反应」**：下载不能在 service worker 里做——它创建的 `blob:` URL
属于 worker，worker 一休眠链接就失效，`chrome.downloads` 拿到的是一条死链，既存不下也不报错。
现在导出统一转给 offscreen 文档执行。

**长图**走「开一个专属窗口把报告铺开、逐屏 `captureVisibleTab`、再在 offscreen 里拼成一张」。
它会短暂弹出一个窗口（截图期间可见，拍完自动关闭），然后直接下载到下载目录，不弹「另存为」。

## 多 P（分 P）视频

分 P 是最容易悄悄出错的地方，三个坑都已修好，改相关代码时别退回去：

- **当前分 P 只能信 URL 的 `?p=`**。`__INITIAL_STATE__` 里没有可靠的当前分 P 字段
  （老版本有 `state.p`，新版早就没有了）。只信 state 的话永远算成 1，多 P 视频一律拿到第一个。
  `src/lib/bilibili-page.js` 里 URL 优先，state 只是兜底。
- **探测到的是「当前打开的那一页」**，只有它和用户要处理的是同一个 BV 号、同一个分 P 时才能用
  （`probeMatches()`）。以前无脑塞进去，于是在看 P1 却粘贴了 P3 链接时，用的仍然是 P1 的数据。
- **切换分 P 后 `window.__playinfo__` 可能还是上一 P 的**（播放器重新请求、写回 window 之间有
  个窗口）。用时长对一下，差 5 秒以上就判定失效，改走接口按 cid 重新取流。

另外分 P 列表要**按 `page` 字段找**，不能按下标取（`pickPage()`）——列表偶尔缺项或乱序，
按下标取就会张冠李戴。要的那一 P 不存在时会明确报错，不会默默退回第一个。

## 长图实现要点（改这块前先读）

这条路上有五个绕不开的坑，都已经在代码里记着：

- **必须声明 `<all_urls>`**。拍的是 `chrome-extension://` 自己的页面，`captureVisibleTab`
  照样要求 `<all_urls>` 或 `activeTab`，否则抛
  `Either the '<all_urls>' or 'activeTab' permission is required.`。
  权限写在 `host_permissions` 里，刷新插件即生效，不会弹授权框。
- **每秒最多拍 2 屏**。Chrome 对 `captureVisibleTab` 有硬性配额，超了抛
  `This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.`——
  连着拍十几屏的话第 3 屏就炸，表现是「窗口闪一下就没了、什么都没存」。
  `src/background/capture.js` 里的 `nextShotDelay()` 负责节流（可单测），撞上配额还会退避重试。
  代价是长图要跑十几秒，所以期间会把「第 n/N 屏」广播回弹窗和历史页。
- **屏只能以 data URL 传递**。`chrome.runtime.sendMessage` 走的是 JSON 风格的序列化，
  一个 `Blob` 到了对面就变成空对象 `{}`——拼图时 `createImageBitmap` 抛
  "The provided value is not of type '(Blob or ...)'"，报错跟「没传过来」毫无关系，
  而且是在十几屏都拍完之后才炸。`src/lib/stitch.js` 里的 `stripSource()` 专门认这个。
- **别再试 SVG foreignObject 那条无权限路线**。把报告塞进 `foreignObject` 再画到 canvas，
  Chrome 会把画布判成 **tainted**，`convertToBlob()` 直接抛
  `Tainted "OffscreenCanvas" may not be exported`——浏览器层面就堵死了。
  另外 `windows.create` 不支持 Firefox 的 `populate`（多传一个字段会直接抛
  `Unexpected property`），tabId 只能从报告页 `VIEWER_READY` 消息的 sender 上取。
- **图上有重影 / 内容叠在一起**，通常是三处叠加（都修好了）：报告模板里的
  `html{scroll-behavior:smooth}` 会把 `scrollTo` 变成动画（截图时 viewer 强制改回 `auto`，
  并等到 scrollY 连续三帧不变才拍）；分屏偏移必须递增（`planStrips()` 保证递增、去重、
  不超过页面真能滚到的距离）；`position: fixed` / `sticky` 的元素会被画 N 遍
  （截图前先 unpin，`.report-nav` 就是 fixed）。

另外每屏都用**实际滚到的位置**（`window.scrollY` 回读）而不是请求的位置，滚不到位时直接停拍；
拼图前 `dedupeStrips()` 还会再兜一次底。拼接时还要注意**设备像素比**：
`captureVisibleTab` 出的是设备像素，150% 缩放的笔记本上 1 CSS px = 1.5 px。
`stitch.js` 先量第一屏拿到比例再决定画布尺寸；装不下 Chrome 的画布上限（单边 16384）时
整体等比缩小（`fitScaleToCanvas()`），而不是直接报错拒出图。

## 自检与开发

**不要直接用 `file://` 打开 `tests/dev.html`**——Chrome 会拦截 `file://` 下的 ES 模块
（`CORS: origin null`），`dev.js` 不会执行，页面就是一片空白。三选一：

```bash
# 1) 无浏览器，最省事（推荐）
node tests/run.mjs          # 76 个纯函数用例，通过退出码 0
node tests/lint.mjs         # 「未声明就赋值」+ SW 里禁止的动态 import() + 注入函数引用模块作用域
node tests/eslint.mjs       # no-undef：抓「用了但没 import」（本机没装 eslint 会自动跳过）
node tests/links.mjs        # 装配检查：manifest/HTML 引用的文件在不在、import 的名字有没有导出

# 2) 作为扩展页（扩展加载后，ID 在 chrome://extensions 的卡片上）
chrome-extension://<扩展 id>/tests/dev.html

# 3) 本地 HTTP 服务
python -m http.server 8765
# 然后打开 http://127.0.0.1:8765/tests/dev.html
```

四条可以一次跑完：`npm run check`。只需要 Node.js 22，不需要装任何依赖
（`package.json` 只是让 Node 把 `.js` 当 ES 模块解析，Chrome 不读它；
ESLint 未安装时该项自动跳过，CI 里会现装）。

`tests/dev.js` 是用例的唯一来源，`dev.html`（浏览器）和 `run.mjs`（Node）共用它，
所以两条路径跑的是同一批断言：URL 校验、接口地址校验、转写格式、ASR 片段归一化、确定性装配。

### 扩展内自检

静态检查看不到的东西（DNR 规则会不会作用在扩展自己发的请求上、沙箱 iframe 能不能 eval、
offscreen 里有没有 canvas、service worker 拿不拿得到 storage），设置页底部有「**运行自检**」，
点一下会列出每一项及其结论，不改动任何设置。

其中几项是**真发请求**的连通性测试：「Bilibili 接口连通性」在两个上下文各测 `nav` 的 omit 与
include 两种凭证模式；「媒体下载链路」会在当前 B 站视频页上真取一小块音频；「语音识别 / 大模型
连通性」会在 service worker 和 offscreen 两个上下文各发一次真请求——只测一个上下文是不够的，
两边失败都只报一句 `Failed to fetch`，分辨不出是网络、地址、Key 还是主机权限。

「**offscreen · 打包资源读取**」会**逐个**读流水线真正会用到的每一个资源（SKILL.md、
standard 模式、5 份 reference、4 份提示词、报告模板），缺一个就列出名字和原因。
自检必须验生产路径本体，不能只验同类请求。

### 排障

- **上次失败诊断**（设置页，打开即自动加载）：失败于哪一跳（`errorStage`）、那一跳前后的
  日志（最后 12 条）、落盘的堆栈（带文件行号，来自 `src/lib/diag.js`）、任务实际拿到的
  配置摘要（不记密钥）。`baseUrl` 为空时 `fetch` 会退化成请求 `chrome-extension://<id>/uploads`，
  报错同样是 `Failed to fetch`——所以这份摘要是排错的第一现场。有「复制全文」按钮。
- **控制台**：弹窗一关、offscreen 一销毁，控制台就没了；而 `chrome://extensions` 的错误列表
  **不会自动清空**（旧条目会一直误导人，记得点「全部清除」）。现在错误会连堆栈写进
  `chrome.storage.local`，弹窗下次打开时状态栏会显示 `上次出错（offscreen）：... at xxx.js:行号`，
  双击任务列表可以清掉这条记录。
- **改完代码怎么让新代码生效**：**必须到 `chrome://extensions` 点一次本插件的刷新按钮**。
  offscreen 文档一创建，它那张 ES 模块图就固化了，只要文档还活着就继续跑旧代码——典型症状是
  报错堆栈的行号永远停在改之前的那一版。代码自己也兜了一层：每次开跑、自检、恢复任务之前，
  service worker 都会先问 offscreen「忙不忙」，不忙就关掉重建。日志里 `env — offscreen 上下文`
  带 `bootAt` 和 `ageSec`，`ageSec` 很大说明你还在跟旧文档说话。

## 目录结构

```
.
├── manifest.json      MV3 清单（权限、action、offscreen、DNR、资源打包）
├── prompts/           运行时追加的提示词（环境声明、组件速查、规划契约、纯文本工具回退）
├── skills/video-report/  报告 Skill：SKILL.md、standard 模式、报告模板、五份 reference
├── sandbox/           eval 沙箱页（唯一允许 eval 的地方）
├── popup/             启动任务、进度、导出
├── options/           全部设置、连接测试、授权
├── src/
│   ├── background/    service worker：offscreen 托管、页面探测、Cookie、DNR、截图编排、看门狗、一键自检
│   ├── offscreen/     流水线本体（ingest → 编排 → 各轮 pass）、上下文内自检
│   ├── lib/           协议、错误分类、存储、转写、ASR、LLM、装配、校验、拼接、错误留痕（diag.js）、
│   │                  历史页筛选与统计（history-query.js）、截图权限闸门（capture-gate.js）
│   ├── viewer/        报告预览 + 截图承载页
│   ├── mini/          后台浮层小窗（进度、取消、打开报告/原视频）
│   └── history/       历史记录管理页（统计、搜索、筛选、批量删除、详情、跳原视频）
├── tests/             自检页（dev.html）、用例本体（dev.js）、Node 运行器（run.mjs）、
│                      静态扫描（lint.mjs）、ESLint 包装（eslint.mjs + eslint.config.mjs）、
│                      装配检查（links.mjs）、转写样本
└── package.json       仅用于让 Node 把 .js 当 ES 模块解析（Chrome 不读）
```

## 已知限制

1. **60 分钟上限**：没有 ffmpeg 的静音检测，长音频不切分，直接拒绝比硬截断更可预期
   （可在设置里放宽到 5 小时，但没有静音切分，不推荐）。
2. **Referer 注入已证伪**：`fetch()` 无法自己设置 Referer，`declarativeNetRequest` 的
   session rule **不会作用在扩展自己发起的请求上**。所以下载走的是「经 B 站页面取流」这条
   主路径：没有已打开的 B 站页面时，扩展会自己开一个后台标签页，下完关掉。
   页面里的 `fetch` 两个硬约束：先不带凭证（CDN 返回 `Access-Control-Allow-Origin: *`，
   带凭证的跨域请求会被浏览器直接拒掉）；`Referer` 要用 `referrer` +
   `referrerPolicy: 'unsafe-url'` 显式给（`Referer` 是禁止头，写进 `headers` 会被静默忽略）。
   另外媒体 CDN 的真实后缀是 **`.cn`**（`*.bilivideo.cn`，且带端口），DNR 的 `urlFilter`
   必须以 `^` 结尾而非 `/`，否则端口会挡在中间导致规则一条都不命中。
3. **扩展里带凭证的跨域请求拿不到 CORS 豁免**：Chrome 靠 `host_permissions` 给扩展的跨域豁免
   **只覆盖 `credentials: 'omit'`**。一旦设成 `include`，就要服务器为
   `chrome-extension://<id>` 这个 origin 返回 `Access-Control-Allow-Origin` +
   `Access-Control-Allow-Credentials`，B 站不会给——请求在网络层就被拒，拿不到状态码，
   只剩一句 `TypeError: Failed to fetch`。所有 B 站接口统一走 `src/lib/http.js` 的 ladder：
   omit 优先，失败了才试 include。代价是拿不到登录态，只有公开可播的那档码率（做语音识别足够）。
4. **exec_js 可能被 CSP 拒绝**：沙箱页理论上允许 eval；若被拒绝，模型会退化成文字、表格或
   公式表达。
5. **修订轮只做静态检查**：横向溢出、纵向裁剪这类需要真实布局的检查只在浏览器里跑
   （viewer 的「自检」），不会自动触发模型重写。
6. **不识别登录才能看的视频**：只处理公开可播的内容。

## 协议

本项目以 [MIT 协议](LICENSE) 发布。

## 致谢与链接

- **上游致谢**：报告的结构与措辞规则、`video-report` Skill（SKILL.md / standard 模式 /
  报告模板 / 五份 reference）与提示词体系衍生自
  [imexlovery/video-report-agent](https://github.com/imexlovery/video-report-agent)（MIT），
  本仓库是其 Python 流水线的纯浏览器移植，仅发布 Chrome 扩展形态，特此致谢。
- **在线网站**：上游的在线报告服务 [vreport.tri4t.xyz](https://vreport.tri4t.xyz/)
  （与本仓库代码相互独立，仅供体验）。
- **本仓库**：<https://github.com/SharpBio/video-report-agent>
