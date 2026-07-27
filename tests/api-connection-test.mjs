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
const page = await browser.newPage({ viewport: { width: 900, height: 720 } });
let textMode = "success";
let imageMode = "success";
let textRequestBody = null;
let imageGenerationCalls = 0;

await page.route("**/responses", async (route) => {
  textRequestBody = JSON.parse(route.request().postData() || "{}");
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (textMode === "auth") return route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "invalid key" }) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ output_text: "OK" }) });
});

await page.route("**/models", async (route) => {
  await new Promise((resolve) => setTimeout(resolve, 120));
  if (imageMode === "unsupported") return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not found" }) });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data: [] }) });
});

await page.route("**/images/generations**", (route) => {
  imageGenerationCalls += 1;
  return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "connection test must not generate images" }) });
});

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  await page.locator("#apiSettingsBtn").click();
  assert.equal(await page.locator("#textBaseUrlInput").evaluate((input) => document.activeElement === input), true, "API 弹窗打开后应聚焦第一个地址输入框，避免标题动作默认显示焦点框");
  assert.equal(await page.locator("#testApiConnectionBtn").count(), 1, "API 配置标题区缺少测试连接按钮");
  const titleActionContract = await page.locator("#testApiConnectionBtn").evaluate((button) => ({
    className: button.className,
    height: button.getBoundingClientRect().height,
    borderWidth: getComputedStyle(button).borderTopWidth,
    backgroundColor: getComputedStyle(button).backgroundColor
  }));
  assert.match(titleActionContract.className, /dialog-title-action/, "测试连接应使用标题文字动作组件");
  assert(titleActionContract.height <= 28 && titleActionContract.borderWidth === "0px" && titleActionContract.backgroundColor === "rgba(0, 0, 0, 0)", "标题文字动作不应保留普通描边按钮体量");
  assert.equal(await page.locator("#textApiTestStatus").textContent(), "未测试", "文本 API 初始状态不正确");
  assert.equal(await page.locator("#imageApiTestStatus").textContent(), "未测试", "生图 API 初始状态不正确");
  assert.equal(await page.locator(".api-key-visibility").count(), 2, "文本和生图 API Key 均应提供显示隐藏按钮");
  assert.equal(await page.locator("#textApiKeyInput").getAttribute("type"), "password", "文本 API Key 默认不应明文显示");
  assert.equal(await page.locator("#imageApiKeyInput").getAttribute("type"), "password", "生图 API Key 默认不应明文显示");
  const keyVisibilityContract = await page.locator(".api-key-control").evaluateAll((controls) => controls.map((control) => {
    const input = control.querySelector("input").getBoundingClientRect();
    const button = control.querySelector("button").getBoundingClientRect();
    return {
      inputHeight: input.height,
      buttonHeight: button.height,
      topDelta: Math.abs(input.top - button.top),
      rightDelta: Math.abs(input.right - button.right),
      paddingRight: Number.parseFloat(getComputedStyle(control.querySelector("input")).paddingRight),
      buttonWidth: button.width
    };
  }));
  assert(keyVisibilityContract.every((item) => item.inputHeight === 32 && item.buttonHeight === 32 && item.topDelta <= 1 && item.rightDelta <= 1), "API Key 显示隐藏按钮未与输入框保持 32px 内嵌对齐");
  assert(keyVisibilityContract.every((item) => item.paddingRight >= item.buttonWidth), "API Key 输入内容可能被显示隐藏按钮遮挡");
  const addressLabelContract = await page.locator('label[for="textBaseUrlInput"]').evaluate((label) => {
    const row = label.querySelector(".form-field-label-row");
    const name = row?.querySelector("span")?.getBoundingClientRect();
    const hint = row?.querySelector("small")?.getBoundingClientRect();
    const input = label.querySelector("input")?.getBoundingClientRect();
    return {
      hasInlineRow: Boolean(row && name && hint),
      hintAfterName: Boolean(name && hint && hint.left >= name.right),
      hintAboveInput: Boolean(hint && input && hint.bottom <= input.top)
    };
  });
  assert(addressLabelContract.hasInlineRow && addressLabelContract.hintAfterName && addressLabelContract.hintAboveInput, "填写到 /v1 应位于 API 地址标签同一行，不应占用输入框下方一行");
  const providerHeadingLayout = await page.locator("#textApiGroupTitle").evaluate((title) => {
    const status = title.parentElement.querySelector(".api-test-status");
    const titleRect = title.getBoundingClientRect();
    const statusRect = status.getBoundingClientRect();
    return {
      statusBelowTitle: statusRect.top >= titleRect.bottom,
      leftDelta: Math.abs(statusRect.left - titleRect.left),
      textAlign: getComputedStyle(status).textAlign
    };
  });
  assert(providerHeadingLayout.statusBelowTitle && providerHeadingLayout.leftDelta <= 1, "API 测试状态应位于分组标题下方并左对齐");
  assert.equal(providerHeadingLayout.textAlign, "left", "API 测试状态不应在标题右侧挤压换行");

  await page.locator("#textBaseUrlInput").fill("https://text.example/v1");
  await page.locator("#textApiKeyInput").fill("text-key");
  await page.locator("#textModelInput").fill("gpt-test");
  await page.locator("#imageBaseUrlInput").fill("https://image.example/v1");
  await page.locator("#imageApiKeyInput").fill("image-key");
  await page.locator("#imageModelInput").fill("gpt-image-test");

  await page.locator("#textApiKeyVisibilityBtn").click();
  assert.equal(await page.locator("#textApiKeyInput").getAttribute("type"), "text", "点击显示后文本 API Key 未切换为明文");
  assert.equal(await page.locator("#textApiKeyInput").inputValue(), "text-key", "显示文本 API Key 时不应改变字段内容");
  assert.equal(await page.locator("#textApiKeyVisibilityBtn").textContent(), "隐藏", "文本 API Key 显示状态按钮文案不正确");
  assert.equal(await page.locator("#textApiKeyVisibilityBtn").getAttribute("aria-pressed"), "true", "文本 API Key 显示状态未同步给辅助技术");
  await page.locator("#textApiKeyVisibilityBtn").click();
  assert.equal(await page.locator("#textApiKeyInput").getAttribute("type"), "password", "再次点击后文本 API Key 未恢复隐藏");
  await page.locator("#imageApiKeyVisibilityBtn").click();
  assert.equal(await page.locator("#imageApiKeyVisibilityBtn").getAttribute("aria-label"), "隐藏生图 API Key", "生图 API Key 显示状态缺少明确辅助文本");
  assert.equal(await page.locator("#imageApiKeyInput").getAttribute("type"), "text", "点击显示后生图 API Key 未切换为明文");
  assert.equal(await page.locator("#textApiKeyInput").getAttribute("type"), "password", "生图 API Key 的显示状态不应影响文本 API Key");
  await page.locator("#imageApiKeyVisibilityBtn").click();

  await page.locator("#testApiConnectionBtn").click();
  assert.equal(await page.locator("#testApiConnectionBtn").isDisabled(), true, "测试期间应禁用重复点击");
  assert.equal(await page.locator("#testApiConnectionBtn").textContent(), "测试中…", "测试期间按钮文案不正确");
  await page.waitForFunction(() => !document.querySelector("#testApiConnectionBtn")?.disabled);
  assert.equal(await page.locator("#textApiTestStatus").textContent(), "文本接口可用", "文本 API 成功状态不正确");
  assert.equal(await page.locator("#imageApiTestStatus").textContent(), "基础连接可用，未实际生图", "生图 API 成功状态不正确");
  assert.equal(textRequestBody?.model, "gpt-test", "文本测试未使用当前表单模型");
  assert.equal(textRequestBody?.max_output_tokens, 16, "文本测试请求不够轻量");
  assert.equal(imageGenerationCalls, 0, "连接测试不应产生生图请求或费用");

  await page.locator("#textModelInput").fill("gpt-test-updated");
  assert.equal(await page.locator("#textApiTestStatus").textContent(), "未测试", "修改文本配置后旧测试结果应失效");
  await page.locator("#textModelInput").fill("gpt-test");

  const savedSettings = await page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("ai-visual-direction-board", 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const value = await new Promise((resolve, reject) => {
      const request = database.transaction("workspace", "readonly").objectStore("workspace").get("api-settings");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return value;
  });
  assert.equal(savedSettings, undefined, "测试连接不应自动保存当前表单配置");

  textMode = "auth";
  imageMode = "unsupported";
  await page.locator("#testApiConnectionBtn").click();
  await page.waitForFunction(() => !document.querySelector("#testApiConnectionBtn")?.disabled);
  assert.equal(await page.locator("#textApiTestStatus").textContent(), "API Key 无效或无权限", "文本鉴权失败提示不明确");
  assert.equal(await page.locator("#imageApiTestStatus").textContent(), "服务可达，无法无费用验证", "生图接口不支持无费用测试时不应误报失败");

  console.log("api connection test passed");
} finally {
  await browser.close();
}
