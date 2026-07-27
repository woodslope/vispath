import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
].filter(Boolean);
const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5000);
const errors = [];
const imageRequests = [];

page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(error.message));
page.on("request", (request) => { if (/\/images\/(generations|edits)/.test(request.url())) imageRequests.push(request.url()); });

const submissionSnapshot = {
  schemaVersion: 1,
  sourcePrompt: "为一家咖啡店制作夏日开业海报",
  contentMode: "factual",
  taskTypeId: "poster",
  taskTypeName: "海报",
  requestedOptionCount: 2,
  ratio: "3:4",
  resolution: "1K",
  generationMode: "sync",
  referenceUsage: "analyze",
  referenceSource: "user-upload",
  hasReferenceImage: true,
  explorationDimensionId: "visual_style",
  explorationDimensionName: "设计风格"
};

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(async ({ base64, submissionSnapshot }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      const makeEntry = (id, title, option, prompt) => ({
        id, batchId: "batch_submission", batchNumber: "03", batchCreatedAt: "2026-07-23T08:30:00.000Z",
        variantTitle: title, changeSummary: `探索${option}`, promptSnapshot: prompt, submissionSnapshot,
        blueprintSnapshot: {
          schemaVersion: 1, taskTypeId: "poster",
          source: { prompt: submissionSnapshot.sourcePrompt, referenceUsage: "analyze", contentMode: "factual" },
          locked: { subject: "透明玻璃冰咖啡杯", technical: { ratio: "3:4" }, constraints: [] },
          dimensions: { visual_style: option }, acceptedPrompt: prompt
        },
        explorationDimensionId: "visual_style", explorationDimensionName: "设计风格", explorationOption: option,
        artClass: "art-editorial", ratio: "3:4", resolution: "1K", generationMode: "sync", responseFormat: "url",
        referenceUsage: "analyze", referenceImageCacheKey: "reference-image-cache:batch_submission",
        createdAt: "16:30", startedAt: "2026-07-23T08:30:00.000Z", completedAt: "2026-07-23T08:31:00.000Z",
        status: "error", errorMessage: "测试记录"
      });
      store.put({
        schemaVersion: 15,
        batchNumber: 3,
        savedAt: "2026-07-23T08:31:00.000Z",
        entries: [
          makeEntry("submission_one", "轻盈编辑感", "极简编辑感", "第一套完整提示词"),
          makeEntry("submission_two", "复古印刷感", "复古印刷感", "第二套完整提示词")
        ]
      }, "generation-history");
      store.put({
        kind: "reference-image", cacheKey: "reference-image-cache:batch_submission", batchId: "batch_submission",
        blob, fileName: "coffee-reference.png", mimeType: "image/png", byteSize: blob.size,
        savedAt: "2026-07-23T08:30:00.000Z"
      }, "reference-image-cache:batch_submission");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { base64: tinyPng.toString("base64"), submissionSnapshot });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator('[data-action="open-batch-submission"]').waitFor();

  assert.equal(await page.locator(".generation-batch-meta > button").count(), 3, "批次操作区应包含提交资料、对比和删除");
  await page.locator('[data-action="open-batch-submission"]').click();
  await page.locator("#batchSubmissionDialog").waitFor({ state: "visible" });
  assert.equal(await page.locator("#batchSubmissionDialogTitle").textContent(), "批次 03 提交资料");
  assert.equal(await page.locator(".batch-submission-variant").count(), 2, "弹窗未展示实际提交的两套方案");
  assert.equal(await page.locator(".batch-submission-reference img").count(), 1, "弹窗未恢复参考图预览");
  assert.match(await page.locator("#batchSubmissionContent").textContent(), /为一家咖啡店制作夏日开业海报/);

  const desktopDialog = await page.locator("#batchSubmissionDialog").evaluate((dialog) => ({
    horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
    bottom: dialog.getBoundingClientRect().bottom,
    closeSize: dialog.querySelector(".dialog-close").getBoundingClientRect().width,
    scrollbarEdgeInset: Math.round(dialog.getBoundingClientRect().right - dialog.querySelector(".batch-submission-content").getBoundingClientRect().right),
    contentScrollbarGap: Math.round(dialog.querySelector(".batch-submission-content").getBoundingClientRect().right - dialog.querySelector(".batch-submission-overview").getBoundingClientRect().right)
  }));
  assert.equal(desktopDialog.horizontalOverflow, false, "提交资料弹窗不应横向溢出");
  assert.ok(desktopDialog.bottom <= 900, "提交资料弹窗不应超出桌面视口");
  assert.equal(desktopDialog.closeSize, 32, "提交资料弹窗关闭按钮应保持 32px");
  assert.ok(desktopDialog.scrollbarEdgeInset <= 2, "正文滚动轨道应贴近弹窗右侧内缘");
  assert.ok(desktopDialog.contentScrollbarGap >= 24, "提交资料内容与滚动轨道之间应保留安全间距");

  await page.locator("#cancelBatchSubmissionBtn").click();
  await page.evaluate(() => {
    const input = document.querySelector("#sourcePrompt");
    input.value = "当前尚未提交的输入";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator('[data-action="open-batch-submission"]').click();
  await page.locator("#reuseBatchSubmissionBtn").click();
  assert.equal(await page.locator("#batchSubmissionDialog").isVisible(), true, "覆盖当前输入前应保持弹窗并要求确认");
  assert.equal(await page.locator("#reuseBatchSubmissionBtn").textContent(), "确认复用");
  assert.equal(await page.locator("#batchSubmissionReuseWarning").isVisible(), true, "覆盖确认说明应就地可见");
  await page.locator("#reuseBatchSubmissionBtn").click();
  await page.locator("#promptStage.is-stage-active").waitFor();

  assert.equal(await page.locator("#sourcePrompt").inputValue(), submissionSnapshot.sourcePrompt, "原始输入未回填");
  assert.equal(await page.locator("#taskType").inputValue(), "poster", "创作类型未回填");
  assert.equal(await page.locator("#imageRatio").inputValue(), "3:4", "画幅比例未回填");
  assert.equal(await page.locator("#referenceUsageAnalyze").isChecked(), true, "参考图用途未回填");
  assert.equal(await page.locator("#fileName").textContent(), "coffee-reference.png", "参考图文件未回填");
  assert.equal(await page.locator("[data-variant-id]").count(), 2, "提交方案未恢复到工作台");
  assert.equal(await page.locator('[data-variant-id] input[data-action="select"]:checked').count(), 2, "复用方案应保持全选");
  assert.equal(await page.locator("#submitSelectedBtn").isEnabled(), true, "复用后应允许用户主动提交为新批次");
  assert.equal(imageRequests.length, 0, "复用提交资料不得直接调用生图接口");

  await page.setViewportSize({ width: 900, height: 720 });
  await page.locator('[data-stage-target="resultStage"]').click();
  await page.locator('[data-action="open-batch-submission"]').click();
  const narrowLayout = await page.evaluate(() => {
    const dialog = document.querySelector("#batchSubmissionDialog");
    const title = document.querySelector(".generation-batch-title").getBoundingClientRect();
    const actions = document.querySelector(".generation-batch-meta").getBoundingClientRect();
    return {
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
      dialogOverflow: dialog.scrollWidth > dialog.clientWidth,
      dialogBottom: dialog.getBoundingClientRect().bottom,
      batchOverlap: title.right > actions.left
    };
  });
  assert.equal(narrowLayout.pageOverflow, false, "900px 桌面不应出现页面横向溢出");
  assert.equal(narrowLayout.dialogOverflow, false, "900px 下弹窗不应横向溢出");
  assert.ok(narrowLayout.dialogBottom <= 720, "900px 下弹窗操作区应保持可达");
  assert.equal(narrowLayout.batchOverlap, false, "900px 下批次标题不应与操作区重叠");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false });

  assert.deepEqual(errors, [], `页面存在控制台错误：${errors.join(" | ")}`);
  console.log("batch submission snapshot test passed");
} finally {
  await browser.close();
}
