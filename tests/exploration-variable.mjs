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
page.setDefaultTimeout(6000);

const textRequests = [];
const imagePrompts = [];
const basePrompt = "保留固定主体与版式，米白背景、深蓝大标题、亮橙角色，现代作品集封面。";

await page.route("**/responses", (route) => {
  const requestBody = JSON.parse(route.request().postData() || "{}");
  textRequests.push(requestBody);
  const serializedInput = typeof requestBody.input === "string"
    ? requestBody.input
    : requestBody.input?.[0]?.content?.find((item) => item.type === "input_text")?.text;
  const requestInput = JSON.parse(serializedInput);
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      output: [{
        type: "message",
        content: [{
          type: "output_text",
          text: JSON.stringify({
            locked: { intent: "作品集封面", subject: "都市青年角色" },
            variants: requestInput.explorationOptions.map((targetOption, index) => ({
              title: `方向${index + 1}`,
              targetOption,
              changeSummary: `将${requestInput.dimensionName}调整为${targetOption}`,
              prompt: `${basePrompt}，${targetOption}。`
            }))
          })
        }]
      }]
    })
  });
});

await page.route("**/images/generations", (route) => {
  const body = JSON.parse(route.request().postData() || "{}");
  imagePrompts.push(body.prompt);
  return route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ data: [{ b64_json: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" }] })
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

  assert.equal(await page.locator('input[name="contentMode"]').count(), 2, "内容模式应提供概念补全和事实保守两项选择");
  assert(await page.locator('input[name="contentMode"][value="concept"]').isChecked(), "默认内容模式应为概念补全");
  await page.locator("#sourcePrompt").fill(basePrompt);
  await page.locator('#dimensionList input[value="color_style"]').check();
  await page.locator("#optionCount").selectOption("3");
  await page.locator("#generateBtn").click();
  await page.locator('[data-variant-id]').first().waitFor();

  const firstInput = JSON.parse(textRequests[0].input);
  assert.equal(firstInput.dimensionId, "color_style", "文本请求应携带当前选择的探索变量");
  assert.deepEqual(firstInput.explorationOptions, ["低饱和奶油色", "高对比黑白", "暖橙蓝"], "每套方案应分配明确且不同的探索目标");
  assert.deepEqual(firstInput.lockFields, ["subject", "composition", "textLayout", "technical"], "文本请求应携带当前维度的规范锁定字段");
  assert.equal(firstInput.promptProfile, "poster", "文本请求应携带任务类型提示词配置");
  assert.equal(firstInput.contentMode, "concept", "默认应使用概念补全模式");
  assert.match(textRequests[0].instructions, /当前没有参考图.*只依赖用户文字.*不得假定存在图片中可补充的信息/, "无参考图模式缺少自包含提示词约束");
  assert.match(textRequests[0].instructions, /用户.*视觉内容.*优先/, "系统提示词未明确用户视觉要求优先级");
  assert.match(textRequests[0].instructions, /海报方案要明确主体、传播目的、标题或信息区域/, "首次概念探索未沿用线上丰富海报契约");
  assert.match(textRequests[0].instructions, /动作.*目的地.*互动对象/, "海报探索未保留动作叙事契约");
  assert.doesNotMatch(textRequests[0].instructions, /内容模式：概念补全|prompt.*保持简洁|逐项列清单/, "首次概念探索不应被新增工作流规则压缩");
  assert.doesNotMatch(textRequests[0].instructions, /主标题.*信息模块.*底部 CTA/, "概念模式不应强制写满完整营销信息清单");

  const promptTargets = await page.locator(".prompt-exploration-option").allTextContents();
  assert.deepEqual(promptTargets, firstInput.explorationOptions, "提示词卡应明确显示每套方案的探索目标");

  await page.locator("#selectAllBtn").click();
  await page.locator("#submitSelectedBtn").click();
  await page.waitForFunction(() => document.querySelectorAll(".generation-status.ready").length === 3);

  assert.equal(imagePrompts.length, 3, "三套方案应分别提交到生图接口");
  assert.equal(new Set(imagePrompts).size, 3, "即使文本服务返回重复提示词，实际生图提示词也必须保持差异");
  assert(imagePrompts.every((prompt) => !prompt.includes("本轮必须")), "最终生图提示词不应包含工作流元话术");
  firstInput.explorationOptions.forEach((option) => {
    assert(imagePrompts.some((prompt) => prompt.includes(`视觉方向：${option}`)), `生图提示词缺少探索目标：${option}`);
  });

  assert.match(await page.locator(".generation-batch-variable").textContent(), /色彩风格/, "批次标题应显示本轮探索变量");
  const cardTargets = await page.locator(".generation-exploration-value").allTextContents();
  assert.deepEqual(cardTargets, firstInput.explorationOptions, "结果卡应显示各自的探索目标");

  const storedEntries = await page.evaluate(async () => {
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
    return history.entries;
  });
  assert(storedEntries.every((entry) => entry.explorationDimensionName === "色彩风格"), "历史记录应保留批次探索变量");
  assert.deepEqual(storedEntries.map((entry) => entry.explorationOption), firstInput.explorationOptions, "历史记录应保留每套探索目标");

  await page.locator('[data-action="continue"]').first().click();
  assert.equal(await page.locator("#sourcePrompt").inputValue(), basePrompt, "细化入口应恢复最初原始提示词，而不是回填上一轮最终提示词");
  await page.locator("#filePreview").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(document.querySelector("#filePreviewImage")?.getAttribute("src")));
  const refinementReferenceSrc = await page.locator("#filePreviewImage").getAttribute("src");
  await page.locator("#referenceUsageExplore").check();
  assert(await page.locator("#filePreview").isVisible(), "切换为参与生图探索后不应移除上一轮结果图片");
  assert.equal(await page.locator("#filePreviewImage").getAttribute("src"), refinementReferenceSrc, "切换参考图用途后应保留同一张上一轮结果图片");
  await page.locator('#dimensionList input[value="layout_style"]').check();
  await page.locator("#optionCount").selectOption("3");
  await page.locator("#generateBtn").click();
  await page.locator('[data-variant-id]').first().waitFor();
  assert(Array.isArray(textRequests[1].input), "基于结果细化时，文本请求必须携带上一轮生成结果图片");
  const refinementInputText = textRequests[1].input[0]?.content?.find((item) => item.type === "input_text")?.text;
  const refinementImagePart = textRequests[1].input[0]?.content?.find((item) => item.type === "input_image");
  assert(refinementInputText && refinementImagePart, "细化请求必须同时包含结构化输入和上一轮生成结果图片");
  const refinedInput = JSON.parse(refinementInputText);
  assert.equal(refinedInput.referenceSource, "generated-result", "细化请求应标记图片1来自上一轮生成结果");
  assert.equal(refinedInput.referenceUsage, "explore", "细化时选择的参考图用途应进入下一轮请求");
  assert.equal(refinedInput.dimensionId, "layout_style", "基于结果细化后，新选择的探索变量必须进入下一轮请求");
  assert.deepEqual(refinedInput.explorationOptions, ["大标题单主体", "杂志网格", "左右分栏"], "细化后的新变量应生成对应探索目标");
  assert(refinedInput.refinementBase, "基于结果细化必须携带结构化方案基线");
  assert.equal(refinedInput.refinementBase.source.prompt, basePrompt, "细化必须保留最初原始提示词，而不是回填上一轮最终提示词");
  assert.equal(refinedInput.refinementBase.source.contentMode, "concept", "细化必须继承上一轮内容模式");
  assert.equal(refinedInput.refinementBase.dimensions.color_style, "低饱和奶油色", "细化必须继承上一轮已选择的变量");
  assert(refinedInput.refinementBase.acceptedPrompt.includes(basePrompt), "细化基线必须保留首轮已确认的丰富提示词");

  console.log("exploration variable regression test passed");
} finally {
  await browser.close();
}
