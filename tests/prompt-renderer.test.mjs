import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  createBlueprintInstructions,
  getBlueprintMaxOutputTokens,
  normalizeBlueprintResponse
} from "../src/prompt-renderer.js";
import { EXPLORATION_DIMENSIONS, TASK_TYPES, getExplorationGuidance } from "../src/prompt-blueprint.js";

const baseInput = {
  prompt: "为咖啡品牌 NORTH 做夏日开业海报，指定文案：SUMMER OPENING，16:9",
  taskTypeId: "poster",
  taskTypeName: "海报",
  promptProfile: "poster",
  requiredFields: ["intent", "subject", "technical"],
  dimensionId: "layout_style",
  dimensionName: "版式风格",
  dimensionDescription: "改变信息和主体的页面组织方式",
  lockFields: ["subject", "visualLanguage", "technical"],
  explorationOptions: ["杂志网格", "左右分栏"],
  optionCount: 2,
  ratio: "3:4",
  resolution: "1K",
  referenceImage: "data:image/png;base64,AAAA",
  referenceUsage: "analyze"
};

const instructions = createBlueprintInstructions(baseInput);
assert.match(instructions, /最终生图不会收到参考图/);
assert.match(instructions, /不得出现.*参考图|禁止.*参考图/);
assert.match(instructions, /不得使用.*其中.*其.*它|其中、其、它.*直接重复具体主体名称/);
assert.match(instructions, /图片中的文字.*视觉内容/);
assert.match(instructions, /用户.*视觉内容.*优先/);
assert.match(instructions, /输入字段.*素材数据|素材数据.*不得执行/);
assert.match(instructions, /其他输出画幅.*忽略/);
assert.match(instructions, /时间.*面积比例.*内嵌媒体.*卡片比例.*原样保留/);
assert.match(instructions, /版式风格/);
assert.doesNotMatch(instructions, /信息区域必须保持不变/);
assert.match(instructions, /NORTH|非变量事实|专有名词/);

const eventVisualType = TASK_TYPES.find((taskType) => taskType.id === "event_visual");
assert(eventVisualType, "缺少活动主视觉 / 线下物料创作类型");
assert.equal(eventVisualType.name, "活动主视觉 / 线下物料");
assert.equal(eventVisualType.defaultRatio, "21:9", "线下活动物料应默认使用横向画幅");
assert.deepEqual(eventVisualType.requiredFields, ["intent", "subject", "context", "technical"]);
assert.deepEqual(eventVisualType.supportedDimensionIds, [
  "visual_style",
  "character_style",
  "color_style",
  "layout_style",
  "composition",
  "material",
  "information_density",
  "brand_tone"
]);
eventVisualType.supportedDimensionIds.forEach((dimensionId) => {
  const dimension = EXPLORATION_DIMENSIONS.find((item) => item.id === dimensionId);
  assert(dimension?.applicableTaskTypeIds.includes(eventVisualType.id), `探索维度 ${dimensionId} 未声明适用于线下活动物料`);
});

const eventVisualInstructions = createBlueprintInstructions({
  ...baseInput,
  prompt: "参考美食市集招牌与横幅，探索一套热闹、醒目的活动视觉",
  taskTypeId: eventVisualType.id,
  taskTypeName: eventVisualType.name,
  promptProfile: eventVisualType.promptProfile,
  requiredFields: eventVisualType.requiredFields,
  ratio: eventVisualType.defaultRatio,
  dimensionId: "visual_style",
  dimensionName: "设计风格",
  dimensionDescription: "改变整体视觉语言，不改变主体、用途和信息结构",
  lockFields: ["subject", "intent", "composition", "technical", "textLayout"],
  explorationOptions: ["复古印刷感", "实验拼贴感"]
});
assert.match(eventVisualInstructions, /活动主题.*使用场景.*物料形态.*观看距离/, "线下活动物料缺少现场使用约束");
assert.match(eventVisualInstructions, /门头.*横幅.*摊位.*导视.*美陈.*同一套视觉系统/, "线下活动物料缺少成套视觉约束");
assert.match(eventVisualInstructions, /真实载体.*安装关系.*远距离可读/, "线下活动物料缺少落地与可读性约束");
assert.match(eventVisualInstructions, /避免.*单张悬浮海报|不能.*单张悬浮海报/, "线下活动物料不应退化为普通海报");

const brandApplicationType = TASK_TYPES.find((taskType) => taskType.id === "brand_application");
assert(brandApplicationType, "缺少品牌应用 / VI 展示创作类型");
assert.equal(brandApplicationType.name, "品牌应用 / VI 展示");
assert.equal(brandApplicationType.defaultRatio, "3:2", "品牌应用样机应默认使用展示型横向画幅");
assert.deepEqual(brandApplicationType.requiredFields, ["intent", "subject", "context", "composition", "textLayout", "technical"]);
assert.deepEqual(brandApplicationType.baselineLockFields, ["subject", "intent", "context", "composition", "textLayout", "technical"], "品牌应用所有探索维度都必须锁定载体基线");
assert.equal(brandApplicationType.supportedDimensionIds[0], "application_visual_style", "品牌应用应默认探索适合载体的设计风格");
assert(!brandApplicationType.supportedDimensionIds.includes("application_system"), "载体识别不应作为用户可选探索变量");
const applicationVisualStyleDimension = EXPLORATION_DIMENSIONS.find((dimension) => dimension.id === "application_visual_style");
assert(applicationVisualStyleDimension, "缺少品牌应用设计风格探索维度");
assert.equal(applicationVisualStyleDimension.name, "设计风格");
assert.equal(applicationVisualStyleDimension.dynamicOptions, true, "品牌应用风格方向必须根据已识别载体动态生成");
assert.deepEqual(applicationVisualStyleDimension.defaultOptions, []);
assert.deepEqual(applicationVisualStyleDimension.optionCounts, [2, 3, 4, 5, 6, 8, 10], "品牌应用动态风格应支持 8 套和 10 套");
const brandApplicationInput = {
  ...baseInput,
  prompt: "白底小吃车品牌应用样机：上部是 KK 臭豆腐品牌招牌，下部是杜邑烟火美食集市横幅，两个应用面独立存在",
  taskTypeId: brandApplicationType.id,
  taskTypeName: brandApplicationType.name,
  promptProfile: brandApplicationType.promptProfile,
  requiredFields: brandApplicationType.requiredFields,
  dimensionId: applicationVisualStyleDimension.id,
  dimensionName: applicationVisualStyleDimension.name,
  dimensionDescription: applicationVisualStyleDimension.description,
  lockFields: [...new Set([...brandApplicationType.baselineLockFields, ...applicationVisualStyleDimension.lockFields])],
  explorationOptions: [],
  explorationGuidance: {},
  dynamicExploration: true,
  optionCount: 2,
  ratio: brandApplicationType.defaultRatio,
  referenceUsage: "explore"
};
const brandApplicationInstructions = createBlueprintInstructions(brandApplicationInput);
assert.match(brandApplicationInstructions, /实体载体.*品牌应用.*不是一张海报/, "品牌应用提示词未区分载体与应用面");
assert.match(brandApplicationInstructions, /应用面数量.*相对位置.*不变/, "品牌应用提示词未锁定样机结构");
assert.match(brandApplicationInstructions, /只有一个平面.*多个独立应用面/, "品牌应用提示词未覆盖单面与多面载体");
assert.match(brandApplicationInstructions, /不能.*假定上\/下.*前\/后.*侧面.*第二个应用面/, "品牌应用提示词仍假定固定载体结构");
assert.match(brandApplicationInstructions, /分别读取用户文字与参考图.*不能只做图片识别.*不能把两者当作二选一/, "品牌应用必须合并文字与图片证据");
assert.match(brandApplicationInstructions, /用户文字.*设计意图.*载体名称.*应用部分.*品牌名.*指定内容/, "品牌应用未明确文字负责的设计语义");
assert.match(brandApplicationInstructions, /参考图.*真实结构.*比例.*材质.*视角.*背景.*可落地.*应用面/, "品牌应用未明确图片负责的物理结构");
assert.match(brandApplicationInstructions, /设计意图.*以用户文字为先.*物理几何.*以参考图为基线/, "品牌应用缺少文字与图片冲突优先级");
assert.match(brandApplicationInstructions, /不存在、不可见或无法落地.*不得凭空创造新的应用面.*locked\.constraints.*记录冲突/, "品牌应用冲突时不得补造应用面");
assert.match(brandApplicationInstructions, /文字与参考图发生物理结构冲突.*文字决定设计意图.*参考图决定应用面是否存在与可落地位置/, "通用用户优先规则不得覆盖品牌应用的物理基线");
assert.match(brandApplicationInstructions, /locked\.subject.*载体类型、关键结构.*基础物理材质.*locked\.context.*展示条件.*locked\.composition.*应用面的数量.*locked\.textLayout.*逐一写明/, "品牌应用提示词未要求识别载体和应用面");
assert.match(brandApplicationInstructions, /locked\.material 只描述可变化的印刷、贴膜、压纹或表面工艺.*不得.*改写载体本体材质/, "品牌应用未区分载体材质与可探索表面工艺");
assert.match(brandApplicationInstructions, /载体识别只是生成前的固定解析步骤，不是探索变量/, "载体识别不应成为探索变量");
assert.match(brandApplicationInstructions, /当前探索使用设计风格.*品类、材质、使用场景和应用面.*视觉风格 targetOption/, "品牌应用未根据载体动态探索设计风格");
assert.match(brandApplicationInstructions, /targetOption 必须是视觉风格名称.*不得命名为载体适配、单面强化、双面协同/, "品牌应用风格方向不得退化为应用面操作");
assert.match(brandApplicationInstructions, /只有一个应用面.*完整应用当前风格.*多个应用面.*同一风格系统同步应用到全部应用面/, "品牌应用风格未覆盖单面与多面载体");
const tenStyleBrandApplicationInstructions = createBlueprintInstructions({ ...brandApplicationInput, optionCount: 10 });
assert.match(tenStyleBrandApplicationInstructions, /10 套方案必须分属 10 个不同的主风格家族/, "10 套品牌应用方向必须跨主风格家族");
assert.match(tenStyleBrandApplicationInstructions, /不得用近义词、同一家族的子风格、仅替换颜色、年代或地域修饰词来凑数量/, "动态风格不得用近义方向凑数量");
assert.match(tenStyleBrandApplicationInstructions, /视觉语言、图像媒介、字体策略、装饰语汇或表面工艺.*至少有两项明显不同/, "动态风格必须形成可感知差异");
assert.match(tenStyleBrandApplicationInstructions, /餐饮摊车、市集摊位、餐饮快闪、节庆售卖/, "优先风格必须先判断是否适配当前载体与场景");
assert.match(tenStyleBrandApplicationInstructions, /必须逐字包含.*国潮喜庆风.*高饱和街头快闪风.*萌趣插画风/, "匹配场景的 10 套探索必须保留三种已验证风格");
assert.match(tenStyleBrandApplicationInstructions, /国潮喜庆风.*不得降级为普通东方传统装饰.*高饱和街头快闪风.*不得替换成单纯街头涂鸦.*萌趣插画风.*不得替换成泛化的手绘插画/, "优先风格不得被相近大类替代");

const textOnlyBrandApplicationInput = {
  ...brandApplicationInput,
  prompt: "为白色外带咖啡杯设计品牌应用，只设计杯身正面的单一标签区域，品牌名 NORTH",
  referenceImage: "",
  referenceUsage: "analyze"
};
const textOnlyBrandApplicationInstructions = createBlueprintInstructions(textOnlyBrandApplicationInput);
assert.match(textOnlyBrandApplicationInstructions, /当前没有参考图.*仅根据用户文字识别载体和要设计的应用面/, "纯文字输入也必须识别载体和应用面");
assert.match(textOnlyBrandApplicationInstructions, /未写明的材质、视角、背景、结构细节或额外应用面保持未指定/, "纯文字输入不得补造载体细节");
assert.match(textOnlyBrandApplicationInstructions, /不得.*套用上\/下、前\/后、侧面或多面载体的默认结构/, "纯文字单面载体不得被扩展成多面结构");
assert.match(textOnlyBrandApplicationInstructions, /当前没有参考图.*只依赖用户文字.*不得假定存在图片中可补充的信息/, "纯文字输入不应依赖图片");
const brandApplicationResponse = {
  locked: {
    intent: "餐饮品牌 VI 应用样机展示",
    subject: "白底金属小吃车实体载体，上部品牌招牌与下部活动横幅",
    context: "干净白色背景的正面样机展示",
    composition: "固定正面视角、车体比例和上下两个独立应用面",
    visualLanguage: "高饱和扁平商业插画",
    palette: "蓝黄粉品牌配色",
    textLayout: "上部品牌识别，下部活动信息",
    constraints: []
  },
  variants: [
    { title: "街头手作拼贴感", targetOption: "街头手作拼贴感", changeSummary: "以撕纸、贴纸与粗粝印刷统一两个应用面", prompt: "白底小吃车品牌应用样机，保留上部品牌招牌与下部横幅两个独立应用面，在两个应用面同步使用街头手作拼贴风格。" },
    { title: "清爽市集插画感", targetOption: "清爽市集插画感", changeSummary: "以明快插画和清晰字形统一两个应用面", prompt: "白底小吃车品牌应用样机，上部品牌招牌与下部活动横幅保持独立信息分配，在两个应用面同步使用清爽市集插画风格。" }
  ]
};
const brandApplicationNormalized = normalizeBlueprintResponse(brandApplicationResponse, brandApplicationInput);
assert(brandApplicationNormalized.variants.every((variant) => variant.prompt.includes("白底小吃车")), "品牌应用最终提示词丢失实体载体");
assert(brandApplicationNormalized.variants.every((variant) => variant.prompt.includes("上部品牌招牌") && variant.prompt.includes("下部活动横幅")), "品牌应用最终提示词丢失独立应用面");
assert(brandApplicationNormalized.variants.every((variant) => variant.prompt.includes("图片1")), "品牌应用参与生图时应保留图片1作为载体参考");
assert.deepEqual(brandApplicationNormalized.exploration.selectedOptions, ["街头手作拼贴感", "清爽市集插画感"], "品牌应用必须保留模型基于载体生成的风格方向");

const partialBrandApplicationInput = { ...brandApplicationInput, optionCount: 10 };
const partialStyleDirections = [
  "国潮喜庆风",
  "高饱和街头快闪风",
  "瑞士现代网格风",
  "极简商业品牌风",
  "实验手作拼贴风",
  "复古商业印刷风",
  "民俗木刻版画风",
  "生活方式摄影风"
];
const partialBrandApplicationResponse = {
  locked: structuredClone(brandApplicationResponse.locked),
  variants: partialStyleDirections.map((targetOption) => ({
    title: targetOption,
    targetOption,
    changeSummary: `将${targetOption}同步应用到两个应用面`,
    prompt: `以图片1中的白底小吃车为载体，在上部品牌招牌和下部活动横幅同步应用${targetOption}。`
  }))
};
const partialBrandApplicationNormalized = normalizeBlueprintResponse(
  partialBrandApplicationResponse,
  partialBrandApplicationInput,
  { status: "completed", outputTokens: 7421, maxOutputTokens: 10000 }
);
assert.equal(partialBrandApplicationNormalized.variants.length, 8, "10 套请求少返时应保留 8 套有效方案");
assert.equal(partialBrandApplicationNormalized.exploration.requestedOptionCount, 10);
assert.equal(partialBrandApplicationNormalized.exploration.missingOptionCount, 2);
assert.equal(partialBrandApplicationNormalized.exploration.isPartial, true);
assert.deepEqual(partialBrandApplicationNormalized.responseDiagnostics, {
  status: "completed",
  incompleteReason: "",
  outputTokens: 7421,
  maxOutputTokens: 10000,
  returnedOptionCount: 8,
  acceptedOptionCount: 8
}, "部分返回应保存不含敏感信息的响应诊断");

const completionInput = {
  ...partialBrandApplicationInput,
  optionCount: 2,
  completionBase: {
    locked: structuredClone(partialBrandApplicationNormalized.locked),
    existingOptions: [...partialStyleDirections],
    requestedOptionCount: 10
  }
};
const completionInstructions = createBlueprintInstructions(completionInput);
assert.match(completionInstructions, /同一轮缺少方案的补齐请求.*只返回 2 套新的方案/, "补齐暗提示应只请求缺少数量");
assert.match(completionInstructions, /已有方向为：.*国潮喜庆风.*生活方式摄影风/, "补齐暗提示应携带已有方向");
assert.match(completionInstructions, /不得与已有方向重复、近义、上下位包含或属于同一个主风格家族/, "补齐方向应排除已有风格家族");
assert.match(completionInstructions, /尚未出现的优先风格为：萌趣插画风.*本次新增方向必须先补入/, "补齐请求应优先补回缺少的已验证风格");
assert.doesNotMatch(completionInstructions, /这是首轮概念探索/, "补齐请求不应被误写成新的首轮探索");
const completionResponse = {
  locked: {},
  variants: ["萌趣插画风", "未来数字霓虹风"].map((targetOption) => ({
    title: targetOption,
    targetOption,
    changeSummary: `将${targetOption}同步应用到两个应用面`,
    prompt: `以图片1中的白底小吃车为载体，在现有两个应用面同步应用${targetOption}。`
  }))
};
const completionNormalized = normalizeBlueprintResponse(completionResponse, completionInput);
assert.equal(completionNormalized.locked.subject, partialBrandApplicationNormalized.locked.subject, "补齐响应省略 locked 时应继承原载体基线");
assert.equal(completionNormalized.locked.composition, partialBrandApplicationNormalized.locked.composition, "补齐响应不得丢失原应用面关系");
assert.equal(completionNormalized.variants.length, 2);
assert.equal(completionNormalized.exploration.missingOptionCount, 0);

const shortPosterInstructions = createBlueprintInstructions({
  ...baseInput,
  contentMode: "factual",
  prompt: "为儿童乐园做一张夏季活动草坪公园里的水上乐园海报，主体是孩子们奔向乐园大门，扭头让家长快跟上。",
  dimensionId: "visual_style",
  dimensionName: "设计风格",
  dimensionDescription: "改变整体视觉语言，不改变主体、用途和信息结构",
  lockFields: ["subject", "intent", "technical", "textLayout"]
});
assert.match(shortPosterInstructions, /只补足.*少量信息|最少必要信息/, "简单原始输入的首轮补全必须保持克制");
assert.match(shortPosterInstructions, /未指定.*文案.*不.*虚构|不写虚构.*标题|不补造标题/, "未指定文案时不得虚构海报文字");
assert.match(shortPosterInstructions, /不添加.*道具.*设施|不要增加.*道具/, "首轮不得擅自增加未指定的道具和设施细节");

const conceptPosterInput = {
  ...baseInput,
  contentMode: "concept",
  prompt: "为儿童乐园做一张夏季活动海报，孩子们奔向水上乐园大门。",
  dimensionId: "visual_style",
  dimensionName: "设计风格",
  dimensionDescription: "改变整体视觉语言，不改变主体、用途和信息结构",
  lockFields: ["subject", "intent", "technical", "textLayout"]
};
const conceptPosterInstructions = createBlueprintInstructions(conceptPosterInput);
assert.match(conceptPosterInstructions, /海报方案要明确主体、传播目的、标题或信息区域/, "首次概念探索应保留线上丰富海报创作契约");
assert.doesNotMatch(conceptPosterInstructions, /内容模式：概念补全|prompt.*保持简洁|逐项列清单/, "首次概念探索不应被新增的工作流规则压缩");
assert.doesNotMatch(conceptPosterInstructions, /视觉方向提案|视觉母题|设计机制|3[—\-]5 个场景锚点/, "概念模式不应把设计方法论写入生图任务");

const waterParkSample = JSON.parse(readFileSync(new URL("./fixtures/water-park-exploration/sample-manifest.json", import.meta.url), "utf8"));
const visualStyleDimension = EXPLORATION_DIMENSIONS.find((dimension) => dimension.id === "visual_style");
assert(visualStyleDimension, "设计风格探索维度缺失");
assert.deepEqual(visualStyleDimension.defaultOptions, waterParkSample.styles.map((style) => style.option), "六张样本图的风格选项必须保持固定顺序");
assert(visualStyleDimension.lockFields.includes("composition"), "设计风格探索必须锁住叙事构图关系");
assert.deepEqual(Object.keys(getExplorationGuidance(visualStyleDimension, ["未来科技感", "复古印刷感"])), ["未来科技感"], "只有有样本语义的探索目标才应携带 guidance");
waterParkSample.styles.forEach((style) => {
  assert(existsSync(new URL(`./fixtures/water-park-exploration/${style.image}`, import.meta.url)), `探索样本图片缺失：${style.image}`);
});
const futureTechSample = waterParkSample.styleAnchors["未来科技感"];
assert(existsSync(new URL(`./fixtures/water-park-exploration/${futureTechSample.referenceImage}`, import.meta.url)), "未来科技原始样本图片缺失");
assert(existsSync(new URL(`./fixtures/water-park-exploration/${futureTechSample.adjustedImage}`, import.meta.url)), "未来科技偏离样本图片缺失");
const waterParkInput = {
  ...conceptPosterInput,
  prompt: waterParkSample.sourcePrompt,
  dimensionDescription: visualStyleDimension.description,
  lockFields: visualStyleDimension.lockFields,
  explorationOptions: waterParkSample.styles.map((style) => style.option),
  optionCount: waterParkSample.styles.length,
  explorationGuidance: getExplorationGuidance(visualStyleDimension, waterParkSample.styles.map((style) => style.option))
};
const waterParkInstructions = createBlueprintInstructions(waterParkInput);
assert.match(waterParkInstructions, /动作.*目的地.*互动对象/, "海报探索必须保留动作、目的地和互动对象关系");
assert.match(waterParkInstructions, /不能.*静态摆拍|不得.*静态摆拍/, "海报探索不得把行动叙事改成静态摆拍");
futureTechSample.mustInclude.forEach((anchor) => {
  assert(waterParkInstructions.includes(anchor), `未来科技样本语义缺失：${anchor}`);
});
futureTechSample.avoid.forEach((anchor) => {
  assert(waterParkInstructions.includes(anchor), `未来科技样本的反向约束缺失：${anchor}`);
});
const waterParkResponse = {
  locked: {
    intent: "儿童乐园夏季活动宣传",
    subject: waterParkSample.mustPreserve[0].text + "，" + waterParkSample.mustPreserve[1].text,
    composition: waterParkSample.mustPreserve[2].text,
    textLayout: waterParkSample.mustPreserve[3].text,
    constraints: []
  },
  variants: waterParkSample.styles.map((style) => ({
    title: "模型方案名",
    targetOption: style.option,
    changeSummary: `只改变${style.option}`,
    prompt: `儿童乐园夏季活动海报，${style.option}。`
  }))
};
const waterParkNormalized = normalizeBlueprintResponse(waterParkResponse, waterParkInput);
waterParkNormalized.variants.forEach((variant) => {
  waterParkSample.mustPreserve.forEach((anchor) => {
    assert(variant.prompt.includes(anchor.text), `${variant.title}丢失不可变叙事锚点：${anchor.id}`);
  });
});

const onlineBaselinePrompt = readFileSync(new URL("./fixtures/online-baseline-prompt.txt", import.meta.url), "utf8").trim();
const onlineBaselineInput = {
  ...waterParkInput,
  prompt: waterParkSample.sourcePrompt,
  ratio: "9:16",
  explorationOptions: ["未来科技感"],
  optionCount: 1,
  explorationGuidance: getExplorationGuidance(visualStyleDimension, ["未来科技感"])
};
const onlineBaselineResponse = {
  locked: {
    intent: "儿童乐园夏季活动宣传海报",
    subject: waterParkSample.mustPreserve[0].text + "，" + waterParkSample.mustPreserve[1].text,
    composition: "主体人物与门头居中，前景家长回应，中景孩子奔跑，背景水上乐园大门作为目的地",
    textLayout: waterParkSample.mustPreserve[3].text,
    constraints: ["儿童乐园夏季活动海报", "用途为儿童乐园宣传"]
  },
  variants: [{
    title: "未来科技感",
    targetOption: "未来科技感",
    changeSummary: "用未来科技视觉语言表达夏季水世界",
    prompt: onlineBaselinePrompt
  }]
};
const onlineBaselineNormalized = normalizeBlueprintResponse(onlineBaselineResponse, onlineBaselineInput);
assert(onlineBaselineNormalized.variants[0].prompt.startsWith(onlineBaselinePrompt), "线上完整视觉段落不能被本地后处理改写");
assert.match(onlineBaselineNormalized.variants[0].prompt, /视觉方向：未来科技感/);
assert.match(onlineBaselineNormalized.variants[0].prompt, /必须保留：\n主体与关键特征：/, "必须保留区应有明确的第一层标题和字段层级");
assert.match(onlineBaselineNormalized.variants[0].prompt, /\n用途与目标：/);
assert.match(onlineBaselineNormalized.variants[0].prompt, /\n技术规格：/);
assert.match(onlineBaselineNormalized.variants[0].prompt, /\n文字与信息组织：/);
assert.match(onlineBaselineNormalized.variants[0].prompt, /\n必须遵守的限制：/);
assert.match(onlineBaselineNormalized.variants[0].prompt, /画幅比例：9:16/);

const response = {
  locked: {
    intent: "咖啡品牌夏日开业传播",
    subject: "一杯冰拿铁",
    context: "明亮夏日咖啡店",
    audience: "年轻城市消费者",
    composition: "主体居中",
    visualLanguage: "清爽现代",
    palette: "冰蓝与暖橙",
    lighting: "自然侧光",
    material: "玻璃与冰块",
    textLayout: "保留标题区",
    constraints: ["保留品牌名 NORTH", "保留指定文案 SUMMER OPENING"]
  },
  variants: [
    {
      title: "左右分栏方向",
      targetOption: "左右分栏",
      changeSummary: "主体与文字左右分栏",
      prompt: "参考图中的冰拿铁，左右分栏，16:9，品牌 NORTH，文案 SUMMER OPENING"
    },
    {
      title: "杂志网格方向",
      targetOption: "杂志网格",
      changeSummary: "使用清晰的杂志网格",
      prompt: "一杯冰拿铁，杂志网格，16:9，品牌 NORTH，文案 SUMMER OPENING"
    }
  ]
};

assert.throws(
  () => normalizeBlueprintResponse(response, baseInput),
  /依赖参考图/
);

const standaloneResponse = structuredClone(response);
standaloneResponse.variants[0].prompt = "一杯冰拿铁，左右分栏，16:9，品牌 NORTH，文案 SUMMER OPENING";
const normalized = normalizeBlueprintResponse(standaloneResponse, baseInput);
assert.deepEqual(normalized.variants.map((variant) => variant.explorationOption), ["杂志网格", "左右分栏"]);
assert.deepEqual(normalized.variants.map((variant) => variant.title), ["杂志网格", "左右分栏"], "方案卡片标题必须使用固定探索项，不能让模型重新命名风格");
assert.equal(normalized.source.referenceUsage, "analyze");
assert(normalized.variants.every((variant) => variant.prompt.includes("3:4")), "最终提示词必须使用 UI 画幅比例");
assert(normalized.variants.every((variant) => !variant.prompt.includes("16:9")), "最终提示词不得保留冲突比例");
assert(normalized.variants.every((variant) => !/参考图|如图|原图/.test(variant.prompt)), "分析模式提示词必须自包含");
assert(normalized.variants.every((variant) => !variant.prompt.includes("本轮必须")), "最终提示词不应包含工作流元话术");
assert.deepEqual(Object.keys(normalized.variants[0].lockedSnapshot).sort(), ["constraints", "subject", "technical", "visualLanguage"]);
assert(normalized.variants.every((variant) => variant.prompt.includes("必须遵守的限制")), "所有探索维度都必须保留固定限制");
assert(normalized.variants.every((variant) => variant.prompt.includes("保留品牌名 NORTH")), "最终提示词不得丢失品牌与指定文案限制");
assert(normalized.variants.every((variant) => !/视觉方向提案|视觉母题|设计机制|主体动作与空间动线优先/.test(variant.prompt)), "最终生图提示词不应包含设计方法论元话术");
assert.equal(normalized.variants[0].blueprintSnapshot.source.prompt, baseInput.prompt, "方案快照必须保留最初原始提示词");
assert.equal(normalized.variants[0].blueprintSnapshot.source.contentMode, "concept", "方案快照缺少内容模式");
assert.equal(normalized.variants[0].blueprintSnapshot.dimensions.layout_style, "杂志网格", "方案快照必须记录本轮变量选择");
assert.equal(normalized.variants[0].blueprintSnapshot.acceptedPrompt, normalized.variants[0].prompt, "方案快照必须保留首轮已确认的丰富提示词基线");

const dependentLockedResponse = structuredClone(standaloneResponse);
dependentLockedResponse.locked.visualLanguage = "沿用参考图中的清爽现代风格";
assert.throws(
  () => normalizeBlueprintResponse(dependentLockedResponse, baseInput),
  /仍依赖参考图/,
  "分析模式必须校验渲染后的完整提示词，而不只检查模型返回的 prompt 字段"
);

const implicitImageReferenceResponse = structuredClone(standaloneResponse);
implicitImageReferenceResponse.variants[0].prompt = "保留图片里的冰拿铁主体，使用左右分栏";
assert.throws(
  () => normalizeBlueprintResponse(implicitImageReferenceResponse, baseInput),
  /仍依赖参考图/,
  "分析模式不能漏过图片里、该图等隐式悬空指代"
);

const conflictingConstraintResponse = structuredClone(standaloneResponse);
conflictingConstraintResponse.locked.constraints.push("禁止使用 16:9 画幅");
assert.throws(
  () => normalizeBlueprintResponse(conflictingConstraintResponse, baseInput),
  /画幅比例/,
  "固定限制中的其他比例不得与 UI 权威比例同时进入最终提示词"
);

const timeTextResponse = structuredClone(standaloneResponse);
timeTextResponse.variants[0].prompt = "活动时间 10:30，一杯冰拿铁，左右分栏，16:9，品牌 NORTH";
const normalizedTimeText = normalizeBlueprintResponse(timeTextResponse, baseInput);
assert(normalizedTimeText.variants[1].prompt.includes("10:30"), "活动时间不能被画幅比例覆盖逻辑误改");
assert(normalizedTimeText.variants[1].prompt.includes("3:4"), "提示词中的官方旧画幅仍应被 UI 比例覆盖");

const internalRatioResponse = structuredClone(standaloneResponse);
internalRatioResponse.variants[0].prompt = "主体与标题面积比例 2:3，一杯冰拿铁，左右分栏，16:9，品牌 NORTH";
const normalizedInternalRatio = normalizeBlueprintResponse(internalRatioResponse, baseInput);
assert(normalizedInternalRatio.variants[1].prompt.includes("面积比例 2:3"), "画面内部面积比例不能被当作输出画幅改写");
assert(normalizedInternalRatio.variants[1].prompt.includes("画幅比例：3:4"), "输出画幅仍应以 UI 比例为准");

const missingRequiredResponse = structuredClone(standaloneResponse);
missingRequiredResponse.locked.intent = "";
missingRequiredResponse.locked.subject = "";
assert.throws(
  () => normalizeBlueprintResponse(missingRequiredResponse, baseInput),
  /必填字段/,
  "缺失任务必填字段时不得用整段原始提示词兜底"
);

const materialReferenceResponse = structuredClone(standaloneResponse);
materialReferenceResponse.variants[0].prompt = "参照该素材的构图，使用左右分栏，品牌 NORTH";
assert.throws(
  () => normalizeBlueprintResponse(materialReferenceResponse, baseInput),
  /仍依赖参考图/,
  "分析模式不能保留该素材等隐式图片指代"
);

const pronounReferenceResponse = structuredClone(standaloneResponse);
pronounReferenceResponse.variants[0].prompt = "延续其配色与主体特征，使用左右分栏，品牌 NORTH";
assert.throws(
  () => normalizeBlueprintResponse(pronounReferenceResponse, baseInput),
  /仍依赖参考图/,
  "分析模式不能保留没有明确先行词的代词型参考"
);

const explicitAntecedentPronounResponse = structuredClone(standaloneResponse);
explicitAntecedentPronounResponse.variants[0].prompt = "主体是一杯透明冰拿铁，延续其暖棕配色，使用左右分栏，品牌 NORTH";
assert.throws(
  () => normalizeBlueprintResponse(explicitAntecedentPronounResponse, baseInput),
  /仍依赖参考图/,
  "KISS 契约要求分析模式直接重复主体名称，不保留其、它、其中等代词"
);

for (const prompt of [
  "主体是一杯透明冰拿铁，它的杯身材质通透，使用左右分栏，品牌 NORTH",
  "主体是一杯透明冰拿铁，其中的冰块细节清晰，使用左右分栏，品牌 NORTH"
]) {
  const responseWithPronoun = structuredClone(standaloneResponse);
  responseWithPronoun.variants[0].prompt = prompt;
  assert.throws(
    () => normalizeBlueprintResponse(responseWithPronoun, baseInput),
    /仍依赖参考图/,
    "分析模式必须统一拒绝它、其中等图片承接代词"
  );
}

const embeddedMediaRatioResponse = structuredClone(standaloneResponse);
embeddedMediaRatioResponse.variants[0].prompt = "一杯冰拿铁，页面内嵌一个 16:9 视频卡片，使用左右分栏，品牌 NORTH，输出画幅 16:9";
const normalizedEmbeddedMediaRatio = normalizeBlueprintResponse(embeddedMediaRatioResponse, baseInput);
assert(normalizedEmbeddedMediaRatio.variants[1].prompt.includes("16:9 视频卡片"), "内嵌视频卡片的比例必须保持原样");
assert(!normalizedEmbeddedMediaRatio.variants[1].prompt.includes("输出画幅 16:9"), "明确的旧输出画幅必须被 UI 比例覆盖");
assert(normalizedEmbeddedMediaRatio.variants[1].prompt.includes("输出画幅 3:4"), "明确输出画幅应使用 UI 权威比例");

const colorInput = {
  ...baseInput,
  dimensionId: "color_style",
  dimensionName: "色彩风格",
  dimensionDescription: "改变色彩系统和情绪，不改变主体与构图",
  lockFields: ["subject", "composition", "textLayout", "technical"],
  explorationOptions: ["高对比黑白", "柔和粉彩"]
};
const colorConstraintResponse = structuredClone(standaloneResponse);
colorConstraintResponse.locked.constraints = ["品牌名 NORTH 必须保留", "必须保持暖橙色配色"];
colorConstraintResponse.variants = [
  { title: "黑白", targetOption: "高对比黑白", changeSummary: "使用高对比黑白", prompt: "品牌 NORTH，一杯冰拿铁，高对比黑白" },
  { title: "粉彩", targetOption: "柔和粉彩", changeSummary: "使用柔和粉彩", prompt: "品牌 NORTH，一杯冰拿铁，柔和粉彩" }
];
assert.throws(
  () => normalizeBlueprintResponse(colorConstraintResponse, colorInput),
  /固定限制.*探索维度/,
  "固定限制不得重新锁死当前探索维度"
);

const missingPrompt = structuredClone(standaloneResponse);
missingPrompt.variants[0].prompt = "";
assert.throws(() => normalizeBlueprintResponse(missingPrompt, baseInput), /完整提示词/);

const duplicatePrompt = structuredClone(standaloneResponse);
duplicatePrompt.variants[1].prompt = duplicatePrompt.variants[0].prompt;
assert.throws(() => normalizeBlueprintResponse(duplicatePrompt, baseInput), /提示词重复/);

const duplicateTarget = structuredClone(standaloneResponse);
duplicateTarget.variants[1].targetOption = duplicateTarget.variants[0].targetOption;
assert.throws(() => normalizeBlueprintResponse(duplicateTarget, baseInput), /探索目标/);

const exploreInput = { ...baseInput, referenceUsage: "explore" };
const exploreResponse = structuredClone(standaloneResponse);
exploreResponse.variants[0].prompt = "以图片1为基础，左右分栏，保留冰拿铁主体";
exploreResponse.variants[1].prompt = "以图片1为基础，杂志网格，保留冰拿铁主体";
const exploreNormalized = normalizeBlueprintResponse(exploreResponse, exploreInput);
assert(exploreNormalized.variants.every((variant) => variant.prompt.includes("图片1")), "参与探索模式必须明确引用图片1");
assert(exploreNormalized.variants.every((variant) => variant.prompt.includes("构图安全要求") && variant.prompt.includes("不得被裁切或贴边")), "参与探索模式必须要求主体完整落在安全区内");

const refinementInput = {
  ...baseInput,
  prompt: baseInput.prompt,
  dimensionId: "composition",
  dimensionName: "构图与镜头",
  dimensionDescription: "改变主体距离、视角、空间轴线和镜头关系",
  lockFields: ["subject", "visualLanguage", "technical"],
  explorationOptions: ["低机位仰视", "广角环境构图"],
  refinementBase: normalized.variants[0].blueprintSnapshot
};
const refinementInstructions = createBlueprintInstructions(refinementInput);
assert.match(refinementInstructions, /已确认的视觉基线|细化基线/, "细化请求必须明确使用既有视觉基线");
assert.match(refinementInstructions, /不得把上一轮.*提示词.*追加|完整重写/, "细化请求必须禁止提示词套接");

const generatedResultRefinementInstructions = createBlueprintInstructions({
  ...refinementInput,
  referenceSource: "generated-result"
});
assert.match(generatedResultRefinementInstructions, /上一轮已经生成的结果|图片1实际可见/, "基于生成结果细化必须要求模型分析图片1的实际视觉状态");
const refinementResponse = structuredClone(standaloneResponse);
refinementResponse.variants = refinementInput.explorationOptions.map((targetOption, index) => ({
  title: `细化方向${index + 1}`,
  targetOption,
  changeSummary: `将构图与镜头调整为${targetOption}`,
  prompt: `一杯冰拿铁，保留已确认的品牌与夏日开业信息，${targetOption}`
}));
const refined = normalizeBlueprintResponse(refinementResponse, refinementInput);
assert.equal(refined.variants[0].blueprintSnapshot.source.prompt, baseInput.prompt, "多轮细化不能把上一轮最终提示词当成原始输入");
assert.equal(refined.variants[0].blueprintSnapshot.dimensions.layout_style, "杂志网格", "多轮细化必须继承上一轮变量");
assert.equal(refined.variants[0].blueprintSnapshot.dimensions.composition, "低机位仰视", "多轮细化必须记录当前变量");
assert.match(refined.variants[0].blueprintSnapshot.acceptedPrompt, /低机位仰视/, "细化方案必须保存当前轮已确认提示词");
assert(refined.variants[0].prompt.includes("清爽现代"), "细化提示词必须保留上一轮已确认的视觉语言");
const changedReferenceUsage = normalizeBlueprintResponse(refinementResponse, { ...refinementInput, referenceUsage: "explore" });
assert.equal(changedReferenceUsage.variants[0].blueprintSnapshot.source.referenceUsage, "explore", "细化时用户当前选择的参考图用法必须覆盖旧快照");

assert.equal(getBlueprintMaxOutputTokens(2), 2400);
assert.equal(getBlueprintMaxOutputTokens(6), 6000);
assert.equal(getBlueprintMaxOutputTokens(8), 8000);
assert.equal(getBlueprintMaxOutputTokens(10), 10000);
assert.equal(getBlueprintMaxOutputTokens(12), 10000);

console.log("prompt renderer test passed");
