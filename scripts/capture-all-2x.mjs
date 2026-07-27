import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const screenshots = path.join(root, "screenshots");
const baseUrl = "http://127.0.0.1:4175/index.html";
const prompt = "为一场名为「城市苔原夜游」的城市植物夜展设计 3:4 新品发布主视觉。固定主体是一枚透明、生物形态的玻璃种子舱，内部包含可见的微型苔藓生态，悬浮在湿润的黑色矿石台座上。目标受众是 22—38 岁、关注设计、自然与夜间文化体验的城市人群。画面需要高级、克制但具有沉浸感；主体保持清晰，位于画面中下部，上方预留中文主标题区，底部预留日期、地址与票务信息区。请只围绕「设计风格」生成四个差异足够明显的视觉方向，保持主体、用途、3:4 比例、信息区域和无真实文字限制不变。避免普通商业海报、廉价霓虹、杂乱装饰、科幻机械、人物和水印。";
const directions = [
  ["极简编辑方向", "以暖白、柔和棚拍和克制材质建立高级编辑感", "极简编辑风格，暖白留白背景，透明玻璃种子舱悬浮于粗粝黑色矿石台座之上，柔和聚光灯与细腻胶片颗粒，主体位于中下部，上方与底部保留信息区，无人物、无水印、无真实文字。"],
  ["透明材质方向", "以折射、流态玻璃和冷光层次强化未来感", "透明材质未来风格，生物形态玻璃种子舱包裹微型苔藓生态，深色环境中呈现冷绿折射和液态高光，黑色矿石台座，沉浸但克制，保留海报信息区，无机械、无人物、无水印。"],
  ["实验拼贴方向", "以纸张纤维、网点和几何切片建立文化展览感", "实验性文化拼贴风格，透明玻璃种子舱与真实苔藓保持摄影质感，叠加撕纸纤维、植物标本、网点和克制几何色块，黑白与酸性绿色点缀，保留标题和活动信息区，无真实文字、无水印。"],
  ["夜间摄影方向", "以湿润薄雾、深蓝夜色和电影光塑造沉浸氛围", "夜间电影摄影风格，透明玻璃种子舱在湿润黑色矿石台座上发出微弱绿色生命光，深蓝森林、薄雾、露水和柔和轮廓光，主体清晰，信息区域完整，无人物、无水印、无真实文字。"]
];
const blueprint = {
  locked: { intent: "城市植物夜展新品发布主视觉", subject: "透明玻璃种子舱与微型苔藓生态", context: "城市夜间植物展", audience: "22—38 岁城市设计与自然爱好者", composition: "主体中下部，上下保留信息区", textLayout: "上方标题区，底部日期地址票务区", constraints: ["3:4", "无真实文字", "无人物", "无水印"] },
  variants: directions.map(([title, changeSummary, variantPrompt]) => ({ title, changeSummary, prompt: variantPrompt }))
};

const browser = await chromium.launch({ headless: true, executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
const page = await context.newPage();
await page.route("**/v1/responses", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output_text: JSON.stringify(blueprint) }) }));
await page.route("**/v1/images/tasks/**", async (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ status: "queued", progress: "24%" }) }));

async function putWorkspace(key, value) {
  await page.evaluate(async ({ key, value }) => {
    const request = indexedDB.open("ai-visual-direction-board", 1);
    const database = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => request.result.createObjectStore("workspace");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("workspace", "readwrite");
      transaction.objectStore("workspace").put(value, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  }, { key, value });
}

async function snap(name) {
  await page.locator("#toast").evaluate((node) => node.classList.remove("show", "has-action"));
  await page.waitForTimeout(180);
  await page.screenshot({ path: path.join(screenshots, name), animations: "disabled" });
}

async function activateStage(stageId) {
  await page.evaluate((activeStageId) => {
    document.querySelectorAll(".workspace-grid > [id]").forEach((node) => node.classList.toggle("is-stage-active", node.id === activeStageId));
    document.querySelectorAll(".stage-nav [data-stage-target]").forEach((button) => button.classList.toggle("is-active", button.dataset.stageTarget === activeStageId));
    const activeStage = document.getElementById(activeStageId);
    if (activeStage) activeStage.style.setProperty("display", "grid", "important");
    if (activeStageId === "resultStage") {
      const feed = document.getElementById("generationFeed");
      feed?.classList.remove("hidden");
      feed?.style.setProperty("display", "block", "important");
      feed?.querySelectorAll("details.generation-batch").forEach((details) => { details.open = true; });
    }
  }, stageId);
}

async function openFresh() {
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.evaluate(() => {
    localStorage.setItem("vispath-open-generation-batches", JSON.stringify(["batch_capture"]));
  });
}

await openFresh();
await putWorkspace("api-settings", { textBaseUrl: "http://127.0.0.1:4175/v1", textApiKey: "vispath-demo-key", textModel: "gpt-5.4-mini", imageBaseUrl: "http://127.0.0.1:4175/v1", imageApiKey: "vispath-image-key", imageModel: "gpt-image-2", imageGenerationMode: "async" });
await page.reload({ waitUntil: "networkidle" });
await page.locator("#sourcePrompt").fill(prompt);
await page.locator("#optionCount").selectOption("4");
await page.locator("#imageRatio").selectOption("3:4");
await snap("01-complex-prompt-input.png");

await page.locator("#generateBtn").click();
await page.locator("#variantGrid .prompt-card").first().waitFor();
await snap("02-four-prompt-plans.png");
await page.locator("#selectAllBtn").click();
await snap("03-four-plans-selected.png");

const now = new Date();
const entryBase = directions.map(([title, changeSummary, promptSnapshot], index) => ({
  id: `capture_${index + 1}`, batchId: "batch_capture", batchNumber: "01", batchCreatedAt: now.toISOString(), variantTitle: title, changeSummary, promptSnapshot,
  artClass: ["art-editorial", "art-future", "art-retro", "art-lifestyle"][index], ratio: "3:4", resolution: "1K", generationMode: "async", responseFormat: "url", createdAt: "16:08", startedAt: now.toISOString(), completedAt: "", status: "loading", taskId: `task_vispath_${index + 1}`, taskStatus: index ? "queued" : "in_progress", taskProgress: index ? "0%" : "62%", favorite: false
}));
await putWorkspace("generation-history", { schemaVersion: 9, entries: entryBase, batchNumber: 1, savedAt: now.toISOString() });
await page.reload({ waitUntil: "networkidle" });
await page.locator("#generationFeed .generation-card").first().waitFor({ state: "attached" });
await activateStage("resultStage");
await page.locator("#generationFeed .generation-card").first().waitFor({ state: "visible" });
await snap("04-generation-in-progress.png");

const sourceShot = "/screenshots/06-batch-comparison-dialog.png";
const crops = await page.evaluate(async (source) => {
  const image = new Image();
  image.src = `${source}?cache=${Date.now()}`;
  await image.decode();
  const regions = [[147, 249, 277, 432], [437, 249, 277, 432], [727, 249, 277, 432], [1017, 249, 275, 432]];
  return regions.map(([x, y, width, height]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width * 2;
    canvas.height = height * 2;
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/png");
  });
}, sourceShot);
const completedAt = new Date(now.getTime() + 12000).toISOString();
const readyEntries = entryBase.map((entry, index) => ({ ...entry, imageUrl: crops[index], imageWidth: 1086, imageHeight: 1448, actualResponseFormat: "b64_json", status: "ready", taskStatus: "completed", taskProgress: "100%", completedAt, favorite: index === 1 }));
await putWorkspace("generation-history", { schemaVersion: 9, entries: readyEntries, batchNumber: 1, savedAt: completedAt });
await page.reload({ waitUntil: "networkidle" });
await page.locator("#generationFeed .generation-card").first().waitFor({ state: "attached" });
await activateStage("resultStage");
await page.locator("#generationFeed img").first().waitFor();
await Promise.all(await page.locator("#generationFeed img").evaluateAll((images) => images.map((image) => image.decode())));
await snap("05-four-images-result-board.png");

await page.locator('[data-action="compare-batch"]').click();
await snap("06-batch-comparison-dialog.png");
await page.locator("#closeComparisonBtn").click();

await page.locator("#apiSettingsBtn").click();
await snap("07-api-config.png");
await page.locator("#apiSettingsDialog [data-dialog-close]").click();

await page.locator("#historyManageBtn").click();
await snap("08-history-management-dialog.png");
await page.locator("#cancelHistoryBtn").click();

await page.locator('[data-action="open-image"]').first().click();
await page.locator("#imagePreviewImage").evaluate((image) => image.decode());
await snap("09-image-preview-dialog.png");
await page.locator("#closeImagePreviewBtn").click();

await page.locator('[data-action="retry"]').first().click();
await snap("10-retry-confirmation-dialog.png");
await page.locator("#cancelRetryGenerationBtn").click();

await page.locator("#resetBtn").click();
await snap("11-reset-confirmation-dialog.png");

await browser.close();
