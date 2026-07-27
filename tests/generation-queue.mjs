import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const tinyPng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
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

function createEntry(index, generationMode) {
  const queuedAt = new Date().toISOString();
  return {
    id: `generation_queue_${generationMode}_${index}`,
    batchId: `batch_queue_${generationMode}`,
    batchNumber: "01",
    batchCreatedAt: new Date().toISOString(),
    variantTitle: `队列方案 ${index}`,
    changeSummary: `验证第 ${index} 个任务的调度`,
    promptSnapshot: `队列测试提示词 ${index}`,
    ratio: "1:1",
    resolution: "1K",
    generationMode,
    createdAt: "12:00",
    queuedAt,
    submittedAt: "",
    startedAt: queuedAt,
    completedAt: "",
    status: "loading",
    taskStatus: "pending_submission"
  };
}

async function seedWorkspace(page, generationMode, count) {
  await page.evaluate(async ({ mode, entries }) => {
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
        imageGenerationMode: mode
      }, "api-settings");
      store.put({ schemaVersion: 17, batchNumber: 1, savedAt: new Date().toISOString(), entries }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { mode: generationMode, entries: Array.from({ length: count }, (_, index) => createEntry(index + 1, generationMode)) });
}

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });

async function testAsyncQueue() {
  const context = await browser.newContext();
  const page = await context.newPage();
  let submissions = 0;
  let releaseFirst = false;
  let releaseSecond = false;

  await page.route("**/app.bundle.js*", async (route) => {
    const response = await route.fetch();
    const source = (await response.text()).replace("const IMAGE_POLL_INTERVAL = 3000;", "const IMAGE_POLL_INTERVAL = 10;");
    await route.fulfill({ response, body: source });
  });
  await page.route("**/images/generations/async", (route) => {
    submissions += 1;
    const taskId = `task_queue_async_${submissions}`;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "queued" }) });
  });
  await page.route("**/images/tasks/task_queue_async_*", (route) => {
    const taskId = route.request().url().split("/").at(-1);
    if (taskId.endsWith("_1") && releaseFirst) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", result: { data: [{ b64_json: tinyPng }] } }) });
    }
    if (taskId.endsWith("_2") && releaseSecond) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "failed", fail_reason: "模拟单任务失败" }) });
    }
    if (taskId.endsWith("_3")) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", result: { data: [{ b64_json: tinyPng }] } }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "in_progress", progress: "50%" }) });
  });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(page, "async", 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".generation-task-id").length === 2);
  assert.equal(submissions, 2, "异步队列应最多同时提交 2 个任务");
  assert.equal(await page.locator(".generation-progress strong").filter({ hasText: "等待提交" }).count(), 1, "第 3 个任务应等待并发空位");

  releaseFirst = true;
  await page.waitForFunction(() => document.querySelectorAll(".generation-task-id").length >= 2 && document.body.textContent.includes("task_queue_async_3"));
  assert.equal(submissions, 3, "前一个异步任务完成后应立即补位提交第 3 个任务");

  releaseSecond = true;
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 2 && document.querySelectorAll(".generation-status.error").length === 1);
  assert.equal(await page.locator(".generation-status.ready").count(), 2, "单任务失败不应阻断其他任务完成");
  assert.match(await page.locator(".generation-error-summary").textContent(), /模拟单任务失败/, "失败任务应保留独立错误原因");
  const completedMeta = await page.locator(".generation-status.ready").locator("xpath=ancestor::article").locator(".generation-card-meta").allTextContents();
  assert(completedMeta.every((text) => /耗时 总 .+ · 排队 .+ · 服务端 .+/.test(text)), "完成任务应分开展示总耗时、排队和服务端耗时");
  await page.setViewportSize({ width: 900, height: 720 });
  const viewportMetrics = await page.evaluate(() => ({ clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(viewportMetrics.scrollWidth, viewportMetrics.clientWidth, "900px 桌面断点不应因耗时信息产生水平溢出");
  await context.close();
}

async function testSyncQueue() {
  const context = await browser.newContext();
  const page = await context.newPage();
  let submissions = 0;
  let releaseFirst = false;
  let releaseSecond = false;

  await page.route("**/images/generations", async (route) => {
    const submissionNumber = ++submissions;
    if (submissionNumber === 1) {
      while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (submissionNumber === 2) {
      while (!releaseSecond) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [{ b64_json: tinyPng }] }) });
  });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(page, "sync", 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".generation-progress strong").length === 3);
  for (let attempt = 0; attempt < 60 && submissions < 2; attempt += 1) await page.waitForTimeout(50);
  assert.equal(submissions, 2, "同步 Base64 生图应最多同时提交 2 个任务");
  assert.equal(await page.locator(".generation-progress strong").filter({ hasText: "等待提交" }).count(), 1, "第 3 个同步任务应等待并发空位");
  releaseFirst = true;
  for (let attempt = 0; attempt < 160 && submissions < 3; attempt += 1) await page.waitForTimeout(50);
  assert.equal(submissions, 3, "前一个同步任务完成后应立即补位提交第 3 个任务");
  releaseSecond = true;
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 3);
  await context.close();
}

async function testSyncRateLimitThrottle() {
  const context = await browser.newContext();
  const page = await context.newPage();
  let submissions = 0;
  let firstPromptRateLimited = false;
  let releaseSecond = false;
  const submittedPrompts = [];

  await page.route("**/app.bundle.js*", async (route) => {
    const response = await route.fetch();
    const source = (await response.text()).replace("const IMAGE_RETRY_DELAYS = [5000, 15000];", "const IMAGE_RETRY_DELAYS = [50, 100];");
    await route.fulfill({ response, body: source });
  });
  await page.route("**/images/generations", async (route) => {
    submissions += 1;
    const prompt = JSON.parse(route.request().postData() || "{}").prompt;
    submittedPrompts.push(prompt);
    if (prompt.endsWith("1") && !firstPromptRateLimited) {
      firstPromptRateLimited = true;
      return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate limited" }) });
    }
    if (prompt.endsWith("2") && !releaseSecond) {
      while (!releaseSecond) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [{ b64_json: tinyPng }] }) });
  });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(page, "sync", 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  for (let attempt = 0; attempt < 80 && submissions < 3; attempt += 1) await page.waitForTimeout(50);
  assert.equal(new Set(submittedPrompts).size, 2, "同步任务收到 429 后不应继续补位第 3 个任务");
  assert.equal(await page.locator(".generation-progress strong").filter({ hasText: "等待提交" }).count(), 1, "同步降速期间后续任务应继续排队");
  releaseSecond = true;
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 3);
  assert.equal(new Set(submittedPrompts).size, 3, "已运行任务释放后应以单并发继续剩余同步任务");
  await context.close();
}

async function testRateLimitThrottle() {
  const context = await browser.newContext();
  const page = await context.newPage();
  let submissions = 0;
  const submittedPrompts = new Set();
  let releaseSecond = false;
  let firstRequestWasRateLimited = false;

  await page.route("**/app.bundle.js*", async (route) => {
    const response = await route.fetch();
    const source = (await response.text())
      .replace("const IMAGE_POLL_INTERVAL = 3000;", "const IMAGE_POLL_INTERVAL = 10;")
      .replace("const IMAGE_RETRY_DELAYS = [5000, 15000];", "const IMAGE_RETRY_DELAYS = [50, 100];");
    await route.fulfill({ response, body: source });
  });
  await page.route("**/images/generations/async", (route) => {
    submissions += 1;
    submittedPrompts.add(JSON.parse(route.request().postData() || "{}").prompt);
    if (!firstRequestWasRateLimited) {
      firstRequestWasRateLimited = true;
      return route.fulfill({ status: 429, contentType: "application/json", body: JSON.stringify({ error: "rate limited" }) });
    }
    const taskId = `task_queue_rate_limit_${submissions}`;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "queued" }) });
  });
  await page.route("**/images/tasks/task_queue_rate_limit_*", (route) => {
    const taskId = route.request().url().split("/").at(-1);
    if (taskId.endsWith("_2") && !releaseSecond) {
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "in_progress", progress: "50%" }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", result: { data: [{ b64_json: tinyPng }] } }) });
  });

  await page.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(page, "async", 3);
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.querySelectorAll(".generation-task-id").length === 1);
  await page.waitForTimeout(150);
  assert.equal(submissions, 3, "429 任务应在退避后发起一次自动重试");
  assert.equal(submittedPrompts.size, 2, "收到 429 后应暂时降为单任务，不得继续补位第 3 个任务");
  assert.equal(await page.locator(".generation-progress strong").filter({ hasText: "等待提交" }).count(), 1, "降速期间后续任务应继续排队");

  releaseSecond = true;
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 3);
  assert.equal(submissions, 4, "429 任务应完成一次退避重试，其他任务应继续生成");
  await context.close();
}

async function testCrossTabQueue() {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const submittedPrompts = [];
  const activeTaskIds = new Set();
  const releasedTaskIds = new Set();
  const completedTaskIds = new Set();
  let maxActiveTasks = 0;

  await context.route("**/app.bundle.js*", async (route) => {
    const response = await route.fetch();
    const source = (await response.text()).replace("const IMAGE_POLL_INTERVAL = 3000;", "const IMAGE_POLL_INTERVAL = 10;");
    await route.fulfill({ response, body: source });
  });
  await context.route("**/images/generations/async", (route) => {
    const prompt = JSON.parse(route.request().postData() || "{}").prompt;
    submittedPrompts.push(prompt);
    const index = Number(prompt.match(/(\d+)$/)?.[1] || submittedPrompts.length);
    const taskId = `task_cross_tab_${index}`;
    activeTaskIds.add(taskId);
    maxActiveTasks = Math.max(maxActiveTasks, activeTaskIds.size);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "queued" }) });
  });
  await context.route("**/images/tasks/task_cross_tab_*", (route) => {
    const taskId = route.request().url().split("/").at(-1);
    if (releasedTaskIds.has(taskId)) {
      if (!completedTaskIds.has(taskId)) {
        completedTaskIds.add(taskId);
        activeTaskIds.delete(taskId);
      }
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ status: "completed", result: { data: [{ b64_json: tinyPng }] } }) });
    }
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ task_id: taskId, status: "in_progress", progress: "50%" }) });
  });

  await pageA.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(pageA, "async", 4);
  await Promise.all([
    pageA.reload({ waitUntil: "domcontentloaded" }),
    pageB.goto(appUrl, { waitUntil: "domcontentloaded" })
  ]);
  for (let attempt = 0; attempt < 100 && submittedPrompts.length < 2; attempt += 1) await pageA.waitForTimeout(50);
  await pageA.waitForTimeout(200);
  assert.equal(submittedPrompts.length, 2, "两个标签页应全局共享 2 个异步槽位");
  assert.equal(new Set(submittedPrompts).size, 2, "两个标签页不应重复提交同一任务");

  [...activeTaskIds].forEach((taskId) => releasedTaskIds.add(taskId));
  for (let attempt = 0; attempt < 160 && submittedPrompts.length < 4; attempt += 1) await pageA.waitForTimeout(50);
  assert.equal(submittedPrompts.length, 4, "释放全局槽位后应继续提交剩余任务");
  assert.equal(new Set(submittedPrompts).size, 4, "跨标签调度全程不应产生重复生图请求");
  assert(maxActiveTasks <= 2, "跨标签同时运行的远端任务不得超过 2 个");

  [...activeTaskIds].forEach((taskId) => releasedTaskIds.add(taskId));
  for (let attempt = 0; attempt < 100 && activeTaskIds.size > 0; attempt += 1) await pageA.waitForTimeout(50);
  await pageA.waitForTimeout(250);
  assert.equal(submittedPrompts.length, 4, "其他标签页在任务完成后不得用旧内存状态二次提交");
  await context.close();
}

async function testCrossTabSyncQueue() {
  const context = await browser.newContext();
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  const submittedPrompts = [];
  const activePrompts = new Set();
  const releasedPrompts = new Set();
  let maxActiveTasks = 0;

  await context.route("**/images/generations", async (route) => {
    const prompt = JSON.parse(route.request().postData() || "{}").prompt;
    submittedPrompts.push(prompt);
    activePrompts.add(prompt);
    maxActiveTasks = Math.max(maxActiveTasks, activePrompts.size);
    while (!releasedPrompts.has(prompt)) await new Promise((resolve) => setTimeout(resolve, 10));
    activePrompts.delete(prompt);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ data: [{ b64_json: tinyPng }] }) });
  });

  await pageA.goto(appUrl, { waitUntil: "networkidle" });
  await seedWorkspace(pageA, "sync", 3);
  await Promise.all([
    pageA.reload({ waitUntil: "domcontentloaded" }),
    pageB.goto(appUrl, { waitUntil: "domcontentloaded" })
  ]);
  for (let attempt = 0; attempt < 100 && submittedPrompts.length < 2; attempt += 1) await pageA.waitForTimeout(50);
  await pageA.waitForTimeout(200);
  assert.equal(submittedPrompts.length, 2, "两个标签页应全局共享 2 个同步生图槽位");
  assert.equal(new Set(submittedPrompts).size, 2, "两个标签页不应重复提交同一同步任务");

  [...activePrompts].forEach((prompt) => releasedPrompts.add(prompt));
  for (let attempt = 0; attempt < 120 && submittedPrompts.length < 3; attempt += 1) await pageA.waitForTimeout(50);
  assert.equal(submittedPrompts.length, 3, "释放全局槽位后应补位提交剩余同步任务");
  assert.equal(new Set(submittedPrompts).size, 3, "跨标签同步调度全程不应产生重复请求");
  assert(maxActiveTasks <= 2, "跨标签同时运行的同步请求不得超过 2 个");

  [...activePrompts].forEach((prompt) => releasedPrompts.add(prompt));
  for (let attempt = 0; attempt < 100 && activePrompts.size > 0; attempt += 1) await pageA.waitForTimeout(50);
  await pageA.waitForTimeout(250);
  assert.equal(submittedPrompts.length, 3, "其他标签页不得用旧内存状态二次提交同步生图");
  await context.close();
}

try {
  await testAsyncQueue();
  await testSyncQueue();
  await testSyncRateLimitThrottle();
  await testRateLimitThrottle();
  await testCrossTabQueue();
  await testCrossTabSyncQueue();
  console.log("generation queue test passed");
} finally {
  await browser.close();
}
