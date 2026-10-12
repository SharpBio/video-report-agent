# 模板组件速查（Standard）

以下是 `assets/report-template.html` 中已定义的组件。**只使用这些类名**，不要自造组件，也不要另起一套 CSS。
完整样式与结构在修订轮会随模板全文提供；本表用于写作时快速选择。

| 关系 | 组件 | 说明 |
|---|---|---|
| 多个对象与共同属性 | `.cards`、`.comparison`、`.categories` | 短定义与横向对照 |
| 并列类型，每类需展开 | `.categories.categories-detailed > .category` | 单列纵向；`data-tone` 可取 `rust` `ochre` `plum` `sage` `rose`，省略为蓝青 |
| 需要展开的操作、阶段、因果路径 | `.steps` | 有序步骤，标签短、解释完整 |
| 定义、公式、重要区别与条件 | `.callout` | 浅蓝解释框；公式要显式写出等式、运算符、条件与变量含义 |
| 关键归纳、独立简短结论 | `.keyline`、`.tiles` | 简短结论，不放大数字 |
| 口径可比的数量 | `.stats`、`.bars > .bar` | 先用文字或表格；只有量级差异本身是核心时才用柱图，同组从零起、共用刻度 |
| 少量并列事项各自有较长依据 | `.evidence-rows` | 左侧事项，右侧判断 + 完整依据 |
| 空间位置、方向、层次、状态变化 | `.map`、内联 SVG | 核心机制优先画出来，不只写描述 |
| 闭合反馈回路 | `.cycle-map`、`.cycle-edge`、`.cycle-node` | 仅在来源支持闭合反馈时使用；箭头用示例中的开放折线箭头 |
| 表格 | `.table-compact`、`.table-details`、`.table-number` | 默认自动列宽；只有短标签+短数值才用 compact |

## 章节时间与来源绑定

- 章节时间由运行时生成，使用 `<span class="section-time">`，你不要输出。
- 每个核心判断所在元素带 `data-source-units`，值为实际支持它的单元 id，空格分隔，例如 `data-source-units="unit-000012 unit-000013"`。
- 禁止区间、通配符、自造 id；无可靠 id 时按段落就近绑定。

## 画布约定

- 纸面 860px、外围浅灰 `#f2f5f7`、正文纯白，桌面约 900px 设计；不要在模板之外另建主题或整页配色。
- 正文约 16–17px，标题层次清楚；主要信息不能只靠颜色表达。
