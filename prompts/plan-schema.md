# 规划轮输出契约（P0）

只输出一个 JSON 对象，不要输出解释文字、Markdown 代码块之外的任何内容。

```json
{
  "profile_primary": "mechanism | procedure | evidence | argument | narrative",
  "profile_secondary": "与 primary 不同的一个值，或 null",
  "title": "报告主标题",
  "subtitle": "副标题；没有新增角度时留空字符串",
  "lead": "一段导语，概括视频讨论对象、核心问题与报告展开方式；不重复主副标题，不提前复述各章结论",
  "nav": ["章节标签1", "章节标签2"],
  "sections": [
    {
      "id": "s1",
      "title": "章节标题",
      "unitRange": [1, 24],
      "timeHint": "",
      "intent": "本章要回答的一个问题"
    }
  ]
}
```

## 约束

- `profile_primary` 按读者最需要理解的信息关系选择，不按题材、标题关键词或说话人数分类。
- `profile_secondary` 只在另一种结构实质影响主线、需要额外编辑规则时填写，最多一个，且不能等于 primary。
- `sections` 数量由信息结构决定，**不超过 12 个**。每个章节只解决一个主要问题，标题连起来要能说明整篇如何推进。
- `unitRange` 用来源单元序号（从 1 开始，含两端），必须真实覆盖该章要用的材料；区间可以重叠，但不要把所有章节都写成全区间。
- `timeHint` 一般留空：章节时间由运行时按实际使用的单元计算。只有来源确实没有可靠时间、你判断需要显式说明时才填写。
- `title` 兑现内容范围，不把例子抬成结论；`nav` 只写简短定位标签，顺序与 `sections` 一致。
- 标题、导语遵守 SKILL.md 的措辞规则：不使用“不是……而是……”及其变体，不写空泛领起语或口号。
