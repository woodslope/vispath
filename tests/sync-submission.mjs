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
page.setDefaultTimeout(5000);
let syncSubmissions = 0;
let asyncSubmissions = 0;
let submittedBody = null;
const submittedBodies = [];
let failPromptRequest = false;
let promptRequestCount = 0;

await page.route("**/responses", async (route) => {
  promptRequestCount += 1;
  const requestBody = JSON.parse(route.request().postData() || "{}");
  const requestInput = JSON.parse(requestBody.input);
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (failPromptRequest) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "模拟文本服务失败" }) });
  return route.fulfill({
  contentType: "application/json",
  body: JSON.stringify({
    output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
      locked: { intent: "同步生图测试", subject: "玻璃杯" },
      variants: requestInput.explorationOptions.map((targetOption, index) => ({
        title: `同步方向${index + 1}`,
        targetOption,
        changeSummary: `验证${targetOption}同步提交`,
        prompt: `透明玻璃杯，横向构图，${targetOption}，方案${index + 1}`
      }))
    }) }] }]
  })
  });
});

await page.route("**/images/generations/async", (route) => {
  asyncSubmissions += 1;
  return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ error: "不应调用异步接口" }) });
});

await page.route("**/images/generations", (route) => {
  syncSubmissions += 1;
  submittedBody = JSON.parse(route.request().postData() || "{}");
  submittedBodies.push(submittedBody);
  if (syncSubmissions === 1) return route.fulfill({
    status: 400,
    contentType: "application/json",
    body: JSON.stringify({ error: { message: "response_format b64_json is not supported" } })
  });
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
  await page.locator("#sourcePrompt").fill("透明玻璃杯，横向构图");
  assert.equal(await page.locator("#blueprintStatus").textContent(), "实时预览", "输入提示词后应立即显示蓝图预览");
  const secondDimension = page.locator('#dimensionList input[name="dimension"]').nth(1);
  const secondDimensionName = await secondDimension.locator("xpath=..").locator("strong").textContent();
  await secondDimension.check();
  assert.match(await page.locator("#blueprintPanel").textContent(), new RegExp(secondDimensionName), "切换探索变量后蓝图应立即同步");
  await page.locator("#optionCount").selectOption("2");
  await page.locator("#imageRatio").selectOption("16:9");
  assert.match(await page.locator("#blueprintPanel").textContent(), /2 套方案/, "切换生成数量后蓝图应立即同步");
  assert.match(await page.locator("#blueprintPanel").textContent(), /16:9/, "切换画幅比例后蓝图应立即同步");
  await page.locator("#generateBtn").click();
  assert.equal(await page.locator("#generateBtn").isDisabled(), true, "建立蓝图时生成按钮应置灰");
  assert.equal(await page.locator("#taskType").isDisabled(), true, "生成期间创作类型应置灰");
  assert.equal(await page.locator("#optionCount").isDisabled(), true, "生成期间生成数量应置灰");
  assert.equal(await page.locator("#imageResolution").isDisabled(), true, "生成期间分辨率应置灰");
  assert.equal(await page.locator("#imageRatio").isDisabled(), true, "生成期间画幅比例应置灰");
  assert.equal(await page.locator("#referenceImage").isDisabled(), true, "生成期间参考图上传应置灰");
  assert.equal(await page.locator('#dimensionList input[name="dimension"]:not(:disabled)').count(), 0, "生成期间探索变量应全部置灰");
  assert.equal(await page.locator("#dropzone").getAttribute("aria-disabled"), "true", "生成期间上传区域应标记为不可操作");
  assert.equal(await page.locator("#blueprintStatus").textContent(), "实时预览", "请求期间蓝图应保持为左侧设置预览");
  assert.equal(await page.locator("#sourcePrompt").getAttribute("readonly"), "", "生成视觉方向后原始提示词应锁定为只读");
  assert.equal(await page.locator("#sourcePromptStatus").textContent(), "已锁定", "输入框应显示明确的锁定状态");
  await page.locator('[data-variant-id]').first().waitFor();
  assert.equal(await page.locator("#taskType").isDisabled(), true, "方案生成成功后创作类型应保持锁定");
  assert.equal(await page.locator('#dimensionList input[name="dimension"]:not(:disabled)').count(), 0, "方案生成成功后探索变量应保持锁定");
  assert.equal(await page.locator("#referenceImage").isDisabled(), true, "方案生成成功后参考图上传应保持锁定");
  assert.equal(await page.locator("#editSetupBtn").getAttribute("class").then((value) => !value.includes("hidden")), true, "方案生成成功后应启用修改输入与设置入口");
  await page.locator("#sourcePrompt").press("ControlOrMeta+A");
  await page.locator("#sourcePrompt").press("Backspace");
  assert.equal(await page.locator("#sourcePrompt").inputValue(), "透明玻璃杯，横向构图", "只读提示词不应被键盘删除或改写");
  await page.locator('[data-variant-id] input[data-action="select"]').first().check();
  await page.locator("#submitSelectedBtn").click();
  await page.waitForFunction(() => document.querySelector(".generation-status")?.textContent === "已完成", null, { timeout: 12000 });

  assert.equal(syncSubmissions, 2, "不支持 Base64 时应自动降级并重试同步图片接口");
  assert.equal(asyncSubmissions, 0, "同步模式不应调用异步接口");
  assert.equal(submittedBodies[0].response_format, "b64_json", "同步模式第一次应请求 Base64");
  assert.equal(submittedBody.response_format, "url", "Base64 不受支持时应降级请求 URL");
  assert.equal(submittedBody.quality, "standard", "同步模式应发送文档 Demo 的标准质量");
  assert.equal(submittedBody.output_format, "png", "同步模式应按官方接口请求 PNG 输出");
  assert.equal("watermark" in submittedBody, false, "同步模式不应发送官方接口未确认的水印字段");
  assert.equal("extra_fields" in submittedBody, false, "同步模式不应固定文档中的示例 seed");
  assert.equal(await page.locator(".generation-task-id").count(), 0, "同步模式不应产生任务 ID");
  await page.waitForFunction(() => document.querySelector(".generation-card img")?.src.startsWith("blob:"), null, { timeout: 5000 });
  assert.match(await page.locator(".generation-card img").getAttribute("src"), /^blob:/, "Base64 结果应归一化为 Blob 后显示");
  assert.match(await page.locator(".generation-card-meta").textContent(), /实际返回 Base64/, "同步结果卡应展示实际返回格式");
  await page.locator('[data-stage-target="setupStage"]').click();
  assert.equal(await page.locator("#optionCount").isDisabled(), true, "返回输入阶段后设置仍应保持锁定");
  await page.locator("#editSetupBtn").click();
  assert.equal(await page.locator("#editSetupDialog").isVisible(), true, "修改输入与设置应先打开确认弹窗");
  assert.match(await page.locator("#editSetupDialogDescription").textContent(), /清空当前 2 个提示词方案/, "确认弹窗应说明将清空的方案数量");
  assert.match(await page.locator("#editSetupDialogDescription").textContent(), /图片任务和历史结果不受影响/, "确认弹窗应说明已提交任务和历史不受影响");
  await page.locator("#cancelEditSetupBtn").click();
  assert.equal(await page.locator('[data-variant-id]').count(), 2, "取消修改不应清空提示词方案");
  assert.equal(await page.locator("#optionCount").isDisabled(), true, "取消修改后设置应继续锁定");
  await page.locator("#editSetupBtn").click();
  await page.locator("#confirmEditSetupBtn").click();
  assert.equal(await page.locator('[data-variant-id]').count(), 0, "确认修改后应清空当前提示词方案");
  assert.equal(await page.locator("#sourcePrompt").getAttribute("readonly"), null, "确认修改后应解锁原始提示词");
  assert.equal(await page.locator("#optionCount").isEnabled(), true, "确认修改后应解锁生成设置");
  assert.equal(await page.locator(".generation-card").count(), 1, "确认修改不应删除已提交的图片结果");
  await page.locator("#optionCount").selectOption("3");
  assert.match(await page.locator("#blueprintPanel").textContent(), /3 套方案/, "解锁后修改设置应立即更新蓝图");
  await page.locator("#resetBtn").click();
  await page.locator("#confirmResetBtn").click();
  await page.waitForFunction(() => !document.querySelector("#resetDialog")?.open);
  assert.equal(await page.locator("#sourcePrompt").getAttribute("readonly"), null, "重置工作台后原始提示词应恢复可编辑");
  await page.locator("#sourcePrompt").fill("失败后仍可编辑");
  failPromptRequest = true;
  await page.locator("#generateBtn").click();
  await page.waitForFunction(() => !document.querySelector("#generateBtn")?.disabled, null, { timeout: 12000 }).catch(async (error) => {
    const state = await page.locator("#generateBtn").evaluate((button) => ({ disabled: button.disabled, label: button.textContent, hint: document.querySelector("#generateHint")?.textContent }));
    throw new Error(`失败请求未恢复：请求数 ${promptRequestCount}，状态 ${JSON.stringify(state)}；${error.message}`);
  });
  assert.equal(await page.locator("#generateBtnLabel").textContent(), "重试生成方向", "生成失败后按钮应进入重试状态");
  assert.equal(await page.locator("#sourcePrompt").getAttribute("readonly"), null, "蓝图生成失败后原始提示词应恢复可编辑");
  assert.equal(await page.locator("#taskType").isEnabled(), true, "生成失败后创作类型应恢复可选");
  assert.equal(await page.locator("#referenceImage").isEnabled(), true, "生成失败后参考图上传应恢复可用");
  assert.equal(await page.locator("#blueprintStatus").textContent(), "实时预览", "生成失败后蓝图仍应显示当前设置预览");
  console.log("sync submission test passed");
} finally {
  await browser.close();
}
