import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const imageDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
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

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(5000);

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(async ({ imageDataUrl }) => {
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
          id: "legacy_base64_entry",
          batchId: "legacy_base64_batch",
          batchNumber: "01",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "旧 Base64 图片",
          changeSummary: "迁移历史图片",
          promptSnapshot: "旧 Base64 图片提示词",
          generationMode: "async",
          responseFormat: "b64_json",
          actualResponseFormat: "b64_json",
          createdAt: "12:00",
          status: "ready",
          imageUrl: imageDataUrl
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { imageDataUrl });

  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.generation-card[data-generation-id="legacy_base64_entry"] img').waitFor({ state: "visible" });
  let migrationReady = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    migrationReady = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("workspace", "readonly");
      const store = transaction.objectStore("workspace");
      const [history, cache] = await Promise.all([
        new Promise((resolve, reject) => {
          const request = store.get("generation-history");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        }),
        new Promise((resolve, reject) => {
          const request = store.get("generation-image-cache:legacy_base64_entry");
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        })
      ]);
      database.close();
      const entry = history?.entries?.find((item) => item.id === "legacy_base64_entry");
      return entry?.imageUrl === "" && entry.imageCacheStatus === "ready" && cache?.blob instanceof Blob && cache.blob.size > 0;
    });
    if (migrationReady) break;
    await page.waitForTimeout(100);
  }
  assert(migrationReady, "旧 Base64 历史未自动迁移为 Blob 单一持久化");

  const migrated = await page.evaluate(async () => {
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
      const request = store.get("generation-image-cache:legacy_base64_entry");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { entry: history.entries[0], cacheSize: cache.blob.size, cacheType: cache.blob.type };
  });
  assert(migrated.entry.imageUrl === "", "旧 Base64 迁移后仍完整保存在历史记录中");
  assert(migrated.entry.originalImageUrl === "", "Base64 不应复制到原始 URL 元数据");
  assert(migrated.entry.imageCacheKey === "generation-image-cache:legacy_base64_entry", "旧 Base64 迁移后未保存缓存引用");
  assert(migrated.entry.imageByteSize === migrated.cacheSize && migrated.entry.imageMimeType === migrated.cacheType, "历史缓存元数据与 Blob 不一致");
  assert((await page.locator('.generation-card[data-generation-id="legacy_base64_entry"] img').getAttribute("src")).startsWith("blob:"), "旧 Base64 迁移后页面未切换到 Blob 地址");

  await page.reload({ waitUntil: "networkidle" });
  await page.locator('.generation-card[data-generation-id="legacy_base64_entry"] img').waitFor({ state: "visible" });
  assert((await page.locator('.generation-card[data-generation-id="legacy_base64_entry"] img').getAttribute("src")).startsWith("blob:"), "刷新后未从 Blob 恢复已迁移图片");

  const failedImageUrl = "https://image.example/cache-failure.png";
  await page.route(failedImageUrl, (route) => route.fulfill({ status: 503, contentType: "text/plain", body: "unavailable" }));
  await page.evaluate(async ({ failedImageUrl }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      store.put({
        schemaVersion: 10,
        batchNumber: 2,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "cache_failure_entry",
          batchId: "cache_failure_batch",
          batchNumber: "02",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "缓存失败图片",
          changeSummary: "保留原始来源",
          promptSnapshot: "缓存失败保护提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:10",
          status: "ready",
          imageUrl: failedImageUrl
        }]
      }, "generation-history");
      store.delete("generation-image-cache:legacy_base64_entry");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { failedImageUrl });
  await page.reload({ waitUntil: "networkidle" });

  let failedCacheState = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    failedCacheState = await page.evaluate(async () => {
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
        const request = store.get("generation-image-cache:cache_failure_entry");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return { entry: history?.entries?.[0], hasCache: Boolean(cache) };
    });
    if (failedCacheState.entry?.imageCacheStatus === "error") break;
    await page.waitForTimeout(100);
  }
  assert(failedCacheState.entry.imageCacheStatus === "error", "图片缓存失败后未记录可重试状态");
  assert(failedCacheState.entry.imageUrl === failedImageUrl, "图片缓存失败时提前清除了原始 URL");
  assert(!failedCacheState.hasCache, "图片缓存失败时留下了无效 Blob 记录");
  const cacheFailureCard = page.locator('.generation-card[data-generation-id="cache_failure_entry"]');
  assert((await cacheFailureCard.locator(".generation-image-cache-error").textContent()).includes("临时图片链接无法长期保存"), "远程图片缓存失败后未显示临时链接说明");
  assert(await cacheFailureCard.locator('[data-action="retry-image-cache"]').count() === 0, "远程图片不可读时仍提供无效的重新缓存入口");
  assert(await cacheFailureCard.locator('[data-action="recover-image-file"]').count() === 0, "结果卡仍直接显示选择本地图片");
  assert(await cacheFailureCard.locator('[data-action="open-image-recovery"]').isVisible(), "远程图片不可读时未提供恢复选项入口");
  assert(await cacheFailureCard.locator('[data-action="download-image"]').isEnabled(), "图片缓存失败后未保留下载入口");
  await cacheFailureCard.locator('[data-action="open-image-recovery"]').click();
  assert(await page.locator("#imageRecoveryOptionsDialog").isVisible(), "恢复选项未打开独立弹窗");
  assert(await page.locator("#regenerateFromRecoveryBtn").isVisible(), "恢复弹窗未提供重新生成主路径");
  assert(await page.locator("#recoverImageFromFileBtn").isVisible(), "恢复弹窗未提供本地备份次级入口");
  await page.locator("#recoverImageFromFileBtn").click();
  await page.locator("#imageRecoveryFileInput").setInputFiles({
    name: "recovered-image.png",
    mimeType: "image/png",
    buffer: Buffer.from(imageDataUrl.split(",")[1], "base64")
  });
  await page.waitForFunction(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const store = database.transaction("workspace", "readonly").objectStore("workspace");
    const read = (key) => new Promise((resolve, reject) => {
      const request = store.get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const [history, cache] = await Promise.all([
      read("generation-history"),
      read("generation-image-cache:cache_failure_entry")
    ]);
    database.close();
    return history?.entries?.[0]?.imageCacheStatus === "ready" && cache?.blob instanceof Blob && cache.blob.size > 0;
  });
  assert(await cacheFailureCard.locator(".generation-image-cache-error").count() === 0, "选择本地图片补回缓存后仍显示失败状态");
  assert((await cacheFailureCard.locator("img").getAttribute("src")).startsWith("blob:"), "选择本地图片后未切换为 Blob 显示");

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
        schemaVersion: 11,
        batchNumber: 3,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "missing_image_entry",
          batchId: "missing_image_batch",
          batchNumber: "03",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "缓存已丢失图片",
          changeSummary: "验证缺失恢复状态",
          promptSnapshot: "缓存丢失后重新生成提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:15",
          status: "ready",
          imageUrl: "",
          originalImageUrl: "",
          imageCacheKey: "generation-image-cache:missing_image_entry",
          imageCacheStatus: "ready"
        }]
      }, "generation-history");
      store.delete("generation-image-cache:missing_image_entry");
      store.delete("generation-image-cache:cache_failure_entry");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });
  const missingImageCard = page.locator('.generation-card[data-generation-id="missing_image_entry"]');
  assert((await missingImageCard.locator(".generation-state.error strong").textContent()).includes("本地图片缓存已丢失"), "缓存和原始来源都缺失时仍显示为生成中");
  assert(await missingImageCard.locator('[data-action="recover-image-file"]').count() === 0, "缓存丢失状态仍直接显示选择文件");
  assert(await missingImageCard.locator('[data-action="open-image-recovery"]').count() === 1, "本地图片缓存丢失时未提供恢复选项入口");
  assert(await missingImageCard.locator('[data-action="download-image"]').isDisabled(), "图片来源完全丢失时仍允许下载空地址");
  assert(await missingImageCard.locator('[data-action="retry"]').isEnabled(), "图片来源完全丢失时未保留重新生成入口");

  await page.evaluate(async ({ imageDataUrl }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      store.put({
        schemaVersion: 11,
        batchNumber: 4,
        savedAt: new Date().toISOString(),
        entries: ["multi_cache_entry_a", "multi_cache_entry_b"].map((id, index) => ({
          id,
          batchId: "multi_cache_batch",
          batchNumber: "04",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: `连续缓存图片 ${index + 1}`,
          changeSummary: "验证多张图片连续缓存",
          promptSnapshot: `连续缓存提示词 ${index + 1}`,
          generationMode: "async",
          responseFormat: "b64_json",
          actualResponseFormat: "b64_json",
          createdAt: `12:${20 + index}`,
          status: "ready",
          imageUrl: imageDataUrl
        }))
      }, "generation-history");
      store.delete("generation-image-cache:multi_cache_entry_a");
      store.delete("generation-image-cache:multi_cache_entry_b");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { imageDataUrl });
  await page.reload({ waitUntil: "networkidle" });
  let multiCacheReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    multiCacheReady = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = database.transaction("workspace", "readonly").objectStore("workspace");
      const read = (key) => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [history, cacheA, cacheB] = await Promise.all([
        read("generation-history"),
        read("generation-image-cache:multi_cache_entry_a"),
        read("generation-image-cache:multi_cache_entry_b")
      ]);
      database.close();
      return history?.entries?.every((entry) => entry.imageUrl === "" && entry.imageCacheStatus === "ready")
        && cacheA?.blob instanceof Blob && cacheA.blob.size > 0
        && cacheB?.blob instanceof Blob && cacheB.blob.size > 0;
    });
    if (multiCacheReady) break;
    await page.waitForTimeout(100);
  }
  assert(multiCacheReady, "多张 Base64 图片未完成 Blob 缓存");
  const multiCacheSources = await page.locator('.generation-card[data-generation-id^="multi_cache_entry_"] img').evaluateAll((images) => images.map((image) => image.getAttribute("src")));
  assert(multiCacheSources.length === 2 && multiCacheSources.every((source) => source.startsWith("blob:")), "多张图片连续缓存后未全部切换为 Blob 显示");

  const unavailableIndexedDbUrl = "https://image.example/indexeddb-unavailable.png";
  let delayUnavailableCacheFetch = true;
  await page.route(unavailableIndexedDbUrl, async (route) => {
    if (delayUnavailableCacheFetch && route.request().resourceType() === "fetch") await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({
      status: 200,
      contentType: "image/png",
      body: Buffer.from(imageDataUrl.split(",")[1], "base64")
    });
  });
  await page.context().addInitScript(() => {
    const originalOpen = indexedDB.open.bind(indexedDB);
    indexedDB.open = function open() {
      if (localStorage.getItem("simulate-indexeddb-unavailable") === "1") {
        throw new DOMException("Injected IndexedDB unavailable", "InvalidStateError");
      }
      return originalOpen(...arguments);
    };
  });
  await page.evaluate(async ({ unavailableIndexedDbUrl }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({
        schemaVersion: 11,
        batchNumber: 5,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "indexeddb_unavailable_entry",
          batchId: "indexeddb_unavailable_batch",
          batchNumber: "05",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "IndexedDB 暂不可用",
          changeSummary: "验证本地存储不可用保护",
          promptSnapshot: "IndexedDB 不可用提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:30",
          status: "ready",
          imageUrl: unavailableIndexedDbUrl
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { unavailableIndexedDbUrl });
  await page.reload({ waitUntil: "domcontentloaded" });
  const unavailableCard = page.locator('.generation-card[data-generation-id="indexeddb_unavailable_entry"]');
  await unavailableCard.locator("img").waitFor({ state: "attached" });
  await page.evaluate(() => localStorage.setItem("simulate-indexeddb-unavailable", "1"));
  await unavailableCard.locator(".generation-image-cache-error").waitFor({ state: "visible" });
  assert((await unavailableCard.locator(".generation-image-cache-error").textContent()).includes("浏览器本地缓存写入失败"), "IndexedDB 不可用时未显示本地存储错误");
  assert(await unavailableCard.locator("img").getAttribute("src") === unavailableIndexedDbUrl, "IndexedDB 不可用时未保留远程图片来源");
  assert(await unavailableCard.locator('[data-action="download-image"]').isEnabled(), "IndexedDB 不可用时未保留下载入口");
  assert(await unavailableCard.locator('[data-action="retry-image-cache"]').isVisible(), "IndexedDB 恢复后缺少重新缓存入口");
  await page.evaluate(() => localStorage.removeItem("simulate-indexeddb-unavailable"));
  delayUnavailableCacheFetch = false;
  await unavailableCard.locator('[data-action="retry-image-cache"]').click();
  let retryCacheReady = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    retryCacheReady = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = database.transaction("workspace", "readonly").objectStore("workspace");
      const read = (key) => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [history, cache] = await Promise.all([
        read("generation-history"),
        read("generation-image-cache:indexeddb_unavailable_entry")
      ]);
      database.close();
      const entry = history?.entries?.find((item) => item.id === "indexeddb_unavailable_entry");
      return entry?.imageCacheStatus === "ready" && entry.imageCacheBackend === "blob" && cache?.blob instanceof Blob && cache.blob.size > 0;
    });
    if (retryCacheReady) break;
    await page.waitForTimeout(100);
  }
  assert(retryCacheReady, "IndexedDB 恢复后重新缓存未完成");
  assert(await unavailableCard.locator(".generation-image-cache-error").count() === 0, "IndexedDB 恢复后重新缓存仍显示失败状态");

  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      const blob = new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" });
      store.put({
        schemaVersion: 11,
        batchNumber: 3,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "referenced_cache_entry",
          batchId: "cache_cleanup_batch",
          batchNumber: "03",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "保留的缓存",
          changeSummary: "验证缓存引用",
          promptSnapshot: "缓存清理提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:20",
          status: "ready",
          imageUrl: "",
          originalImageUrl: "",
          imageCacheKey: "generation-image-cache:referenced_cache_entry",
          imageCacheStatus: "ready",
          imageMimeType: "image/png",
          imageByteSize: blob.size
        }]
      }, "generation-history");
      store.put({ entryId: "referenced_cache_entry", imageUrl: "", blob, mimeType: blob.type, byteSize: blob.size, savedAt: new Date().toISOString() }, "generation-image-cache:referenced_cache_entry");
      store.put({ entryId: "orphan_cache_entry", imageUrl: "", blob, mimeType: blob.type, byteSize: blob.size, savedAt: new Date().toISOString() }, "generation-image-cache:orphan_cache_entry");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });

  let orphanCleanupState = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    orphanCleanupState = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = database.transaction("workspace", "readonly").objectStore("workspace");
      const read = (key) => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [referenced, orphan] = await Promise.all([
        read("generation-image-cache:referenced_cache_entry"),
        read("generation-image-cache:orphan_cache_entry")
      ]);
      database.close();
      return { hasReferenced: Boolean(referenced), hasOrphan: Boolean(orphan) };
    });
    if (!orphanCleanupState.hasOrphan) break;
    await page.waitForTimeout(100);
  }
  assert(orphanCleanupState.hasReferenced, "孤立缓存清理误删了仍被历史引用的 Blob");
  assert(!orphanCleanupState.hasOrphan, "刷新后未清理无历史引用的孤立 Blob");

  const referencedBatch = page.locator(".generation-batch");
  if (await referencedBatch.getAttribute("open") === null) await referencedBatch.locator(":scope > summary").click();
  const deletedObjectUrl = await page.locator('.generation-card[data-generation-id="referenced_cache_entry"] img').getAttribute("src");
  await page.locator('.generation-card[data-generation-id="referenced_cache_entry"] [data-action="delete"]').click();
  assert(await page.evaluate(async (url) => (await fetch(url)).ok, deletedObjectUrl), "撤销期内临时 Blob 地址被过早释放");
  await page.waitForTimeout(5700);
  const deletedCacheState = await page.evaluate(async ({ deletedObjectUrl }) => {
    const objectUrlStillReadable = await fetch(deletedObjectUrl).then((response) => response.ok, () => false);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const cache = await new Promise((resolve, reject) => {
      const request = database.transaction("workspace", "readonly").objectStore("workspace").get("generation-image-cache:referenced_cache_entry");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return { objectUrlStillReadable, hasCache: Boolean(cache) };
  }, { deletedObjectUrl });
  assert(!deletedCacheState.hasCache, "删除撤销期结束后仍保留 IndexedDB Blob");
  assert(!deletedCacheState.objectUrlStillReadable, "删除撤销期结束后未释放临时 Blob 地址");

  await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      const store = transaction.objectStore("workspace");
      const blob = new Blob([new Uint8Array(2048)], { type: "image/png" });
      store.put({
        schemaVersion: 11,
        batchNumber: 4,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "storage_stats_entry",
          batchId: "storage_stats_batch",
          batchNumber: "04",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "容量统计图片",
          changeSummary: "验证容量拆分",
          promptSnapshot: "容量统计提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:30",
          status: "ready",
          imageUrl: "",
          originalImageUrl: "",
          imageCacheKey: "generation-image-cache:storage_stats_entry",
          imageCacheStatus: "ready",
          imageMimeType: "image/png",
          imageByteSize: blob.size
        }]
      }, "generation-history");
      store.put({ entryId: "storage_stats_entry", imageUrl: "", blob, mimeType: blob.type, byteSize: blob.size, savedAt: new Date().toISOString() }, "generation-image-cache:storage_stats_entry");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator("#historyManageBtn").click();
  await page.waitForFunction(() => ["historyDataSize", "historyImageCacheSize", "historyStorageEstimate"].every((id) => document.getElementById(id)?.textContent !== "--"));
  const storageBreakdown = {
    history: await page.locator("#historyDataSize").textContent(),
    images: await page.locator("#historyImageCacheSize").textContent(),
    total: await page.locator("#historyStorageEstimate").textContent()
  };
  assert(storageBreakdown.history !== "--" && /B$/.test(storageBreakdown.history), "历史管理未单独统计历史数据大小");
  assert(storageBreakdown.images === "2 KB", `图片 Blob 缓存统计不准确：${storageBreakdown.images}`);
  assert(storageBreakdown.total !== "--" && /B$/.test(storageBreakdown.total), "历史管理未显示本站总存储占用");
  assert(await page.locator("#historyEntryCount").textContent() === "1" && await page.locator("#historyImageCount").textContent() === "1", "历史管理数量统计与缓存引用不一致");
  await page.locator("#historyKeepCount").selectOption("0");
  await page.locator("#cleanupHistoryBtn").click();
  await page.waitForTimeout(5700);
  await page.locator("#historyManageBtn").click();
  await page.waitForFunction(() => document.getElementById("historyImageCacheSize")?.textContent === "0 B");
  assert(await page.locator("#historyDataSize").textContent() !== storageBreakdown.history, "清空历史后历史数据大小没有变化");
  assert(await page.locator("#historyImageCacheSize").textContent() === "0 B", "清空历史撤销期结束后图片 Blob 占用未归零");
  assert(await page.locator("#historyEntryCount").textContent() === "0", "清空历史后结果数量未归零");

  const referenceFailureUrl = "https://image.example/reference-write-failure.png";
  await page.route(referenceFailureUrl, (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64")
  }));
  await page.context().addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(value, key) {
      const shouldFail = key === "generation-history"
        && localStorage.getItem("fail-generation-cache-reference-once") === "1"
        && value?.entries?.some((entry) => entry.id === "reference_failure_entry" && entry.imageCacheStatus === "ready");
      if (shouldFail) {
        localStorage.removeItem("fail-generation-cache-reference-once");
        throw new DOMException("Injected history write failure", "QuotaExceededError");
      }
      return originalPut.apply(this, arguments);
    };
  });
  await page.evaluate(async ({ referenceFailureUrl }) => {
    localStorage.setItem("fail-generation-cache-reference-once", "1");
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({
        schemaVersion: 11,
        batchNumber: 5,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "reference_failure_entry",
          batchId: "reference_failure_batch",
          batchNumber: "05",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "引用写入失败",
          changeSummary: "保留原始来源",
          promptSnapshot: "引用写入失败提示词",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:40",
          status: "ready",
          imageUrl: referenceFailureUrl
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { referenceFailureUrl });
  await page.reload({ waitUntil: "domcontentloaded", timeout: 10000 });

  let referenceFailureState = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    referenceFailureState = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const store = database.transaction("workspace", "readonly").objectStore("workspace");
      const read = (key) => new Promise((resolve, reject) => {
        const request = store.get(key);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const [history, cache] = await Promise.all([
        read("generation-history"),
        read("generation-image-cache:reference_failure_entry")
      ]);
      database.close();
      return { entry: history?.entries?.[0], hasCache: Boolean(cache) };
    });
    if (referenceFailureState.entry?.imageCacheStatus === "error") break;
    await page.waitForTimeout(100);
  }
  const referenceFailureSource = await page.locator('.generation-card[data-generation-id="reference_failure_entry"] img').getAttribute("src");
  assert(referenceFailureState.entry.imageUrl === referenceFailureUrl && referenceFailureSource === referenceFailureUrl, "缓存引用写入失败时提前移除了原始图片来源");
  assert(referenceFailureState.entry.imageCacheStatus === "error" && !referenceFailureState.hasCache, "缓存引用写入失败后未回滚 Blob 并标记重试状态");

  console.log("history image storage test passed");
} finally {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

process.exit(0);
