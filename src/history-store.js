const DB_NAME = "ai-visual-direction-board";
const DB_VERSION = 1;
const STORE_NAME = "workspace";
const HISTORY_KEY = "generation-history";
const API_SETTINGS_KEY = "api-settings";
const OUTPUT_SETTINGS_KEY = "output-settings";
const IMAGE_CACHE_KEY_PREFIX = "generation-image-cache:";
const REFERENCE_IMAGE_CACHE_KEY_PREFIX = "reference-image-cache:";
const HISTORY_SCHEMA_VERSION = 17;
const ENTRY_FIELDS = [
  "id", "batchId", "batchNumber", "batchCreatedAt", "variantTitle", "changeSummary", "promptSnapshot",
  "blueprintSnapshot", "submissionSnapshot", "parentGenerationId", "refinementDepth",
  "explorationDimensionId", "explorationDimensionName", "explorationOption", "artClass", "ratio", "resolution",
  "generationMode", "responseFormat", "actualResponseFormat", "createdAt", "queuedAt", "submittedAt", "startedAt", "completedAt", "status",
  "referenceUsage", "referenceImageCacheKey",
  "imageUrl", "originalImageUrl", "imageCacheKey", "imageCacheBackend", "imageCacheStatus", "imageCacheErrorCode", "imageCacheErrorMessage", "imageMimeType", "imageByteSize",
  "imageWidth", "imageHeight", "errorMessage", "requestId", "taskId", "taskStatus", "taskProgress", "favorite",
  "outputSaveStatus", "outputFileName", "outputSavedAt", "outputSaveError"
];

const BLUEPRINT_FIELDS = ["intent", "subject", "context", "audience", "composition", "visualLanguage", "palette", "lighting", "material", "textLayout"];

function sanitizeBlueprintSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const source = value.source && typeof value.source === "object" ? value.source : {};
  const locked = value.locked && typeof value.locked === "object" ? value.locked : {};
  const dimensions = value.dimensions && typeof value.dimensions === "object" ? value.dimensions : {};
  const cleanLocked = {};
  BLUEPRINT_FIELDS.forEach((field) => {
    if (typeof locked[field] === "string" && locked[field].trim()) cleanLocked[field] = locked[field].trim();
  });
  cleanLocked.technical = { ratio: typeof locked.technical?.ratio === "string" ? locked.technical.ratio : "" };
  cleanLocked.constraints = Array.isArray(locked.constraints)
    ? [...new Set(locked.constraints.filter((item) => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    taskTypeId: typeof value.taskTypeId === "string" ? value.taskTypeId : "",
    source: {
      prompt: typeof source.prompt === "string" ? source.prompt : "",
      referenceUsage: source.referenceUsage === "explore" ? "explore" : "analyze",
      referenceRole: source.referenceRole === "generation-reference" ? "generation-reference" : "analysis-only",
      referenceSource: source.referenceSource === "generated-result" ? "generated-result" : "",
      contentMode: source.contentMode === "factual" ? "factual" : "concept"
    },
    locked: cleanLocked,
    dimensions: Object.fromEntries(Object.entries(dimensions).filter(([, option]) => typeof option === "string" && option.trim()).map(([id, option]) => [id, option.trim()])),
    acceptedPrompt: typeof value.acceptedPrompt === "string" ? value.acceptedPrompt : ""
  };
}

function sanitizeSubmissionSnapshot(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const requestedOptionCount = Number(value.requestedOptionCount);
  return {
    schemaVersion: Number(value.schemaVersion) || 1,
    sourcePrompt: typeof value.sourcePrompt === "string" ? value.sourcePrompt : "",
    contentMode: value.contentMode === "factual" ? "factual" : "concept",
    taskTypeId: typeof value.taskTypeId === "string" ? value.taskTypeId : "",
    taskTypeName: typeof value.taskTypeName === "string" ? value.taskTypeName : "",
    requestedOptionCount: Number.isInteger(requestedOptionCount) && requestedOptionCount > 0 ? requestedOptionCount : 1,
    ratio: typeof value.ratio === "string" ? value.ratio : "",
    resolution: typeof value.resolution === "string" ? value.resolution : "",
    generationMode: value.generationMode === "sync" ? "sync" : "async",
    referenceUsage: value.referenceUsage === "explore" ? "explore" : "analyze",
    referenceSource: value.referenceSource === "generated-result" ? "generated-result" : value.referenceSource === "user-upload" ? "user-upload" : "",
    hasReferenceImage: Boolean(value.hasReferenceImage),
    explorationDimensionId: typeof value.explorationDimensionId === "string" ? value.explorationDimensionId : "",
    explorationDimensionName: typeof value.explorationDimensionName === "string" ? value.explorationDimensionName : ""
  };
}

function inferActualResponseFormat(imageUrl) {
  if (typeof imageUrl !== "string" || !imageUrl) return undefined;
  return imageUrl.startsWith("data:image/") ? "b64_json" : "url";
}

function sanitizeEntry(entry) {
  const clean = {};
  for (const field of ENTRY_FIELDS) {
    if (entry?.[field] !== undefined) clean[field] = entry[field];
  }
  clean.batchNumber = String(clean.batchNumber || "00");
  clean.batchId = String(clean.batchId || `legacy_batch_${clean.batchNumber}`);
  clean.batchCreatedAt = typeof clean.batchCreatedAt === "string" ? clean.batchCreatedAt : "";
  clean.startedAt = typeof clean.startedAt === "string" ? clean.startedAt : "";
  clean.queuedAt = typeof clean.queuedAt === "string" ? clean.queuedAt : clean.startedAt;
  clean.submittedAt = typeof clean.submittedAt === "string" ? clean.submittedAt : "";
  clean.completedAt = typeof clean.completedAt === "string" ? clean.completedAt : "";
  clean.status = ["loading", "ready", "error"].includes(clean.status) ? clean.status : "error";
  if (typeof clean.imageUrl !== "string" || clean.imageUrl.startsWith("blob:")) clean.imageUrl = "";
  clean.originalImageUrl = typeof clean.originalImageUrl === "string" ? clean.originalImageUrl : "";
  clean.imageCacheBackend = ["blob", "opaque"].includes(clean.imageCacheBackend) ? clean.imageCacheBackend : "";
  clean.imageCacheStatus = ["pending", "ready", "error"].includes(clean.imageCacheStatus) ? clean.imageCacheStatus : "";
  clean.imageCacheErrorCode = typeof clean.imageCacheErrorCode === "string" ? clean.imageCacheErrorCode : "";
  clean.imageCacheErrorMessage = typeof clean.imageCacheErrorMessage === "string" ? clean.imageCacheErrorMessage : "";
  clean.imageCacheKey = typeof clean.imageCacheKey === "string" ? clean.imageCacheKey : "";
  clean.imageMimeType = typeof clean.imageMimeType === "string" ? clean.imageMimeType : "";
  clean.imageByteSize = Number.isInteger(clean.imageByteSize) && clean.imageByteSize > 0 ? clean.imageByteSize : undefined;
  clean.generationMode = clean.generationMode === "sync" ? "sync" : "async";
  clean.referenceUsage = clean.referenceUsage === "explore" ? "explore" : "analyze";
  clean.referenceImageCacheKey = typeof clean.referenceImageCacheKey === "string" ? clean.referenceImageCacheKey : "";
  clean.responseFormat = clean.responseFormat === "b64_json" ? "b64_json" : "url";
  clean.actualResponseFormat = ["url", "b64_json"].includes(clean.actualResponseFormat)
    ? clean.actualResponseFormat
    : inferActualResponseFormat(clean.imageUrl);
  clean.imageWidth = Number.isInteger(clean.imageWidth) && clean.imageWidth > 0 ? clean.imageWidth : undefined;
  clean.imageHeight = Number.isInteger(clean.imageHeight) && clean.imageHeight > 0 ? clean.imageHeight : undefined;
  clean.favorite = Boolean(clean.favorite);
  clean.outputSaveStatus = ["pending", "saving", "saved", "error"].includes(clean.outputSaveStatus) ? clean.outputSaveStatus : "";
  clean.outputFileName = typeof clean.outputFileName === "string" ? clean.outputFileName : "";
  clean.outputSavedAt = typeof clean.outputSavedAt === "string" ? clean.outputSavedAt : "";
  clean.outputSaveError = typeof clean.outputSaveError === "string" ? clean.outputSaveError : "";
  clean.parentGenerationId = typeof clean.parentGenerationId === "string" ? clean.parentGenerationId : "";
  clean.refinementDepth = Number.isInteger(clean.refinementDepth) && clean.refinementDepth >= 0 ? clean.refinementDepth : 0;
  clean.blueprintSnapshot = sanitizeBlueprintSnapshot(clean.blueprintSnapshot);
  clean.submissionSnapshot = sanitizeSubmissionSnapshot(clean.submissionSnapshot);
  return clean;
}

export function sanitizeGenerationHistory(payload) {
  if (!payload || typeof payload !== "object") return null;
  const entries = Array.isArray(payload.entries) ? payload.entries.map(sanitizeEntry) : [];
  const clean = {
    schemaVersion: HISTORY_SCHEMA_VERSION,
    entries,
    batchNumber: Number(payload.batchNumber) || 0,
    savedAt: typeof payload.savedAt === "string" ? payload.savedAt : new Date(0).toISOString()
  };
  const migrated = payload.schemaVersion !== HISTORY_SCHEMA_VERSION || JSON.stringify(payload) !== JSON.stringify(clean);
  return { ...clean, migrated };
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction(mode, action) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, mode);
    let request;
    let result;
    try {
      request = action(transaction.objectStore(STORE_NAME));
    } catch (error) {
      database.close();
      reject(error);
      return;
    }
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => {
      database.close();
      resolve(result);
    };
    transaction.onabort = transaction.onerror = () => {
      database.close();
      reject(transaction.error);
    };
  });
}

export async function loadGenerationHistory() {
  const payload = await runTransaction("readonly", (store) => store.get(HISTORY_KEY));
  return sanitizeGenerationHistory(payload);
}

export function saveGenerationHistory(payload) {
  const clean = sanitizeGenerationHistory(payload);
  if (!clean) throw new Error("历史记录格式无效");
  const { migrated, ...stored } = clean;
  return runTransaction("readwrite", (store) => store.put(stored, HISTORY_KEY));
}

export function clearGenerationHistory() {
  return runTransaction("readwrite", (store) => store.delete(HISTORY_KEY));
}

export function getGenerationImageCacheKey(entryId) {
  const id = String(entryId || "").trim();
  if (!id) throw new Error("生成记录 ID 无效");
  return `${IMAGE_CACHE_KEY_PREFIX}${id}`;
}

export function loadGenerationImageCache(entryId) {
  return runTransaction("readonly", (store) => store.get(getGenerationImageCacheKey(entryId)));
}

export async function listGenerationImageCaches() {
  const records = await runTransaction("readonly", (store) => store.getAll());
  return records.filter((record) => typeof record?.entryId === "string" && record.blob instanceof Blob && record.blob.size > 0);
}

export function saveGenerationImageCache(entryId, imageUrl, blob) {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error("图片缓存内容无效");
  const record = {
    kind: "generation-image",
    entryId: String(entryId),
    imageUrl: /^https?:\/\//i.test(String(imageUrl || "")) ? String(imageUrl) : "",
    blob,
    mimeType: blob.type || "application/octet-stream",
    byteSize: blob.size,
    savedAt: new Date().toISOString()
  };
  return runTransaction("readwrite", (store) => store.put(record, getGenerationImageCacheKey(entryId)));
}

export function getReferenceImageCacheKey(batchId) {
  const id = String(batchId || "").trim();
  if (!id) throw new Error("参考图批次 ID 无效");
  return `${REFERENCE_IMAGE_CACHE_KEY_PREFIX}${id}`;
}

export function loadReferenceImageCache(cacheKey) {
  const key = String(cacheKey || "").trim();
  if (!key.startsWith(REFERENCE_IMAGE_CACHE_KEY_PREFIX)) throw new Error("参考图缓存键无效");
  return runTransaction("readonly", (store) => store.get(key));
}

export function saveReferenceImageCache(batchId, blob, fileName = "reference.png") {
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error("参考图缓存内容无效");
  const cacheKey = getReferenceImageCacheKey(batchId);
  const record = {
    kind: "reference-image",
    cacheKey,
    batchId: String(batchId),
    blob,
    fileName: String(fileName || "reference.png"),
    mimeType: blob.type || "application/octet-stream",
    byteSize: blob.size,
    savedAt: new Date().toISOString()
  };
  return runTransaction("readwrite", (store) => store.put(record, cacheKey));
}

export function deleteReferenceImageCache(cacheKey) {
  const key = String(cacheKey || "").trim();
  if (!key.startsWith(REFERENCE_IMAGE_CACHE_KEY_PREFIX)) return Promise.resolve();
  return runTransaction("readwrite", (store) => store.delete(key));
}

export async function listReferenceImageCaches() {
  const records = await runTransaction("readonly", (store) => store.getAll());
  return records.filter((record) => record?.kind === "reference-image" && record.blob instanceof Blob && record.blob.size > 0);
}

export function deleteGenerationImageCache(entryId) {
  return runTransaction("readwrite", (store) => store.delete(getGenerationImageCacheKey(entryId)));
}

export function loadApiSettings() {
  return runTransaction("readonly", (store) => store.get(API_SETTINGS_KEY));
}

function isDirectoryHandle(value) {
  return Boolean(value && typeof value.getFileHandle === "function");
}

export function sanitizeOutputSettings(payload) {
  const directoryHandle = isDirectoryHandle(payload?.directoryHandle) ? payload.directoryHandle : null;
  return {
    schemaVersion: 1,
    autoSaveEnabled: Boolean(payload?.autoSaveEnabled),
    directoryHandle,
    directoryName: String(payload?.directoryName || directoryHandle?.name || "").trim(),
    savedAt: typeof payload?.savedAt === "string" ? payload.savedAt : ""
  };
}

export async function loadOutputSettings() {
  const payload = await runTransaction("readonly", (store) => store.get(OUTPUT_SETTINGS_KEY));
  return sanitizeOutputSettings(payload);
}

export function saveOutputSettings(settings) {
  const clean = sanitizeOutputSettings({ ...settings, savedAt: new Date().toISOString() });
  return runTransaction("readwrite", (store) => store.put(clean, OUTPUT_SETTINGS_KEY));
}

export function saveApiSettings(settings) {
  const legacyBaseUrl = String(settings?.apiBaseUrl || "").trim().replace(/\/+$/, "");
  const clean = {
    textBaseUrl: String(settings?.textBaseUrl || legacyBaseUrl || "").trim().replace(/\/+$/, ""),
    textApiKey: String(settings?.textApiKey || "").trim(),
    textModel: String(settings?.textModel || "gpt-5.4-mini").trim(),
    imageBaseUrl: String(settings?.imageBaseUrl || legacyBaseUrl || "").trim().replace(/\/+$/, ""),
    imageApiKey: String(settings?.imageApiKey || "").trim(),
    imageModel: String(settings?.imageModel || "gpt-image-2").trim(),
    imageGenerationMode: settings?.imageGenerationMode === "async" ? "async" : "sync"
  };
  return runTransaction("readwrite", (store) => store.put(clean, API_SETTINGS_KEY));
}

export function clearApiSettings() {
  return runTransaction("readwrite", (store) => store.delete(API_SETTINGS_KEY));
}
