# 文本模式工具调用语法

当前模型接口未启用原生工具调用。需要调用工具时，在回复中插入如下围栏块：

````
```tool
{"name": "write_section", "arguments": {"id": "s1", "title": "标题", "html": "<p>…</p>"}}
```
````

规则：

- 一个围栏块只放**一个** JSON 对象，字段是 `name` 与 `arguments`。
- 围栏块之外的文字会被视为对读者的说明，不会被执行；同一次回复里可以既有文字也有工具块。
- 工具结果会以 `TOOL_RESULT(name): {json}` 的形式回灌给你，读完再决定下一步。
- 不要在同一个回复里连续写多个互相依赖的工具块；一次调用，等结果，再一次调用。
- 不需要再调用工具时，直接输出正常文字结束本轮，不要调用 `finish`。

## 可用工具

| name | arguments |
|---|---|
| `read_transcript` | `{from: number, to: number}` — 按 unit 序号区间读取转写原文 |
| `read_report` | `{scope: "outline" \| "section" \| "head", id?: string}` |
| `write_section` | `{id, order?, title, html, sourceUnits?: string[], unitRange?: number[], nav?: string}` |
| `write_meta` | `{title?, subtitle?, lead?, nav?: string[], sourcesHtml?: string}` |
| `exec_js` | `{code: string, args?: any[]}` — 沙箱内计算图形坐标 |
| `finish` | `{summary?: string}` |
