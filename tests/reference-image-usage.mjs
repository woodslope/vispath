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

function readBlueprintInput(requestBody) {
  if (typeof requestBody.input === "string") return JSON.parse(requestBody.input);
  const inputText = requestBody.input?.[0]?.content?.find((item) => item.type === "input_text")?.text;
  return JSON.parse(inputText || "{}");
}

function multipartField(body, name) {
  const markerIndex = body.indexOf(`name="${name}"`);
  if (markerIndex < 0) return "";
  const valueStart = body.indexOf("\r\n\r\n", markerIndex);
  if (valueStart < 0) return "";
  const valueEnd = body.indexOf("\r\n--", valueStart + 4);
  return body.slice(valueStart + 4, valueEnd < 0 ? undefined : valueEnd);
}

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(8000);

const textRequests = [];
const generationRequests = [];
const editRequests = [];
let failingExploreOption = "";

await page.route("**/responses", (route) => {
  const requestBody = JSON.parse(route.request().postData() || "{}");
  const input = readBlueprintInput(requestBody);
  textRequests.push({ body: requestBody, input });
  const targetOptions = input.explorationOptions.length
    ? input.explorationOptions
    : Array.from({ length: input.optionCount }, (_, index) => `动态视觉方向 ${index + 1}`);
  const variants = targetOptions.map((targetOption, index) => ({
    title: `${targetOption}方向`,
    targetOption,
    changeSummary: `将${input.dimensionName}调整为${targetOption}`,
    prompt: input.referenceUsage === "explore"
      ? `以图片1中的咖啡杯为主体，保留杯身造型，探索${targetOption}，方案${index + 1}`
      : `一只透明玻璃冰咖啡杯，木质桌面与自然侧光，探索${targetOption}，方案${index + 1}`
  }));
  if (input.referenceUsage === "explore") failingExploreOption = targetOptions[0];
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            locked: {
              intent: "咖啡视觉探索",
              subject: "透明玻璃冰咖啡杯",
              composition: "主体居中",
              palette: "棕色与米白",
              textLayout: "保留标题区域",
              constraints: ["主体名称保持一致"]
            },
            variants
          })
        }]
      }]
    })
  });
});

await page.route("**/images/generations", (route) => {
  generationRequests.push({
    contentType: route.request().headers()["content-type"] || "",
    body: JSON.parse(route.request().postData() || "{}")
  });
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: [{ b64_json: tinyPng.toString("base64") }] })
  });
});

await page.route("**/images/edits**", (route) => {
  const body = route.request().postDataBuffer()?.toString("utf8") || "";
  const requestRecord = {
    url: route.request().url(),
    contentType: route.request().headers()["content-type"] || "",
    body,
    prompt: multipartField(body, "prompt"),
    responseFormat: multipartField(body, "response_format")
  };
  editRequests.push(requestRecord);
  assert.match(requestRecord.contentType, /^multipart\/form-data; boundary=/, "编辑请求必须由浏览器生成 multipart boundary");
  assert.match(body, /name="image"; filename="reference\.png"/, "编辑请求必须携带原始参考图文件");
  assert.equal(multipartField(body, "aspect_ratio"), "3:4", "编辑接口必须使用 UI 画幅比例");

  if (!requestRecord.prompt.includes(failingExploreOption)) {
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ data: [{ b64_json: tinyPng.toString("base64") }] })
    });
  }
  if (requestRecord.responseFormat === "b64_json") {
    return route.fulfill({
      status: 422,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "response_format b64_json not supported" } })
    });
  }
  return route.fulfill({
    status: 500,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "test edit failure" } })
  });
});

async function readHistoryAndReferences() {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("workspace", "readonly");
    const store = transaction.objectStore("workspace");
    const [history, records] = await Promise.all([
      new Promise((resolve, reject) => {
        const request = store.get("generation-history");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
      new Promise((resolve, reject) => {
        const request = store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })
    ]);
    database.close();
    return {
      history,
      references: records
        .filter((record) => record?.kind === "reference-image")
        .map((record) => ({
          cacheKey: record.cacheKey,
          batchId: record.batchId,
          fileName: record.fileName,
          mimeType: record.mimeType,
          byteSize: record.byteSize,
          blobSize: record.blob?.size || 0
        }))
    };
  });
}

async function deleteReferenceCache(cacheKey) {
  await page.evaluate(async (key) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, cacheKey);
}

async function saveReferenceCache({ cacheKey, batchId }) {
  await page.evaluate(async ({ key, batch, base64 }) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const blob = new Blob([bytes], { type: "image/png" });
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({
        kind: "reference-image",
        cacheKey: key,
        batchId: batch,
        blob,
        fileName: "reference.png",
        mimeType: "image/png",
        byteSize: blob.size,
        savedAt: new Date().toISOString()
      }, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { key: cacheKey, batch: batchId, base64: tinyPng.toString("base64") });
}

async function waitForEditRequestCount(expectedCount) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (editRequests.length >= expectedCount) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`编辑请求数量未达到 ${expectedCount}，当前为 ${editRequests.length}`);
}

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
        imageGenerationMode: "sync"
      }, "api-settings");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });

  assert.equal(await page.locator("#referenceUsageField").isHidden(), true, "未上传图片时不应显示用途选择");
  await page.evaluate(() => {
    const NativeFileReader = window.FileReader;
    window.__restoreVisPathFileReader = () => { window.FileReader = NativeFileReader; };
    window.FileReader = class extends NativeFileReader {
      readAsDataURL(file) {
        if (file.name === "slow-reference.png") {
          window.setTimeout(() => super.readAsDataURL(file), 250);
          return;
        }
        super.readAsDataURL(file);
      }
    };
  });
  await page.locator("#referenceImage").setInputFiles({ name: "slow-reference.png", mimeType: "image/png", buffer: tinyPng });
  await page.locator("#referenceImage").setInputFiles({ name: "latest-reference.png", mimeType: "image/png", buffer: tinyPng });
  await page.locator("#filePreview").waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  assert.equal(await page.locator("#fileName").textContent(), "latest-reference.png", "较慢的旧图片读取不得覆盖最新选择");
  await page.evaluate(() => window.__restoreVisPathFileReader?.());
  await page.locator("#removeFileBtn").click();

  await page.locator("#referenceImage").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: tinyPng });
  await page.locator("#filePreview").waitFor({ state: "visible" });
  await page.locator("#referenceUsageField").waitFor({ state: "visible" });
  assert.equal(await page.locator("#referenceUsageAnalyze").isChecked(), true, "上传参考图后应默认仅分析提示词");

  await page.locator("#referenceUsageExplore").check();
  await page.locator("#removeFileBtn").click();
  assert.equal(await page.locator("#referenceUsageField").isHidden(), true, "移除图片后应隐藏用途选择");
  assert.equal(await page.locator("#referenceUsageAnalyze").isChecked(), true, "移除图片后应恢复默认分析模式");

  await page.locator("#referenceImage").setInputFiles({ name: "reference.png", mimeType: "image/png", buffer: tinyPng });
  if (process.env.REFERENCE_USAGE_SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.REFERENCE_USAGE_SCREENSHOT_PREFIX}-1440.png`, fullPage: false });
    await page.setViewportSize({ width: 900, height: 720 });
    await page.screenshot({ path: `${process.env.REFERENCE_USAGE_SCREENSHOT_PREFIX}-900.png`, fullPage: false });
    await page.setViewportSize({ width: 1440, height: 960 });
  }
  await page.locator("#generateBtn").click();
  await page.locator("[data-variant-id]").first().waitFor();
  assert.equal(textRequests[0].input.referenceUsage, "analyze", "默认模式必须进入文本请求");
  assert.equal(textRequests[0].body.input[0].content.some((item) => item.type === "input_image"), true, "分析模式仍应把参考图交给文本服务");
  assert.equal(await page.locator("#referenceUsageAnalyze").isDisabled(), true, "方案锁定后用途不可修改");

  const lockedFileName = await page.locator("#fileName").textContent();
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "locked-replacement.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  }, tinyPng.toString("base64"));
  assert.equal(await page.locator("#fileName").textContent(), lockedFileName, "方案锁定后粘贴图片不得绕过控件禁用");

  await page.locator('[data-variant-id] input[data-action="select"]').first().check();
  await page.locator("#submitSelectedBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length >= 1);
  assert.equal(generationRequests.length, 1, "仅分析模式必须调用文生图接口");
  assert.match(generationRequests[0].contentType, /^application\/json/, "文生图请求应保持 JSON");
  assert.equal(editRequests.length, 0, "仅分析模式不得调用编辑接口");

  await page.locator('[data-stage-target="setupStage"]').click();
  await page.locator("#editSetupBtn").click();
  await page.locator("#confirmEditSetupBtn").click();
  await page.locator("#referenceUsageExplore").check();
  await page.locator("#generateBtn").click();
  await page.locator("[data-variant-id]").first().waitFor();
  assert.equal(textRequests[1].input.referenceUsage, "explore", "参与探索模式必须进入文本请求");
  assert.match(textRequests[1].body.instructions, /图片1/, "参与探索的系统提示词应明确最终图片编号");

  await page.locator("#selectAllBtn").click();
  await page.locator("#submitSelectedBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".generation-status").length >= 4
    && document.querySelectorAll(".generation-status.loading").length === 0);

  const stored = await readHistoryAndReferences();
  const analyzeEntries = stored.history.entries.filter((entry) => entry.referenceUsage === "analyze");
  const exploreEntries = stored.history.entries.filter((entry) => entry.referenceUsage === "explore");
  assert.equal(analyzeEntries.length, 1, "仅分析模式记录应保留提交快照");
  assert.ok(analyzeEntries[0].referenceImageCacheKey, "仅分析模式也应缓存参考图以支持复用");
  assert.equal(exploreEntries.length, 3, "参与探索批次的每条记录都应保存用途");
  assert.equal(new Set(exploreEntries.map((entry) => entry.referenceImageCacheKey)).size, 1, "同批记录必须共享一个参考图缓存键");
  assert.equal(stored.references.length, 2, "两个提交批次应分别保存一份原始参考图 Blob");
  assert.ok(stored.references.every((reference) => reference.blobSize === tinyPng.length), "IndexedDB 应保存未压缩的原始参考图");
  assert.ok(stored.references.every((reference) => reference.fileName === "reference.png"));
  assert(editRequests.every((request) => request.url.endsWith("/images/edits")), "同步参与探索必须调用 /images/edits");
  assert(editRequests.some((request) => request.responseFormat === "b64_json"), "编辑请求应先尝试 Base64");
  assert(editRequests.some((request) => request.responseFormat === "url"), "Base64 不兼容时应回退 URL");

  const referenceCacheKey = exploreEntries[0].referenceImageCacheKey;
  const readyExploreEntry = exploreEntries.find((entry) => entry.status === "ready");
  await deleteReferenceCache(referenceCacheKey);
  const editCountBeforeReadyMissingCacheRetry = editRequests.length;
  await page.locator(`[data-generation-id="${readyExploreEntry.id}"] [data-action="retry"]`).click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForFunction(() => document.querySelector("#toast")?.textContent.includes("参考图缓存"));
  const readyEntryAfterMissingCache = (await readHistoryAndReferences()).history.entries.find((entry) => entry.id === readyExploreEntry.id);
  assert.equal(readyEntryAfterMissingCache.status, "ready", "参考图缓存缺失时不得破坏已经成功的图片结果");
  assert.equal(editRequests.length, editCountBeforeReadyMissingCacheRetry, "成功结果预检失败时不得继续提交编辑请求");
  await saveReferenceCache({ cacheKey: referenceCacheKey, batchId: readyExploreEntry.batchId });

  await page.locator(`[data-generation-id="${readyExploreEntry.id}"] [data-action="delete"]`).click();
  await page.waitForTimeout(6000);
  assert.equal((await readHistoryAndReferences()).references.length, 2, "删除同批一条记录时不得误删仍被引用的参考图");

  await page.reload({ waitUntil: "networkidle" });
  const failedEntry = (await readHistoryAndReferences()).history.entries.find((entry) => entry.referenceUsage === "explore" && entry.status === "error");
  const editCountBeforeRetry = editRequests.length;
  await page.locator(`[data-generation-id="${failedEntry.id}"] [data-action="retry"]`).click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await waitForEditRequestCount(editCountBeforeRetry + 2);
  await page.waitForFunction((entryId) => document.querySelector(`[data-generation-id="${entryId}"] .generation-status`)?.classList.contains("error"), failedEntry.id);
  assert.equal(editRequests.length, editCountBeforeRetry + 2, "刷新后的重试与 URL 回退都必须重新携带参考图");

  await deleteReferenceCache(referenceCacheKey);

  const editCountBeforeMissingCacheRetry = editRequests.length;
  await page.locator(`[data-generation-id="${failedEntry.id}"] [data-action="retry"]`).click();
  await page.locator("#confirmRetryGenerationBtn").click();
  await page.waitForFunction((entryId) => document.querySelector(`[data-generation-id="${entryId}"]`)?.textContent.includes("参考图缓存"), failedEntry.id);
  assert.equal(editRequests.length, editCountBeforeMissingCacheRetry, "参考图缓存缺失时不得静默退化或继续请求");

  await saveReferenceCache({ cacheKey: referenceCacheKey, batchId: failedEntry.batchId });

  const remainingExploreEntries = (await readHistoryAndReferences()).history.entries
    .filter((entry) => entry.referenceUsage === "explore");
  await page.locator(`[data-generation-id="${remainingExploreEntries[0].id}"] [data-action="delete"]`).click();
  await page.waitForTimeout(3000);
  await page.locator(`[data-generation-id="${remainingExploreEntries[1].id}"] [data-action="delete"]`).click();
  await page.waitForTimeout(3000);
  assert.equal((await readHistoryAndReferences()).references.length, 2, "另一条记录仍在撤销期时不得提前清理共享参考图");
  await page.waitForTimeout(3000);
  assert.equal((await readHistoryAndReferences()).references.length, 1, "删除最后一条探索记录后应只保留其他批次的参考图 Blob");

  console.log("reference image usage test passed");
} finally {
  await Promise.race([context.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 5000))]);
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}
process.exit(0);
