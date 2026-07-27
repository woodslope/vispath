import { access } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

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
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(3000);
const errors = [];

page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
page.on("pageerror", (error) => errors.push(error.message));
page.on("requestfailed", (request) => errors.push(`${request.url()}: ${request.failure()?.errorText || "request failed"}`));

try {
  const appUrl = pathToFileURL(fileURLToPath(new URL("../index.html", import.meta.url))).href;
  await page.goto(appUrl, { waitUntil: "load" });
  await page.waitForTimeout(200);

  assert(errors.length === 0, `双击打开存在浏览器错误：${errors.join(" | ")}`);
  await page.locator("#setupStage.is-stage-active").waitFor();

  assert(await page.locator("#taskType option").count() > 0, "双击打开后创作类型没有初始化");
  assert(await page.locator(".stage-nav [aria-current='step']").count() === 1, "双击打开后没有活动阶段");
  assert(await page.locator(".stage-nav button").count() === 3, "顶部流程导航阶段数量异常");
  assert(await page.locator(".stage-nav button:disabled").count() === 0, "顶部流程导航不应按数据状态锁定");

  await page.locator('[data-stage-target="promptStage"]').click();
  await page.locator("#promptStage.is-stage-active").waitFor();
  assert(await page.locator("#emptyBoard").isVisible(), "首次进入方案阶段未显示空状态");
  const emptyPromptScroll = await page.locator(".prompt-scroll-region").evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight
  }));
  assert(emptyPromptScroll.scrollHeight <= emptyPromptScroll.clientHeight + 1, "方案空状态不应出现可滚动的纯空白区域");

  await page.locator('[data-stage-target="resultStage"]').click();
  await page.locator("#resultStage.is-stage-active").waitFor();
  assert(await page.locator("#emptyGenerationBoard").isVisible(), "首次进入结果阶段未显示空状态");

  await page.locator('[data-stage-target="setupStage"]').click();
  await page.locator("#setupStage.is-stage-active").waitFor();

  console.log("file open test passed");
} finally {
  await browser.close();
}
