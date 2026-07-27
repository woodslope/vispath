import assert from "node:assert/strict";
import { createImageEditRequest, createImageRequest, getImageEndpointPath } from "../src/image-generation.js";

assert.deepEqual(createImageRequest({ model: "gpt-image-2-1k", prompt: "测试", ratio: "16:9", generationMode: "sync" }), {
  model: "gpt-image-2-1k",
  prompt: "测试",
  n: 1,
  size: "1792x1024",
  aspect_ratio: "16:9",
  quality: "standard",
  response_format: "b64_json",
  output_format: "png"
});
assert.deepEqual(createImageRequest({ model: "gpt-image-2-1k", prompt: "测试", ratio: "16:9", generationMode: "async" }), {
  model: "gpt-image-2-1k",
  prompt: "测试",
  n: 1,
  size: "1792x1024",
  aspect_ratio: "16:9",
  response_format: "b64_json",
  output_format: "png"
});
assert.equal(createImageRequest({ model: "test", prompt: "test" }).size, "1024x1024");
assert.equal("extra_fields" in createImageRequest({ model: "test", prompt: "test" }), false);
assert.equal(createImageRequest({ model: "test", prompt: "test", responseFormat: "url" }).response_format, "url");

assert.equal(getImageEndpointPath({ generationMode: "sync", referenceUsage: "analyze" }), "/images/generations");
assert.equal(getImageEndpointPath({ generationMode: "async", referenceUsage: "analyze" }), "/images/generations/async");
assert.equal(getImageEndpointPath({ generationMode: "sync", referenceUsage: "explore" }), "/images/edits");
assert.equal(getImageEndpointPath({ generationMode: "async", referenceUsage: "explore" }), "/images/edits/async");

const referenceBlob = new Blob([Uint8Array.from([137, 80, 78, 71])], { type: "image/png" });
const editRequest = createImageEditRequest({
  model: "gpt-image-2-1k",
  prompt: "以图片1为基础进行版式探索",
  ratio: "3:4",
  generationMode: "sync",
  responseFormat: "b64_json",
  image: referenceBlob,
  imageName: "reference.png"
});
assert.equal(editRequest.get("model"), "gpt-image-2-1k");
assert.equal(editRequest.get("prompt"), "以图片1为基础进行版式探索");
assert.equal(editRequest.get("n"), "1");
assert.equal(editRequest.get("size"), "768x1024");
assert.equal(editRequest.get("aspect_ratio"), "3:4");
assert.equal(editRequest.get("response_format"), "b64_json");
assert.equal(editRequest.get("output_format"), "png");
assert.equal(editRequest.get("quality"), "standard");
assert.equal(editRequest.has("watermark"), false, "官方编辑接口不应携带未确认的 watermark 字段");
assert.equal(editRequest.get("image").size, referenceBlob.size);
assert.equal(editRequest.get("image").name, "reference.png");
assert.throws(() => createImageEditRequest({ model: "test", prompt: "test", image: null }), /参考图/);

const asyncEditRequest = createImageEditRequest({
  model: "gpt-image-2-1k",
  prompt: "异步参考图探索",
  ratio: "16:9",
  generationMode: "async",
  image: referenceBlob
});
assert.equal(asyncEditRequest.get("size"), "1792x1024");
assert.equal(asyncEditRequest.get("output_format"), "png");
assert.equal(asyncEditRequest.has("quality"), false, "异步编辑请求不应携带同步质量字段");
assert.equal(asyncEditRequest.get("image").size, referenceBlob.size);
