/**
 * PromptBlueprint domain registry.
 * The UI should read these registries instead of hard-coding task types or dimensions.
 */

export const CONTENT_MODES = [
  {
    id: "concept",
    name: "概念补全",
    description: "允许合理补足概念内容；角色参考图可推断画面外的身体、服装与场景"
  },
  {
    id: "factual",
    name: "事实保守",
    description: "只使用已提供或可见内容；角色参考图默认不补造画面外的身体与服装"
  }
];

export const TASK_TYPES = [
  {
    id: "poster",
    name: "海报",
    description: "活动、品牌或传播用途的视觉海报",
    defaultRatio: "3:4",
    requiredFields: ["intent", "subject", "technical"],
    supportedDimensionIds: [
      "visual_style",
      "character_style",
      "color_style",
      "layout_style",
      "composition",
      "material",
      "information_density",
      "brand_tone"
    ],
    promptProfile: "poster"
  },
  {
    id: "event_visual",
    name: "活动主视觉 / 线下物料",
    description: "市集、快闪、节庆、展位、横幅和导视等成套线下活动视觉",
    defaultRatio: "21:9",
    requiredFields: ["intent", "subject", "context", "technical"],
    supportedDimensionIds: [
      "visual_style",
      "character_style",
      "color_style",
      "layout_style",
      "composition",
      "material",
      "information_density",
      "brand_tone"
    ],
    promptProfile: "event-visual"
  },
  {
    id: "brand_application",
    name: "品牌应用 / VI 展示",
    description: "将品牌识别系统应用到摊车、包装、空间和实体载体的样机展示",
    defaultRatio: "3:2",
    requiredFields: ["intent", "subject", "context", "composition", "textLayout", "technical"],
    baselineLockFields: ["subject", "intent", "context", "composition", "textLayout", "technical"],
    supportedDimensionIds: [
      "application_visual_style",
      "color_style",
      "layout_style",
      "material",
      "information_density",
      "brand_tone"
    ],
    promptProfile: "brand-application"
  },
  {
    id: "landing_page",
    name: "Landing Page",
    description: "品牌、产品或活动的页面视觉方向板",
    defaultRatio: "16:9",
    requiredFields: ["intent", "audience", "subject"],
    supportedDimensionIds: [
      "visual_style",
      "color_style",
      "layout_style",
      "composition",
      "information_density",
      "brand_tone"
    ],
    promptProfile: "landing-page"
  },
  {
    id: "dashboard",
    name: "Dashboard 方向板",
    description: "B 端数据产品的界面风格与信息层级方向板",
    defaultRatio: "16:9",
    requiredFields: ["intent", "audience"],
    supportedDimensionIds: [
      "visual_style",
      "color_style",
      "layout_style",
      "information_density",
      "data_hierarchy",
      "brand_tone"
    ],
    promptProfile: "dashboard"
  },
  {
    id: "character_ip",
    name: "卡通 / IP 形象",
    description: "角色、吉祥物或个人 IP 的视觉方向板",
    defaultRatio: "3:4",
    requiredFields: ["intent", "subject"],
    supportedDimensionIds: [
      "character_style",
      "color_style",
      "composition",
      "material",
      "character_proportion",
      "brand_tone"
    ],
    promptProfile: "character-ip"
  }
];

export const EXPLORATION_DIMENSIONS = [
  {
    id: "application_visual_style",
    name: "设计风格",
    description: "先识别载体与可设计应用面，再探索适合该载体的整套品牌视觉风格；不改变载体结构、背景、视角、应用面数量与信息分配",
    applicableTaskTypeIds: ["brand_application"],
    defaultOptions: [],
    dynamicOptions: true,
    optionCounts: [2, 3, 4, 5, 6, 8, 10],
    lockFields: ["subject", "intent", "context", "composition", "textLayout", "technical"]
  },
  {
    id: "visual_style",
    name: "设计风格",
    description: "改变整体视觉语言，不改变主体动作、目的地、互动关系、构图与信息结构",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard"],
    dynamicOptions: true,
    optionCounts: [2, 3, 4, 5, 6, 8, 10],
    defaultOptions: ["极简编辑感", "复古印刷感", "未来科技感", "生活方式摄影感", "瑞士网格感", "实验拼贴感"],
    lockFields: ["subject", "intent", "composition", "technical", "textLayout"],
    optionGuidance: {
      "未来科技感": "参考未来科技样本的视觉语义：深蓝至蓝紫夜景，青紫霓虹光轨与高亮边缘，发光轮廓、半透明能量面板、流动光带、微粒水雾、霓虹青蓝与紫色渐变；巨型中心对称未来水上乐园入口或传送门作为主视觉，玻璃与金属硬表面、全息 UI 面板、发光图标和商业主视觉级高对比；避免退化为白天自然摄影、普通透明水滑道或仅叠加少量青色 HUD。"
    }
  },
  {
    id: "character_style",
    name: "卡通 / 角色风格",
    description: "改变角色的绘制媒介、轮廓简化、五官概括、体块塑造和材质表达；允许为目标风格进行必要的适度造型夸张，但保留可识别身份锚点、服装类别、主色与基本姿态",
    applicableTaskTypeIds: ["poster", "event_visual", "character_ip"],
    dynamicOptions: true,
    optionCounts: [2, 3, 4, 5, 6, 8, 10],
    defaultOptions: ["Q版卡通 2D", "Q版表情包 IP", "软胶潮玩 3D", "扁平知识漫画", "手帐贴纸角色", "温柔绘本角色"],
    lockFields: ["subject", "composition", "technical"],
    optionGuidance: {
      "Q版卡通 2D": "面向内容创作的通用 Q 版角色，使用 3 至 4 头身、圆润大头、清晰深色描边、干净的低饱和平涂色块与少量高光；五官友好可读、全身轮廓简洁，适合继续扩展日常场景和封面配图。不得保留写实人体比例、摄影皮肤或复杂照片纹理。",
      "Q版表情包 IP": "面向社媒表情和口播封面的 Q 版 IP，使用更夸张的大头小身、清楚的眉眼嘴型、明显腮红或汗滴等情绪符号、粗轮廓和高识别剪影；角色必须留出丰富表情空间，适合后续批量制作表情包与互动贴图。不得生成写实肖像、低表情的普通卡通人物或复杂背景。",
      "软胶潮玩 3D": "转化为可收藏的软胶潮玩角色，使用圆润大头、小巧身体、概括五官与手脚、柔和棚拍光和轻微磨砂乙烯基质感；造型要像独立摆件，适合小红书封面主视觉和立体场景。不得退化为真人比例数字人、写实 CG 肤质或普通证件照。",
      "扁平知识漫画": "使用教程和知识文章常见的扁平漫画人物语言：较粗深色描边、清晰外轮廓、有限色板、概括五官和可读手势，保留适合与标题、箭头、步骤卡片并置的干净留白；角色应像信息图中的讲解者，而不是写实插画或复杂场景海报。",
      "手帐贴纸角色": "使用小红书笔记常见的手帐贴纸角色语言：圆润白边贴纸轮廓、简洁扁平填色、轻微纸感、可搭配星星、对话框或重点标记的留白，整体亲和轻松；角色需独立清楚，适合封面、清单和步骤页配图。不得画成真实摄影、厚重 3D 或信息过密的完整海报。",
      "温柔绘本角色": "使用适合生活方式文章与教程封面的温柔绘本人物语言：低饱和暖色、柔和笔触、轻纸张纹理、简化五官和衣褶、安静留白；角色表情自然亲和，适合作为文章页首或叙事配图。不得生成写实照片、强硬矢量商务插画或高反光 3D 公仔。",
      "2D 扁平插画": "使用清晰概括的外轮廓、有限层级的大色块、平涂或极少量硬边阴影，主动简化五官、头发、衣褶与鞋面细节；成品必须一眼可见为完整的 2D 插画，不得保留摄影皮肤、布料写实纹理、镜头光影或仅做照片描边与磨皮。",
      "3D 潮玩": "转化为可收藏的设计师潮玩造型，适度头大身小，五官与手脚概括，体块圆润清楚，使用乙烯基、树脂或塑胶玩具质感和棚拍式产品光；不得退化为正常真人比例的写实 3D 数字人或普通人像渲染。",
      "黏土软质感": "使用手工捏塑般的柔软圆润轮廓、哑光黏土表面、轻微手作痕迹与柔和漫反射，五官、发型和服装褶皱都转化为可见的黏土体块；不得保留真人皮肤、真实布料或光滑写实 CG 人像质感。",
      "绘本卡通": "使用可见的手绘笔触、纸张肌理、概括轮廓和温和色块，简化五官、头发与服装细节，以绘本人物的造型逻辑重画完整角色；不得生成写实照片、照片级数码肖像或只叠加轻微纸纹滤镜。",
      "几何吉祥物": "把身份特征提炼为可识别的几何符号与模块化体块，使用强轮廓、大形状、简化面部和统一图形语言，允许明显重构人体细节但保留发型、服装类别与主色锚点；不得保留写实人体解剖、照片纹理或普通商务人像观感。",
      "手绘线稿": "使用有粗细变化和手作节奏的明确线条、克制填色与纸面质感，以线条重新组织五官、发型、衣褶和肢体轮廓；不得把照片直接灰度化、边缘检测化，或保留照片级明暗与皮肤纹理。"
    }
  },
  {
    id: "color_style",
    name: "色彩风格",
    description: "改变色彩系统和情绪，不改变主体与构图",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard", "character_ip", "brand_application"],
    defaultOptions: ["低饱和奶油色", "高对比黑白", "暖橙蓝", "冷色霓虹", "单色品牌色", "柔和粉彩"],
    lockFields: ["subject", "composition", "textLayout", "technical"]
  },
  {
    id: "layout_style",
    name: "版式风格",
    description: "改变信息和主体的页面组织方式",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard", "brand_application"],
    defaultOptions: ["大标题单主体", "杂志网格", "左右分栏", "卡片化布局", "非对称斜向", "居中对称"],
    lockFields: ["subject", "visualLanguage", "technical"]
  },
  {
    id: "composition",
    name: "构图与镜头",
    description: "改变主体距离、视角、空间轴线和镜头关系",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "character_ip"],
    defaultOptions: ["主体特写", "平视中景", "俯视构图", "开放式偏轴", "低机位仰视", "广角环境构图"],
    lockFields: ["subject", "visualLanguage", "technical"]
  },
  {
    id: "material",
    name: "材质与质感",
    description: "改变表面、渲染和触感表达",
    applicableTaskTypeIds: ["poster", "event_visual", "character_ip", "brand_application"],
    defaultOptions: ["纸张印刷", "金属玻璃", "毛绒软质", "胶片颗粒", "半透明果冻", "陶瓷黏土"],
    lockFields: ["subject", "composition", "technical"]
  },
  {
    id: "information_density",
    name: "信息密度",
    description: "改变画面或界面的信息量与留白关系",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard", "brand_application"],
    defaultOptions: ["极简留白", "平衡信息", "高密度信息", "模块化分区", "大字报聚焦", "目录式标注"],
    lockFields: ["subject", "palette", "technical"]
  },
  {
    id: "brand_tone",
    name: "品牌气质",
    description: "改变品牌表达的性格和情绪",
    applicableTaskTypeIds: ["poster", "event_visual", "landing_page", "dashboard", "character_ip", "brand_application"],
    defaultOptions: ["高端克制", "亲和轻松", "专业理性", "年轻潮流", "先锋实验", "自然温暖"],
    lockFields: ["subject", "technical"]
  },
  {
    id: "data_hierarchy",
    name: "数据层级",
    description: "改变 Dashboard 中关键指标、趋势和明细的视觉优先级",
    applicableTaskTypeIds: ["dashboard"],
    defaultOptions: ["核心指标优先", "趋势分析优先", "异常监控优先", "明细操作优先", "全局决策优先", "任务流程优先"],
    lockFields: ["subject", "palette", "technical"]
  },
  {
    id: "character_proportion",
    name: "角色比例",
    description: "改变角色头身、五官和年龄感关系",
    applicableTaskTypeIds: ["character_ip"],
    defaultOptions: ["2 头身", "3 头身", "5 头身", "7 头身", "大头萌系", "修长时装比例"],
    lockFields: ["subject", "visualLanguage", "composition", "technical"]
  }
];

export function getExplorationGuidance(dimension, options = []) {
  const guidance = dimension?.optionGuidance || {};
  return Object.fromEntries(options
    .map((option) => [option, typeof guidance[option] === "string" ? guidance[option].trim() : ""])
    .filter(([, value]) => value));
}

export function createEmptyPromptBlueprint() {
  return {
    schemaVersion: 1,
    source: {
      prompt: "",
      referenceImages: [],
      referenceRole: "analysis-only",
      referenceUsage: "analyze",
      contentMode: "concept"
    },
    taskTypeId: "poster",
    locked: {
      intent: "",
      subject: "",
      context: "",
      audience: "",
      composition: "",
      visualLanguage: "",
      palette: "",
      lighting: "",
      material: "",
      textLayout: "",
      technical: { ratio: "3:4" },
      constraints: []
    },
    dimensions: {},
    exploration: {
      dimensionIds: [],
      optionCount: 3,
      selectedOptions: []
    },
    variants: []
  };
}
