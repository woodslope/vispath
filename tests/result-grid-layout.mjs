import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
].filter(Boolean);
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

async function findBrowserExecutable() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const page = await browser.newPage();

try {
  await page.goto(appUrl, { waitUntil: "load" });
  await page.evaluate(async ({ imageUrl }) => {
    const request = indexedDB.open("ai-visual-direction-board", 1);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const batchNumbers = { batch_five: "03", batch_four: "02", batch_three: "01" };
    const ratios = ["3:4", "16:9", "1:1", "9:16", "4:3"];
    const titles = ["轻盈编辑感", "窗边自然光生活方式摄影与城市通勤场景叙事验证", "高对比复古印刷", "未来材质实验", "克制品牌叙事"];
    const summaries = [
      "大面积留白与单主体构图",
      "使用较长的场景说明验证卡片在真实内容下的纵向节奏、操作区位置、提示词关系、视觉层级以及多种浏览器宽度下的稳定表现",
      "网点颗粒与套色偏移",
      "半透明材质与冷色边缘光",
      "低饱和配色与清晰信息区域"
    ];
    const makeStoredEntry = (batchId, index, createdAt) => ({
      id: `${batchId}_${index}`,
      batchId,
      batchNumber: batchNumbers[batchId],
      batchCreatedAt: createdAt,
      variantTitle: titles[index],
      changeSummary: summaries[index],
      promptSnapshot: "测量提示词",
      artClass: ["art-editorial", "art-lifestyle", "art-retro", "art-future", "art-editorial"][index],
      ratio: ratios[index],
      resolution: "1K",
      createdAt: "10:00",
      startedAt: createdAt,
      completedAt: createdAt,
      status: [2, 3].includes(index) && batchId === "batch_five" ? "error" : "ready",
      errorMessage: index === 2 && batchId === "batch_five" ? "图片生成请求过于频繁，请稍后重试或检查当前账户额度与服务配置后再次提交（错误 2）" : index === 3 && batchId === "batch_five" ? "服务暂不可用" : "",
      requestId: [2, 3].includes(index) && batchId === "batch_five" ? `request_${index}` : "",
      imageUrl: [2, 3].includes(index) && batchId === "batch_five" ? "" : imageUrl
    });
    const entries = [
      ...Array.from({ length: 5 }, (_, index) => makeStoredEntry("batch_five", index, "2026-07-15T12:00:00.000Z")),
      ...Array.from({ length: 4 }, (_, index) => makeStoredEntry("batch_four", index, "2026-07-15T11:00:00.000Z")),
      ...Array.from({ length: 3 }, (_, index) => makeStoredEntry("batch_three", index, "2026-07-15T10:00:00.000Z"))
    ];
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({ schemaVersion: 5, batchNumber: 3, savedAt: new Date().toISOString(), entries }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { imageUrl });
  await page.reload({ waitUntil: "load" });
  await page.locator(".generation-card.is-error").first().waitFor({ state: "attached" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => {
    localStorage.setItem("vispath-open-generation-batches", JSON.stringify(["batch_five", "batch_four", "batch_three"]));
    document.querySelectorAll(".generation-batch").forEach((batch) => { batch.open = true; });
    document.querySelector(".result-scroll-region").scrollTop = 0;
  });
  await page.locator(".generation-card.is-error").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const images = [...document.querySelectorAll(".generation-card img")];
    return images.length > 0 && images.every((image) => image.complete && image.naturalWidth > 0);
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const failureHierarchy = await page.locator(".generation-card.is-error").first().evaluate((card) => ({
    hasInlineErrorBlock: Boolean(card.querySelector(".generation-error")),
    hasErrorInDiagnosticsSlot: Boolean(card.querySelector(".generation-image-diagnostics .generation-error-tooltip-trigger")),
    errorUsesSharedTooltip: Boolean(card.querySelector(".generation-error-tooltip-trigger.text-tooltip-trigger .generation-error-tooltip.text-tooltip")),
    hasClickToggle: Boolean(card.querySelector('[data-action="toggle-error"], [aria-expanded]')),
    promptIsFixedFrame: Boolean(card.querySelector(".generation-prompt-snapshot > .prompt-preview")) && !card.querySelector(".generation-prompt-snapshot")?.matches("details"),
    promptHeight: card.querySelector(".generation-prompt-snapshot > .prompt-preview")?.getBoundingClientRect().height,
    promptTopGap: card.querySelector(".generation-prompt-snapshot > .prompt-preview")?.getBoundingClientRect().top - card.querySelector(".generation-prompt-snapshot")?.getBoundingClientRect().top,
    promptHasRedundantLabel: Boolean(card.querySelector(".generation-prompt-snapshot > strong")),
    promptAccessibleName: card.querySelector(".generation-prompt-snapshot > .prompt-preview")?.getAttribute("aria-label"),
    retryPrimary: card.querySelector('[data-action="retry"]')?.classList.contains("button-primary"),
    retryLabel: card.querySelector('[data-action="retry"]')?.textContent.trim(),
    actionHeight: card.querySelector(".generation-actions").getBoundingClientRect().height
  }));
  assert(!failureHierarchy.hasInlineErrorBlock, "失败原因不应再以独立内容块撑高卡片");
  assert(failureHierarchy.hasErrorInDiagnosticsSlot, "失败原因应复用实际尺寸与比例的信息槽位");
  assert(failureHierarchy.errorUsesSharedTooltip, "失败原因应复用共享文字提示气泡组件");
  assert(!failureHierarchy.hasClickToggle, "失败原因应使用悬浮文字提示，不应保留点击展开状态");
  assert(failureHierarchy.promptIsFixedFrame, "提示词快照应改为卡片内常驻固定框");
  assert(Math.abs(failureHierarchy.promptHeight - 96) <= 1, `提示词固定框高度不正确：实际 ${failureHierarchy.promptHeight}px`);
  assert(failureHierarchy.promptTopGap <= 10, `提示词内容框顶部间距重复叠加：实际 ${failureHierarchy.promptTopGap}px`);
  assert(!failureHierarchy.promptHasRedundantLabel, "唯一提示词内容框不应重复显示“提示词快照”标签");
  assert.equal(failureHierarchy.promptAccessibleName, "完整提示词", "删除可见标签后应保留明确的无障碍名称");
  assert(failureHierarchy.retryPrimary && failureHierarchy.retryLabel === "重新尝试", "失败卡应突出明确的主重试操作");
  assert(Math.abs(failureHierarchy.actionHeight - 80) <= 1, `失败卡未使用与成功卡一致的两层底部操作节奏：实际 ${failureHierarchy.actionHeight}px`);

  const errorTriggers = page.locator(".generation-error-tooltip-trigger");
  assert.equal(await errorTriggers.count(), 2, "测试数据应包含两个失败原因悬浮入口");
  await page.waitForFunction(() => [...document.querySelectorAll(".generation-error-tooltip-trigger")].every((trigger) => trigger.dataset.tooltipMeasured === "true"));
  assert(await errorTriggers.nth(0).evaluate((trigger) => trigger.classList.contains("has-overflow")), "被截断的失败原因应启用气泡");
  assert(!await errorTriggers.nth(1).evaluate((trigger) => trigger.classList.contains("has-overflow")), "完整显示的短失败原因不应启用气泡");
  assert.equal(await errorTriggers.nth(1).getAttribute("tabindex"), null, "短失败原因不应进入 Tooltip 键盘焦点序列");
  await errorTriggers.nth(0).hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".generation-error-tooltip")).opacity === "1");
  const firstTooltipState = await page.locator(".generation-error-tooltip").nth(0).evaluate((tooltip) => ({
    opacity: getComputedStyle(tooltip).opacity,
    visibility: getComputedStyle(tooltip).visibility,
    backgroundColor: getComputedStyle(tooltip).backgroundColor,
    text: tooltip.textContent
  }));
  assert.equal(firstTooltipState.opacity, "1", "鼠标悬浮失败原因时应显示文字提示气泡");
  assert.equal(firstTooltipState.visibility, "visible", "悬浮气泡不应保持隐藏");
  assert.match(firstTooltipState.backgroundColor, /rgba?\(21, 24, 22/, "失败原因应使用半透明黑色气泡");
  assert.match(firstTooltipState.text, /Request ID：request_2/, "悬浮气泡应包含完整失败信息与请求编号");
  await errorTriggers.nth(1).hover();
  await page.waitForFunction(() => [...document.querySelectorAll(".generation-error-tooltip")].every((tooltip) => getComputedStyle(tooltip).opacity === "0"));
  const tooltipOpacities = await page.locator(".generation-error-tooltip").evaluateAll((tooltips) => tooltips.map((tooltip) => getComputedStyle(tooltip).opacity));
  assert.deepEqual(tooltipOpacities, ["0", "0"], "短失败原因悬浮时不应显示气泡");

  const shortTitleTrigger = page.locator('[data-generation-id="batch_five_0"] .generation-card-title-tooltip');
  assert.equal(await shortTitleTrigger.count(), 1, "短标题卡应存在标题容器");
  assert(!await shortTitleTrigger.evaluate((trigger) => trigger.classList.contains("has-overflow")), "未省略的短标题不应启用气泡");
  await shortTitleTrigger.hover();
  assert.equal(await page.locator('[data-generation-id="batch_five_0"] .generation-card-title-tooltip-content').evaluate((tooltip) => getComputedStyle(tooltip).opacity), "0", "短标题悬浮时不应显示气泡");

  const longTitleTrigger = page.locator('[data-generation-id="batch_five_1"] .generation-card-title-tooltip');
  assert.equal(await longTitleTrigger.count(), 1, "长标题卡应存在唯一的标题提示气泡入口");
  const longTitleLayout = await longTitleTrigger.evaluate((trigger) => {
    const title = trigger.querySelector(".generation-card-title-text");
    const style = getComputedStyle(title);
    return {
      clientWidth: title.clientWidth,
      scrollWidth: title.scrollWidth,
      height: title.getBoundingClientRect().height,
      lineHeight: Number.parseFloat(style.lineHeight),
      whiteSpace: style.whiteSpace,
      overflow: style.overflow,
      textOverflow: style.textOverflow,
      sharedTooltip: trigger.classList.contains("text-tooltip-trigger") && trigger.querySelector(".text-tooltip")?.classList.contains("generation-card-title-tooltip-content")
    };
  });
  assert(longTitleLayout.scrollWidth > longTitleLayout.clientWidth, "测试长标题应真实发生溢出");
  assert(longTitleLayout.height <= longTitleLayout.lineHeight + 1, "结果卡标题应固定为单行高度");
  assert.equal(longTitleLayout.whiteSpace, "nowrap", "结果卡标题不应换行");
  assert.equal(longTitleLayout.overflow, "hidden", "过长标题应隐藏溢出部分");
  assert.equal(longTitleLayout.textOverflow, "ellipsis", "过长标题应显示省略号");
  assert(longTitleLayout.sharedTooltip, "结果卡标题应与失败原因复用同一文字提示气泡组件");
  assert(await longTitleTrigger.evaluate((trigger) => trigger.classList.contains("has-overflow")), "被省略的长标题应启用气泡");
  await longTitleTrigger.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-generation-id="batch_five_1"] .generation-card-title-tooltip-content')).opacity === "1");
  const titleTooltipState = await page.locator('[data-generation-id="batch_five_1"] .generation-card-title-tooltip-content').evaluate((tooltip) => ({
    backgroundColor: getComputedStyle(tooltip).backgroundColor,
    text: tooltip.textContent
  }));
  assert.equal(titleTooltipState.backgroundColor, firstTooltipState.backgroundColor, "标题与失败原因应使用同一种黑色气泡视觉");
  assert.match(titleTooltipState.text, /窗边自然光生活方式摄影与城市通勤场景叙事验证/, "标题气泡应显示完整标题");

  const longChangeCard = page.locator('[data-generation-id="batch_five_1"]');
  const changeSummaryLayout = await longChangeCard.evaluate((card) => {
    const prompt = card.querySelector(".generation-prompt-snapshot");
    const summary = card.querySelector(".generation-card-summary");
    const actions = card.querySelector(".generation-actions");
    const text = card.querySelector(".generation-change-text");
    const style = text ? getComputedStyle(text) : null;
    return {
      afterPrompt: Boolean(prompt?.compareDocumentPosition(summary) & Node.DOCUMENT_POSITION_FOLLOWING),
      beforeActions: Boolean(summary?.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING),
      height: text?.getBoundingClientRect().height || 0,
      lineHeight: style ? Number.parseFloat(style.lineHeight) : 0,
      lineClamp: style?.webkitLineClamp || "",
      overflow: style?.overflow || "",
      sharedTooltip: Boolean(summary?.querySelector(".generation-change-tooltip.text-tooltip-trigger .generation-change-tooltip-content.text-tooltip"))
    };
  });
  assert(changeSummaryLayout.afterPrompt && changeSummaryLayout.beforeActions, "本轮变化应位于提示词快照下方、操作按钮上方");
  assert(Math.abs(changeSummaryLayout.height - changeSummaryLayout.lineHeight * 2) <= 1, "本轮变化应固定预留两行高度");
  assert.equal(changeSummaryLayout.lineClamp, "2", "本轮变化超出两行后应省略");
  assert.equal(changeSummaryLayout.overflow, "hidden", "本轮变化不应撑高卡片");
  assert(changeSummaryLayout.sharedTooltip, "本轮变化应复用共享文字提示气泡组件");
  const shortChangeTrigger = page.locator('[data-generation-id="batch_five_0"] .generation-change-tooltip');
  assert.equal(await shortChangeTrigger.count(), 1, "短本轮变化应存在内容容器");
  assert(!await shortChangeTrigger.evaluate((trigger) => trigger.classList.contains("has-overflow")), "未省略的本轮变化不应启用气泡");
  const changeTooltipTrigger = longChangeCard.locator(".generation-change-tooltip");
  assert.equal(await changeTooltipTrigger.count(), 1, "长本轮变化应存在唯一悬浮入口");
  assert(await changeTooltipTrigger.evaluate((trigger) => trigger.classList.contains("has-overflow")), "被省略的本轮变化应启用气泡");
  await changeTooltipTrigger.hover();
  await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-generation-id="batch_five_1"] .generation-change-tooltip-content')).opacity === "1");
  const changeTooltipState = await longChangeCard.locator(".generation-change-tooltip-content").evaluate((tooltip) => ({
    backgroundColor: getComputedStyle(tooltip).backgroundColor,
    text: tooltip.textContent
  }));
  assert.equal(changeTooltipState.backgroundColor, firstTooltipState.backgroundColor, "本轮变化应与标题、失败原因使用同一种气泡视觉");
  assert.match(changeTooltipState.text, /使用较长的场景说明/, "本轮变化气泡应显示完整内容");

  for (const [width, expectedColumns] of [[900, 3], [1180, 3], [1200, 4], [1440, 4], [1540, 5], [1680, 5]]) {
    await page.setViewportSize({ width, height: 900 });
    const layout = await page.evaluate(() => {
      const grids = [...document.querySelectorAll(".generation-batch-grid")];
      return {
        batches: grids.map((grid) => ({
          columns: getComputedStyle(grid).gridTemplateColumns.split(" ").length,
          cardWidth: grid.querySelector(".generation-card").getBoundingClientRect().width,
          cardCount: grid.querySelectorAll(".generation-card").length,
          overflow: grid.scrollWidth > grid.clientWidth,
          actionOverflow: [...grid.querySelectorAll(".generation-actions")].some((actions) => actions.scrollWidth > actions.clientWidth),
          rows: [...new Set([...grid.querySelectorAll(".generation-card")].map((card) => Math.round(card.getBoundingClientRect().top)))].map((top) => {
            const cards = [...grid.querySelectorAll(".generation-card")].filter((card) => Math.abs(card.getBoundingClientRect().top - top) <= 1);
            const heights = cards.map((card) => card.getBoundingClientRect().height);
            const actionBottoms = cards.map((card) => card.querySelector(".generation-actions").getBoundingClientRect().bottom);
            return { heightDelta: Math.max(...heights) - Math.min(...heights), actionBottomDelta: Math.max(...actionBottoms) - Math.min(...actionBottoms) };
          })
        })),
        pageOverflow: document.documentElement.scrollWidth > innerWidth
      };
    });
    assert.deepEqual(layout.batches.map((batch) => batch.cardCount), [5, 4, 3], `${width}px 下混排批次数量不正确`);
    assert(layout.batches.every((batch) => batch.columns === expectedColumns), `${width}px 下不同批次未复用相同列数`);
    assert(layout.batches.every((batch) => Math.abs(batch.cardWidth - layout.batches[0].cardWidth) <= 1), `${width}px 下不同批次卡片宽度不一致`);
    assert(layout.batches.every((batch) => !batch.overflow && !batch.actionOverflow) && !layout.pageOverflow, `${width}px 下结果布局存在横向溢出`);
    assert(layout.batches.every((batch) => batch.rows.every((row) => row.heightDelta <= 1 && row.actionBottomDelta <= 1)), `${width}px 下同一行卡片高度或底部操作未对齐`);
    if (width === 1440 && process.env.RESULT_GRID_SCREENSHOT) {
      await page.evaluate(() => { document.querySelector(".result-scroll-region").scrollTop = 0; });
      const screenshotChange = page.locator('[data-generation-id="batch_five_1"] .generation-change-tooltip');
      assert.equal(await screenshotChange.count(), 1, "截图前应存在本轮变化悬浮入口");
      await screenshotChange.hover();
      await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-generation-id="batch_five_1"] .generation-change-tooltip-content')).opacity === "1");
      await page.screenshot({ path: process.env.RESULT_GRID_SCREENSHOT, fullPage: false });
    }
  }

  console.log("result grid layout test passed");
} finally {
  await browser.close();
}
