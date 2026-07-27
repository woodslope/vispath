import assert from "node:assert/strict";
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

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(5000);

try {
  await page.goto(appUrl, { waitUntil: "load" });
  await page.evaluate(async () => {
    localStorage.removeItem("vispath-open-generation-batches");
    const request = indexedDB.open("ai-visual-direction-board", 1);
    const database = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const makeEntry = (batchId, batchNumber, createdAt) => ({
      id: `${batchId}_entry`, batchId, batchNumber, batchCreatedAt: createdAt,
      variantTitle: `方向 ${batchNumber}`, changeSummary: "批次展开记忆测试", promptSnapshot: "测试提示词",
      artClass: "art-editorial", ratio: "3:4", resolution: "1K", createdAt: "10:00",
      startedAt: createdAt, completedAt: createdAt, status: "ready", imageUrl: ""
    });
    const entries = [
      makeEntry("batch_new", "02", "2026-07-15T11:00:00.000Z"),
      makeEntry("batch_old", "01", "2026-07-15T10:00:00.000Z")
    ];
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({ schemaVersion: 5, batchNumber: 2, savedAt: new Date().toISOString(), entries }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "load" });

  const newest = page.locator('[data-batch-id="batch_new"]');
  const oldest = page.locator('[data-batch-id="batch_old"]');
  assert.equal(await newest.getAttribute("open"), "", "首次恢复历史时最新批次应默认展开");
  assert.equal(await oldest.getAttribute("open"), null, "首次恢复历史时旧批次应默认收起");

  await newest.locator(":scope > .generation-batch-summary").click();
  await oldest.locator(":scope > .generation-batch-summary").click();
  await page.waitForFunction(() => localStorage.getItem("vispath-open-generation-batches")?.includes("batch_old"));
  assert.equal(await newest.getAttribute("open"), null, "用户应能收起最新批次");
  assert.equal(await oldest.getAttribute("open"), "", "用户应能展开旧批次");

  await page.reload({ waitUntil: "load" });
  assert.equal(await page.locator('[data-batch-id="batch_new"]').getAttribute("open"), null, "刷新后应保留最新批次收起状态");
  assert.equal(await page.locator('[data-batch-id="batch_old"]').getAttribute("open"), "", "刷新后应保留旧批次展开状态");

  await page.locator("#resultBatchFilter").selectOption("batch_new");
  await page.locator("#resultBatchFilter").selectOption("all");
  assert.equal(await page.locator('[data-batch-id="batch_old"]').getAttribute("open"), "", "筛选后应保留隐藏批次的展开状态");

  await page.locator('[data-batch-id="batch_old"] [data-action="delete"]').click();
  assert.equal(await page.locator('[data-batch-id="batch_new"]').getAttribute("open"), null, "卡片状态更新后应保留其他批次收起状态");

  console.log("batch disclosure test passed");
} finally {
  await browser.close();
}
