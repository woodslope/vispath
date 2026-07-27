import { readFile } from "node:fs/promises";

const files = {
  agents: new URL("../AGENTS.md", import.meta.url),
  app: new URL("../app.js", import.meta.url),
  designSystem: new URL("../DESIGN_SYSTEM.md", import.meta.url),
  html: new URL("../index.html", import.meta.url),
  styleGuide: new URL("../UI_STYLE_GUIDE.md", import.meta.url),
  styles: new URL("../styles.css", import.meta.url)
};

const [agents, app, designSystem, html, styleGuide, styles] = await Promise.all(
  Object.values(files).map((file) => readFile(file, "utf8"))
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readHexToken(token) {
  const value = styles.match(new RegExp(`${token}:\\s*(#[0-9a-f]{6});`, "i"))?.[1];
  assert(value, `无法读取颜色 Token：${token}`);
  return value;
}

function relativeLuminance(hex) {
  const channels = hex.slice(1).match(/.{2}/g).map((value) => parseInt(value, 16) / 255);
  const [red, green, blue] = channels.map((value) => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return .2126 * red + .7152 * green + .0722 * blue;
}

function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  return (Math.max(first, second) + .05) / (Math.min(first, second) + .05);
}

const requiredTokens = new Map([
  ["--space-1", "8px"],
  ["--space-2", "12px"],
  ["--space-3", "16px"],
  ["--space-4", "24px"],
  ["--control-height", "32px"],
  ["--icon-button-size", "32px"],
  ["--icon-size", "16px"],
  ["--result-card-min-width", "260px"],
  ["--result-grid-columns", "3"],
  ["--result-thumbnail-height", "180px"],
  ["--success", "#0d8050"],
  ["--danger", "#9f3522"],
  ["--warning", "#8b610b"],
  ["--panel", "#f2f5ef"],
  ["--selected-paper", "#fffaf7"]
]);

for (const [token, value] of requiredTokens) {
  assert(styles.includes(`${token}: ${value};`), `缺少设计 Token：${token}: ${value}`);
  assert(designSystem.includes(token), `DESIGN_SYSTEM.md 未记录 Token：${token}`);
}

for (const token of ["--accent", "--accent-hover", "--accent-active"]) {
  const ratio = contrastRatio("#ffffff", readHexToken(token));
  assert(ratio >= 4.5, `${token} 上的白色主按钮文字对比度仅 ${ratio.toFixed(2)}:1，低于 4.5:1`);
}
assert(designSystem.includes("default、hover、active 三态均须达到至少 `4.5:1`"), "DESIGN_SYSTEM.md 未记录主按钮三态对比度合同");

for (const value of ["#c84725", "#b83d20", "#a9341a", "#9f3522", "#812817", "#d7a398", "#fff0ec", "#b68016", "#8b610b", "#fff5d9"]) {
  assert(styles.split(value).length - 1 === 1, `语义颜色未完全收口到 Token：${value}`);
}

for (const section of ["## 3. 基础 Token", "## 5. 组件目录", "## 7. 状态矩阵", "## 10. 验收合同"]) {
  assert(designSystem.includes(section), `DESIGN_SYSTEM.md 缺少章节：${section}`);
}

for (const component of [".button-danger", ".select-control", ".generation-card", ".image-preview-dialog", ".toast"]) {
  assert(designSystem.includes(component), `DESIGN_SYSTEM.md 未登记组件族：${component}`);
}

assert(designSystem.includes(".choice-option"), "DESIGN_SYSTEM.md 未登记共享选择卡组件族");
assert((html.match(/class="choice-option reference-usage-option"/g) || []).length === 2, "参考图用途未消费共享选择卡实现");
assert(app.includes('class="choice-option content-mode-option"'), "内容模式未消费共享选择卡实现");
for (const state of [".choice-option:hover", ".choice-option:active", ".choice-option:has(input:checked)", ".choice-option:has(input:focus-visible)", ".choice-option:has(input:disabled)"]) {
  assert(styles.includes(state), `共享选择卡缺少状态：${state}`);
}

const dialogCloseRule = styles.match(/\.dialog-close\s*\{[^}]+\}/)?.[0] || "";
assert(dialogCloseRule.includes("border-color: var(--line-strong)"), "弹窗关闭按钮缺少默认描边");
assert(dialogCloseRule.includes("background: var(--paper)"), "弹窗关闭按钮缺少默认背景");
assert(styles.includes(".dialog-close:hover"), "弹窗关闭按钮缺少 hover 状态");
assert(styles.includes(".icon-button:focus-visible"), "图标按钮缺少 focus-visible 状态");
assert(styles.includes(".icon-button:disabled"), "图标按钮缺少 disabled 状态");

const dialogCloseButtons = html.match(/<button\b[^>]*data-dialog-close[^>]*>/g) || [];
assert(dialogCloseButtons.length === 11, `预期 11 个弹窗关闭按钮，实际 ${dialogCloseButtons.length} 个`);

const stageButtons = html.match(/<button\b[^>]*data-stage-target[^>]*>/g) || [];
assert(stageButtons.length === 3, `预期 3 个阶段导航按钮，实际 ${stageButtons.length} 个`);
assert(stageButtons.every((button) => !/\bdisabled\b/.test(button)), "阶段导航不应按数据状态锁定");
assert(designSystem.includes("三个阶段始终可点击"), "DESIGN_SYSTEM.md 未记录阶段导航始终可点击");

for (const button of dialogCloseButtons) {
  assert(/class="[^"]*\bdialog-close\b/.test(button), "弹窗关闭按钮未复用 dialog-close");
  assert(/aria-label="[^"]+"/.test(button), "弹窗关闭按钮缺少 aria-label");
  assert(/title="[^"]+"/.test(button), "弹窗关闭按钮缺少 title");
}

const staticIconButtons = html.match(/<button\b[^>]*class="[^"]*\bicon-button\b[^"]*"[^>]*>/g) || [];
for (const button of staticIconButtons) {
  assert(/aria-label="[^"]+"/.test(button), "静态图标按钮缺少 aria-label");
  assert(/title="[^"]+"/.test(button), "静态图标按钮缺少 title");
}

assert(styleGuide.includes("DESIGN_SYSTEM.md"), "UI_STYLE_GUIDE.md 未指向可执行设计系统");
assert(agents.includes("DESIGN_SYSTEM.md"), "AGENTS.md 未要求 UI 修改前读取设计系统");
assert(agents.includes("xiaobai-coding"), "AGENTS.md 未要求页面级视觉工作加载小白经验");
assert(agents.includes("design-system-routing.md"), "AGENTS.md 未要求加载小白设计系统路由");
assert(agents.includes("test:experience"), "AGENTS.md 未要求页面级 UI 运行体验测试");
assert(styleGuide.includes("只显示边界说明"), "UI_STYLE_GUIDE.md 未同步电脑端产品边界");
assert(designSystem.includes("有效工作区宽度为 `>= 900px`") && designSystem.includes("`<= 899px` 只显示电脑端边界说明"), "DESIGN_SYSTEM.md 未记录 900px 起支持的产品边界");
assert(styles.includes("@media (min-width: 900px)") && styles.includes("@media (max-width: 899px)"), "CSS 未以 900px / 899px 作为工作台与边界页分界");
assert(app.includes('matchMedia("(min-width: 900px)")'), "运行时阶段切换未以 900px 作为最小桌面宽度");
assert(html.includes('<meta name="author" content="LINPO LAB">'), "页面缺少作者元数据");
assert(html.includes('<meta name="copyright" content="© 2026 LINPO LAB. All rights reserved.">'), "页面缺少版权元数据");
assert(html.includes('aria-label="项目归属与版权"'), "页面缺少可见的归属区");
assert(html.includes("VisPath · LINPO LAB · © 2026"), "电脑端边界页缺少项目归属");
assert(html.includes('class="prompt-scroll-region"'), "方案阶段缺少独立滚动区");
assert(html.includes('class="result-scroll-region"'), "结果阶段缺少独立滚动区");
assert(html.includes('class="setup-scroll-region"'), "输入阶段缺少内容独立滚动区");
assert(styles.includes(".control-panel .form-stack { min-height: 0; grid-column: 1; grid-template-rows: minmax(0, 1fr) auto;"), "输入内容与阶段主操作未分离为滚动区和固定操作行");
assert((html.match(/class="confirm-dialog-content/g) || []).length === 9, "九个基础弹窗缺少统一正文滚动区");
assert(html.includes('id="editSetupDialog"') && html.includes('id="confirmEditSetupBtn"'), "修改输入与设置缺少统一确认弹窗");
assert(styles.includes(".workspace-grid > .is-stage-active { display: block; height: 100%; overflow: hidden;"), "阶段外层滚动未关闭");
const confirmDialogRule = styles.match(/\.confirm-dialog\s*\{[^}]+\}/)?.[0] || "";
assert(confirmDialogRule.includes("max-height: calc(100dvh - 48px)") && confirmDialogRule.includes("overflow: hidden"), "基础弹窗缺少统一最大高度");
const confirmDialogContentRule = styles.match(/\.confirm-dialog-content\s*\{[^}]+\}/)?.[0] || "";
assert(confirmDialogContentRule.includes("min-height: 0") && confirmDialogContentRule.includes("overflow-y: auto"), "基础弹窗缺少正文滚动样式");
assert(styles.includes(".setup-scroll-region, .confirm-dialog-content { scrollbar-width: thin;") && styles.includes("padding-right: var(--space-3)"), "输入表单和基础弹窗缺少共享细滚动条或内容安全间距");
assert(designSystem.includes("滚动轨道之间至少保留 `8px` 安全距离") && designSystem.includes("滚动轨道进入弹窗右侧内边距"), "DESIGN_SYSTEM.md 未记录滚动条安全轨道合同");
const batchSummaryTemplate = app.match(/<summary class="generation-batch-summary">([\s\S]*?)<\/summary>/)?.[1] || "";
assert(batchSummaryTemplate && !batchSummaryTemplate.includes("<button"), "批次展开 summary 内不应嵌套操作按钮");
assert(app.includes('data-action="open-batch-submission"'), "批次操作区缺少提交资料入口");
assert(designSystem.includes("提交资料、对比和删除作为并列操作区"), "DESIGN_SYSTEM.md 未记录批次提交资料操作合同");
assert(app.includes("function renderGenerationActions(entry)"), "结果卡缺少统一操作区渲染函数");
for (const action of ["continue", "download-image", "copy-generation", "retry"]) {
  assert(app.includes(`data-action="${action}"`), `结果卡固定操作缺少 ${action}`);
}
const generationActionsRule = styles.match(/\.generation-actions\s*\{[^}]+\}/)?.[0] || "";
assert(generationActionsRule.includes("repeat(2, minmax(0, 1fr))") && generationActionsRule.includes("repeat(2, var(--control-height))"), "结果卡操作区未固定为 2×2 网格");
assert(styles.includes(".generation-actions .button:disabled"), "结果卡操作区缺少独立置灰状态");
assert(designSystem.includes("底部固定显示四个操作") && designSystem.includes("2×2"), "DESIGN_SYSTEM.md 未记录结果卡固定四按钮合同");
assert(html.includes('id="textBaseUrlError"') && html.includes('id="imageBaseUrlError"'), "文本和生图 API 根地址缺少各自的字段错误提示");
assert(app.includes('showApiBaseUrlError("text")') && app.includes('showApiBaseUrlError("image",'), "两个 API 根地址校验失败后应分别标记并聚焦字段");
assert((html.match(/class="api-key-visibility"/g) || []).length === 2, "文本和生图 API Key 均应使用共享显示隐藏按钮");
assert(styles.includes(".api-key-control") && styles.includes(".api-key-visibility[aria-pressed=\"true\"]"), "API Key 显示隐藏控件缺少共享样式与显示状态");
assert(app.includes("function setApiKeyVisibility") && app.includes("resetApiKeyVisibility();"), "API Key 显示隐藏行为未复用共享逻辑或弹窗打开时未恢复隐藏");
assert(designSystem.includes(".api-key-control") && styleGuide.includes("重新打开配置弹窗时恢复隐藏"), "项目规范未同步 API Key 显示隐藏合同");
assert(html.includes('id="clearApiSettingsDialog"') && html.includes('id="confirmClearApiSettingsBtn"'), "清除 API 配置缺少统一确认弹窗");
const generationMetaRule = styles.match(/\.generation-card-meta\s*\{[^}]+\}/)?.[0] || "";
assert(generationMetaRule.includes("flex-wrap: wrap"), "紧凑结果卡元数据应允许换行");
const generationGridRule = styles.match(/\.generation-batch-grid\s*\{[^}]+\}/)?.[0] || "";
assert(generationGridRule.includes("repeat(var(--result-grid-columns)") && generationGridRule.includes("1fr"), "所有结果批次应复用画布级统一列轨");
assert(!styles.includes(".generation-batch-grid:has(> .generation-card:only-child)"), "结果批次不应再按卡片数量改变列宽");
assert(styles.includes("--result-grid-columns: 4") && styles.includes("--result-grid-columns: 5"), "结果画布缺少宽屏四列和五列断点");
assert(styles.includes("@media (min-width: 1200px)") && designSystem.includes("`1200px` 起统一四列"), "结果画布四列断点未同步到共享实现和设计合同");
assert(styles.includes(".prompt-scroll-region .prompt-list:empty") && designSystem.includes("不得产生可滚动的纯空白区域"), "方案空状态滚动修复未同步到共享实现和设计合同");
assert(app.includes('const OPEN_BATCHES_KEY = "vispath-open-generation-batches"'), "批次展开状态缺少浏览器偏好存储键");
assert(app.includes('generationFeed.addEventListener("toggle"') && app.includes("saveOpenGenerationBatchIds()"), "批次展开与收起未同步保存浏览器偏好");
assert(app.includes("if (generationHistoryLoaded) pruneOpenGenerationBatchIds(allBatches)"), "批次展开偏好未在历史恢复后清理失效 ID");
assert(app.includes("renderGenerationFeed({ openBatchId: batchId })"), "新提交或恢复的批次未自动加入展开集合");
assert(designSystem.includes("刷新、筛选和卡片状态更新后保持用户选择"), "DESIGN_SYSTEM.md 未记录批次展开状态记忆合同");

console.log("design system contract passed");
