import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
].filter(Boolean);

async function findBrowserExecutable() {
  for (const candidate of browserCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {}
  }
  return undefined;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function ensureFirstBatchOpen(page) {
  const batch = page.locator(".generation-batch").first();
  if (await batch.getAttribute("open") === null) await batch.locator(":scope > .generation-batch-summary").click();
  return batch;
}

async function waitForCachedGenerationImage(page, entryId) {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const cached = await page.evaluate(async (id) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const request = database.transaction("workspace", "readonly").objectStore("workspace").get(`generation-image-cache:${id}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return record?.blob instanceof Blob ? { size: record.blob.size, type: record.blob.type } : null;
    }, entryId);
    if (cached?.size > 0) return cached;
    await page.waitForTimeout(100);
  }
  return null;
}

async function readGenerationActionContract(page) {
  const cards = page.locator(".generation-card");
  const cardCount = await cards.count();
  if (cardCount !== 1) throw new Error(`操作区合同检查需要恰好一张结果卡，实际 ${cardCount} 张`);
  return cards.evaluate((card) => {
    const actionArea = card.querySelector(".generation-actions");
    const buttons = [...actionArea.querySelectorAll("button")].map((button) => {
      const box = button.getBoundingClientRect();
      return {
        action: button.dataset.action,
        text: button.textContent.trim(),
        title: button.title,
        disabled: button.disabled,
        left: Math.round(box.left),
        top: Math.round(box.top),
        width: box.width,
        height: box.height
      };
    });
    return {
      buttons,
      columns: new Set(buttons.map((button) => button.left)).size,
      rows: new Set(buttons.map((button) => button.top)).size,
      widthDelta: Math.max(...buttons.map((button) => button.width)) - Math.min(...buttons.map((button) => button.width)),
      overflow: actionArea.scrollWidth > actionArea.clientWidth
    };
  });
}

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
const page = await context.newPage();
page.setDefaultTimeout(5000);
page.setDefaultNavigationTimeout(5000);
const consoleErrors = [];
let promptFailure = "";
let imageFailure = "";
let imageAssetFailure = false;
let historyImageAssetFailure = false;
let imageCacheFetchDelay = 0;
let imageGenerationCount = 0;
let imageTaskCount = 0;
let lastImageRequestBody = null;
let lastTextRequestBody = null;
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(error.message));

await page.route("**/responses", (route) => {
  lastTextRequestBody = JSON.parse(route.request().postData() || "{}");
  const serializedInput = typeof lastTextRequestBody.input === "string"
    ? lastTextRequestBody.input
    : lastTextRequestBody.input?.[0]?.content?.find((item) => item.type === "input_text")?.text;
  const requestInput = JSON.parse(serializedInput || "{}");
  if (promptFailure === "timeout") return route.abort("timedout");
  if (promptFailure === "rate-limit") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "文本生成请求过于频繁，请稍后重试" }) });
  if (promptFailure === "service") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "文本生成服务暂时不可用，请稍后重试" }) });
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
        locked: {
          intent: "测试视觉方案",
          subject: "测试主体",
          context: "桌面产品场景",
          audience: "需要清晰信息层级的产品用户",
          composition: "主体与信息区域层级明确",
          visualLanguage: "克制清晰",
          palette: "中性色",
          lighting: "均匀柔和",
          material: "哑光界面质感",
          textLayout: "标题与内容区清晰分层",
          constraints: []
        },
        variants: requestInput.explorationOptions.map((targetOption, index) => ({
          id: `variant_test_${index + 1}`,
          title: index === 0 ? "测试方向" : "测试方向二",
          targetOption,
          changeSummary: `只改变为${targetOption}`,
          prompt: `测试图片生成提示词，${targetOption}，方案${index + 1}`
        }))
      }) }] }]
    })
  });
});
await page.route("**/images/generations/async", async (route) => {
  if (imageFailure === "rate-limit") return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "图片生成请求过于频繁，请稍后重试" }) });
  if (imageFailure === "service") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "图片生成服务暂时不可用，请稍后重试" }) });
  if (imageFailure === "network") return route.abort("timedout");
  if (imageFailure === "slow-success") await new Promise((resolve) => setTimeout(resolve, 300));
  lastImageRequestBody = JSON.parse(route.request().postData() || "{}");
  imageGenerationCount += 1;
  imageTaskCount += 1;
  return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: `task_experience_${imageTaskCount}`, status: "queued" }) });
});
await page.route("**/images/tasks/task_experience_*", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ status: "completed", data: [{ url: `https://image.example/generated/experience-test-${imageTaskCount}.png` }] })
  });
});
await page.route("https://image.example/generated/experience-test-*.png", async (route) => {
  if (imageCacheFetchDelay && route.request().resourceType() === "fetch") {
    await new Promise((resolve) => setTimeout(resolve, imageCacheFetchDelay));
  }
  return route.fulfill(imageAssetFailure ? {
    status: 410,
    contentType: "text/plain",
    body: "expired"
  } : {
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
});
try {
  const historyBackfillPage = await context.newPage();
  await historyBackfillPage.route("https://image.example/generated/history-backfill.png", (route) => {
    return route.fulfill(historyImageAssetFailure ? {
      status: 410,
      contentType: "text/plain",
      body: "expired"
    } : {
      status: 200,
      contentType: "image/png",
      body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
    });
  });
  await historyBackfillPage.goto(appUrl, { waitUntil: "networkidle" });
  await historyBackfillPage.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({
        schemaVersion: 10,
        batchNumber: 1,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "history_backfill_entry",
          batchId: "history_backfill_batch",
          batchNumber: "01",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "旧历史图片",
          promptSnapshot: "旧历史图片提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: new Date().toISOString(),
          status: "ready",
          imageUrl: "https://image.example/generated/history-backfill.png"
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await historyBackfillPage.reload({ waitUntil: "networkidle" });
  const backfilledHistoryImage = await waitForCachedGenerationImage(historyBackfillPage, "history_backfill_entry");
  assert(backfilledHistoryImage?.size > 0 && backfilledHistoryImage.type === "image/png", "恢复旧历史后未自动补写图片 Blob 缓存");
  const normalizedHistoryEntry = await historyBackfillPage.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const history = await new Promise((resolve, reject) => {
      const request = database.transaction("workspace", "readonly").objectStore("workspace").get("generation-history");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return history.entries.find((entry) => entry.id === "history_backfill_entry");
  });
  assert(normalizedHistoryEntry.imageUrl === "" && normalizedHistoryEntry.originalImageUrl === "https://image.example/generated/history-backfill.png", "旧远程历史迁移后未只保留原始 URL 元数据");
  assert(normalizedHistoryEntry.imageCacheStatus === "ready" && normalizedHistoryEntry.imageCacheKey === "generation-image-cache:history_backfill_entry", "旧远程历史迁移后未保存缓存引用");
  assert((await historyBackfillPage.locator(".generation-card img").getAttribute("src")).startsWith("blob:"), "旧远程历史迁移成功后未切换为 Blob 显示");
  historyImageAssetFailure = true;
  await historyBackfillPage.reload({ waitUntil: "networkidle" });
  await historyBackfillPage.locator(".generation-card img").waitFor({ state: "visible" });
  const restoredHistoryImage = await historyBackfillPage.locator(".generation-card img").evaluate((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth }));
  assert(restoredHistoryImage.src.startsWith("blob:") && restoredHistoryImage.width > 0, "远程链接失效后刷新未直接从 Blob 恢复历史图片");
  assert(await historyBackfillPage.locator('.generation-image-frame [data-action="recover-image"]').count() === 0, "已有 Blob 缓存时不应显示下载恢复错误态");
  const historyRecoveryUrl = historyBackfillPage.url();
  await Promise.all([
    historyBackfillPage.waitForEvent("download"),
    historyBackfillPage.locator('.generation-card [data-action="download-image"]').click()
  ]);
  assert(historyBackfillPage.url() === historyRecoveryUrl, "旧历史图片下载恢复离开了当前工作台");
  await historyBackfillPage.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      store.delete("generation-history");
      store.delete("generation-image-cache:history_backfill_entry");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await historyBackfillPage.close();
  historyImageAssetFailure = false;

  const pendingContext = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: "block" });
  const pendingPage = await pendingContext.newPage();
  await pendingPage.addInitScript(() => {
    const nativeSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay, ...args) => nativeSetTimeout(callback, delay >= 3000 ? 1 : delay, ...args);
  });
  await pendingPage.route("**/images/tasks/task_pending_feedback", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ status: "processing", progress: "72%" })
  }));
  await pendingPage.goto(appUrl, { waitUntil: "networkidle" });
  await pendingPage.evaluate(async () => {
    const now = new Date().toISOString();
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      store.put({
        textBaseUrl: "",
        textApiKey: "",
        textModel: "gpt-5.4-mini",
        imageBaseUrl: "https://image-api.example/v1",
        imageApiKey: "test-image-key",
        imageModel: "gpt-image-2",
        imageGenerationMode: "async"
      }, "api-settings");
      store.put({
        schemaVersion: 10,
        batchNumber: 1,
        savedAt: now,
        entries: [{
          id: "pending_feedback_entry",
          batchId: "pending_feedback_batch",
          batchNumber: "01",
          batchCreatedAt: now,
          createdAt: now,
          startedAt: now,
          variantTitle: "异步任务测试",
          promptSnapshot: "异步任务仍在服务端生成",
          changeSummary: "验证轮询暂停后的反馈",
          generationMode: "async",
          referenceUsage: "analyze",
          resolution: "1K",
          ratio: "1:1",
          status: "loading",
          taskId: "task_pending_feedback",
          taskStatus: "processing",
          taskProgress: "72%"
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await pendingPage.reload({ waitUntil: "networkidle" });
  await pendingPage.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("原任务仍在生成，稍后刷新即可继续查询"), null, { timeout: 30000 });
  assert(await pendingPage.locator(".generation-state.loading").isVisible(), "轮询暂停后原任务未保持为加载状态");
  assert(!(await pendingPage.locator("#toast").textContent()).includes("重试"), "原任务仍在运行时错误建议用户重新提交");
  await pendingContext.close();

  const narrowPage = await browser.newPage({ viewport: { width: 899, height: 720 } });
  await narrowPage.goto(appUrl, { waitUntil: "networkidle" });
  assert(await narrowPage.locator("#desktopRequired").isVisible(), "窄屏未显示电脑端使用提示");
  assert(await narrowPage.locator(".app-shell").isHidden(), "窄屏仍显示完整工作台");
  assert((await narrowPage.locator("#desktopRequired").textContent()).includes("宽度至少 900px"), "窄屏提示未说明最小桌面宽度");
  await narrowPage.close();

  const minimumDesktopPage = await browser.newPage({ viewport: { width: 900, height: 720 } });
  await minimumDesktopPage.goto(appUrl, { waitUntil: "networkidle" });
  assert(await minimumDesktopPage.locator("#desktopRequired").isHidden(), "900px 桌面端误显示边界页");
  assert(await minimumDesktopPage.locator(".app-shell").isVisible(), "900px 桌面端未显示完整工作台");
  assert(await minimumDesktopPage.evaluate(() => document.documentElement.scrollWidth === innerWidth), "900px 桌面端存在横向溢出");
  const readMinimumDesktopSetupAction = () => minimumDesktopPage.evaluate(() => {
    const formNode = document.querySelector("#setupStage .form-stack");
    const scrollNode = document.querySelector("#setupStage .setup-scroll-region") || formNode;
    const actionNode = document.querySelector("#setupStage .setup-action");
    const form = formNode.getBoundingClientRect();
    const action = actionNode.getBoundingClientRect();
    const button = document.querySelector("#generateBtn").getBoundingClientRect();
    const intersects = (first, second) => first.left < second.right && first.right > second.left && first.top < second.bottom && first.bottom > second.top;
    const scroll = scrollNode.getBoundingClientRect();
    const overlappingControls = [...document.querySelectorAll("#setupStage textarea, #setupStage select, #setupStage .choice-option, #setupStage .dimension-option, #setupStage .dropzone, #setupStage .file-preview")]
      .filter((node) => node.getClientRects().length && intersects(node.getBoundingClientRect(), scroll) && intersects(node.getBoundingClientRect(), action));
    const scrollChildren = [...scrollNode.children].filter((node) => node.getClientRects().length);
    return {
      visible: button.top >= form.top && button.bottom <= form.bottom,
      regionsSeparated: scroll.bottom <= action.top + 1,
      overlappingControlCount: overlappingControls.length,
      formScrollTop: scrollNode.scrollTop,
      contentRailGap: scroll.right - Math.max(...scrollChildren.map((node) => node.getBoundingClientRect().right))
    };
  });
  const initialSetupAction = await readMinimumDesktopSetupAction();
  assert(initialSetupAction.visible && initialSetupAction.regionsSeparated && initialSetupAction.overlappingControlCount === 0 && initialSetupAction.contentRailGap >= 8, "900x720 首次进入时生成主操作不可见、滚动轨道遮挡或表单控件重叠");
  await minimumDesktopPage.locator("#referenceImage").setInputFiles({
    name: "minimum-desktop-reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
  await minimumDesktopPage.locator("#filePreview").waitFor({ state: "visible" });
  const setupActionWithReference = await readMinimumDesktopSetupAction();
  assert(setupActionWithReference.visible && setupActionWithReference.regionsSeparated && setupActionWithReference.overlappingControlCount === 0 && setupActionWithReference.formScrollTop === 0, "900x720 上传参考图后生成主操作不可见或遮挡表单控件");
  await minimumDesktopPage.close();

  const promptPreviewPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
  await promptPreviewPage.goto(new URL("?preview=prompts", appUrl).toString(), { waitUntil: "networkidle" });
  await promptPreviewPage.locator("#promptStage.is-stage-active").waitFor();
  assert(await promptPreviewPage.locator(".prompt-card").count() === 3, "本地方案页预览未加载三张示例卡片");
  assert(await promptPreviewPage.locator('[data-stage-target="promptStage"]').getAttribute("aria-current") === "step", "本地方案页预览未停在方案阶段");
  assert((await promptPreviewPage.locator("#boardHint").textContent()).includes("本地预览"), "本地方案页预览缺少示例状态说明");
  await promptPreviewPage.close();

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({ apiBaseUrl: "https://legacy-api.example/v1" }, "api-settings");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#apiSettingsBtn").click();
  assert(await page.locator("#textBaseUrlInput, #imageBaseUrlInput").count() === 2, "文本和生图 API 应分别提供根地址输入框");
  assert(await page.locator("#apiBaseUrlInput").count() === 0, "API 配置仍保留无法表达双中转站的共用地址");
  assert(await page.locator("#apiSettingsDialog .confirm-dialog-content > p").count() === 0, "API 配置顶部仍保留归属不明的长说明");
  assert((await page.locator("#apiSettingsStorageNote").textContent()).includes("当前浏览器"), "API 配置标题区缺少简短的本机保存说明");
  assert(await page.locator("#textBaseUrlInput").inputValue() === "https://legacy-api.example/v1" && await page.locator("#imageBaseUrlInput").inputValue() === "https://legacy-api.example/v1", "旧版共用 API 地址未兼容回填到两个服务");
  await page.locator("#textBaseUrlInput").fill("");
  await page.locator("#textApiKeyInput").fill("test-text-key");
  await page.locator("#saveApiSettingsBtn").click();
  assert(await page.locator("#textBaseUrlError").isVisible() && await page.locator("#apiSettingsDialog").isVisible(), "文本 API 根地址错误未留在对应字段旁");
  await page.locator("#clearApiSettingsBtn").click();
  assert(await page.locator("#clearApiSettingsDialog").isVisible() && await page.locator("#apiSettingsDialog").isHidden(), "清除 API 配置未先打开确认弹窗");
  await page.locator("#cancelClearApiSettingsBtn").click();
  assert(await page.locator("#apiSettingsDialog").isVisible() && await page.locator("#clearApiSettingsDialog").isHidden(), "取消清除 API 配置后未回到配置弹窗");
  await page.locator("#textBaseUrlInput").fill("https://text-api.example/v1");
  await page.locator("#imageBaseUrlInput").fill("https://image-api.example/v1");
  await page.locator("#imageApiKeyInput").fill("test-image-key");
  const apiDialogControls = await page.evaluate(() => [...document.querySelectorAll("#apiSettingsDialog input, #apiSettingsDialog .button")].map((item) => item.getBoundingClientRect().height));
  assert(apiDialogControls.length === 8 && apiDialogControls.every((height) => height === 32), "API 配置弹窗普通控件未统一为 32px");
  const imageApiOptions = await page.evaluate(() => ({
    generationModes: [...document.querySelectorAll("#imageGenerationModeInput option")].map((option) => option.value),
    generationModeLabels: [...document.querySelectorAll("#imageGenerationModeInput option")].map((option) => option.textContent.trim()),
    defaultGenerationMode: document.querySelector("#imageGenerationModeInput")?.value,
    generationModeHint: document.querySelector("#imageGenerationModeHint")?.textContent.replace(/\s+/g, " ").trim() || "",
    hasResponseFormatInput: Boolean(document.querySelector("#imageResponseFormatInput")),
    protocolText: document.querySelector("#apiProtocolSummary")?.textContent.replace(/\s+/g, " ").trim() || ""
  }));
  assert(imageApiOptions.generationModes.join(",") === "sync,async", "生图配置未同时提供同步和异步方式");
  assert(imageApiOptions.generationModeLabels[0].includes("并发 2") && imageApiOptions.generationModeLabels[1].includes("快速预览"), "生图方式未在决策点区分稳定同步与异步预览");
  assert(imageApiOptions.generationModeHint.includes("自动保存") && imageApiOptions.generationModeHint.includes("跨域 URL"), "生图方式缺少自动保存能力边界说明");
  assert(!imageApiOptions.hasResponseFormatInput, "生图配置仍暴露独立返回格式选择");
  assert(imageApiOptions.defaultGenerationMode === "sync", "生图配置默认值不是同步模式");
  await page.locator("#imageGenerationModeInput").selectOption("async");
  assert(imageApiOptions.protocolText.includes("/responses")
    && imageApiOptions.protocolText.includes("/images/generations")
    && imageApiOptions.protocolText.includes("/images/generations/async")
    && imageApiOptions.protocolText.includes("/images/edits")
    && imageApiOptions.protocolText.includes("/images/edits/async")
    && imageApiOptions.protocolText.includes("/images/tasks/{task_id}")
    && imageApiOptions.protocolText.includes("自动兼容 URL / Base64")
    && imageApiOptions.protocolText.includes("异步 URL 可能无法自动保存"), "API 配置未清楚展示固定协议映射和保存边界");
  await page.setViewportSize({ width: 900, height: 720 });
  await page.locator("#apiProtocolSummary > summary").click();
  const compactApiDialogLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#apiSettingsDialog").getBoundingClientRect();
    const head = document.querySelector("#apiSettingsDialog .confirm-dialog-head").getBoundingClientRect();
    const content = document.querySelector("#apiSettingsDialog .confirm-dialog-content");
    const contentRect = content.getBoundingClientRect();
    const settingsGrid = content.querySelector(".api-settings-grid").getBoundingClientRect();
    const actions = document.querySelector("#apiSettingsDialog .confirm-dialog-actions").getBoundingClientRect();
    return {
      dialogTop: dialog.top,
      dialogBottom: dialog.bottom,
      headVisible: head.top >= dialog.top && head.bottom <= dialog.bottom,
      actionsVisible: actions.top >= dialog.top && actions.bottom <= dialog.bottom,
      contentOverflowY: getComputedStyle(content).overflowY,
      contentRailGap: contentRect.right - settingsGrid.right
    };
  });
  assert(compactApiDialogLayout.dialogTop >= 23 && compactApiDialogLayout.dialogBottom <= 697, "900x720 下 API 弹窗超出视口边界");
  assert(compactApiDialogLayout.headVisible && compactApiDialogLayout.actionsVisible && compactApiDialogLayout.contentOverflowY === "auto" && compactApiDialogLayout.contentRailGap >= 8, "900x720 下 API 弹窗标题、正文、操作区或滚动轨道职责异常");
  if (process.env.API_DIALOG_SCREENSHOT) await page.screenshot({ path: process.env.API_DIALOG_SCREENSHOT, fullPage: false });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#saveApiSettingsBtn").click();
  const savedApiAddressContract = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const settings = await new Promise((resolve, reject) => {
      const request = database.transaction("workspace", "readonly").objectStore("workspace").get("api-settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return settings;
  });
  assert(savedApiAddressContract.textBaseUrl === "https://text-api.example/v1", "文本 API 根地址未独立保存");
  assert(savedApiAddressContract.imageBaseUrl === "https://image-api.example/v1", "生图 API 根地址未独立保存");
  assert(!("apiBaseUrl" in savedApiAddressContract), "保存配置仍保留旧版共用地址字段");
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator("#apiSettingsBtn").click();
  const scrolledApiContent = await page.locator("#apiSettingsDialog .confirm-dialog-content").evaluate((content) => {
    content.scrollTop = content.scrollHeight;
    return { scrollTop: content.scrollTop, maxScroll: content.scrollHeight - content.clientHeight };
  });
  assert(scrolledApiContent.maxScroll > 0 && scrolledApiContent.scrollTop > 0, "短窗口下 API 弹窗正文未成为可滚动区");
  await page.locator("#apiSettingsDialog [data-dialog-close]").click();
  await page.locator("#apiSettingsBtn").click();
  assert(await page.locator("#apiSettingsDialog .confirm-dialog-content").evaluate((content) => content.scrollTop) === 0, "API 弹窗重新打开后未回到正文顶部");
  await page.locator("#apiSettingsDialog [data-dialog-close]").click();
  await page.setViewportSize({ width: 1440, height: 960 });
  const componentContract = await page.evaluate(() => ({
    selectWrappers: document.querySelectorAll(".select-control").length,
    selectIndicators: [...document.querySelectorAll(".select-control")].every((element) => getComputedStyle(element, "::after").content !== "none"),
    optionValues: [...document.querySelectorAll("#optionCount option")].map((option) => option.value),
    plusBox: (() => { const box = document.querySelector(".dropzone-icon").getBoundingClientRect(); return { width: box.width, height: box.height }; })(),
    iconButtons: [...document.querySelectorAll(".icon-button")].map((element) => {
      const style = getComputedStyle(element);
      return {
        width: style.width,
        height: style.height,
        display: style.display,
        placeItems: style.placeItems,
        padding: style.padding,
        hasSvg: Boolean(element.querySelector("svg.ui-icon"))
      };
    })
  }));
  assert(componentContract.selectWrappers >= 2, "选择控件未使用统一包裹结构");
  assert(componentContract.selectIndicators, "选择控件缺少统一箭头指示器");
  assert(componentContract.optionValues.join(",") === "2,3,4,5,6", "生成数量选项未覆盖 2 至 6 套");
  assert(componentContract.plusBox.width === componentContract.plusBox.height, "上传图标容器不是稳定正方形");
  assert(componentContract.iconButtons.every((item) => item.width === "32px" && item.height === "32px" && ["grid", "none"].includes(item.display) && item.placeItems === "center" && item.padding === "0px" && item.hasSvg), "图标按钮未使用稳定的 SVG 居中结构");
  const formControlTypography = await page.evaluate(() => [...document.querySelectorAll("input, textarea, select")]
    .filter((item) => !["radio", "checkbox", "file"].includes(item.type))
    .map((item) => ({ id: item.id, fontSize: getComputedStyle(item).fontSize })));
  assert(formControlTypography.every((item) => item.fontSize === "11px"), `表单控件文字未统一为 11px：${formControlTypography.filter((item) => item.fontSize !== "11px").map((item) => item.id).join("、")}`);
  const promptInputHeight = await page.locator("#sourcePrompt").evaluate((item) => item.getBoundingClientRect().height);
  assert(promptInputHeight >= 88 && promptInputHeight <= 96, `原始提示词输入框高度偏离紧凑设计范围：${promptInputHeight}px`);
  const setupGrouping = await page.evaluate(() => ({
    sectionTitles: [...document.querySelectorAll(".form-section-heading h3")].map((item) => item.textContent),
    sectionIndexes: [...document.querySelectorAll(".form-section-index")].map((item) => item.textContent),
    formGap: parseFloat(getComputedStyle(document.querySelector(".setup-scroll-region")).rowGap),
    sectionBorders: [...document.querySelectorAll(".form-section")].map((item) => getComputedStyle(item).borderTopWidth),
    dimensionColumns: getComputedStyle(document.querySelector("#dimensionList")).gridTemplateColumns.split(" ").length,
    dimensionDescriptions: document.querySelectorAll("#dimensionList small").length,
    dimensionLegendVisible: Boolean(document.querySelector(".dimension-fieldset legend"))
  }));
  assert(setupGrouping.sectionTitles.length === 0, "输入页仍显示多余的分组标题");
  assert(setupGrouping.sectionIndexes.length === 0, "合并后的输入表单仍显示分组编号");
  assert(setupGrouping.formGap === 16 && setupGrouping.sectionBorders.every((width) => width === "0px"), "输入表单分组间距偏离设计规范");
  assert(setupGrouping.dimensionColumns === 4, "探索变量卡片未使用宽屏四列布局");
  assert(setupGrouping.dimensionDescriptions === 0 && setupGrouping.dimensionLegendVisible, "探索变量标题或选项说明不符合当前组件规范");
  const referenceLabelContract = await page.evaluate(() => ({
    labelText: document.querySelector('label[for="referenceImage"]')?.textContent.replace(/\s+/g, " ").trim(),
    leadingText: document.querySelector('label[for="referenceImage"] > span')?.textContent.replace(/\s+/g, " ").trim(),
    helperFontSize: getComputedStyle(document.querySelector('label[for="referenceImage"] .label-helper')).fontSize,
    promptTrailingHelper: Boolean(document.querySelector('#sourcePrompt + .helper')),
    inlineHelper: Boolean(document.querySelector('label[for="referenceImage"] .label-helper'))
  }));
  assert(referenceLabelContract.leadingText === "参考图", "参考图标题仍混入可选状态");
  assert(referenceLabelContract.labelText.includes("可选 · 点击、拖入或 ⌘V / Ctrl+V 粘贴图片") && referenceLabelContract.inlineHelper, "参考图可选状态与粘贴提示未合并到右侧说明");
  assert(referenceLabelContract.helperFontSize === "10px", "参考图右侧说明字号发生变化");
  assert(!referenceLabelContract.promptTrailingHelper, "原始提示词下方仍保留错位说明");
  const dimensionContract = await page.evaluate(() => [...document.querySelectorAll("#dimensionList .dimension-option")].map((option) => {
    const input = option.querySelector("input[type=radio]");
    return {
      inputWidth: getComputedStyle(input).width,
      inputHeight: getComputedStyle(input).height,
      checked: input.checked,
      cardHeight: option.getBoundingClientRect().height,
      listGap: parseFloat(getComputedStyle(option.parentElement).rowGap)
    };
  }));
  assert(dimensionContract.length > 0, "本轮探索列表没有可选项");
  assert(dimensionContract.every((item) => item.inputWidth === "16px" && item.inputHeight === "16px"), "本轮探索单选框被全局输入框样式拉伸");
  assert(dimensionContract.filter((item) => item.checked).length === 1, "本轮探索列表必须默认选中且只能选中一项");
  assert(dimensionContract.every((item) => item.cardHeight <= 36 && item.listGap === 12), "探索变量卡片间距未与生成设置保持一致");
  const setupControlHeights = await page.evaluate(() => [...document.querySelectorAll("#taskType, #optionCount, #imageResolution, #imageRatio")].map((item) => item.getBoundingClientRect().height));
  assert(setupControlHeights.every((height) => height === 32), "生成设置控件未统一为 32px 高度");
  const generationSettingsLayout = await page.evaluate(() => {
    const controls = [...document.querySelectorAll("#taskType, #optionCount, #imageResolution, #imageRatio")];
    const widths = controls.map((item) => item.getBoundingClientRect().width);
    return {
      equalWidths: widths.every((width) => Math.abs(width - widths[0]) <= 1),
      fontSizes: controls.map((item) => getComputedStyle(item).fontSize),
      hasOutputNote: Boolean(document.querySelector(".output-settings-note"))
    };
  });
  assert(generationSettingsLayout.equalWidths, "生成设置左右两列未保持等宽");
  assert(generationSettingsLayout.fontSizes.every((size) => size === "11px"), "生成设置下拉文字仍然偏大");
  assert(!generationSettingsLayout.hasOutputNote, "输出分辨率下方仍显示重复说明文字");
  const visibleTextButtonHeights = await page.evaluate(() => [...document.querySelectorAll("button.button, a.button, .stage-nav button")]
    .filter((item) => getComputedStyle(item).display !== "none" && item.getBoundingClientRect().width > 0)
    .map((item) => ({ text: item.textContent.trim(), height: item.getBoundingClientRect().height })));
  assert(visibleTextButtonHeights.every((item) => item.height === 32), `页面文字按钮未统一为 32px：${visibleTextButtonHeights.filter((item) => item.height !== 32).map((item) => `${item.text}:${item.height}`).join("；")}`);
  assert(await page.locator("#imageResolution option").count() === 3, "输出分辨率选项不完整");
  assert(await page.locator("#imageResolution").inputValue() === "1K", "输出分辨率默认值不是 1K");
  assert(await page.locator("#imageRatio").inputValue() === "3:4", "海报默认画幅比例不是 3:4");
  await page.locator("#imageRatio").selectOption("16:9");
  await page.locator("#taskType").selectOption("landing_page");
  assert(await page.locator("#imageRatio").inputValue() === "16:9", "手动覆盖画幅比例后被创作类型覆盖");
  assert(await page.locator("#imageResolution").inputValue() === "1K", "当前生成配置未保留 1K 分辨率");
  const desktopLayout = await page.evaluate(() => ({
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    desktopRequiredDisplay: getComputedStyle(document.querySelector("#desktopRequired")).display,
    stageNavDisplay: getComputedStyle(document.querySelector(".stage-nav")).display,
    stageIndexes: [...document.querySelectorAll(".stage-nav .stage-index")].map((item) => item.textContent.trim()),
    frameVerticalGaps: (() => {
      const topbar = document.querySelector(".topbar").getBoundingClientRect();
      const stageButton = document.querySelector(".stage-nav button").getBoundingClientRect();
      const workspace = document.querySelector(".workspace-grid").getBoundingClientRect();
      return {
        stageWithinTopbar: stageButton.top >= topbar.top && stageButton.bottom <= topbar.bottom,
        stageCenterDelta: Math.abs((stageButton.top + stageButton.bottom) / 2 - (topbar.top + topbar.bottom) / 2),
        topbarToWorkspace: workspace.top - topbar.bottom
      };
    })(),
    frameAlignment: (() => {
      const brand = document.querySelector(".brand").getBoundingClientRect();
      const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
      const workspace = document.querySelector(".workspace-grid").getBoundingClientRect();
      return {
        leftDelta: Math.abs(brand.left - workspace.left),
        rightDelta: Math.abs(actions.right - workspace.right)
      };
    })()
  }));
  assert(!desktopLayout.horizontalOverflow, "桌面端存在横向溢出");
  assert(desktopLayout.desktopRequiredDisplay === "none", "桌面端误显示窄屏提示");
  assert(desktopLayout.stageNavDisplay === "grid", "桌面端阶段导航未显示");
  assert(desktopLayout.stageIndexes.join(",") === "01,02,03", "阶段导航缺少清晰的 01 / 02 / 03 顺序编号");
  assert(desktopLayout.frameVerticalGaps.stageWithinTopbar, "流程组件未位于顶部导航栏内部");
  assert(desktopLayout.frameVerticalGaps.stageCenterDelta <= 1, "流程组件未在顶部导航栏垂直居中");
  assert(Math.abs(desktopLayout.frameVerticalGaps.topbarToWorkspace - 16) <= 1, "顶部导航与内容区域间距未统一为 16px");
  assert(desktopLayout.frameAlignment.leftDelta <= 1, "顶部 Logo 与下方内容左边界未对齐");
  assert(desktopLayout.frameAlignment.rightDelta <= 1, "顶部配置按钮与下方内容右边界未对齐");
  const setupColumnAlignment = await page.evaluate(() => {
    const form = document.querySelector("#setupStage .form-stack").getBoundingClientRect();
    const blueprint = document.querySelector("#setupStage .inline-blueprint").getBoundingClientRect();
    return {
      topDelta: Math.abs(form.top - blueprint.top),
      bottomDelta: Math.abs(form.bottom - blueprint.bottom),
      heightDelta: Math.abs(form.height - blueprint.height)
    };
  });
  assert(setupColumnAlignment.topDelta <= 1, "输入内容区与提示词蓝图顶部未对齐");
  assert(setupColumnAlignment.bottomDelta <= 1, "输入内容区与提示词蓝图底部未对齐");
  assert(setupColumnAlignment.heightDelta <= 1, "输入内容区与提示词蓝图高度不一致");
  const scrollContract = await page.evaluate(() => {
    const stage = (id) => {
      const node = document.querySelector(`#${id}`);
      return { overflowY: getComputedStyle(node).overflowY, height: node.getBoundingClientRect().height };
    };
    const dialog = (id) => {
      const node = document.querySelector(`#${id}`);
      const content = node.querySelector(".confirm-dialog-content");
      return {
        maxHeight: getComputedStyle(node).maxHeight,
        contentOverflowY: content ? getComputedStyle(content).overflowY : "missing"
      };
    };
    return {
      setup: stage("setupStage"),
      prompt: stage("promptStage"),
      result: stage("resultStage"),
      promptScroll: getComputedStyle(document.querySelector(".prompt-scroll-region")).overflowY,
      resultScroll: getComputedStyle(document.querySelector(".result-scroll-region")).overflowY,
      basicDialogs: ["apiSettingsDialog", "historyDialog", "resetDialog", "retryGenerationDialog"].map(dialog),
      mediaDialogs: {
        imageStage: getComputedStyle(document.querySelector(".image-preview-stage")).overflowY,
        comparisonGrid: getComputedStyle(document.querySelector(".comparison-grid")).overflowY
      }
    };
  });
  assert([scrollContract.setup, scrollContract.prompt, scrollContract.result].every((item) => item.overflowY === "hidden"), "三个阶段外层应统一由内部区域承担滚动");
  assert(scrollContract.promptScroll === "auto" && scrollContract.resultScroll === "auto", "方案列表和结果批次列表缺少独立滚动区");
  assert(scrollContract.basicDialogs.every((item) => item.maxHeight !== "none" && item.contentOverflowY === "auto"), "基础弹窗未统一为固定标题/滚动正文/固定操作区");
  assert(scrollContract.mediaDialogs.imageStage === "auto" && scrollContract.mediaDialogs.comparisonGrid === "auto", "媒体弹窗的内容滚动区不明确");
  if (process.env.SETUP_SCREENSHOT) await page.screenshot({ path: process.env.SETUP_SCREENSHOT, fullPage: false });
  await page.setViewportSize({ width: 1728, height: 960 });
  const wideFrameAlignment = await page.evaluate(() => {
    const brand = document.querySelector(".brand").getBoundingClientRect();
    const actions = document.querySelector(".topbar-actions").getBoundingClientRect();
    const workspace = document.querySelector(".workspace-grid").getBoundingClientRect();
    return { leftDelta: Math.abs(brand.left - workspace.left), rightDelta: Math.abs(actions.right - workspace.right) };
  });
  assert(wideFrameAlignment.leftDelta <= 1 && wideFrameAlignment.rightDelta <= 1, "超宽桌面顶部与内容框架未保持左右对齐");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#referenceImage").setInputFiles({
    name: "reference.png",
    mimeType: "image/png",
    buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  });
  await page.locator("#filePreview").waitFor({ state: "visible" });
  assert(await page.locator("#fileName").textContent() === "reference.png", "参考图上传预览失败");

  await page.locator("#optionCount").selectOption("2");
  promptFailure = "rate-limit";
  await page.locator("#generateBtn").click();
  await page.waitForFunction(() => document.querySelector("#generateHint")?.textContent.includes("请求过于频繁"));
  promptFailure = "service";
  await page.locator("#generateBtn").click();
  await page.waitForFunction(() => document.querySelector("#generateHint")?.textContent.includes("暂时不可用"));
  promptFailure = "timeout";
  await page.locator("#generateBtn").click();
  await page.waitForFunction(() => document.querySelector("#generateHint")?.textContent.includes("连接失败"));
  promptFailure = "";
  await page.locator("#generateBtn").click();
  assert(lastTextRequestBody.stream === false && lastTextRequestBody.max_output_tokens === 2400, "文本请求未使用兼容的 Responses 非流式参数");
  assert(!("text" in lastTextRequestBody), "文本请求不应强制服务商支持 text.format");
  assert(lastTextRequestBody.input?.[0]?.content?.[0]?.type === "input_text" && lastTextRequestBody.input?.[0]?.content?.[1]?.type === "input_image", "参考图未使用 Responses 多模态输入结构");
  await page.locator("[data-variant-id]").first().waitFor();
  const blueprintScan = await page.evaluate(() => [...document.querySelectorAll(".blueprint-block")].map((block) => ({
    hasIndex: Boolean(block.querySelector(".blueprint-block-index")),
    height: block.getBoundingClientRect().height
  })));
  assert(blueprintScan.length === 3 && blueprintScan.every((item) => item.hasIndex), "提示词蓝图缺少稳定的扫描编号");
  assert(blueprintScan.every((item) => item.height <= 82), "提示词蓝图单块纵向占用过大");
  const promptCardLayout = await page.evaluate(() => [...document.querySelectorAll(".prompt-card")].map((card) => {
    const checkbox = card.querySelector(".prompt-card-selector input").getBoundingClientRect();
    const title = card.querySelector(".prompt-card-selector strong").getBoundingClientRect();
    const copy = card.querySelector(".prompt-copy").getBoundingClientRect();
    const cardBox = card.getBoundingClientRect();
    return { checkboxWidth: checkbox.width, checkboxHeight: checkbox.height, titleWidth: title.width, copyWidth: copy.width, cardWidth: cardBox.width };
  }));
  assert(promptCardLayout.every((item) => item.checkboxWidth <= 20 && item.checkboxHeight <= 20 && item.titleWidth >= 100), "方案卡片复选框或标题布局异常");
  assert(promptCardLayout.every((item) => item.copyWidth < item.cardWidth * 0.4), "复制按钮视觉权重仍然过高");
  const unusedPromptGridWidth = await page.evaluate(() => {
    const list = document.querySelector(".prompt-list").getBoundingClientRect();
    const cards = document.querySelectorAll(".prompt-card");
    return list.right - cards[cards.length - 1].getBoundingClientRect().right;
  });
  assert(unusedPromptGridWidth <= 2, "方案数量较少时右侧留下整列空位");
  const promptSpacing = await page.evaluate(() => {
    const list = document.querySelector(".prompt-list");
    const bar = document.querySelector(".submission-bar");
    return {
      listPaddingBottom: parseFloat(getComputedStyle(list).paddingBottom),
      gap: bar.getBoundingClientRect().top - list.getBoundingClientRect().bottom
    };
  });
  assert(promptSpacing.listPaddingBottom <= 20, "方案列表底部仍保留大块无效空间");
  assert(promptSpacing.gap <= 4, "提交栏距离方案卡片区域过远");

  const secondCard = page.locator("[data-variant-id]").nth(1);
  await secondCard.locator(".changed-line").click();
  assert(await page.locator("#selectedCount").textContent() === "1", "点击卡片主体未切换选中状态");
  await secondCard.locator('[data-action="toggle-prompt"]').click();
  assert(await page.locator("#selectedCount").textContent() === "1", "展开完整提示词时误切换选中状态");
  assert(await secondCard.locator(".prompt-preview").isVisible(), "完整提示词无法展开");
  const expandedPromptText = await secondCard.locator(".prompt-preview").textContent();
  assert(/必须保留：\n主体与关键特征：/.test(expandedPromptText), "完整提示词的固定内容缺少层级换行");
  assert(/\n用途与目标：/.test(expandedPromptText), "完整提示词缺少用途与目标层级");
  assert(/\n技术规格：/.test(expandedPromptText), "完整提示词缺少技术规格层级");
  await secondCard.locator(".prompt-preview").click();
  assert(await page.locator("#selectedCount").textContent() === "1", "点击提示词正文时误切换选中状态");
  await secondCard.locator('[data-action="copy"]').click();
  assert(await page.locator("#selectedCount").textContent() === "1", "复制提示词时误切换选中状态");
  assert(await page.locator('[data-stage-target="promptStage"]').getAttribute("aria-current") === "step", "生成方案后当前阶段未更新");

  await page.locator('[data-variant-id] input[data-action="select"]').nth(1).check();
  imageFailure = "rate-limit";
  await page.locator("#submitSelectedBtn").click();
  await page.locator('.generation-card [data-action="delete"]').waitFor();
  await page.waitForFunction(() => document.querySelector(".generation-error-tooltip-trigger")?.textContent.includes("请求过于频繁"), null, { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("请求过于频繁"), null, { timeout: 30000 });
  assert(!(await page.locator("#toast").textContent()).includes("账单"), "明确的 429 失败仍提示用户核对账单");
  const errorActionContract = await readGenerationActionContract(page);
  const errorActions = Object.fromEntries(errorActionContract.buttons.map((button) => [button.action, button]));
  assert(errorActionContract.buttons.length === 4 && errorActionContract.columns === 2 && errorActionContract.rows === 2, "失败结果卡未稳定显示 2×2 四按钮操作区");
  assert(errorActionContract.buttons.every((button) => button.height === 32) && errorActionContract.widthDelta <= 1 && !errorActionContract.overflow, "失败结果卡四按钮尺寸不一致或存在溢出");
  assert(errorActions.continue.disabled && errorActions["download-image"].disabled, "失败结果卡的细化或保存操作未置灰");
  assert(!errorActions["copy-generation"].disabled && !errorActions.retry.disabled && errorActions.retry.text === "重新尝试", "失败结果卡的复制或重新尝试状态不正确");
  if (process.env.ERROR_ACTION_GRID_SCREENSHOT) await page.screenshot({ path: process.env.ERROR_ACTION_GRID_SCREENSHOT, fullPage: false });
  const stateVisualContract = await page.evaluate(() => ({
    errorState: Boolean(document.querySelector(".generation-state.error .state-marker") && document.querySelector(".generation-state.error strong") && document.querySelector(".generation-state.error small")),
    emptyState: Boolean(document.querySelector("#emptyGenerationBoard .state-marker") && document.querySelector("#emptyGenerationBoard .state-copy"))
  }));
  assert(stateVisualContract.errorState && stateVisualContract.emptyState, "空状态与失败状态未使用统一视觉结构");
  imageFailure = "service";
  await page.locator('.generation-card [data-action="retry"]').click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("服务暂不可用"), null, { timeout: 30000 });
  assert(!(await page.locator("#toast").textContent()).includes("账单"), "明确的 503 失败仍提示用户核对账单");
  await page.waitForFunction(() => document.querySelector(".generation-error-tooltip-trigger")?.textContent.includes("服务暂时不可用"), null, { timeout: 30000 });
  imageFailure = "network";
  await page.locator('.generation-card [data-action="retry"]').click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForFunction(() => document.querySelector(".generation-error-tooltip-trigger")?.textContent.includes("连接中断"), null, { timeout: 30000 });
  await page.waitForFunction(() => {
    const text = document.querySelector("#toast")?.textContent || "";
    return text.includes("状态未知") && text.includes("核对账单") && text.includes("勿立即重试");
  }, null, { timeout: 30000 });
  imageFailure = "slow-success";
  await page.locator('.generation-card [data-action="retry"]').click();
  await page.locator("#retryGenerationDialog").waitFor({ state: "visible" });
  const retryDialogButtons = await page.locator("#retryGenerationDialog .button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  assert(retryDialogButtons.every((height) => height === 32), "重试确认弹窗按钮未统一为 32px");
  assert(imageGenerationCount === 0, "点击重试后未经确认就再次调用了生图 API");
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.locator(".generation-state.loading").waitFor({ state: "visible" });
  assert(await page.locator(".generation-state.loading .state-marker").count() === 1, "加载状态未使用统一视觉标记");
  const loadingActionContract = await readGenerationActionContract(page);
  const loadingActions = Object.fromEntries(loadingActionContract.buttons.map((button) => [button.action, button]));
  assert(loadingActionContract.buttons.length === 4 && loadingActionContract.columns === 2 && loadingActionContract.rows === 2, "生成中结果卡未稳定显示 2×2 四按钮操作区");
  assert(loadingActions.continue.disabled && loadingActions["download-image"].disabled && loadingActions.retry.disabled, "生成中结果卡的不可执行操作未置灰");
  assert(!loadingActions["copy-generation"].disabled && loadingActions.retry.title === "当前图片生成中", "生成中结果卡的复制或重试提示不正确");
  if (process.env.LOADING_ACTION_GRID_SCREENSHOT) await page.screenshot({ path: process.env.LOADING_ACTION_GRID_SCREENSHOT, fullPage: false });
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成");
  await page.locator(".generation-card").waitFor({ state: "visible" });
  imageFailure = "";
  const readyActionContract = await readGenerationActionContract(page);
  assert(readyActionContract.buttons.length === 4 && readyActionContract.columns === 2 && readyActionContract.rows === 2, "完成结果卡未稳定显示 2×2 四按钮操作区");
  assert(readyActionContract.buttons.every((button) => !button.disabled && button.height === 32) && readyActionContract.widthDelta <= 1 && !readyActionContract.overflow, "完成结果卡四按钮未全部可用或网格尺寸异常");
  const visibleIconGeometry = await page.evaluate(() => [...document.querySelectorAll(".generation-card .icon-button")].map((button) => {
    const buttonBox = button.getBoundingClientRect();
    const iconBox = button.querySelector("svg.ui-icon")?.getBoundingClientRect();
    return {
      square: buttonBox.width === 32 && buttonBox.height === 32,
      centerDeltaX: iconBox ? Math.abs((buttonBox.left + buttonBox.width / 2) - (iconBox.left + iconBox.width / 2)) : Infinity,
      centerDeltaY: iconBox ? Math.abs((buttonBox.top + buttonBox.height / 2) - (iconBox.top + iconBox.height / 2)) : Infinity
    };
  }));
  assert(visibleIconGeometry.length > 0 && visibleIconGeometry.every((item) => item.square && item.centerDeltaX <= .5 && item.centerDeltaY <= .5), "可见图标按钮中的 SVG 未精确水平垂直居中");
  const imagePreviewButtons = page.locator('[data-action="open-image"]');
  assert(await imagePreviewButtons.count() === 1, "已完成图片缺少大图查看入口");
  assert(await page.locator('.generation-card [data-action="download-image"]').count() === 1, "已完成图片缺少保存本地入口");
  await imagePreviewButtons.click();
  assert(await page.locator("#imagePreviewDialog").isVisible(), "点击生成图片后未打开大图预览");
  const imageDialogControls = await page.locator("#imagePreviewDialog .button, #imagePreviewDialog .icon-button").evaluateAll((items) => items.map((item) => ({ width: item.getBoundingClientRect().width, height: item.getBoundingClientRect().height, icon: item.classList.contains("icon-button") })));
  assert(imageDialogControls.every((item) => item.height === 32 && (!item.icon || item.width === 32)), "大图预览弹窗按钮未遵循 32px 规范");
  const imageDialogHeaderAlignment = await page.evaluate(() => {
    const title = document.querySelector("#imagePreviewTitle").getBoundingClientRect();
    const controls = [...document.querySelectorAll("#imagePreviewDialog .image-preview-actions > *")].map((item) => item.getBoundingClientRect());
    const centerY = (box) => box.top + box.height / 2;
    return {
      controlsAligned: controls.length === 2 && Math.abs(controls[0].top - controls[1].top) <= 1,
      titleAligned: controls.every((box) => Math.abs(centerY(box) - centerY(title)) <= 1)
    };
  });
  assert(imageDialogHeaderAlignment.controlsAligned && imageDialogHeaderAlignment.titleAligned, "大图弹窗标题、下载和关闭控件未按同一中心线对齐");
  if (process.env.IMAGE_DIALOG_SCREENSHOT) await page.screenshot({ path: process.env.IMAGE_DIALOG_SCREENSHOT, fullPage: false });
  assert(await page.locator("#imagePreviewTitle").textContent() === "复古印刷感", "大图预览未显示固定探索项标题");
  const previewImageSource = await page.locator("#imagePreviewImage").getAttribute("src");
  assert(previewImageSource.startsWith("blob:"), "大图预览未使用已验证的 Blob 图片地址");
  assert((await page.locator(".generation-card-meta").textContent()).includes("实际返回 URL"), "服务端返回 URL 时结果卡未展示实际响应格式");
  assert(await page.locator("#imageDownloadLink").getAttribute("href") === previewImageSource, "原图下载未指向当前预览图片");
  assert((await page.locator("#imageDownloadLink").getAttribute("download")).endsWith(".png"), "原图下载缺少稳定文件名");
  const generatedThumbnail = await page.locator(".generation-art").evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    imageFit: getComputedStyle(element.querySelector("img")).objectFit,
    ratioBadge: element.querySelector(".generation-ratio-badge")?.textContent.trim(),
    frame: (() => {
      const frame = element.querySelector(".generation-image-frame")?.getBoundingClientRect();
      const art = element.getBoundingClientRect();
      return frame ? {
        centerDeltaX: Math.abs((frame.left + frame.width / 2) - (art.left + art.width / 2)),
        centerDeltaY: Math.abs((frame.top + frame.height / 2) - (art.top + art.height / 2)),
        fillsBothAxes: Math.abs(frame.width - art.width) <= 1 && Math.abs(frame.height - art.height) <= 1
      } : null;
    })()
  }));
  assert(generatedThumbnail.height === 180 && generatedThumbnail.imageFit === "contain", "结果卡未使用统一缩略图高度或完整容纳图片");
  assert(generatedThumbnail.ratioBadge === "16:9", "结果卡缩略图缺少常驻画幅比例标识");
  assert(generatedThumbnail.frame && generatedThumbnail.frame.centerDeltaX <= 1 && generatedThumbnail.frame.centerDeltaY <= 1 && !generatedThumbnail.frame.fillsBothAxes, "结果图没有按自身比例居中适配缩略框");
  await page.locator("#closeImagePreviewBtn").click();
  assert(await page.locator("#imagePreviewDialog").isHidden(), "大图预览无法关闭");
  const cachedGenerationId = await page.locator(".generation-card").getAttribute("data-generation-id");
  const cachedGenerationImage = await waitForCachedGenerationImage(page, cachedGenerationId);
  assert(cachedGenerationImage?.size > 0 && cachedGenerationImage.type === "image/png", "生成完成后未把图片 Blob 缓存到 IndexedDB");
  imageAssetFailure = true;
  const recoveryPage = await page.context().newPage();
  await recoveryPage.route("https://image.example/generated/experience-test-*.png", (route) => route.fulfill({ status: 410, contentType: "text/plain", body: "expired" }));
  await recoveryPage.goto(appUrl, { waitUntil: "networkidle" });
  await recoveryPage.locator(".generation-card img").waitFor({ state: "visible" });
  const cachedRecoveryImage = await recoveryPage.locator(".generation-card img").evaluate((image) => ({ src: image.getAttribute("src"), width: image.naturalWidth }));
  assert(cachedRecoveryImage.src.startsWith("blob:") && cachedRecoveryImage.width > 0, "远程链接失效后未直接从 Blob 显示图片");
  assert(await recoveryPage.locator('.generation-image-frame [data-action="recover-image"]').count() === 0, "已有 Blob 缓存时不应显示下载恢复状态");
  const recoveryPageUrl = recoveryPage.url();
  await Promise.all([
    recoveryPage.waitForEvent("download"),
    recoveryPage.locator('.generation-card [data-action="download-image"]').click()
  ]);
  assert(recoveryPage.url() === recoveryPageUrl, "Blob 图片下载离开了当前工作台");
  await recoveryPage.evaluate(async (entryId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").delete(`generation-image-cache:${entryId}`);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, cachedGenerationId);
  await recoveryPage.reload({ waitUntil: "networkidle" });
  const recoveryOptionsAction = recoveryPage.locator('.generation-image-cache-error [data-action="open-image-recovery"]');
  await recoveryOptionsAction.waitFor({ state: "visible" });
  assert((await recoveryPage.locator(".generation-image-cache-error").textContent()).includes("临时图片链接无法长期保存"), "缓存缺失且外链失效时未显示临时链接说明");
  assert(await recoveryPage.locator('.generation-card [data-action="recover-image-file"]').count() === 0, "结果卡仍直接显示选择本地图片");
  assert(await recoveryPage.locator('.generation-image-frame [data-action="recover-image"]').count() === 0, "外链失效时仍显示无效的下载恢复入口");
  assert(await recoveryPage.locator('.generation-card [data-action="retry"]').isEnabled(), "外链失效时未保留重新生成入口");
  await recoveryPage.close();
  imageAssetFailure = false;
  const resultCardHierarchy = await page.evaluate(() => {
    const card = document.querySelector(".generation-card");
    const primary = card.querySelector('[data-action="continue"]')?.getBoundingClientRect();
    const copy = card.querySelector('[data-action="copy-generation"]')?.getBoundingClientRect();
    return {
      hasTitleBlock: Boolean(card.querySelector(".generation-card-title")),
      hasSummary: Boolean(card.querySelector(".generation-card-summary")),
      hasMeta: Boolean(card.querySelector(".generation-card-meta")),
      primaryBeforeSecondary: Boolean(primary && copy && primary.top < copy.top),
      actionOverflow: card.querySelector(".generation-actions")?.scrollWidth > card.querySelector(".generation-actions")?.clientWidth
    };
  });
  assert(resultCardHierarchy.hasTitleBlock && resultCardHierarchy.hasSummary && resultCardHierarchy.hasMeta, "结果卡片缺少明确的标题、摘要或参数层级");
  assert(resultCardHierarchy.primaryBeforeSecondary, "结果卡片主操作未优先于次要操作");
  assert(!resultCardHierarchy.actionOverflow, "结果卡片操作区存在横向溢出");
  assert(await page.locator("#overviewReadyCount").textContent() === "1", "任务总览未统计已完成的卡片");
  assert(await page.locator("#activeGenerationNavCount").isHidden(), "全部完成后仍显示生成中提醒");
  assert(lastImageRequestBody.model === "gpt-image-2-1k", "1K 分辨率未匹配对应生图模型");
  assert(lastImageRequestBody.size === "1792x1024", "异步生图未传递官方画幅尺寸");
  assert(lastImageRequestBody.aspect_ratio === "16:9", "画幅比例未传入生图 API");
  assert(lastImageRequestBody.response_format === "b64_json", "异步生图默认应请求 Base64，避免外链图片受网络拦截");
  assert(!("quality" in lastImageRequestBody) && !("watermark" in lastImageRequestBody), "异步请求包含文档 Demo 之外的同步字段");
  assert(lastImageRequestBody.output_format === "png", "异步生图未按官方接口请求 PNG 输出");
  await page.locator('[data-stage-target="promptStage"]').click();
  await page.locator('[data-variant-id] input[data-action="select"]').first().check();
  await page.locator("#submitSelectedBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 2);
  const resultBoardRhythm = await page.evaluate(() => {
    const toolbar = document.querySelector(".result-toolbar")?.getBoundingClientRect();
    const overview = document.querySelector(".generation-overview")?.getBoundingClientRect();
    const filters = document.querySelector(".result-filters")?.getBoundingClientRect();
    const summary = document.querySelector(".generation-batch-summary")?.getBoundingClientRect();
    const filterControls = [...document.querySelectorAll("#resultFilters input, #resultFilters select, #clearResultFiltersBtn")].map((item) => item.getBoundingClientRect());
    return {
      hasToolbar: Boolean(toolbar),
      controlsShareRow: Boolean(overview && filters && Math.abs(overview.top - filters.top) <= 4),
      overviewHeight: overview?.height,
      filtersHeight: filters?.height,
      toolbarHeight: toolbar?.height || Infinity,
      batchSummaryHeight: summary?.height || Infinity,
      hasRedundantBatchCount: Boolean(document.querySelector(".generation-batch-count")),
      statusItemCounts: [...document.querySelectorAll(".generation-batch-stats")].map((item) => item.children.length),
      visibleFilterLabels: [...document.querySelectorAll("#resultFilters label > span:not(.select-control)")].filter((item) => getComputedStyle(item).display !== "none").length,
      clearButtonText: document.querySelector("#clearResultFiltersBtn")?.textContent.trim(),
      clearButtonFontMatches: getComputedStyle(document.querySelector("#clearResultFiltersBtn")).fontSize === getComputedStyle(document.querySelector("#historyManageBtn")).fontSize,
      filterControlsAligned: filterControls.every((item) => Math.abs(item.top - filterControls[0].top) <= 1 && Math.abs(item.height - filterControls[0].height) <= 1),
      toolbarGroupsEqualHeight: Boolean(overview && filters && Math.abs(overview.height - filters.height) <= 1),
      toolbarGroupHeight: Math.max(overview?.height || Infinity, filters?.height || Infinity)
    };
  });
  assert(resultBoardRhythm.hasToolbar && resultBoardRhythm.controlsShareRow, "结果总览与筛选未形成统一工具栏");
  assert(resultBoardRhythm.toolbarHeight <= 72 && resultBoardRhythm.batchSummaryHeight <= 54, "结果页工具栏或批次标题纵向占用过大");
  assert(!resultBoardRhythm.hasRedundantBatchCount, "批次标题仍显示重复的数量徽章");
  assert(resultBoardRhythm.statusItemCounts.every((count) => count === 1), "批次标题仍显示无意义的零状态");
  assert(resultBoardRhythm.visibleFilterLabels === 0, "结果筛选仍显示重复的外部文字标签");
  assert(resultBoardRhythm.clearButtonText === "清除", "清除筛选未使用明确的文字按钮");
  assert(resultBoardRhythm.clearButtonFontMatches, "清除筛选按钮字号未遵循弱化文字按钮规范");
  assert(resultBoardRhythm.filterControlsAligned, "结果筛选控件与清除按钮未对齐");
  assert(resultBoardRhythm.toolbarGroupsEqualHeight, "结果统计与筛选组件高度不一致");
  assert(resultBoardRhythm.toolbarGroupHeight === 32, "结果统计与筛选组件未统一为 32px");
  const compareButtonContract = await page.evaluate(() => {
    const compare = document.querySelector(".generation-batch-compare");
    const reference = document.querySelector("#historyManageBtn");
    const compareStyle = getComputedStyle(compare);
    const referenceStyle = getComputedStyle(reference);
    return {
      heightDelta: Math.abs(compare.getBoundingClientRect().height - reference.getBoundingClientRect().height),
      fontSizeMatches: compareStyle.fontSize === referenceStyle.fontSize,
      paddingMatches: compareStyle.paddingInlineStart === referenceStyle.paddingInlineStart && compareStyle.paddingInlineEnd === referenceStyle.paddingInlineEnd,
      borderMatches: compareStyle.borderWidth === referenceStyle.borderWidth
    };
  });
  assert(compareButtonContract.heightDelta <= 1 && compareButtonContract.fontSizeMatches && compareButtonContract.paddingMatches && compareButtonContract.borderMatches, "批次对比按钮未遵循弱化文字按钮规范");
  const resultHeadingAlignment = await page.evaluate(() => {
    const hint = document.querySelector("#feedHint");
    const button = document.querySelector("#historyManageBtn");
    const hintBox = hint?.getBoundingClientRect();
    const buttonBox = button?.getBoundingClientRect();
    return {
      hintPaddingTop: parseFloat(getComputedStyle(hint).paddingTop),
      centerDelta: hintBox && buttonBox ? Math.abs((hintBox.top + hintBox.height / 2) - (buttonBox.top + buttonBox.height / 2)) : Infinity
    };
  });
  assert(resultHeadingAlignment.hintPaddingTop === 0, "结果统计文字仍有破坏居中的顶部补偿");
  assert(resultHeadingAlignment.centerDelta <= 1, "结果统计文字与历史管理按钮中心线未对齐");
  await page.setViewportSize({ width: 900, height: 720 });
  const narrowActionGrids = await page.evaluate(() => [...document.querySelectorAll(".generation-card")]
    .filter((card) => card.getClientRects().length > 0)
    .map((card) => {
      const actionArea = card.querySelector(".generation-actions");
      const buttons = [...actionArea.querySelectorAll("button")];
      return {
        buttonCount: buttons.length,
        columns: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().left))).size,
        rows: new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
        textFits: buttons.every((button) => button.scrollWidth <= button.clientWidth),
        overflow: actionArea.scrollWidth > actionArea.clientWidth
      };
    }));
  assert(narrowActionGrids.length > 0 && narrowActionGrids.every((grid) => grid.buttonCount === 4 && grid.columns === 2 && grid.rows === 2 && grid.textFits && !grid.overflow), "900px 窄桌面下结果卡四按钮网格发生裁切或溢出");
  const resultScrollPosition = await page.locator(".result-scroll-region").evaluate((region) => {
    const maxScroll = region.scrollHeight - region.clientHeight;
    region.scrollTop = Math.min(120, maxScroll);
    return { maxScroll, scrollTop: region.scrollTop };
  });
  assert(resultScrollPosition.maxScroll > 0 && resultScrollPosition.scrollTop > 0, "900x720 下结果批次列表没有形成独立滚动区");
  await page.locator('[data-stage-target="promptStage"]').click();
  await page.locator('[data-stage-target="resultStage"]').click();
  const restoredResultScrollTop = await page.locator(".result-scroll-region").evaluate((region) => region.scrollTop);
  assert(Math.abs(restoredResultScrollTop - resultScrollPosition.scrollTop) <= 1, "手动切换阶段后未保留结果浏览位置");
  await page.evaluate(() => document.querySelector('.generation-card [data-action="toggle-favorite"]')?.click());
  const rerenderedResultScrollTop = await page.locator(".result-scroll-region").evaluate((region) => region.scrollTop);
  assert(Math.abs(rerenderedResultScrollTop - resultScrollPosition.scrollTop) <= 1, "结果卡状态更新后批次列表跳回顶部");
  await page.setViewportSize({ width: 1440, height: 960 });
  if (process.env.RESULT_TOOLBAR_SCREENSHOT) await page.screenshot({ path: process.env.RESULT_TOOLBAR_SCREENSHOT, fullPage: false });
  const compactResultLayout = await page.evaluate(() => [...document.querySelectorAll(".generation-card")].map((card) => ({
    cardWidth: card.getBoundingClientRect().width,
    thumbnailHeight: card.querySelector(".generation-art").getBoundingClientRect().height,
    horizontal: getComputedStyle(card).display === "grid"
  })));
  assert(compactResultLayout.length > 0 && compactResultLayout.every((item) => item.cardWidth <= 480), "稀疏批次的结果卡超过舒适宽度上限");
  assert(compactResultLayout.every((item) => item.thumbnailHeight === 180 && !item.horizontal), "结果卡缩略图高度不一致或仍存在横向宽卡");
  await page.setViewportSize({ width: 1024, height: 800 });
  const narrowDesktopCards = await page.evaluate(() => [...document.querySelectorAll(".generation-card")].map((card) => ({
    width: card.getBoundingClientRect().width,
    thumbnailHeight: card.querySelector(".generation-art").getBoundingClientRect().height
  })));
  assert(narrowDesktopCards.length > 0 && narrowDesktopCards.every((item) => item.width <= 480 && item.thumbnailHeight === 180), "1024px 桌面端未保持舒适结果卡宽度");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#resultSearchInput").fill("复古印刷感");
  assert(await page.locator(".generation-card").count() === 1, "结果关键词搜索未正确过滤");
  await page.locator("#resultStatusFilter").selectOption("ready");
  assert(await page.locator(".generation-card").count() === 1, "结果状态筛选未保留匹配项");
  assert(await page.locator("#resultBatchFilter option").count() === 3, "批次筛选未列出全部真实批次");
  await page.locator("#clearResultFiltersBtn").click();
  assert(await page.locator(".generation-card").count() === 2, "清除筛选后未恢复全部结果");
  await page.setViewportSize({ width: 900, height: 720 });
  await page.locator("#historyManageBtn").click();
  await page.locator("#historyDialog").waitFor({ state: "visible" });
  const compactHistoryDialogLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#historyDialog").getBoundingClientRect();
    const head = document.querySelector("#historyDialog .confirm-dialog-head").getBoundingClientRect();
    const actions = document.querySelector("#historyDialog .confirm-dialog-actions").getBoundingClientRect();
    return {
      withinViewport: dialog.top >= 23 && dialog.bottom <= 697,
      headVisible: head.top >= dialog.top && head.bottom <= dialog.bottom,
      actionsVisible: actions.top >= dialog.top && actions.bottom <= dialog.bottom
    };
  });
  assert(compactHistoryDialogLayout.withinViewport && compactHistoryDialogLayout.headVisible && compactHistoryDialogLayout.actionsVisible, "900x720 下历史弹窗标题或操作区不可达");
  const historyDialogControls = await page.locator("#historyDialog select, #historyDialog .button").evaluateAll((items) => items.map((item) => ({ id: item.id, height: item.getBoundingClientRect().height })));
  assert(historyDialogControls.every((item) => item.height === 32), "历史管理弹窗控件未统一为 32px");
  assert(await page.locator("#historyEntryCount").textContent() === "2", "历史管理未统计真实结果数量");
  assert(await page.locator("#historyBatchCount").textContent() === "2", "历史管理未统计真实批次数量");
  await page.locator("#historyKeepCount").selectOption("5");
  assert(await page.locator("#cleanupHistoryBtn").isDisabled(), "保留 5 条时不应误启用清理");
  await page.locator("#historyKeepCount").selectOption("0");
  await page.locator("#cleanupHistoryBtn").click();
  assert(await page.locator(".generation-card").count() === 0, "全部清空未移除历史记录");
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.locator("#toast button").filter({ hasText: "撤销" }).click();
  assert(await page.locator(".generation-card").count() === 2, "历史清理撤销未恢复全部记录");
  await page.getByText("已恢复 2 条历史记录", { exact: true }).waitFor();
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator(".generation-card").count() === 2, "历史清理撤销后的记录未持久化");
  const batchStats = await page.locator(".generation-batch-stats").allTextContents();
  assert(batchStats.length === 2 && batchStats.every((text) => /已完成 1/.test(text)), "批次标题未显示真实状态统计");
  const batchDeleteButtons = page.locator(".generation-batch-delete");
  assert(await batchDeleteButtons.count() === 2, "批次级删除入口数量不正确");
  const firstBatchForDelete = await ensureFirstBatchOpen(page);
  await firstBatchForDelete.locator(":scope > .generation-batch-meta .generation-batch-delete").click();
  assert(await page.locator(".generation-card").count() === 1, "批次级删除未移除整批结果");
  const pendingImageCleanup = await page.evaluate(() => JSON.parse(localStorage.getItem("ai-visual-direction-board-pending-image-cleanup") || "[]"));
  assert(pendingImageCleanup.length === 1 && pendingImageCleanup.every((item) => item.entryId && item.deleteAfter && !("imageUrl" in item)), "延迟清理队列不应把完整图片地址写入 localStorage");
  await page.locator("#toast button").filter({ hasText: "撤销" }).click();
  assert(await page.locator(".generation-card").count() === 2, "批次级删除撤销失败");
  await (await ensureFirstBatchOpen(page)).locator('.generation-card [data-action="delete"]').first().click();
  assert(await page.locator(".generation-card").count() === 1, "单条生成记录删除失败");
  await page.locator("#toast button").filter({ hasText: "撤销" }).click();
  assert(await page.locator(".generation-card").count() === 2, "删除撤销失败");
  await page.waitForTimeout(5700);
  await (await ensureFirstBatchOpen(page)).locator('.generation-card [data-action="delete"]').first().click();
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(5700);
  assert(await page.locator(".generation-card").count() === 1, "单条删除结果未正确持久化");
  const resetRaceGenerationId = await page.locator(".generation-card").getAttribute("data-generation-id");
  imageCacheFetchDelay = 1200;
  await (await ensureFirstBatchOpen(page)).locator('.generation-card [data-action="retry"]').click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成");
  await page.locator("#resetBtn").click();
  const resetDialogButtons = await page.locator("#resetDialog .button").evaluateAll((items) => items.map((item) => item.getBoundingClientRect().height));
  assert(resetDialogButtons.every((height) => height === 32), "重置确认弹窗按钮未统一为 32px");
  await page.locator("#confirmResetBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".generation-card").length === 0);
  await page.waitForTimeout(1500);
  const staleResetCache = await page.evaluate(async (entryId) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const record = await new Promise((resolve, reject) => {
      const request = database.transaction("workspace", "readonly").objectStore("workspace").get(`generation-image-cache:${entryId}`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return Boolean(record);
  }, resetRaceGenerationId);
  assert(!staleResetCache, "工作台重置后，迟到的缓存请求重新写入了孤立图片 Blob");
  imageCacheFetchDelay = 0;
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator(".generation-card").count() === 0, "重置结果未持久化");
  const unexpectedConsoleErrors = consoleErrors.filter((message) => !/Failed to load resource:.*(?:429|503)|net::ERR_TIMED_OUT/.test(message));
  assert(unexpectedConsoleErrors.length === 0, `页面出现非预期控制台错误：${unexpectedConsoleErrors.join("；")}`);
  console.log("experience smoke test passed");
} finally {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

process.exit(0);
