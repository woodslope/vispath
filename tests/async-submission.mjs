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
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
let asyncSubmissions = 0;
let syncSubmissions = 0;
let taskPolls = 0;
let submittedBody = null;
let submittedTextBody = null;
let legacyTextSubmissions = 0;

async function waitForNormalizedImage(entryId) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const normalized = await page.evaluate(async (id) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("workspace", "readonly");
      const store = transaction.objectStore("workspace");
      const history = await new Promise((resolve, reject) => {
        const request = store.get("generation-history");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const cache = await new Promise((resolve, reject) => {
        const request = store.get(`generation-image-cache:${id}`);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const entry = history?.entries?.find((item) => item.id === id);
      if (!entry || entry.imageCacheStatus !== "ready" || entry.imageUrl || !(cache?.blob instanceof Blob)) return null;
      return {
        entry,
        cache: { size: cache.blob.size, type: cache.blob.type }
      };
    }, entryId);
    if (normalized) return normalized;
    await page.waitForTimeout(100);
  }
  return null;
}

await page.route("**/responses", (route) => {
  submittedTextBody = JSON.parse(route.request().postData() || "{}");
  const requestInput = JSON.parse(submittedTextBody.input);
  return route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      locked: { intent: "异步生图测试", subject: "白色马克杯" },
      variants: (requestInput.explorationOptions.length
        ? requestInput.explorationOptions
        : Array.from({ length: requestInput.optionCount }, (_, index) => `动态视觉方向 ${index + 1}`))
        .map((targetOption, index) => ({
        title: `异步方向${index + 1}`,
        targetOption,
        changeSummary: `验证${targetOption}异步提交`,
        prompt: `一只白色马克杯，横向构图，${targetOption}，方案${index + 1}`
        }))
    }) }] }]
  })
  });
});

await page.route("**/chat/completions", (route) => {
  legacyTextSubmissions += 1;
  return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "不应调用旧文本接口" }) });
});

await page.route("**/images/generations/async", async (route) => {
  asyncSubmissions += 1;
  if (asyncSubmissions === 2) await new Promise((resolve) => setTimeout(resolve, 300));
  submittedBody = JSON.parse(route.request().postData() || "{}");
  const taskId = `task_new_async_${asyncSubmissions}`;
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ id: taskId, task_id: taskId, status: "queued" })
  });
});

await page.route("**/images/generations", (route) => {
  syncSubmissions += 1;
  return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "不应调用同步接口" }) });
});

await page.route("**/images/tasks/task_new_async_*", (route) => {
  taskPolls += 1;
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(taskPolls === 1
      ? { task_id: "task_new_async_1", status: "pending", progress: "10%" }
      : taskPolls === 2
        ? { task_id: "task_new_async_1", status: "in_progress", progress: "50%" }
        : { status: "completed", result: { data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] } })
  });
});

await page.route("https://image.example/generated-*.png", (route) => route.fulfill({
  contentType: "image/png",
  body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
}));

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
      transaction.objectStore("workspace").put({
        textBaseUrl: "https://text.example/v1",
        textApiKey: "test-text-key",
        textModel: "gpt-5.4-mini",
        imageBaseUrl: "https://image.example/v1",
        imageApiKey: "test-image-key",
        imageModel: "gpt-image-2",
        imageGenerationMode: "async"
      }, "api-settings");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#sourcePrompt").fill("一只白色马克杯，横向构图");
  await page.locator("#optionCount").selectOption("2");
  await page.locator("#imageRatio").selectOption("16:9");
  await page.locator("#generateBtn").click();
  await page.locator('[data-variant-id] input[data-action="select"]').first().check();
  await page.locator("#submitSelectedBtn").click();
  await page.locator(".generation-task-id").waitFor();
  assert.match(await page.locator(".generation-task-id").textContent(), /task_id：task_new_async_1/, "生成卡片应展示任务编号");
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成", null, { timeout: 12000 });

  assert.equal(asyncSubmissions, 1, "新生图任务应提交到异步接口");
  assert.equal(syncSubmissions, 0, "不应继续调用同步生图接口");
  assert.equal(legacyTextSubmissions, 0, "不应继续调用 Chat Completions 文本接口");
  assert.equal(typeof submittedTextBody.input, "string", "纯文本方向请求应直接使用 Responses input 字符串");
  assert.equal(submittedTextBody.stream, false, "文本方向请求应使用非流式响应");
  assert.equal(submittedTextBody.max_output_tokens, 2400, "两套文本方向请求应使用足够的输出上限");
  assert.equal("text" in submittedTextBody, false, "文本方向请求不应强制服务商支持 text.format");
  assert.equal("messages" in submittedTextBody, false, "Responses 请求不应继续发送 messages");
  assert.ok(taskPolls >= 3, "pending 等非终态应继续轮询到完成状态");
  assert.equal(submittedBody.aspect_ratio, "16:9", "应传递画幅比例");
  assert.equal(submittedBody.response_format, "b64_json", "异步生图默认应请求 Base64，避免外链图片受网络拦截");
  assert.equal("quality" in submittedBody, false, "异步请求不应添加文档 Demo 未使用的质量字段");
  assert.equal("watermark" in submittedBody, false, "异步请求不应添加文档 Demo 未使用的水印字段");
  assert.equal(submittedBody.size, "1792x1024", "异步请求应传递官方画幅尺寸");
  assert.equal(submittedBody.output_format, "png", "异步请求应按官方接口请求 PNG 输出");

  const generatedEntryId = await page.locator(".generation-card").getAttribute("data-generation-id");
  const normalizedImage = await waitForNormalizedImage(generatedEntryId);
  assert(normalizedImage, "生成完成后未把 Base64 安全归一化为 Blob 单一持久化");
  const storedTask = normalizedImage.entry;
  assert.equal(storedTask.taskId, "task_new_async_1", "提交响应中的 task_id 应持久化");
  assert.equal(storedTask.responseFormat, "url", "历史应记录文档请求使用的 URL 格式");
  assert.equal(storedTask.imageUrl, "", "Blob 验证成功后历史不应继续保存完整 Base64");
  assert.equal(storedTask.imageCacheKey, `generation-image-cache:${generatedEntryId}`, "历史未保存稳定图片缓存引用");
  assert.equal(storedTask.imageMimeType, "image/png", "历史未保存缓存图片格式");
  assert.equal(storedTask.imageByteSize, normalizedImage.cache.size, "历史未保存缓存图片字节数");
  assert(normalizedImage.cache.size > 0 && normalizedImage.cache.type === "image/png", "图片 Blob 未成功写入并回读");
  assert.equal(storedTask.actualResponseFormat, "b64_json", "异步任务应记录服务端实际返回的 Base64 格式");
  assert.match(await page.locator(".generation-card img").getAttribute("src"), /^blob:/, "生成完成后页面未使用 Blob 临时地址显示图片");
  assert.match(await page.locator(".generation-card-meta").textContent(), /实际返回 Base64/, "结果卡应展示实际返回格式");
  await page.waitForFunction(() => document.querySelector(".generation-actual-size")?.textContent?.includes("实际 1×1"));
  assert.match(await page.locator(".generation-actual-size").textContent(), /比例不符/, "实际图片比例与请求不一致时应明确提示");
  const storedDimensions = await page.evaluate(async () => {
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
    return { width: history.entries[0].imageWidth, height: history.entries[0].imageHeight };
  });
  assert.deepEqual(storedDimensions, { width: 1, height: 1 }, "实际图片尺寸应写入本地历史");

  await page.locator('.generation-card [data-action="retry"]').click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForTimeout(100);
  const retryDimensions = await page.evaluate(async () => {
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
    return {
      width: history.entries[0].imageWidth,
      height: history.entries[0].imageHeight,
      actualResponseFormat: history.entries[0].actualResponseFormat
    };
  });
  assert.deepEqual(retryDimensions, { width: undefined, height: undefined, actualResponseFormat: undefined }, "重新生成时应清空上一张图片的尺寸和实际返回格式");
  assert.doesNotMatch(await page.locator(".generation-card-meta").textContent(), /实际返回/, "重新生成中不应显示上一张图片的实际返回格式");
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成", null, { timeout: 12000 });
  assert.equal(asyncSubmissions, 2, "重新生成应创建新的异步任务");
  const retriedEntryId = await page.locator(".generation-card").getAttribute("data-generation-id");
  assert(await waitForNormalizedImage(retriedEntryId), "重新生成后的图片未归一化为 Blob 单一持久化");
  assert.match(await page.locator(".generation-card img").getAttribute("src"), /^blob:/, "重新生成后页面未使用 Blob 临时地址");
  console.log("async submission test passed");
} finally {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}
