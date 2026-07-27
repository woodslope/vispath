import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const [html, app] = await Promise.all([
  readFile(new URL("../index.html", import.meta.url), "utf8"),
  readFile(new URL("../app.js", import.meta.url), "utf8")
]);

assert.match(html, /最近一次生图诊断/);
assert.match(html, /id="imageDiagnosticRequestMode"/);
assert.match(html, /id="imageDiagnosticActualFormat"/);
assert.match(html, /id="imageDiagnosticStorageBackend"/);
assert.match(html, /id="imageDiagnosticRestoreStatus"/);
assert.match(app, /VISPATH_IMAGE_DIAGNOSTIC_KEY/);
assert.match(app, /loadLastImageDiagnostic/);
assert.match(app, /saveLastImageDiagnostic/);
assert.match(app, /renderLastImageDiagnostic/);
assert.match(app, /getDiagnosticFailureReason/);
assert.match(app, /reference_cache_missing/);
assert.doesNotMatch(app, /failureReason:\s*entry\.errorMessage/);
assert.ok((app.match(/saveLastImageDiagnostic\(/g) || []).length >= 5, "请求、响应、Blob/opaque 保存和刷新恢复均应更新诊断");
const requestGeneratedImageSource = app.slice(app.indexOf("async function requestGeneratedImage"), app.indexOf("async function checkImageService"));
assert(requestGeneratedImageSource.indexOf("saveLastImageDiagnostic") < requestGeneratedImageSource.indexOf("if (entry.taskId)"), "续查任务前应先绑定当前诊断 entry");
assert(requestGeneratedImageSource.indexOf("saveLastImageDiagnostic") < requestGeneratedImageSource.indexOf("loadReferenceImageForEntry"), "读取参考图缓存前应先绑定当前诊断 entry");

console.log("VisPath image diagnostic contract passed");
