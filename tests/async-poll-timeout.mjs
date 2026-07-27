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
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
let taskPolls = 0;

await page.route("**/app.bundle.js*", async (route) => {
  const response = await route.fetch();
  const source = (await response.text())
    .replace("const IMAGE_POLL_INTERVAL = 3000;", "const IMAGE_POLL_INTERVAL = 1;")
    .replace("const IMAGE_POLL_MAX_ATTEMPTS = 120;", "const IMAGE_POLL_MAX_ATTEMPTS = 1;");
  await route.fulfill({ response, body: source });
});

await page.route("**/images/tasks/task_poll_timeout", async (route) => {
  taskPolls += 1;
  await route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ task_id: "task_poll_timeout", status: "in_progress", progress: "60%" })
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
        imageModel: "gpt-image-2",
        imageGenerationMode: "async"
      }, "api-settings");
      store.put({
        schemaVersion: 14,
        batchNumber: 1,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "generation_poll_timeout",
          batchId: "batch_poll_timeout",
          batchNumber: "01",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "轮询暂停方案",
          changeSummary: "验证继续查询原任务",
          promptSnapshot: "一只白色马克杯，产品级棚拍",
          ratio: "1:1",
          resolution: "1K",
          generationMode: "async",
          createdAt: "12:00",
          startedAt: new Date().toISOString(),
          completedAt: "",
          status: "loading",
          taskId: "task_poll_timeout",
          taskStatus: "in_progress",
          taskProgress: "50%"
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });

  await page.reload({ waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  assert.equal(taskPolls, 1, "测试应在一次轮询后触发查询窗口结束");
  assert.equal(await page.locator(".generation-status").textContent(), "生成中", "轮询暂停后不应把服务端任务标记为失败");
  assert.equal(await page.locator('[data-action="retry"]').isDisabled(), true, "原任务未终态时不得允许重新提交");
  assert.match(await page.locator(".generation-task-id").textContent(), /task_poll_timeout/, "页面必须保留原任务编号");

  const storedEntry = await page.evaluate(async () => {
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
    return history.entries[0];
  });
  assert.equal(storedEntry.status, "loading", "轮询暂停状态必须可由刷新恢复逻辑继续接管");
  assert.equal(storedEntry.taskId, "task_poll_timeout", "轮询暂停后不得清空原 taskId");
  assert.equal(storedEntry.completedAt, "", "原任务未终态时不得写入完成时间");
  console.log("async poll timeout test passed");
} finally {
  await browser.close();
}
