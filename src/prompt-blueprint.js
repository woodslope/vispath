/**
 * PromptBlueprint domain registry.
 * The UI should read these registries instead of hard-coding task types or dimensions.
 */

export const CONTENT_MODES = [
  {
    id: "concept",
    name: "概念补全",
    description: "AI 补足少量概念文案和信息区域，保留创作空间"
  },
  {
    id: "factual",
    name: "事实保守",
    description: "只使用用户提供的内容，不补造标题、日期、地点或品牌"
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
    defaultOptions: ["极简编辑感", "复古印刷感", "未来科技感", "生活方式摄影感", "瑞士网格感", "实验拼贴感"],
    lockFields: ["subject", "intent", "composition", "technical", "textLayout"],
    optionGuidance: {
      "未来科技感": "参考未来科技样本的视觉语义：深蓝至蓝紫夜景，青紫霓虹光轨与高亮边缘，发光轮廓、半透明能量面板、流动光带、微粒水雾、霓虹青蓝与紫色渐变；巨型中心对称未来水上乐园入口或传送门作为主视觉，玻璃与金属硬表面、全息 UI 面板、发光图标和商业主视觉级高对比；避免退化为白天自然摄影、普通透明水滑道或仅叠加少量青色 HUD。"
    }
  },
  {
    id: "character_style",
    name: "卡通 / 角色风格",
    description: "改变角色的绘制、渲染或卡通表达方式",
    applicableTaskTypeIds: ["poster", "event_visual", "character_ip"],
    defaultOptions: ["2D 扁平插画", "3D 潮玩", "黏土软质感", "绘本卡通", "几何吉祥物", "手绘线稿"],
    lockFields: ["subject", "composition", "technical"]
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
