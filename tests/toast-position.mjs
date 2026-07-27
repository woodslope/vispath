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

async function readToastLayout(page) {
  return page.evaluate(() => {
    const workspace = document.querySelector(".workspace-grid").getBoundingClientRect();
    const toast = document.querySelector("#toast").getBoundingClientRect();
    const submission = document.querySelector(".submission-bar");
    const submissionRect = submission && getComputedStyle(submission).display !== "none" ? submission.getBoundingClientRect() : null;
    return {
      rightInset: workspace.right - toast.right,
      bottomInset: workspace.bottom - toast.bottom,
      submissionGap: submissionRect ? submissionRect.top - toast.bottom : null,
      overflow: document.documentElement.scrollWidth > innerWidth
    };
  });
}

const executablePath = await findBrowserExecutable();
const browser = await chromium.launch(executablePath ? { headless: true, executablePath } : { headless: true });

try {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 900, height: 720 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(new URL("?preview=prompts", appUrl).toString(), { waitUntil: "networkidle" });
    await page.locator("#promptStage.is-stage-active").waitFor();
    const copyButtons = page.locator('[data-action="copy"]');
    assert.equal(await copyButtons.count(), 3, "本地方案预览应提供三处复制操作");
    await copyButtons.first().click();
    await page.locator("#toast.show").waitFor();
    await page.waitForTimeout(250);
    const promptLayout = await readToastLayout(page);
    assert(Math.abs(promptLayout.rightInset - 16) <= 1, `${viewport.width}px 下 Toast 未与工作区右边缘保持 16px：实际 ${promptLayout.rightInset}px`);
    assert(promptLayout.submissionGap >= 15 && promptLayout.submissionGap <= 17, `${viewport.width}px 下 Toast 未避让方案提交栏 16px：实际 ${promptLayout.submissionGap}px`);
    assert(!promptLayout.overflow, `${viewport.width}px 下 Toast 引起横向溢出`);

    await page.locator('[data-stage-target="resultStage"]').click();
    const resultLayout = await readToastLayout(page);
    assert(Math.abs(resultLayout.rightInset - 16) <= 1, `${viewport.width}px 结果页 Toast 右侧安全间距不正确`);
    assert(Math.abs(resultLayout.bottomInset - 16) <= 1, `${viewport.width}px 结果页 Toast 底部安全间距不正确：实际 ${resultLayout.bottomInset}px`);
    if (viewport.width === 900 && process.env.TOAST_SCREENSHOT) await page.screenshot({ path: process.env.TOAST_SCREENSHOT, fullPage: false });
    await page.close();
  }
  console.log("toast position test passed");
} finally {
  await browser.close();
}
