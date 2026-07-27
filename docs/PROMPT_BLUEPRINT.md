# PromptBlueprint 设计

## 1. 定位

PromptBlueprint 是原始提示词 / 参考图和最终提示词之间的结构化中间层。

它不是展示给用户的一段大文本，也不是某一家模型的专用提示词。它保存可锁定、可变化、可组合的视觉语义，随后由目标模型的 PromptRenderer 编译成最终提示词。

## 2. 通用层

所有任务类型共享以下语义字段：

```text
taskType             # 任务类型 ID
intent               # 任务目标
subject              # 主体
context              # 场景与使用环境
audience             # 目标受众
composition          # 构图与空间关系
visualLanguage       # 视觉语言
palette              # 色彩
lighting             # 光线
material             # 材质
textLayout           # 文字与信息区域
technical            # 比例、尺寸、输出要求
references           # 参考图与参考作用
constraints           # 必须保留 / 禁止内容
```

字段不是每次都必填；任务配置决定哪些字段必填、哪些字段默认隐藏。

## 3. 任务类型配置

```js
{
  id: "poster",
  name: "海报",
  description: "活动、品牌或传播用途的视觉海报",
  defaultRatio: "3:4",
  requiredFields: ["intent", "subject", "technical"],
  supportedDimensionIds: [
    "visual_style",
    "color_style",
    "layout_style",
    "composition",
    "material",
    "information_density",
    "brand_tone"
  ],
  promptProfile: "poster"
}
```

新增类型只需增加配置并指定可用维度，不应修改主流程代码。

`event_visual` 对应“活动主视觉 / 线下物料”，覆盖市集、快闪、节庆、展位、横幅和导视等成套现场视觉。它默认使用 `21:9` 横向画幅，要求明确使用场景、物料形态、观看距离、真实载体和安装关系，避免把现场物料退化为单张悬浮海报。

`brand_application` 对应“品牌应用 / VI 展示”，用于把品牌识别系统应用到摊车、包装、空间或其他实体载体的样机展示。它默认使用 `3:2` 画幅和“设计风格”变量：先识别并锁定实体载体、基础物理材质、背景、镜头、应用面数量与信息分配，再动态生成适合该载体的视觉风格方向。载体识别是固定解析步骤，不作为用户比较的探索变量；多面载体上的全部应用面共享同一风格系统。载体基础材质属于主体基线，只有印刷、贴膜、压纹等表面工艺可以在“材质与质感”维度中变化。动态“设计风格”可生成 2、3、4、5、6、8 或 10 套，并要求各方案跨不同主风格家族；其他固定候选维度仍最多生成 6 套。10 套探索还维护可扩展的已验证优先风格锚点：餐饮摊车、市集摊位、餐饮快闪、节庆售卖等匹配场景当前保留“国潮喜庆风”“高饱和街头快闪风”“萌趣插画风”，补齐请求会优先补回缺失锚点；不匹配载体不强制套用。

## 3.1 内容模式

内容模式控制缺失信息的处理方式，不改变探索维度或输出规格。

```text
concept   # 概念补全：允许 AI 合理补足少量短文案、信息区域和必要视觉细节
factual   # 事实保守：只使用用户提供的标题、品牌、日期、地点、价格和报名信息
```

`concept` 是默认模式。首次探索沿用线上验证过的丰富视觉创作契约，直接生成完整、可生图的主体、场景、构图和风格段落；不会强制写满卖点标签、活动卡片和 CTA。自动补全内容必须被视为 AI 草案，不代表真实活动事实。`factual` 模式保留干净排版区域，不生成缺失的现实信息。

概念模式保持线上提示词的表达顺序：先写清主体动作、场景和用途，再写当前探索风格、材质、光线、构图和信息层级。结构化蓝图用于记录和校验，不把设计方法、内容清单或工作流说明写入最终生图提示词。

首次概念探索的线上基线是 [WoodSlope/vispath](https://woodslope.github.io/vispath/) 的 `main` 构建（当前对应提交 `ff431f7`）。线下新增的内容模式、蓝图和细化数据只能作为外围状态管理，不能改变这条首次创作契约。

## 3.2 探索样本与不可变骨架

儿童乐园水上活动的六张样本图保存在 `tests/fixtures/water-park-exploration/`，对应六个固定设计风格。它们用于验证“风格可以变，叙事不能丢”，共同保留以下内容：

- 孩子奔向水上乐园大门，并回头呼喊家长跟上。
- 家长在前景或后方回应，孩子在中景运动，大门在背景成为明确目的地。
- 画面保持前景—主体—目的地的运动轴线，而不是静态人物摆拍。
- 海报仍保留上方标题区、中部主体视觉和下方活动信息区。

设计风格探索会锁定主体、动作、目的地、互动关系、构图与信息结构；模型只能改变视觉语言、材质和装饰表达。样本清单见 `sample-manifest.json`，回归入口是 `tests/prompt-renderer.test.mjs`。

从生成结果继续细化时，当前生成图片会作为 `generated-result` 图片1提供给文本模型做视觉分析，同时保留结构化蓝图。它只用于理解上一轮实际生成的主体、动作、构图、色彩、材质和文字排布；下一轮生图仍使用重新编译后的完整提示词，不会默认把上一张图片当作编辑底图。

## 4. 探索维度配置

```js
{
  id: "visual_style",
  name: "设计风格",
  description: "改变整体视觉语言，不改变主体、用途和信息结构",
  applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard"],
  defaultOptions: [
    { id: "editorial", label: "极简编辑感" },
    { id: "retro_print", label: "复古印刷感" },
    { id: "future_tech", label: "未来科技感" }
  ],
  lockRules: ["subject", "intent", "technical", "textLayout"],
  promptProfile: "visual-style"
}
```

新增维度只需声明适用类型、候选值、锁定规则和提示词配置。

## 5. 运行时蓝图

```js
{
  schemaVersion: 1,
  source: {
    prompt: "",
    referenceImages: [],
    referenceRole: "inspiration"
  },
  taskTypeId: "poster",
  locked: {
    intent: "咖啡店开业宣传",
    subject: "一杯冰拿铁",
    context: "夏日咖啡店场景",
    technical: { ratio: "3:4" },
    constraints: ["保留标题区域", "不生成复杂中文文字"]
  },
  dimensions: {
    visualLanguage: null,
    palette: null,
    composition: null,
    textLayout: null,
    material: null
  },
  exploration: {
    dimensionIds: ["visual_style"],
    optionCount: 3,
    requestedOptionCount: 3,
    missingOptionCount: 0,
    isPartial: false,
    selectedOptions: []
  },
  responseDiagnostics: {
    status: "completed",
    incompleteReason: "",
    outputTokens: 2400,
    maxOutputTokens: 3000,
    returnedOptionCount: 3,
    acceptedOptionCount: 3
  },
  variants: []
}
```

文本模型可能在复杂多模态请求中少返回方案。只要 JSON 可解析且至少有一套方案通过校验，运行时蓝图就标记 `isPartial` 并保留有效结果；不能再因 `variants.length` 小于请求数量而丢弃整批。`responseDiagnostics` 只保存完成状态、输出 token 和数量等非敏感诊断，不保存 API Key 或完整服务响应。

补齐时发起独立请求，`optionCount` 等于当前 `missingOptionCount`，并通过 `completionBase` 传入原 `locked` 与已有 `targetOption`。补齐暗提示必须声明这是同一轮补充而非新一轮探索，禁止改写载体、应用面、构图、信息分配和品牌事实；新方向还要排除已有方向的重复、近义、上下位包含和同一主风格家族。新方案追加到原列表，补齐再次少返或失败时仍保留此前结果。

## 6. PromptVariant

每套最终方案必须保存变化来源，而不是只保存一段最终文字：

方案卡片的 `title` 必须逐字使用当前探索项，例如设计风格探索时固定显示“极简编辑感”“复古印刷感”“未来科技感”等。模型生成的提案名称只能写入 `changeSummary` 或完整提示词，不能重新命名探索项，否则会破坏横向比较。

```js
{
  id: "variant_1",
  title: "复古印刷感",
  changed: {
    visual_style: "retro_print"
  },
  lockedSnapshot: {
    subject: "一杯冰拿铁",
    technical: { ratio: "3:4" }
  },
  changeSummary: "只改变设计风格，保留主体、场景、比例和标题留白。",
  prompt: "...",
  generation: {
    providerId: "",
    model: "",
    ratio: "3:4",
    imageCount: 1
  }
}
```

## 7. 多维度组合规则

首版默认 `dimensionIds` 只能有一个值。

高级模式最多允许两个维度。系统不能无提示地生成所有组合；应根据用户指定的方案数量生成经过选择的组合，并明确显示每个方案改变了哪些维度。

例如：

```text
设计风格 × 色彩风格
方案 A：极简编辑 × 低饱和奶油色
方案 B：极简编辑 × 高对比黑白
方案 C：复古印刷 × 暖橙蓝
方案 D：未来科技 × 冷色霓虹
```

如果用户需要完整矩阵，作为高级功能单独显示总数量、成本和缺失组合。

## 8. 多轮细化继承

用户的原始提示词可能很短。首轮必须先把它克制地补全为可执行的视觉蓝图，只补足主体动作、空间层次和视觉风格所必需的少量信息；用户选中的方案会成为下一轮的已确认基线。未指定的文案、品牌、日期、道具、服装、人数和设施不应被擅自编造。

多轮细化遵循以下数据流：

```text
source.prompt → blueprintSnapshot 1 → promptSnapshot 1
blueprintSnapshot 1 + 新维度 → blueprintSnapshot 2 → promptSnapshot 2
blueprintSnapshot 2 + 新维度 → blueprintSnapshot 3 → promptSnapshot 3
```

- `source.prompt` 是用户最初输入，只读，不能被上一轮最终提示词覆盖。
- `blueprintSnapshot` 保存已经确认的主体、动作、空间关系、视觉细节、限制和已选维度，是下一轮细化的唯一基线。
- `promptSnapshot` 是当轮实际提交给生图接口的完整文字，用于复制、重试和审计，不作为下一轮原始输入。
- 新一轮只能修改当前选择的探索维度；其他已确认维度必须继续保留。
- 同一维度再次探索时覆盖该维度，切换到新维度时合并该维度。
- 每一轮都从当前蓝图重新编译完整提示词，不能把上一轮提示词原样追加到下一轮。
