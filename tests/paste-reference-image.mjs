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

try {
  await page.goto(appUrl, { waitUntil: "networkidle" });
  const textPastePrevented = await page.locator("#sourcePrompt").evaluate((target) => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "普通文本");
    return !target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });
  assert.equal(textPastePrevented, false, "普通文本粘贴不应被页面拦截");

  await page.evaluate(() => {
    const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], "clipboard-image.png", { type: "image/png" }));
    document.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: transfer }));
  });

  await page.locator("#filePreview").waitFor({ state: "visible" });
  assert.equal(await page.locator("#fileName").textContent(), "clipboard-image.png", "粘贴图片应显示剪贴板文件名");
  assert.match(await page.locator("#filePreviewImage").getAttribute("src"), /^data:image\/jpeg;base64,/, "粘贴图片应复用参考图压缩预览流程");
  console.log("paste reference image test passed");
} finally {
  await Promise.race([browser.close(), new Promise((resolve) => setTimeout(resolve, 5000))]);
}
