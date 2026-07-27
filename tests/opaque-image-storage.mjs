import { createServer } from "node:http";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const imageBuffer = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z2d0AAAAASUVORK5CYII=",
  "base64"
);
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve(server.address().port);
    });
  });
}

function close(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function openContext(profileDir, executablePath) {
  return chromium.launchPersistentContext(profileDir, {
    headless: true,
    executablePath,
    viewport: { width: 1440, height: 960 }
  });
}

const imageServer = createServer((request, response) => {
  if (request.url !== "/generated.png") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }
  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "image/png",
    "Content-Length": imageBuffer.length
  });
  response.end(imageBuffer);
});
const imagePort = await listen(imageServer);
const imageUrl = `http://127.0.0.1:${imagePort}/generated.png`;
const executablePath = await findBrowserExecutable();
const profileDir = await mkdtemp(join(tmpdir(), "vispath-opaque-storage-"));
const contexts = new Set();
const firstContext = await openContext(profileDir, executablePath);
contexts.add(firstContext);
const page = firstContext.pages()[0] || await firstContext.newPage();
page.setDefaultTimeout(6000);

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.evaluate(async ({ imageUrl }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put({
        schemaVersion: 12,
        batchNumber: 1,
        savedAt: new Date().toISOString(),
        entries: [{
          id: "opaque_cache_entry",
          batchId: "opaque_cache_batch",
          batchNumber: "01",
          batchCreatedAt: new Date().toISOString(),
          variantTitle: "Opaque 缓存图片",
          changeSummary: "验证无 CORS 图片自动持久化",
          promptSnapshot: "无 CORS 图片缓存测试",
          generationMode: "async",
          responseFormat: "url",
          actualResponseFormat: "url",
          createdAt: "12:00",
          status: "ready",
          imageUrl
        }]
      }, "generation-history");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { imageUrl });

  await page.reload({ waitUntil: "networkidle" });
  let cacheState;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    cacheState = await page.evaluate(async ({ imageUrl }) => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open("ai-visual-direction-board", 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = database.transaction("workspace", "readonly");
      const history = await new Promise((resolve, reject) => {
        const request = transaction.objectStore("workspace").get("generation-history");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      const entry = history?.entries?.find((item) => item.id === "opaque_cache_entry");
      const response = await caches.match(imageUrl);
      return { entry, responseType: response?.type || "" };
    }, { imageUrl });
    if (cacheState.entry?.imageCacheBackend === "opaque" && cacheState.responseType === "opaque") break;
    await page.waitForTimeout(100);
  }
  assert(cacheState.entry?.imageCacheStatus === "ready", `opaque 缓存未进入 ready，实际为 ${cacheState.entry?.imageCacheStatus || "空"}`);
  assert(cacheState.entry?.imageCacheBackend === "opaque", `历史未记录 opaque 后端，实际为 ${cacheState.entry?.imageCacheBackend || "空"}`);
  assert(cacheState.entry.imageUrl === imageUrl && cacheState.entry.originalImageUrl === imageUrl, "opaque 缓存未保留稳定远程请求键");
  assert(cacheState.responseType === "opaque", `Cache Storage 响应类型错误，实际为 ${cacheState.responseType || "空"}`);

  const card = page.locator('.generation-card[data-generation-id="opaque_cache_entry"]');
  assert(await card.locator("img").isVisible(), "opaque 缓存完成后图片未显示");
  assert(await card.locator(".generation-image-cache-error").count() === 0, "opaque 缓存成功后仍显示缓存失败");
  await page.locator("#historyManageBtn").click();
  await page.locator("#historyImageCacheSize").waitFor({ state: "visible" });
  assert((await page.locator("#historyImageCacheSize").textContent()).includes("1 张链接缓存"), "历史管理未标明 opaque 图片缓存数量");
  await page.locator("#cancelHistoryBtn").click();

  await firstContext.close();
  contexts.delete(firstContext);
  await close(imageServer);

  const secondContext = await openContext(profileDir, executablePath);
  contexts.add(secondContext);
  const reopenedPage = secondContext.pages()[0] || await secondContext.newPage();
  reopenedPage.setDefaultTimeout(7000);
  await reopenedPage.goto(appUrl, { waitUntil: "networkidle" });
  await reopenedPage.reload({ waitUntil: "networkidle" });
  const reopenedCard = reopenedPage.locator('.generation-card[data-generation-id="opaque_cache_entry"]');
  await reopenedCard.locator("img").waitFor({ state: "visible" });
  assert(await reopenedCard.locator("img").evaluate((image) => image.complete && image.naturalWidth > 0), "图片源关闭且浏览器重启后未从 opaque 缓存恢复");
  assert(await reopenedCard.locator(".generation-image-cache-error").count() === 0, "浏览器重启后 opaque 缓存被错误标记为失败");

  const restoredState = await reopenedPage.evaluate(async ({ imageUrl }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = database.transaction("workspace", "readonly");
    const history = await new Promise((resolve, reject) => {
      const request = transaction.objectStore("workspace").get("generation-history");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const entry = history?.entries?.find((item) => item.id === "opaque_cache_entry");
    const response = await caches.match(imageUrl);
    return { entry, responseType: response?.type || "" };
  }, { imageUrl });
  assert(restoredState.entry?.imageCacheStatus === "ready" && restoredState.entry.imageCacheBackend === "opaque", "浏览器重启后历史未保持 opaque ready 状态");
  assert(restoredState.responseType === "opaque", "浏览器重启后 Cache Storage 中的 opaque 响应丢失");

  await reopenedCard.locator('[data-action="delete"]').click();
  await reopenedPage.waitForTimeout(6000);
  assert(await reopenedPage.evaluate(async (url) => !await caches.match(url), imageUrl), "删除记录后未清理 opaque Cache Storage");
  await secondContext.close();
  contexts.delete(secondContext);
  console.log("opaque image storage test passed");
} finally {
  await Promise.all([...contexts].map((context) => context.close().catch(() => {})));
  await close(imageServer);
  await rm(profileDir, { recursive: true, force: true });
}
