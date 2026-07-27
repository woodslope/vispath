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

const tinyPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
page.setDefaultTimeout(8000);
const browserErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") browserErrors.push(message.text());
});
page.on("pageerror", (error) => browserErrors.push(error.message));

const textRequests = [];
const styleDirections = [
  "国潮喜庆风",
  "高饱和街头快闪风",
  "瑞士现代网格风",
  "极简商业品牌风",
  "实验手作拼贴风",
  "复古商业印刷风",
  "民俗木刻版画风",
  "生活方式摄影风",
  "萌趣插画风",
  "未来数字霓虹风"
];

await page.route("**/responses", (route) => {
  const requestBody = JSON.parse(route.request().postData() || "{}");
  const input = readBlueprintInput(requestBody);
  textRequests.push({ body: requestBody, input });
  const isCompletion = Boolean(input.completionBase);
  const directionOffset = isCompletion ? input.completionBase.existingOptions.length : 0;
  const responseCount = isCompletion ? input.optionCount : Math.min(input.optionCount, 8);
  const variants = styleDirections.slice(directionOffset, directionOffset + responseCount).map((targetOption) => ({
    title: targetOption,
    targetOption,
    changeSummary: `将同一套${targetOption}同步应用到已识别的全部应用面`,
    prompt: `以图片1中的双层摊位门头为载体，保持上下两个应用面、支撑结构、白色背景和正面视角，在两个应用面同步应用${targetOption}。`
  }));
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      status: "completed",
      usage: { output_tokens: isCompletion ? 1500 : 7421 },
      output_text: JSON.stringify({
        locked: {
          intent: "餐饮品牌 VI 应用展示",
          subject: "白色背景中的双层印刷横幅摊位门头，上下两个横向应用面由金属支撑杆连接",
          context: "白色背景的正面样机展示",
          composition: "固定正面视角、双层门头比例、上下两个应用面和连接关系",
          material: "印刷横幅与金属支撑杆",
          textLayout: "上层承载 KK 臭豆腐品牌，下层承载美食集市活动信息",
          constraints: ["不得把双层摊位门头改成其他实体载体"]
        },
        variants
      })
    })
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
      transaction.objectStore("workspace").put({
        textBaseUrl: "https://text.example/v1",
        textApiKey: "test-text-key",
        textModel: "gpt-5.4-mini",
        imageBaseUrl: "",
        imageApiKey: "",
        imageModel: "gpt-image-2",
        imageGenerationMode: "sync"
      }, "api-settings");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    database.close();
  });
  await page.reload({ waitUntil: "networkidle" });

  await page.locator("#taskType").selectOption("brand_application");
  assert.equal(await page.locator("#imageRatio").inputValue(), "3:2", "品牌应用应保持 3:2 默认画幅");
  assert.equal(await page.locator('#dimensionList input[name="dimension"]:checked').inputValue(), "application_visual_style", "品牌应用应默认探索设计风格");
  assert.match(await page.locator("#dimensionList").textContent(), /设计风格/, "品牌应用应显示设计风格变量");
  assert.doesNotMatch(await page.locator("#dimensionList").textContent(), /载体适配/, "载体识别不应显示为探索变量");
  assert.deepEqual(await page.locator("#optionCount option").evaluateAll((options) => options.map((option) => option.value)), ["2", "3", "4", "5", "6", "8", "10"], "品牌应用设计风格应开放 8 套和 10 套");
  await page.locator("#optionCount").selectOption("10");
  await page.locator('#dimensionList input[value="color_style"]').check();
  assert.deepEqual(await page.locator("#optionCount option").evaluateAll((options) => options.map((option) => option.value)), ["2", "3", "4", "5", "6"], "固定候选维度仍应限制为最多 6 套");
  assert.equal(await page.locator("#optionCount").inputValue(), "6", "切换到固定候选维度时应将 10 套自动收敛为 6 套");
  await page.locator('#dimensionList input[value="application_visual_style"]').check();
  assert.deepEqual(await page.locator("#optionCount option").evaluateAll((options) => options.map((option) => option.value)), ["2", "3", "4", "5", "6", "8", "10"], "切回动态设计风格后应恢复 8 套和 10 套选项");

  const desktopInputLayout = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(desktopInputLayout.scrollWidth, desktopInputLayout.innerWidth, "品牌应用输入页不应产生横向溢出");
  if (process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX}-1440.png`, fullPage: false });
  }
  await page.setViewportSize({ width: 900, height: 720 });
  await page.locator("#dimensionList").scrollIntoViewIfNeeded();
  const narrowInputLayout = await page.evaluate(() => ({ innerWidth, scrollWidth: document.documentElement.scrollWidth }));
  assert.equal(narrowInputLayout.scrollWidth, narrowInputLayout.innerWidth, "900px 品牌应用输入页不应产生横向溢出");
  assert.match(await page.locator("#dimensionList").textContent(), /设计风格/, "900px 下设计风格变量必须可达");
  const narrowDimensionBox = await page.locator("#dimensionList").boundingBox();
  assert(narrowDimensionBox && narrowDimensionBox.y >= 0 && narrowDimensionBox.y + narrowDimensionBox.height <= 720, "900px 下探索变量必须能完整滚动到可视区域");
  if (process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX}-900.png`, fullPage: false });
  }
  await page.setViewportSize({ width: 1440, height: 960 });

  await page.locator("#sourcePrompt").fill("基于参考图中的实体载体，为 KK 臭豆腐探索适合该载体的品牌视觉风格；保留真实结构和两个应用面。 ");
  await page.locator("#referenceImage").setInputFiles({ name: "carrier.png", mimeType: "image/png", buffer: tinyPng });
  await page.locator("#referenceUsageExplore").check();
  await page.locator("#optionCount").selectOption("10");
  assert.match(await page.locator("#blueprintPanel").textContent(), /设计风格.*识别载体与应用面.*10 套适配风格/s, "蓝图预览应说明载体识别后探索 10 套风格");

  await page.locator("#generateBtn").click();
  await page.locator("[data-variant-id]").first().waitFor();

  assert.equal(textRequests.length, 1, "品牌应用应通过一次多模态请求完成载体识别与风格探索");
  const [{ body, input }] = textRequests;
  assert.equal(input.taskTypeId, "brand_application");
  assert.equal(input.dimensionId, "application_visual_style");
  assert.equal(input.dimensionName, "设计风格");
  assert.equal(input.dynamicExploration, true, "风格方向应根据已识别载体动态生成");
  assert.equal(input.optionCount, 10, "品牌应用动态风格应请求 10 套方案");
  assert.deepEqual(input.explorationOptions, [], "动态载体风格不应预置通用海报风格列表");
  assert.deepEqual(input.lockFields, ["subject", "intent", "context", "composition", "textLayout", "technical"], "所有风格方案都必须锁定载体基线");
  assert.equal(body.max_output_tokens, 10000, "10 套方案应获得足够的文本输出预算");
  assert.equal(body.input[0].content.some((item) => item.type === "input_image"), true, "文本服务必须同时收到载体参考图");
  assert.match(body.instructions, /载体识别只是生成前的固定解析步骤，不是探索变量/, "暗提示应区分载体解析与风格探索");
  assert.match(body.instructions, /targetOption 必须是视觉风格名称/, "动态方向必须返回视觉风格名称");
  assert.match(body.instructions, /同一风格系统同步应用到全部应用面/, "多面载体必须共享同一风格系统");
  assert.match(body.instructions, /10 套方案必须分属 10 个不同的主风格家族/, "10 套方向必须跨不同主风格家族");
  assert.match(body.instructions, /不得用近义词.*来凑数量/, "动态方向不得用近义风格凑数量");
  assert.match(body.instructions, /必须逐字包含.*国潮喜庆风.*高饱和街头快闪风.*萌趣插画风/, "餐饮摊位的 10 套探索必须包含三种已验证风格");
  assert.match(body.instructions, /不得降级为普通东方传统装饰.*不得替换成单纯街头涂鸦.*不得替换成泛化的手绘插画/, "已验证风格不得被相近大类替代");

  assert.equal(await page.locator("[data-variant-id]").count(), 8, "10 套请求少返时应显示已返回的 8 张风格卡");
  assert.deepEqual(await page.locator(".prompt-exploration-option").allTextContents(), styleDirections.slice(0, 8), "部分结果应保留已返回的可比较风格方向");
  assert.match(await page.locator("#boardHint").textContent(), /已返回 8 \/ 10 套.*模型实际返回不足.*现有方案可直接使用/, "方案区应明确说明部分返回且不阻断使用");
  await page.locator("#completeDirectionsBtn").waitFor({ state: "visible" });
  assert.equal(await page.locator("#completeDirectionsBtn").textContent(), "补齐缺少 2 套");

  await page.locator("#completeDirectionsBtn").click();
  await page.waitForFunction(() => document.querySelectorAll("[data-variant-id]").length === 10);

  assert.equal(textRequests.length, 2, "补齐缺少方案应单独发起一次请求");
  const completionRequest = textRequests[1];
  assert.equal(completionRequest.input.optionCount, 2, "补齐请求只应请求缺少的 2 套");
  assert.deepEqual(completionRequest.input.completionBase.existingOptions, styleDirections.slice(0, 8), "补齐请求应携带已有 8 个方向作为排除清单");
  assert.equal(completionRequest.body.max_output_tokens, 2400, "2 套补齐请求应使用对应的最小输出预算");
  assert.match(completionRequest.body.instructions, /同一轮缺少方案的补齐请求.*只返回 2 套新的方案/, "补齐暗提示应与首轮探索区分");
  assert.match(completionRequest.body.instructions, /不得与已有方向重复、近义、上下位包含或属于同一个主风格家族/, "补齐暗提示应排除重复与同家族方向");
  assert.match(completionRequest.body.instructions, /尚未出现的优先风格为：萌趣插画风.*本次新增方向必须先补入/, "补齐请求应优先补回缺少的萌趣插画风");
  assert.doesNotMatch(completionRequest.body.instructions, /这是首轮概念探索/, "补齐暗提示不应残留首轮探索规则");
  assert.equal(await page.locator("[data-variant-id]").count(), 10, "补齐后方案区应显示 10 张风格卡");
  assert.deepEqual(await page.locator(".prompt-exploration-option").allTextContents(), styleDirections, "补齐方案应追加到原有方案之后");
  await page.locator("#completeDirectionsBtn").waitFor({ state: "hidden" });
  assert.doesNotMatch(await page.locator("#boardHint").textContent(), /已返回 .* \/ 10 套/, "补齐完成后应清除部分结果提示");
  const layout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.equal(layout.scrollWidth, layout.innerWidth, "品牌应用方案页不应产生横向溢出");
  if (process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX}-results-1440.png`, fullPage: true });
  }
  await page.setViewportSize({ width: 900, height: 720 });
  const narrowResultsLayout = await page.evaluate(() => ({
    innerWidth,
    scrollWidth: document.documentElement.scrollWidth
  }));
  assert.equal(narrowResultsLayout.scrollWidth, narrowResultsLayout.innerWidth, "900px 下 10 套品牌应用方案不应产生横向溢出");
  if (process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX) {
    await page.screenshot({ path: `${process.env.BRAND_APPLICATION_SCREENSHOT_PREFIX}-results-900.png`, fullPage: true });
  }
  assert.deepEqual(browserErrors, [], "品牌应用主路径不应产生控制台错误");

  console.log("brand application style regression test passed");
} finally {
  await browser.close();
}
