import { chromium } from "playwright";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(new URL("../screenshots/01-complex-prompt-input-2x.png", import.meta.url));
const prompt = "为一场名为「城市苔原夜游」的城市植物夜展设计 3:4 新品发布主视觉。固定主体是一枚透明、生物形态的玻璃种子舱，内部包含可见的微型苔藓生态，悬浮在湿润的黑色矿石台座上。目标受众是 22—38 岁、关注设计、自然与夜间文化体验的城市人群。画面需要高级、克制但具有沉浸感；主体保持清晰，位于画面中下部，上方预留中文主标题区，底部预留日期、地址与票务信息区。请只围绕「设计风格」生成四个差异足够明显的视觉方向，保持主体、用途、3:4 比例、信息区域和无真实文字限制不变。避免普通商业海报、廉价霓虹、杂乱装饰、科幻机械、人物和水印。";
const browser = await chromium.launch({
  headless: true,
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});
const page = await context.newPage();

try {
  await page.goto("http://127.0.0.1:4173/index.html", { waitUntil: "networkidle" });
  await page.locator("#sourcePrompt").fill(prompt);
  await page.locator("#optionCount").selectOption("4");
  await page.evaluate(() => {
    document.querySelector("#blueprintStatus").textContent = "已建立";
    document.querySelector("#blueprintPanel").innerHTML = `
      <div class="blueprint-block"><span class="blueprint-block-index">01</span><div><strong>固定内容</strong><p>城市植物夜展新品发布主视觉<br>透明生物形玻璃种子舱与微型苔藓生态</p></div></div>
      <div class="blueprint-block"><span class="blueprint-block-index">02</span><div><strong>本轮变化</strong><p>设计风格 · 4 套方案</p></div></div>
      <div class="blueprint-block"><span class="blueprint-block-index">03</span><div><strong>输出限制</strong><p>3:4 · 上方标题区与底部活动信息区</p></div></div>
    `;
    document.querySelector("#generateBtnLabel").textContent = "重新生成方向";
    document.querySelector("#generateHint").textContent = "已生成方案，可继续调整输入并重新生成。";
    document.querySelector("#serviceStatus").classList.remove("is-offline");
    document.querySelector("#serviceStatusText").textContent = "浏览器 API 已配置";
    document.querySelector("#toast").classList.remove("show", "has-action");
  });
  await page.waitForTimeout(250);
  await page.screenshot({ path: outputPath, animations: "disabled" });
} finally {
  await browser.close();
}
