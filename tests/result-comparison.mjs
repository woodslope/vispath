import { access } from "node:fs/promises";
import { chromium } from "playwright";

const appUrl = process.env.APP_URL || "http://127.0.0.1:8771/";
const browserCandidates = [
  process.env.BROWSER_EXECUTABLE,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
].filter(Boolean);
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

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
  await page.evaluate(async ({ imageUrl }) => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction("workspace", "readwrite");
        transaction.objectStore("workspace").put({
          schemaVersion: 5,
          batchNumber: 1,
          savedAt: "2026-07-13T12:00:00.000Z",
          entries: [
            {
              id: "compare_portrait",
              batchId: "batch_compare",
              batchNumber: "01",
              batchCreatedAt: "2026-07-13T12:00:00.000Z",
              variantTitle: "竖版 IP",
              changeSummary: "3:4 角色卡",
              promptSnapshot: "竖版提示词",
              artClass: "art-editorial",
              ratio: "3:4",
              resolution: "1K",
              createdAt: "12:00",
              startedAt: "2026-07-13T12:00:00.000Z",
              completedAt: "2026-07-13T12:03:00.000Z",
              status: "ready",
              imageUrl
            },
            {
              id: "compare_wide",
              batchId: "batch_compare",
              batchNumber: "01",
              batchCreatedAt: "2026-07-13T12:00:00.000Z",
              variantTitle: "横版 IP",
              changeSummary: "16:9 场景卡",
              promptSnapshot: "横版提示词",
              artClass: "art-future",
              ratio: "16:9",
              resolution: "1K",
              createdAt: "12:00",
              startedAt: "2026-07-13T12:00:00.000Z",
              completedAt: "2026-07-13T12:03:10.000Z",
              status: "ready",
              imageUrl
            }
          ]
        }, "generation-history");
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, { imageUrl });
  await page.reload({ waitUntil: "networkidle" });
  await page.locator(".generation-card").first().waitFor();

  const favoriteButtons = page.locator('[data-action="toggle-favorite"]');
  assert(await favoriteButtons.count() === 2, "每条完成结果都应提供收藏按钮");
  await favoriteButtons.first().click();
  assert(await favoriteButtons.first().getAttribute("aria-pressed") === "true", "收藏状态未即时更新");
  await page.reload({ waitUntil: "networkidle" });
  assert(await page.locator('[data-action="toggle-favorite"]').first().getAttribute("aria-pressed") === "true", "收藏状态刷新后未保留");

  const compareButton = page.locator('[data-action="compare-batch"]');
  assert(await compareButton.count() === 1, "批次标题缺少对比入口");
  assert(!(await compareButton.isDisabled()), "包含两条完成图片的批次不应禁用对比");
  await page.locator("#resultSearchInput").fill("竖版");
  assert(!(await page.locator('[data-action="compare-batch"]').isDisabled()), "筛选单条结果后不应误禁用整批对比");
  await page.locator("#clearResultFiltersBtn").click();
  await compareButton.click();
  assert(await page.locator("#comparisonDialog").isVisible(), "点击批次对比后未打开弹窗");
  const comparisonClose = await page.locator("#closeComparisonBtn").evaluate((button) => {
    const box = button.getBoundingClientRect();
    const icon = button.querySelector("svg.ui-icon").getBoundingClientRect();
    return {
      width: box.width,
      height: box.height,
      centerDeltaX: Math.abs((box.left + box.width / 2) - (icon.left + icon.width / 2)),
      centerDeltaY: Math.abs((box.top + box.height / 2) - (icon.top + icon.height / 2))
    };
  });
  assert(comparisonClose.width === 32 && comparisonClose.height === 32 && comparisonClose.centerDeltaX <= .5 && comparisonClose.centerDeltaY <= .5, "批次对比弹窗图标按钮未遵循 32px 居中规范");
  assert(await page.locator(".comparison-item").count() === 2, "对比弹窗未展示该批次的两条完成结果");
  assert(await page.locator(".comparison-item.is-favorite").count() === 1, "对比弹窗未同步收藏状态");
  const comparisonLayout = await page.locator("#comparisonDialog").evaluate((dialog) => ({
    horizontalOverflow: dialog.scrollWidth > dialog.clientWidth,
    gridHorizontalOverflow: dialog.querySelector("#comparisonGrid").scrollWidth > dialog.querySelector("#comparisonGrid").clientWidth,
    visibleHeight: dialog.getBoundingClientRect().height
  }));
  assert(!comparisonLayout.horizontalOverflow && !comparisonLayout.gridHorizontalOverflow, "对比弹窗存在横向溢出");
  assert(comparisonLayout.visibleHeight <= 912, "对比弹窗超出当前桌面视口");
  if (process.env.SCREENSHOT_PATH) await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: false });

  const storedSchema = await page.evaluate(async () => new Promise((resolve, reject) => {
    const request = indexedDB.open("ai-visual-direction-board", 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction("workspace", "readonly");
      const getRequest = transaction.objectStore("workspace").get("generation-history");
      getRequest.onsuccess = () => resolve(getRequest.result?.schemaVersion);
      getRequest.onerror = () => reject(getRequest.error);
      transaction.oncomplete = () => database.close();
    };
  }));
  assert(storedSchema === 17, "历史记录未迁移到 schema v17");

  console.log("result comparison test passed");
} finally {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}

process.exit(0);
