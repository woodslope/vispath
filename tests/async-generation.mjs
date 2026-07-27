import assert from "node:assert/strict";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let taskPollCount = 0;

await page.route("**/images/tasks/task_async_test", async (route) => {
  taskPollCount += 1;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(taskPollCount < 2
      ? { task_id: "task_async_test", status: "in_progress", progress: "50%" }
      : { task_id: "task_async_test", status: "completed", data: [{ b64_json: "YVN5bmNJbWFnZQ==" }] })
  });
});

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      store.put({
        textBaseUrl: "https://text.example/v1",
        textApiKey: "test-text-key",
        textModel: "gpt-5.4-mini",
        imageBaseUrl: "https://image.example/v1",
        imageApiKey: "test-image-key",
        imageModel: "gpt-image-2"
      }, "api-settings");
      store.put({
        schemaVersion: 5,
        batchNumber: 1,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "generation_async_test",
          batchId: "batch_async_test",
          batchNumber: "01",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "异步历史方案",
          changeSummary: "继续接收旧任务",
          promptSnapshot: "一只原创云朵猫，产品级棚拍",
          ratio: "1:1",
          resolution: "1K",
          createdAt: "12:00",
          status: "loading",
          taskId: "task_async_test"
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成", null, { timeout: 10000 });
  assert.ok(taskPollCount >= 2, "应至少轮询一次进行中和一次完成状态");
  await page.waitForFunction(() => document.querySelector(".generation-card img")?.src.startsWith("blob:"), null, { timeout: 5000 });
  assert.match(await page.locator(".generation-card img").getAttribute("src"), /^blob:/);
  console.log("async generation test passed");
} finally {
  await browser.close();
}
