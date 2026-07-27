import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const [bundle, index] = await Promise.all([
  readFile(new URL("../app.bundle.js", import.meta.url), "utf8"),
  readFile(new URL("../index.html", import.meta.url), "utf8")
]);

const expectedCacheKey = createHash("sha256").update(bundle).digest("hex").slice(0, 12);
const actualCacheKey = index.match(/<script\s+src="app\.bundle\.js\?v=([a-f0-9]+)"><\/script>/)?.[1];

assert(actualCacheKey, "index.html 缺少 app.bundle.js 内容哈希缓存键");
assert(actualCacheKey === expectedCacheKey, `Bundle 缓存键未同步：期望 ${expectedCacheKey}，实际 ${actualCacheKey}`);

console.log("browser bundle cache key test passed");
