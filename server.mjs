import { createServer } from "node:http";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.env.PORT || 8771);
const root = fileURLToPath(new URL("./", import.meta.url));
const generatedDir = join(root, "generated");
const defaultApiBaseUrl = "https://api.openai.com/v1";
const sharedApiKey = process.env.AI_API_KEY || process.env.MONOND_API_KEY || "";
const sharedApiBaseUrl = process.env.AI_API_BASE_URL || process.env.MONOND_BASE_URL || "";
const textApiKey = process.env.TEXT_API_KEY || sharedApiKey;
const imageApiKey = process.env.IMAGE_API_KEY || sharedApiKey;
const textApiBaseUrl = (process.env.TEXT_API_BASE_URL || sharedApiBaseUrl || defaultApiBaseUrl).replace(/\/$/, "");
const imageApiBaseUrl = (process.env.IMAGE_API_BASE_URL || sharedApiBaseUrl || defaultApiBaseUrl).replace(/\/$/, "");
const textApiModel = process.env.TEXT_API_MODEL || process.env.AI_TEXT_MODEL || "gpt-5.4-mini";
const imageApiModel = process.env.IMAGE_API_MODEL || process.env.AI_IMAGE_MODEL || "gpt-image-2";
const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp"
};
const sizeByRatio = {
  "1:1": "1024x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "16:9": "1280x720",
  "9:16": "720x1280",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "21:9": "1280x544"
};

function sendJson(response, status, payload) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8_000_000) throw new Error("请求内容过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function safeApiError(payload, status) {
  const message = payload?.error?.message || payload?.message;
  if (status === 401 || status === 403) return "图片生成服务鉴权失败，请检查本地配置";
  if (status === 429) return "图片生成请求过于频繁，请稍后重试";
  if (status >= 500) return "图片生成服务暂时不可用，请稍后重试";
  return typeof message === "string" && message.length < 180 ? message : `图片生成请求失败（HTTP ${status}）`;
}

function safeTextApiError(payload, status) {
  const message = payload?.error?.message || payload?.message;
  if (status === 401 || status === 403) return "文本生成服务鉴权失败，请检查本地配置";
  if (status === 429) return "文本生成请求过于频繁，请稍后重试";
  if (status >= 500) return "文本生成服务暂时不可用，请稍后重试";
  return typeof message === "string" && message.length < 180 ? message : `文本生成请求失败（HTTP ${status}）`;
}

function normalizePromptBlueprint(value, input) {
  const variants = Array.isArray(value?.variants) ? value.variants.slice(0, input.optionCount) : [];
  if (variants.length !== input.optionCount) throw new Error("文本服务返回的方案数量不正确");
  const locked = value?.locked || {};
  return {
    schemaVersion: 1,
    taskTypeId: input.taskTypeId,
    source: { prompt: input.prompt, referenceImages: input.referenceImage ? [{ source: "uploaded-reference" }] : [], referenceRole: "inspiration" },
    locked: {
      intent: String(locked.intent || input.prompt).slice(0, 240),
      subject: String(locked.subject || "保留原始主体").slice(0, 160),
      context: String(locked.context || "").slice(0, 160),
      audience: String(locked.audience || "").slice(0, 160),
      composition: String(locked.composition || "保持基础空间关系").slice(0, 160),
      visualLanguage: String(locked.visualLanguage || "").slice(0, 160),
      palette: String(locked.palette || "").slice(0, 160),
      lighting: String(locked.lighting || "").slice(0, 160),
      material: String(locked.material || "").slice(0, 160),
      textLayout: String(locked.textLayout || "保留可后期排版区域").slice(0, 160),
      technical: { ratio: input.ratio },
      constraints: Array.isArray(locked.constraints) ? locked.constraints.slice(0, 8).map(String) : []
    },
    exploration: { dimensionIds: [input.dimensionId], optionCount: input.optionCount, selectedOptions: variants.map((item) => String(item.title || "未命名方向")) },
    variants: variants.map((item, index) => ({
      id: `variant_${Date.now()}_${index + 1}`,
      title: String(item.title || `方向 ${index + 1}`).slice(0, 40),
      changed: { [input.dimensionId]: String(item.title || "") },
      changeSummary: String(item.changeSummary || `只改变${input.dimensionName}`).slice(0, 200),
      prompt: String(item.prompt || "").slice(0, 4000),
      generation: { ratio: input.ratio, imageCount: 1 },
      artClass: ["art-editorial", "art-retro", "art-future", "art-lifestyle"][index % 4]
    }))
  };
}

async function generatePrompts(request, response) {
  const apiKey = textApiKey;
  if (!apiKey) return sendJson(response, 503, { error: "本地服务未配置文本生成 API Key" });
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message || "请求格式错误" });
  }
  const input = {
    prompt: String(body.prompt || "").trim(), taskTypeId: String(body.taskTypeId || "poster"),
    taskTypeName: String(body.taskTypeName || "视觉内容"), dimensionId: String(body.dimensionId || "visual_style"),
    dimensionName: String(body.dimensionName || "设计风格"), optionCount: Math.min(4, Math.max(2, Number(body.optionCount) || 3)),
    ratio: String(body.ratio || "3:4"),
    referenceImage: typeof body.referenceImage === "string" && /^data:image\/(jpeg|png|webp);base64,/.test(body.referenceImage) ? body.referenceImage : ""
  };
  if (!input.prompt && !input.referenceImage) return sendJson(response, 400, { error: "原始提示词和参考图不能同时为空" });
  const requestId = `prompt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const systemPrompt = `你是视觉提示词方案设计器。只输出 JSON，不要 Markdown。用户提供参考图时，先识别主体、构图、色彩、材质和视觉语言，再围绕指定的单一探索维度生成方案；没有文字时从参考图推断基础意图，但不要编造品牌。保持主体、用途、比例和信息区域不变。输出对象包含 locked 和 variants。locked 包含 intent、subject、context、audience、composition、visualLanguage、palette、lighting、material、textLayout、constraints。variants 必须恰好 ${input.optionCount} 项，每项包含 title、changeSummary、prompt。prompt 可直接用于图片生成，避免未确认品牌、Logo、水印和复杂可读文字。`;
  const responseSchema = {
    type: "object",
    additionalProperties: false,
    required: ["locked", "variants"],
    properties: {
      locked: {
        type: "object",
        additionalProperties: false,
        required: ["intent", "subject", "context", "audience", "composition", "visualLanguage", "palette", "lighting", "material", "textLayout", "constraints"],
        properties: {
          intent: { type: "string" }, subject: { type: "string" }, context: { type: "string" }, audience: { type: "string" },
          composition: { type: "string" }, visualLanguage: { type: "string" }, palette: { type: "string" }, lighting: { type: "string" },
          material: { type: "string" }, textLayout: { type: "string" }, constraints: { type: "array", items: { type: "string" } }
        }
      },
      variants: {
        type: "array", minItems: input.optionCount, maxItems: input.optionCount,
        items: {
          type: "object", additionalProperties: false, required: ["title", "changeSummary", "prompt"],
          properties: { title: { type: "string" }, changeSummary: { type: "string" }, prompt: { type: "string" } }
        }
      }
    }
  };
  try {
    const upstream = await fetch(`${textApiBaseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "X-Request-ID": requestId },
      body: JSON.stringify({
        model: textApiModel,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: input.referenceImage ? [
            { type: "text", text: JSON.stringify({ ...input, referenceImage: undefined, hasReferenceImage: true }) },
            { type: "image_url", image_url: { url: input.referenceImage, detail: "low" } }
          ] : JSON.stringify(input) }
        ],
        response_format: { type: "json_schema", json_schema: { name: "prompt_blueprint", strict: true, schema: responseSchema } },
        max_completion_tokens: 8000
      }),
      signal: AbortSignal.timeout(120_000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return sendJson(response, upstream.status, { error: safeTextApiError(payload, upstream.status) });
    const content = payload.choices?.[0]?.message?.content;
    const parsed = typeof content === "string" ? JSON.parse(content) : content;
    return sendJson(response, 200, { blueprint: normalizePromptBlueprint(parsed, input) });
  } catch (error) {
    const message = error.name === "TimeoutError" ? "文本生成请求超时，请重试" : error.message || "提示词方案生成失败";
    return sendJson(response, 502, { error: message });
  }
}

async function saveImage(result, id) {
  await mkdir(generatedDir, { recursive: true });
  if (result.b64_json || result.image_base64 || result.base64) {
    const raw = result.b64_json || result.image_base64 || result.base64;
    const match = String(raw).match(/^data:image\/(png|jpeg|webp);base64,(.+)$/s);
    const extension = match?.[1] === "jpeg" ? "jpg" : match?.[1] || "png";
    const base64 = match?.[2] || raw;
    const filename = `${id}.${extension}`;
    await writeFile(join(generatedDir, filename), Buffer.from(base64, "base64"));
    return `/generated/${filename}`;
  }
  const remoteUrl = result.url || result.image_url || result.download_url;
  if (!remoteUrl) throw new Error("图片生成服务未返回图片数据");
  const imageResponse = await fetch(remoteUrl);
  if (!imageResponse.ok) throw new Error("生成成功，但图片下载失败");
  const contentType = imageResponse.headers.get("content-type") || "image/png";
  const extension = contentType.includes("webp") ? "webp" : contentType.includes("jpeg") ? "jpg" : "png";
  const filename = `${id}.${extension}`;
  await writeFile(join(generatedDir, filename), Buffer.from(await imageResponse.arrayBuffer()));
  return `/generated/${filename}`;
}

async function generateImage(request, response) {
  const apiKey = imageApiKey;
  if (!apiKey) return sendJson(response, 503, { error: "本地服务未配置图片生成 API Key" });
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message || "请求格式错误" });
  }
  if (!body.prompt?.trim()) return sendJson(response, 400, { error: "提示词不能为空" });
  const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const upstream = await fetch(`${imageApiBaseUrl}/images/generations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": id
      },
      body: JSON.stringify({
        model: imageApiModel,
        prompt: body.prompt,
        n: 1,
        size: sizeByRatio[body.ratio] || "1024x1024",
        quality: "high"
      }),
      signal: AbortSignal.timeout(300_000)
    });
    const payload = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return sendJson(response, upstream.status, { error: safeApiError(payload, upstream.status) });
    const result = payload.data?.[0] || payload.response?.data?.[0] || payload;
    const imageUrl = await saveImage(result, id);
    return sendJson(response, 200, { imageUrl });
  } catch (error) {
    const message = error.name === "TimeoutError" ? "图片生成请求超时，请重试" : error.message || "图片生成失败";
    return sendJson(response, 502, { error: message });
  }
}

async function deleteGeneratedImage(request, response) {
  let body;
  try {
    body = await readJson(request);
  } catch (error) {
    return sendJson(response, 400, { error: error.message || "请求格式错误" });
  }
  const match = String(body.imageUrl || "").match(/^\/generated\/([A-Za-z0-9_-]+\.(?:png|jpe?g|webp))$/i);
  if (!match) return sendJson(response, 400, { error: "只能删除本项目生成的图片" });
  try {
    await unlink(join(generatedDir, match[1]));
  } catch (error) {
    if (error.code !== "ENOENT") return sendJson(response, 500, { error: "图片文件清理失败" });
  }
  response.writeHead(204);
  response.end();
}

async function serveStatic(request, response) {
  const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
  const requested = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const filePath = join(root, normalize(requested));
  if (!filePath.startsWith(root)) return sendJson(response, 403, { error: "禁止访问" });
  try {
    const file = await readFile(filePath);
    response.writeHead(200, { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream" });
    response.end(file);
  } catch {
    sendJson(response, 404, { error: "文件不存在" });
  }
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/api/status") {
    const imageConfigured = Boolean(imageApiKey);
    const textConfigured = Boolean(textApiKey);
    const configured = imageConfigured && textConfigured;
    const explicitText = Boolean(process.env.TEXT_API_KEY || process.env.TEXT_API_BASE_URL);
    const explicitImage = Boolean(process.env.IMAGE_API_KEY || process.env.IMAGE_API_BASE_URL);
    const configuration = explicitText && explicitImage ? "separate" : sharedApiKey && (explicitText || explicitImage) ? "mixed" : sharedApiKey ? "shared" : explicitText || explicitImage ? "separate" : "unconfigured";
    return sendJson(response, textConfigured || imageConfigured ? 200 : 503, { service: "ai-generation", configured, configuration, capabilities: { text: textConfigured, image: imageConfigured } });
  }
  if (request.method === "POST" && request.url === "/api/prompts/generate") return generatePrompts(request, response);
  if (request.method === "POST" && request.url === "/api/images/generate") return generateImage(request, response);
  if (request.method === "DELETE" && request.url === "/api/images/file") return deleteGeneratedImage(request, response);
  if (request.method === "GET") return serveStatic(request, response);
  sendJson(response, 405, { error: "请求方法不支持" });
}).listen(port, "127.0.0.1", () => {
  console.log(`VisPath · 视觉路径：http://127.0.0.1:${port}`);
});
