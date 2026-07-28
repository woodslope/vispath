import { CONTENT_MODES, EXPLORATION_DIMENSIONS, TASK_TYPES, getExplorationGuidance } from "./src/prompt-blueprint.js";
import { createImageEditRequest, createImageRequest, getImageEndpointPath } from "./src/image-generation.js";
import { clearApiSettings, clearGenerationHistory, deleteGenerationImageCache, deleteReferenceImageCache, getGenerationImageCacheKey, getReferenceImageCacheKey, listGenerationImageCaches, listReferenceImageCaches, loadApiSettings, loadGenerationHistory, loadGenerationImageCache, loadReferenceImageCache, loadOutputSettings, saveApiSettings, saveGenerationHistory, saveGenerationImageCache, saveReferenceImageCache, saveOutputSettings } from "./src/history-store.js";
import { canUseOutputDirectoryPicker, createOutputImageFileName, getOutputDirectoryPermission, isOutputDirectoryHandle, requestOutputDirectoryPermission, writeBlobToOutputDirectory } from "./src/output-storage.js";
import { createBlueprintInstructions, getBlueprintMaxOutputTokens, normalizeBlueprintResponse } from "./src/prompt-renderer.js";

const state = {
  blueprint: null,
  refinementBase: null,
  refinementParentGenerationId: "",
  refinementDepth: 0,
  contentMode: "concept",
  referenceImage: null,
  referenceImageData: "",
  referenceImageSource: "",
  referenceUsage: "analyze",
  selectedVariantIds: new Set(),
  generationEntries: [],
  resultFilters: { query: "", status: "all", batchId: "all" },
  batchNumber: 0,
  apiSettings: null,
  outputSettings: { autoSaveEnabled: false, directoryHandle: null, directoryName: "" },
  directionCompletionError: ""
};

const $ = (id) => document.getElementById(id);

function clearRefinementLineage() {
  if (state.referenceImageSource === "generated-result") {
    referenceImageLoadToken += 1;
    state.referenceImage = null;
    state.referenceImageData = "";
    state.referenceImageSource = "";
    state.referenceUsage = "analyze";
    $("filePreview").classList.add("hidden");
    $("dropzone").classList.remove("hidden");
    syncReferenceUsageUI();
  }
  state.refinementBase = null;
  state.refinementParentGenerationId = "";
  state.refinementDepth = 0;
}

const taskTypeSelect = $("taskType");
const dimensionList = $("dimensionList");
const promptList = $("variantGrid");
const generationFeed = $("generationFeed");
const stageButtons = [...document.querySelectorAll(".stage-nav [data-stage-target]")];
const blueprintSection = document.querySelector(".inline-blueprint");
const blueprintToggle = $("toggleBlueprintBtn");
const apiSettingsDialog = $("apiSettingsDialog");
const outputSettingsDialog = $("outputSettingsDialog");
const clearApiSettingsDialog = $("clearApiSettingsDialog");
const resetDialog = $("resetDialog");
const editSetupDialog = $("editSetupDialog");
const historyDialog = $("historyDialog");
const batchSubmissionDialog = $("batchSubmissionDialog");
const retryGenerationDialog = $("retryGenerationDialog");
const imageRecoveryOptionsDialog = $("imageRecoveryOptionsDialog");
const imagePreviewDialog = $("imagePreviewDialog");
const comparisonDialog = $("comparisonDialog");
const imageRatioSelect = $("imageRatio");
let imageRatioOverridden = false;
let pendingRetryEntryId = "";
let pendingImageRecoveryEntryId = "";
let pendingBatchSubmissionId = "";
let pendingBatchReuseConfirmed = false;
let batchSubmissionReferencePreviewUrl = "";
let historySaveQueue = Promise.resolve();
const generationQueue = [];
const scheduledGenerationIds = new Set();
let activeGenerationCount = 0;
let generationConcurrency = 2;
let generationConcurrencyRestoreTimer = 0;
let imageCacheQueue = Promise.resolve();
let historyImageCacheQueue = Promise.resolve();
let outputSaveQueue = Promise.resolve();
let outputSettingsDraft = null;
let outputDirectoryStatusToken = 0;
let textTooltipSyncFrame = 0;
const IMAGE_CLEANUP_KEY = "ai-visual-direction-board-pending-image-cleanup";
const OPEN_BATCHES_KEY = "vispath-open-generation-batches";
const OPAQUE_IMAGE_CACHE_NAME = "vispath-generated-images-v1";
const VISPATH_IMAGE_DIAGNOSTIC_KEY = "vispath-last-image-diagnostic";
const IMAGE_CLEANUP_DELAY = 5500;
const IMAGE_POLL_INTERVAL = 3000;
const IMAGE_POLL_MAX_ATTEMPTS = 120;
const IMAGE_RETRY_DELAYS = [5000, 15000];
const IMAGE_GENERATION_CONCURRENCY = 2;
const IMAGE_RATE_LIMIT_COOLDOWN = 60000;
const GLOBAL_GENERATION_SLOT_NAMES = ["vispath-image-slot-1", "vispath-image-slot-2"];
const GLOBAL_GENERATION_ENTRY_LOCK_PREFIX = "vispath-image-entry:";
const GLOBAL_RATE_LIMIT_KEY = "vispath-image-rate-limit-until";
const imageCleanupTimers = new Map();
const pendingOpaqueImageCleanupUrls = new Map();
const generatedImageObjectUrls = new Map();
let generatedImageServiceWorkerRegistration = null;
let generatedImageServiceWorkerPromise = null;
let isGeneratingDirections = false;
let openGenerationBatchIds = readOpenGenerationBatchIds();
let hasSavedBatchDisclosure = localStorage.getItem(OPEN_BATCHES_KEY) !== null;
let generationHistoryLoaded = false;
let isSubmittingSelected = false;
let isCompletingDirections = false;
let referenceImageLoadToken = 0;
let isProcessingReferenceImage = false;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function loadLastImageDiagnostic() {
  try {
    const value = JSON.parse(localStorage.getItem(VISPATH_IMAGE_DIAGNOSTIC_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function getDiagnosticImageHost(value) {
  try {
    return new URL(value).host || "API 响应";
  } catch {
    return "API 响应";
  }
}

function getDiagnosticFailureReason(code = "request_failed") {
  if (code === "remote_unavailable") return "图片 URL 无法读取（CORS、网络或链接失效）";
  if (code === "storage_unavailable") return "IndexedDB 图片写入失败";
  if (code === "missing_source") return "本地图片缓存和原始来源均不可用";
  if (code === "restore_failed") return "浏览器图片缓存读取失败";
  if (code === "reference_cache_missing") return "参与生图探索所需的参考图缓存已丢失";
  return "生图请求失败";
}

function renderLastImageDiagnostic() {
  const diagnostic = loadLastImageDiagnostic();
  const values = {
    imageDiagnosticRequestMode: diagnostic?.requestMode,
    imageDiagnosticEndpointPath: diagnostic?.endpointPath,
    imageDiagnosticRequestedFormat: diagnostic?.requestedFormat,
    imageDiagnosticActualFormat: diagnostic?.actualFormat,
    imageDiagnosticImageHost: diagnostic?.imageHost,
    imageDiagnosticStorageBackend: diagnostic?.storageBackend,
    imageDiagnosticStorageStatus: diagnostic?.storageStatus,
    imageDiagnosticRestoreStatus: diagnostic?.restoreStatus,
    imageDiagnosticFailureReason: diagnostic?.failureReason || "无"
  };
  for (const [id, value] of Object.entries(values)) {
    const element = $(id);
    if (element) element.textContent = value || "未记录";
  }
  const updatedAt = $("imageDiagnosticUpdatedAt");
  if (updatedAt) updatedAt.textContent = diagnostic?.updatedAt ? new Date(diagnostic.updatedAt).toLocaleString() : "暂无记录";
}

function saveLastImageDiagnostic(patch, expectedEntryId = "") {
  const previous = loadLastImageDiagnostic();
  if (expectedEntryId && previous?.entryId !== expectedEntryId) return previous;
  const next = { ...(previous || {}), ...patch, updatedAt: new Date().toISOString() };
  localStorage.setItem(VISPATH_IMAGE_DIAGNOSTIC_KEY, JSON.stringify(next));
  renderLastImageDiagnostic();
  return next;
}

function readOpenGenerationBatchIds() {
  try {
    const ids = JSON.parse(localStorage.getItem(OPEN_BATCHES_KEY) || "[]");
    return new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string" && id) : []);
  } catch {
    return new Set();
  }
}

function saveOpenGenerationBatchIds() {
  localStorage.setItem(OPEN_BATCHES_KEY, JSON.stringify([...openGenerationBatchIds]));
  hasSavedBatchDisclosure = true;
}

function pruneOpenGenerationBatchIds(batches) {
  const availableIds = new Set(batches.map((batch) => batch.id));
  const nextIds = new Set([...openGenerationBatchIds].filter((id) => availableIds.has(id)));
  if (nextIds.size === openGenerationBatchIds.size) return;
  openGenerationBatchIds = nextIds;
  saveOpenGenerationBatchIds();
}

function renderCloseIcon() {
  return '<svg class="ui-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M14 14L34 34M34 14L14 34" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function renderStarIcon(filled = false) {
  return `<svg class="ui-icon" viewBox="0 0 48 48" aria-hidden="true"><path d="M24 4.5L30.1 17L44 19L34 28.7L36.4 42.5L24 36L11.6 42.5L14 28.7L4 19L17.9 17L24 4.5Z" fill="${filled ? "currentColor" : "none"}" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>`;
}

function normalizeApiBaseUrl(value) { return String(value || "").trim().replace(/\/+$/, ""); }
function getTextApiBaseUrl(settings = state.apiSettings) { return normalizeApiBaseUrl(settings?.textBaseUrl || settings?.apiBaseUrl); }
function getImageApiBaseUrl(settings = state.apiSettings) { return normalizeApiBaseUrl(settings?.imageBaseUrl || settings?.apiBaseUrl); }
function hasBrowserTextApi() { return Boolean(state.apiSettings?.textApiKey && getTextApiBaseUrl()); }
function hasBrowserImageApi() { return Boolean(state.apiSettings?.imageApiKey && getImageApiBaseUrl()); }

function resolveImageModel(settings, resolution) {
  const configuredModel = String(settings?.imageModel || "gpt-image-2").trim();
  if (!/^gpt-image-2(?:-(?:1k|2k|4k))?$/.test(configuredModel)) return configuredModel;
  return `gpt-image-2-${String(resolution || "1K").toLowerCase()}`;
}

function getRequestedAspectRatio(ratio) {
  const [width, height] = String(ratio || "").split(":").map(Number);
  return width > 0 && height > 0 ? width / height : null;
}

function getDisplayAspectRatio(entry) {
  if (entry?.imageWidth > 0 && entry?.imageHeight > 0) return entry.imageWidth / entry.imageHeight;
  return getRequestedAspectRatio(entry?.ratio) || 4 / 3;
}

function isImageAspectRatioMatching(entry) {
  const requested = getRequestedAspectRatio(entry?.ratio);
  if (!requested || !entry?.imageWidth || !entry?.imageHeight) return null;
  return Math.abs(entry.imageWidth / entry.imageHeight - requested) / requested <= 0.02;
}

function renderActualImageSize(entry) {
  if (!entry.imageWidth || !entry.imageHeight) return '<span class="generation-actual-size is-pending">实际尺寸待读取</span>';
  const matches = isImageAspectRatioMatching(entry);
  return `<span class="generation-actual-size ${matches ? "is-match" : "is-mismatch"}">实际 ${entry.imageWidth}×${entry.imageHeight} · ${matches ? "比例一致" : "比例不符"}</span>`;
}

function renderGeneratedImageCacheStatus(entry) {
  if (entry.imageCacheStatus !== "error") return "";
  const remoteUnavailable = entry.imageCacheErrorCode === "remote_unavailable";
  const title = remoteUnavailable ? "临时图片链接无法长期保存" : "浏览器本地缓存写入失败";
  const message = remoteUnavailable
    ? "当前地址已失效或无法写入浏览器缓存，可重新生成或查看恢复选项。"
    : entry.imageCacheErrorMessage || "当前图片仍可使用，恢复浏览器存储后可重新缓存。";
  const action = remoteUnavailable
    ? '<button class="button button-quiet" type="button" data-action="open-image-recovery">恢复选项</button>'
    : '<button class="button button-quiet" type="button" data-action="retry-image-cache">重新缓存</button>';
  return `<span class="generation-image-cache-error" role="status"><strong>${title}</strong><span class="generation-image-cache-error-message">${escapeHtml(message)}</span><span class="generation-image-cache-error-actions">${action}</span></span>`;
}

function isGeneratedImageMissing(entry) {
  return entry.status === "ready" && !entry.imageUrl && entry.imageCacheStatus === "error";
}

function createImageDownloadName(entry) {
  const title = String(entry?.variantTitle || "生成图片")
    .replace(/[\\/:*?"<>|]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `${title || "生成图片"}.png`;
}

function normalizeOutputSettings(settings = {}) {
  const directoryHandle = isOutputDirectoryHandle(settings.directoryHandle) ? settings.directoryHandle : null;
  return {
    autoSaveEnabled: Boolean(settings.autoSaveEnabled),
    directoryHandle,
    directoryName: String(settings.directoryName || directoryHandle?.name || "").trim()
  };
}

function getOutputSettingsForForm() {
  return outputSettingsDraft || state.outputSettings;
}

function isOutputAutoSaveReady(settings = state.outputSettings) {
  return Boolean(settings.autoSaveEnabled && isOutputDirectoryHandle(settings.directoryHandle));
}

function renderOutputDirectoryStatus(settings = getOutputSettingsForForm(), permission = "") {
  const hasHandle = isOutputDirectoryHandle(settings.directoryHandle);
  const pickerSupported = canUseOutputDirectoryPicker();
  const status = $("outputSettingsStatus");
  const directoryName = $("outputDirectoryName");
  const permissionLabel = $("outputDirectoryPermission");
  const supportNote = $("outputSettingsSupportNote");
  const chooseButton = $("chooseOutputDirectoryBtn");
  const autoSaveInput = $("outputAutoSaveInput");
  if (!status || !directoryName || !permissionLabel || !supportNote || !chooseButton || !autoSaveInput) return;

  directoryName.textContent = hasHandle ? settings.directoryName || settings.directoryHandle.name || "已选择目录" : "未选择";
  permissionLabel.textContent = !hasHandle
    ? "需要选择一个本地文件夹"
    : permission === "granted"
      ? "目录已授权，可自动写入"
      : permission === "denied"
        ? "授权已失效，请重新选择目录"
        : permission === "checking"
          ? "正在检查目录授权…"
          : "需要重新授权后才能自动写入";
  status.textContent = !pickerSupported && !hasHandle
    ? "当前浏览器不支持"
    : !hasHandle
      ? "未设置"
      : permission === "granted"
        ? settings.autoSaveEnabled ? "自动保存已启用" : "目录已选择"
        : "需要授权";
  status.className = `output-settings-status${permission === "granted" && settings.autoSaveEnabled ? " is-success" : permission === "denied" ? " is-error" : ""}`;
  chooseButton.disabled = !pickerSupported && !hasHandle;
  chooseButton.textContent = hasHandle ? "重新选择目录" : "选择目录";
  autoSaveInput.checked = Boolean(settings.autoSaveEnabled);
  autoSaveInput.disabled = !hasHandle;
  supportNote.textContent = !pickerSupported && !hasHandle
    ? "当前浏览器不支持直接写入指定文件夹，请使用支持 File System Access API 的桌面浏览器。"
    : "目录用于保存图片文件；历史记录、任务状态和必要的图片缓存仍保留在当前浏览器中。";
}

async function refreshOutputDirectoryStatus(settings = getOutputSettingsForForm()) {
  const token = ++outputDirectoryStatusToken;
  renderOutputDirectoryStatus(settings, isOutputDirectoryHandle(settings.directoryHandle) ? "checking" : "");
  const permission = isOutputDirectoryHandle(settings.directoryHandle)
    ? await getOutputDirectoryPermission(settings.directoryHandle)
    : "";
  if (token !== outputDirectoryStatusToken) return;
  renderOutputDirectoryStatus(settings, permission);
}

function renderGeneratedImageOutputStatus(entry) {
  if (!entry.outputSaveStatus) return "";
  const status = entry.outputSaveStatus;
  const label = status === "saved"
    ? `已保存到输出目录${entry.outputFileName ? ` · ${entry.outputFileName}` : ""}`
    : status === "saving"
      ? "正在保存到输出目录"
      : status === "pending"
        ? "等待自动保存"
        : `输出目录保存失败${entry.outputSaveError ? ` · ${entry.outputSaveError}` : ""}`;
  return `<span class="generation-output-status is-${status}" role="status">${escapeHtml(label)}</span>`;
}

function setEntryOutputSaveState(entry, status, errorMessage = "") {
  entry.outputSaveStatus = status;
  entry.outputSaveError = status === "error" ? String(errorMessage || "图片写入失败") : "";
  if (status !== "saved") entry.outputSavedAt = "";
}

async function loadGeneratedImageBlobForOutput(entry) {
  const cached = await loadGenerationImageCache(entry.id).catch(() => null);
  if (cached?.blob instanceof Blob && cached.blob.size > 0) return cached.blob;
  const sourceUrl = entry.originalImageUrl || entry.imageUrl;
  if (!isGeneratedImageSourceUrl(sourceUrl) && !String(sourceUrl || "").startsWith("blob:")) {
    const error = new Error("当前结果没有可读取的图片来源");
    error.outputErrorCode = "image_missing";
    throw error;
  }
  return fetchGeneratedImageBlob(sourceUrl);
}

async function saveEntryImageToOutput(entry, { automatic = false } = {}) {
  const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
  if (!currentEntry || currentEntry.status !== "ready") return;
  const directoryHandle = state.outputSettings.directoryHandle;
  if (!isOutputDirectoryHandle(directoryHandle)) {
    const error = new Error("请先在“输出设置”中选择输出目录");
    error.outputErrorCode = "directory_missing";
    throw error;
  }
  const permission = await getOutputDirectoryPermission(directoryHandle);
  if (permission !== "granted") {
    const error = new Error("输出目录授权已失效，请在“输出设置”中重新选择目录");
    error.outputErrorCode = "permission_required";
    throw error;
  }
  const blob = await loadGeneratedImageBlobForOutput(currentEntry);
  const fileName = currentEntry.outputFileName || createOutputImageFileName(currentEntry, blob.type);
  setEntryOutputSaveState(currentEntry, "saving");
  await persistGenerationHistory();
  renderGenerationFeed({ openBatchId: currentEntry.batchId || `legacy_batch_${currentEntry.batchNumber || "00"}` });
  await writeBlobToOutputDirectory(directoryHandle, fileName, blob);
  const latestEntry = state.generationEntries.find((item) => item.id === entry.id);
  if (!latestEntry || latestEntry.status !== "ready") return;
  latestEntry.outputFileName = fileName;
  latestEntry.outputSaveStatus = "saved";
  latestEntry.outputSavedAt = new Date().toISOString();
  latestEntry.outputSaveError = "";
  await persistGenerationHistory();
  renderGenerationFeed({ openBatchId: latestEntry.batchId || `legacy_batch_${latestEntry.batchNumber || "00"}` });
  if (!automatic) showToast(`已保存到输出目录：${fileName}`);
}

function queueGeneratedImageOutput(entry, cachePromise = Promise.resolve()) {
  outputSaveQueue = outputSaveQueue
    .then(() => cachePromise)
    .then(async () => {
      const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
      if (!currentEntry || currentEntry.status !== "ready" || currentEntry.outputSaveStatus !== "pending") return;
      try {
        await saveEntryImageToOutput(currentEntry, { automatic: true });
      } catch (error) {
        const latestEntry = state.generationEntries.find((item) => item.id === entry.id);
        if (!latestEntry || latestEntry.status !== "ready") return;
        setEntryOutputSaveState(latestEntry, "error", error.message || "图片写入输出目录失败");
        await persistGenerationHistory();
        renderGenerationFeed({ openBatchId: latestEntry.batchId || `legacy_batch_${latestEntry.batchNumber || "00"}` });
        showToast(`自动保存失败：${latestEntry.outputSaveError}`);
      }
    })
    .catch(() => {});
  return outputSaveQueue;
}

async function handleSaveGeneratedImage(entry) {
  if (!entry?.imageUrl) return;
  const directoryHandle = state.outputSettings.directoryHandle;
  if (isOutputDirectoryHandle(directoryHandle)) {
    try {
      const permission = await requestOutputDirectoryPermission(directoryHandle);
      if (permission !== "granted") {
        const error = new Error("输出目录授权未完成，请在“输出设置”中重新选择目录");
        error.outputErrorCode = "permission_required";
        throw error;
      }
      setEntryOutputSaveState(entry, "saving");
      renderGenerationFeed({ openBatchId: entry.batchId || `legacy_batch_${entry.batchNumber || "00"}` });
      await persistGenerationHistory();
      await saveEntryImageToOutput(entry);
    } catch (error) {
      const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
      if (currentEntry) {
        setEntryOutputSaveState(currentEntry, "error", error.message || "图片写入输出目录失败");
        await persistGenerationHistory();
        renderGenerationFeed({ openBatchId: currentEntry.batchId || `legacy_batch_${currentEntry.batchNumber || "00"}` });
      }
      showToast(error.message || "图片写入输出目录失败");
    }
    return;
  }
  const link = document.createElement("a");
  link.href = entry.imageUrl;
  link.download = createImageDownloadName(entry);
  link.rel = "noopener";
  link.click();
  showToast("已开始下载图片");
}

async function fetchGeneratedImageBlob(imageUrl) {
  try {
    const response = await fetch(imageUrl, { cache: "no-store" });
    if (!response.ok) throw new Error(`远程图片请求失败（HTTP ${response.status}）`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("远程图片内容为空");
    return blob;
  } catch (cause) {
    const error = new Error(cause?.message || "远程图片无法读取");
    error.imageCacheErrorCode = "remote_unavailable";
    throw error;
  }
}

function canUseOpaqueImageCache() {
  return ["http:", "https:"].includes(window.location.protocol)
    && "serviceWorker" in navigator
    && "caches" in window;
}

function registerGeneratedImageServiceWorker() {
  if (!canUseOpaqueImageCache()) return null;
  if (!generatedImageServiceWorkerPromise) {
    generatedImageServiceWorkerPromise = navigator.serviceWorker.register("./sw.js", { scope: "./" })
      .then(async (registration) => {
        await navigator.serviceWorker.ready;
        generatedImageServiceWorkerRegistration = registration;
        return registration;
      })
      .catch((error) => {
        generatedImageServiceWorkerPromise = null;
        throw error;
      });
  }
  return generatedImageServiceWorkerPromise;
}

async function verifyGeneratedImageCanLoad(imageUrl) {
  await new Promise((resolve, reject) => {
    const image = new Image();
    const timeout = window.setTimeout(() => reject(new Error("远程图片加载超时")), 10000);
    image.onload = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    image.onerror = () => {
      window.clearTimeout(timeout);
      reject(new Error("远程图片已失效或无访问权限"));
    };
    image.src = imageUrl;
  });
}

async function cacheGeneratedImageOpaque(imageUrl) {
  if (!canUseOpaqueImageCache()) throw new Error("当前页面不支持 Service Worker 图片缓存");
  await verifyGeneratedImageCanLoad(imageUrl);
  const registration = generatedImageServiceWorkerRegistration || await registerGeneratedImageServiceWorker();
  const worker = registration?.active || registration?.waiting || registration?.installing;
  if (!worker) throw new Error("Service Worker 未激活");

  await new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => reject(new Error("Service Worker 图片缓存超时")), 15000);
    channel.port1.onmessage = (event) => {
      window.clearTimeout(timeout);
      if (event.data?.ok) resolve();
      else reject(new Error(event.data?.error || "Service Worker 图片缓存失败"));
    };
    worker.postMessage({ type: "CACHE_IMAGE", url: imageUrl }, [channel.port2]);
  });

  const cache = await caches.open(OPAQUE_IMAGE_CACHE_NAME);
  const response = await cache.match(imageUrl);
  if (response?.type !== "opaque") throw new Error("Cache Storage 未保存 opaque 图片响应");
}

async function loadGeneratedImageOpaqueCache(imageUrl) {
  if (!canUseOpaqueImageCache() || !isRemoteGeneratedImageUrl(imageUrl)) return null;
  const cache = await caches.open(OPAQUE_IMAGE_CACHE_NAME);
  const response = await cache.match(imageUrl);
  return response?.type === "opaque" ? response : null;
}

async function deleteGeneratedImageOpaqueCache(imageUrl) {
  if (!canUseOpaqueImageCache() || !isRemoteGeneratedImageUrl(imageUrl)) return false;
  const cache = await caches.open(OPAQUE_IMAGE_CACHE_NAME);
  return cache.delete(imageUrl);
}

function downloadGeneratedImageBlob(entry, blob) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = createImageDownloadName(entry);
  link.rel = "noopener";
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

function isRemoteGeneratedImageUrl(imageUrl) {
  if (typeof imageUrl !== "string" || !imageUrl.trim()) return false;
  try {
    return ["http:", "https:"].includes(new URL(imageUrl, window.location.href).protocol);
  } catch {
    return false;
  }
}

function isGeneratedImageSourceUrl(imageUrl) {
  return isRemoteGeneratedImageUrl(imageUrl) || /^data:image\/[a-z0-9.+-]+;base64,/i.test(String(imageUrl || ""));
}

function releaseGeneratedImageObjectUrl(entryId) {
  const objectUrl = generatedImageObjectUrls.get(entryId);
  if (!objectUrl) return;
  URL.revokeObjectURL(objectUrl);
  generatedImageObjectUrls.delete(entryId);
}

function setGeneratedImageCacheMetadata(entry, blob, sourceUrl = "") {
  if (isRemoteGeneratedImageUrl(sourceUrl)) entry.originalImageUrl = sourceUrl;
  entry.imageCacheKey = getGenerationImageCacheKey(entry.id);
  entry.imageCacheBackend = "blob";
  entry.imageCacheStatus = "ready";
  entry.imageCacheErrorCode = "";
  entry.imageCacheErrorMessage = "";
  entry.imageMimeType = blob.type || "application/octet-stream";
  entry.imageByteSize = blob.size;
}

function setGeneratedImageOpaqueCacheMetadata(entry, sourceUrl) {
  entry.imageUrl = sourceUrl;
  entry.originalImageUrl = sourceUrl;
  entry.imageCacheKey = "";
  entry.imageCacheBackend = "opaque";
  entry.imageCacheStatus = "ready";
  entry.imageCacheErrorCode = "";
  entry.imageCacheErrorMessage = "";
  entry.imageMimeType = "";
  entry.imageByteSize = undefined;
}

function attachGeneratedImageBlob(entry, blob, sourceUrl = "") {
  releaseGeneratedImageObjectUrl(entry.id);
  const objectUrl = URL.createObjectURL(blob);
  generatedImageObjectUrls.set(entry.id, objectUrl);
  setGeneratedImageCacheMetadata(entry, blob, sourceUrl);
  entry.imageUrl = objectUrl;
}

function syncGeneratedImageCacheSuccess(entry) {
  const card = generationFeed.querySelector(`[data-generation-id="${CSS.escape(entry.id)}"]`);
  const image = card?.querySelector(".generation-image-frame img");
  if (image) image.src = entry.imageUrl;
  card?.querySelector(".generation-image-cache-error")?.remove();
}

async function cacheGeneratedImage(entry) {
  const imageUrl = entry.imageUrl;
  try {
    const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (!currentEntry || currentEntry.status !== "ready" || currentEntry.imageUrl !== imageUrl) return;
    const cached = await loadGenerationImageCache(currentEntry.id).catch(() => null);
    let blob;
    if (cached?.blob instanceof Blob && cached.blob.size > 0 && (!cached.imageUrl || cached.imageUrl === imageUrl)) {
      blob = cached.blob;
    } else {
      currentEntry.imageCacheStatus = "pending";
      blob = await fetchGeneratedImageBlob(imageUrl);
      const latestEntry = state.generationEntries.find((item) => item.id === entry.id);
      if (!latestEntry || latestEntry.status !== "ready" || latestEntry.imageUrl !== imageUrl) return;
      let verified;
      try {
        await saveGenerationImageCache(latestEntry.id, imageUrl, blob);
        verified = await loadGenerationImageCache(latestEntry.id);
      } catch (cause) {
        const storageError = new Error(cause?.message || "浏览器本地缓存写入失败");
        storageError.imageCacheErrorCode = "storage_unavailable";
        throw storageError;
      }
      if (!(verified?.blob instanceof Blob) || verified.blob.size !== blob.size) throw new Error("图片 Blob 缓存校验失败");
      blob = verified.blob;
    }

    const referenceEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (!referenceEntry || referenceEntry.status !== "ready" || referenceEntry.imageUrl !== imageUrl) {
      await deleteGenerationImageCache(entry.id).catch(() => {});
      return;
    }
    setGeneratedImageCacheMetadata(referenceEntry, blob, imageUrl);
    await persistGenerationHistory({ strict: true });

    const latestEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (!latestEntry || latestEntry.status !== "ready" || latestEntry.imageUrl !== imageUrl) {
      await deleteGenerationImageCache(entry.id).catch(() => {});
      return;
    }
    attachGeneratedImageBlob(latestEntry, blob, imageUrl);
    await persistGenerationHistory();
    saveLastImageDiagnostic({ storageBackend: "IndexedDB", storageStatus: "成功", restoreStatus: "尚未验证", failureReason: "" }, entry.id);
    syncGeneratedImageCacheSuccess(latestEntry);
  } catch (error) {
    await deleteGenerationImageCache(entry.id).catch(() => {});
    const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (currentEntry?.status === "ready" && currentEntry.imageUrl === imageUrl) {
      if (error?.imageCacheErrorCode === "remote_unavailable" && isRemoteGeneratedImageUrl(imageUrl)) {
        try {
          await cacheGeneratedImageOpaque(imageUrl);
          const opaqueEntry = state.generationEntries.find((item) => item.id === entry.id);
          if (!opaqueEntry || opaqueEntry.status !== "ready" || opaqueEntry.imageUrl !== imageUrl) {
            await deleteGeneratedImageOpaqueCache(imageUrl).catch(() => false);
            return;
          }
          setGeneratedImageOpaqueCacheMetadata(opaqueEntry, imageUrl);
          await persistGenerationHistory({ strict: true });
          saveLastImageDiagnostic({ storageBackend: "Cache Storage", storageStatus: "成功", restoreStatus: "尚未验证", failureReason: "" }, entry.id);
          syncGeneratedImageCacheSuccess(opaqueEntry);
          showToast("临时图片已保存到浏览器缓存");
          return;
        } catch {
          await deleteGeneratedImageOpaqueCache(imageUrl).catch(() => false);
        }
      }
      currentEntry.imageCacheKey = "";
      currentEntry.imageCacheBackend = "";
      currentEntry.imageCacheStatus = "error";
      currentEntry.imageCacheErrorCode = error?.imageCacheErrorCode || "storage_unavailable";
      currentEntry.imageCacheErrorMessage = currentEntry.imageCacheErrorCode === "remote_unavailable"
        ? "远程地址已过期、无权限或被 CORS 拦截，请选择已保存的本地图片。"
        : "IndexedDB 暂时不可用或写入失败，请恢复浏览器存储后重试。";
      currentEntry.imageMimeType = "";
      currentEntry.imageByteSize = undefined;
      saveLastImageDiagnostic({
        storageBackend: currentEntry.imageCacheErrorCode === "remote_unavailable" ? "Cache Storage" : "IndexedDB",
        storageStatus: "失败",
        restoreStatus: "尚未验证",
        failureReason: getDiagnosticFailureReason(currentEntry.imageCacheErrorCode)
      }, entry.id);
      await persistGenerationHistory();
      renderGenerationFeed({ openBatchId: currentEntry.batchId || `legacy_batch_${currentEntry.batchNumber || "00"}` });
      showToast(currentEntry.imageCacheErrorCode === "remote_unavailable"
        ? "远程图片无法读取，请选择已保存的本地图片"
        : "浏览器本地缓存写入失败，请稍后重新缓存");
    }
    throw error;
  }
}

function queueGeneratedImageCache(entry) {
  imageCacheQueue = imageCacheQueue
    .then(() => cacheGeneratedImage(entry))
    .catch(() => {});
  return imageCacheQueue;
}

function queueGenerationHistoryImageCache(entries) {
  entries
    .filter((entry) => entry.status === "ready" && entry.imageCacheBackend !== "opaque" && isGeneratedImageSourceUrl(entry.imageUrl))
    .forEach((entry) => {
      historyImageCacheQueue = historyImageCacheQueue
        .then(() => cacheGeneratedImage(entry))
        .catch(() => {});
    });
  return historyImageCacheQueue;
}

async function restoreGenerationHistoryImages(entries) {
  let normalized = false;
  for (const entry of entries) {
    if (entry.status !== "ready") continue;
    const cached = await loadGenerationImageCache(entry.id).catch(() => null);
    if (cached?.blob instanceof Blob && cached.blob.size > 0) {
      const sourceUrl = entry.originalImageUrl || cached.imageUrl || entry.imageUrl;
      const expectedMimeType = cached.blob.type || "application/octet-stream";
      if (entry.imageUrl
        || entry.originalImageUrl !== (isRemoteGeneratedImageUrl(sourceUrl) ? sourceUrl : "")
        || entry.imageCacheKey !== getGenerationImageCacheKey(entry.id)
        || entry.imageCacheBackend !== "blob"
        || entry.imageCacheStatus !== "ready"
        || entry.imageCacheErrorCode
        || entry.imageCacheErrorMessage
        || entry.imageMimeType !== expectedMimeType
        || entry.imageByteSize !== cached.blob.size) normalized = true;
      attachGeneratedImageBlob(entry, cached.blob, sourceUrl);
      saveLastImageDiagnostic({ restoreStatus: "成功", failureReason: "" }, entry.id);
      continue;
    }
    const opaqueSourceUrl = isRemoteGeneratedImageUrl(entry.originalImageUrl) ? entry.originalImageUrl : entry.imageUrl;
    if (entry.imageCacheBackend === "opaque" && isRemoteGeneratedImageUrl(opaqueSourceUrl)) {
      const opaqueResponse = await loadGeneratedImageOpaqueCache(opaqueSourceUrl).catch(() => null);
      if (opaqueResponse) {
        if (entry.imageUrl !== opaqueSourceUrl
          || entry.originalImageUrl !== opaqueSourceUrl
          || entry.imageCacheKey
          || entry.imageCacheStatus !== "ready"
          || entry.imageCacheErrorCode
          || entry.imageCacheErrorMessage
          || entry.imageMimeType
          || entry.imageByteSize !== undefined) normalized = true;
        setGeneratedImageOpaqueCacheMetadata(entry, opaqueSourceUrl);
        saveLastImageDiagnostic({ restoreStatus: "成功", failureReason: "" }, entry.id);
        continue;
      }
      entry.imageCacheBackend = "";
      entry.imageCacheStatus = "";
      normalized = true;
    }
    if (!entry.imageUrl && isRemoteGeneratedImageUrl(entry.originalImageUrl)) entry.imageUrl = entry.originalImageUrl;
    if (!isGeneratedImageSourceUrl(entry.imageUrl)) {
      if (entry.imageCacheStatus !== "error" || entry.imageCacheKey || entry.imageCacheErrorCode !== "missing_source" || entry.imageCacheErrorMessage !== "本地图片缓存和原始来源均不可用。" || entry.imageMimeType || entry.imageByteSize !== undefined) normalized = true;
      entry.imageCacheKey = "";
      entry.imageCacheBackend = "";
      entry.imageCacheStatus = "error";
      entry.imageCacheErrorCode = "missing_source";
      entry.imageCacheErrorMessage = "本地图片缓存和原始来源均不可用。";
      entry.imageMimeType = "";
      entry.imageByteSize = undefined;
      saveLastImageDiagnostic({ restoreStatus: "失败", failureReason: getDiagnosticFailureReason("missing_source") }, entry.id);
    }
  }
  return normalized;
}

async function cleanupOrphanedGenerationImageCaches(retainedEntryIds) {
  const blobCaches = await listGenerationImageCaches().catch(() => []);
  await Promise.all(blobCaches
    .filter((cache) => !retainedEntryIds.has(cache.entryId))
    .map((cache) => deleteGenerationImageCache(cache.entryId).catch(() => {})));
}

async function cleanupOrphanedGeneratedImageOpaqueCaches(retainedImageUrls) {
  if (!canUseOpaqueImageCache()) return;
  const cache = await caches.open(OPAQUE_IMAGE_CACHE_NAME);
  const requests = await cache.keys();
  await Promise.all(requests
    .filter((request) => !retainedImageUrls.has(request.url))
    .map((request) => cache.delete(request).catch(() => false)));
}

async function cleanupOrphanedReferenceImageCaches(retainedCacheKeys) {
  const caches = await listReferenceImageCaches().catch(() => []);
  await Promise.all(caches
    .filter((cache) => !retainedCacheKeys.has(cache.cacheKey))
    .map((cache) => deleteReferenceImageCache(cache.cacheKey).catch(() => {})));
}

function fillApiSettingsForm(settings = {}) {
  $("textBaseUrlInput").value = settings.textBaseUrl || settings.apiBaseUrl || "";
  $("textApiKeyInput").value = settings.textApiKey || "";
  $("textModelInput").value = settings.textModel || "gpt-5.4-mini";
  $("imageBaseUrlInput").value = settings.imageBaseUrl || settings.apiBaseUrl || "";
  $("imageApiKeyInput").value = settings.imageApiKey || "";
  $("imageModelInput").value = settings.imageModel || "gpt-image-2";
  $("imageGenerationModeInput").value = settings.imageGenerationMode === "async" ? "async" : "sync";
  resetApiKeyVisibility();
}

function setApiKeyVisibility(button, visible) {
  const input = $(button.dataset.apiKeyInput);
  const keyName = button.dataset.apiKeyName || "";
  input.type = visible ? "text" : "password";
  button.textContent = visible ? "隐藏" : "显示";
  button.setAttribute("aria-pressed", String(visible));
  button.setAttribute("aria-label", `${visible ? "隐藏" : "显示"}${keyName} API Key`);
}

function resetApiKeyVisibility() {
  document.querySelectorAll("[data-api-key-input]").forEach((button) => setApiKeyVisibility(button, false));
}

function readApiSettingsForm() {
  return {
    textBaseUrl: $("textBaseUrlInput").value,
    textApiKey: $("textApiKeyInput").value,
    textModel: $("textModelInput").value,
    imageBaseUrl: $("imageBaseUrlInput").value,
    imageApiKey: $("imageApiKeyInput").value,
    imageModel: $("imageModelInput").value,
    imageGenerationMode: $("imageGenerationModeInput").value
  };
}

function setApiTestStatus(kind, tone, message) {
  const status = $(`${kind}ApiTestStatus`);
  status.className = `api-test-status${tone === "neutral" ? "" : ` is-${tone}`}`;
  status.textContent = message;
}

function resetApiTestStatus(kind) {
  if ($("testApiConnectionBtn").disabled) return;
  setApiTestStatus(kind, "neutral", "未测试");
}

function classifyApiTestFailure(response, kind) {
  if (response.status === 401 || response.status === 403) return { tone: "error", message: "API Key 无效或无权限" };
  if (response.status === 429) return { tone: "warning", message: "请求过于频繁，请稍后再试" };
  if (response.status >= 500) return { tone: "error", message: "服务暂不可用" };
  if (response.status === 404 || response.status === 405) {
    return kind === "image"
      ? { tone: "warning", message: "服务可达，无法无费用验证" }
      : { tone: "error", message: "未找到 /responses 接口" };
  }
  return { tone: "error", message: `连接测试失败（HTTP ${response.status}）` };
}

async function fetchApiTest(url, options) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timeout);
  }
}

function getApiTestReadiness(settings, kind) {
  const baseUrl = normalizeApiBaseUrl(settings[`${kind}BaseUrl`]);
  const apiKey = String(settings[`${kind}ApiKey`] || "").trim();
  const model = String(settings[`${kind}Model`] || "").trim();
  if (!baseUrl && !apiKey) return { ready: false, empty: true };
  if (!baseUrl || !apiKey || !model) return { ready: false, empty: false };
  return { ready: true, baseUrl, apiKey, model };
}

async function testTextApiConnection(settings) {
  const readiness = getApiTestReadiness(settings, "text");
  if (!readiness.ready) return readiness.empty
    ? { tone: "neutral", message: "未配置" }
    : { tone: "error", message: "请补充地址、Key 和模型" };
  try {
    const response = await fetchApiTest(`${readiness.baseUrl}/responses`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readiness.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: readiness.model, input: "只回复 OK", max_output_tokens: 16, stream: false })
    });
    return response.ok ? { tone: "success", message: "文本接口可用" } : classifyApiTestFailure(response, "text");
  } catch (error) {
    return { tone: "error", message: error.name === "AbortError" ? "连接超时" : "连接失败：检查 CORS、网络或地址" };
  }
}

async function testImageApiConnection(settings) {
  const readiness = getApiTestReadiness(settings, "image");
  if (!readiness.ready) return readiness.empty
    ? { tone: "neutral", message: "未配置" }
    : { tone: "error", message: "请补充地址、Key 和模型" };
  try {
    const response = await fetchApiTest(`${readiness.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${readiness.apiKey}` }
    });
    return response.ok ? { tone: "success", message: "基础连接可用，未实际生图" } : classifyApiTestFailure(response, "image");
  } catch (error) {
    return { tone: "error", message: error.name === "AbortError" ? "连接超时" : "连接失败：检查 CORS、网络或地址" };
  }
}

async function testApiConnections() {
  const button = $("testApiConnectionBtn");
  if (button.disabled) return;
  const settings = readApiSettingsForm();
  const textReadiness = getApiTestReadiness(settings, "text");
  const imageReadiness = getApiTestReadiness(settings, "image");
  button.disabled = true;
  button.textContent = "测试中…";
  setApiTestStatus("text", textReadiness.ready ? "testing" : "neutral", textReadiness.empty ? "未配置" : "测试中…");
  setApiTestStatus("image", imageReadiness.ready ? "testing" : "neutral", imageReadiness.empty ? "未配置" : "测试中…");
  try {
    const [textResult, imageResult] = await Promise.all([
      testTextApiConnection(settings),
      testImageApiConnection(settings)
    ]);
    setApiTestStatus("text", textResult.tone, textResult.message);
    setApiTestStatus("image", imageResult.tone, imageResult.message);
    showToast("连接测试已完成，结果未自动保存");
  } finally {
    button.disabled = false;
    button.textContent = "测试连接";
  }
}

function getTaskType() {
  return TASK_TYPES.find((item) => item.id === taskTypeSelect.value) || TASK_TYPES[0];
}

function syncDefaultImageRatio() {
  if (!imageRatioOverridden) imageRatioSelect.value = getTaskType().defaultRatio;
}

function getAvailableDimensions() {
  const type = getTaskType();
  return EXPLORATION_DIMENSIONS.filter((dimension) => type.supportedDimensionIds.includes(dimension.id));
}

function selectedDimension() {
  const id = dimensionList.querySelector("input:checked")?.value;
  return EXPLORATION_DIMENSIONS.find((item) => item.id === id) || getAvailableDimensions()[0];
}

function getExplorationOptions(dimension, optionCount) {
  if (dimension.dynamicOptions) return [];
  return dimension.defaultOptions.slice(0, optionCount);
}

function renderOptionCounts() {
  const select = $("optionCount");
  const counts = selectedDimension()?.optionCounts || [2, 3, 4, 5, 6];
  const current = Number(select.value) || 3;
  const next = counts.includes(current)
    ? current
    : [...counts].reverse().find((count) => count < current) || counts[0];
  select.innerHTML = counts.map((count) => `<option value="${count}">${count} 套</option>`).join("");
  select.value = String(next);
}

function renderContentModes() {
  $("contentModeOptions").innerHTML = CONTENT_MODES.map((mode) => `
    <label class="choice-option content-mode-option" for="contentMode-${escapeHtml(mode.id)}">
      <input id="contentMode-${escapeHtml(mode.id)}" type="radio" name="contentMode" value="${escapeHtml(mode.id)}" ${mode.id === state.contentMode ? "checked" : ""}>
      <span><strong>${escapeHtml(mode.name)}</strong><small>${escapeHtml(mode.description)}</small></span>
    </label>
  `).join("");
}

function renderTaskTypes() {
  taskTypeSelect.innerHTML = TASK_TYPES.map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("");
  taskTypeSelect.value = "poster";
}

function renderDimensions() {
  const available = getAvailableDimensions();
  const current = dimensionList.querySelector("input:checked")?.value;
  const activeId = available.some((item) => item.id === current) ? current : available[0]?.id;
  dimensionList.innerHTML = available.map((dimension) => `
    <label class="dimension-option">
      <input type="radio" name="dimension" value="${escapeHtml(dimension.id)}" ${dimension.id === activeId ? "checked" : ""}>
      <span><strong>${escapeHtml(dimension.name)}</strong></span>
    </label>
  `).join("");
}

function renderBlueprintEmpty() {
  $("blueprintStatus").textContent = "等待输入";
  $("blueprintPanel").innerHTML = '<div class="blueprint-empty"><strong>等待输入内容</strong><span>输入提示词或添加参考图后，这里会实时预览本轮设置。</span></div>';
}

function renderBlueprintPreview() {
  const prompt = $("sourcePrompt").value.trim();
  if (!prompt && !state.referenceImageData) {
    renderBlueprintEmpty();
    return;
  }
  const referenceSummary = state.referenceImageData
    ? ` · 参考图：${state.referenceUsage === "explore" ? "参与生图探索" : "仅分析提示词"}`
    : "";
  const inheritedSummary = state.refinementBase
    ? ` · 已继承上一轮确认方案${state.refinementDepth ? ` · 第 ${state.refinementDepth + 1} 轮` : ""}`
    : "";
  const contentModeSummary = state.contentMode === "factual" ? " · 事实保守" : " · 概念补全";
  const dimension = selectedDimension();
  const explorationSummary = dimension.dynamicOptions
    ? dimension.id === "application_visual_style"
      ? `${dimension.name} · AI 将识别载体与应用面后生成 ${$("optionCount").value} 套适配风格`
      : `${dimension.name} · AI 将根据当前用途生成 ${$("optionCount").value} 套不同方向`
    : `${dimension.name} · ${$("optionCount").value} 套方案`;
  $("blueprintStatus").textContent = "实时预览";
  $("blueprintPanel").innerHTML = `
    <div class="blueprint-block"><span class="blueprint-block-index">01</span><div><strong>原始输入</strong><p>${escapeHtml(`${prompt || "已添加参考图，等待提取固定内容"}${contentModeSummary}${referenceSummary}${inheritedSummary}`)}</p></div></div>
    <div class="blueprint-block"><span class="blueprint-block-index">02</span><div><strong>本轮变化</strong><p>${escapeHtml(explorationSummary)}</p></div></div>
    <div class="blueprint-block"><span class="blueprint-block-index">03</span><div><strong>输出限制</strong><p>${escapeHtml(imageRatioSelect.value)} · ${escapeHtml($("imageResolution").value)}</p></div></div>
  `;
}

function isSetupLocked() {
  return isGeneratingDirections || Boolean(state.blueprint);
}

function syncReferenceUsageUI() {
  const hasReferenceImage = Boolean(state.referenceImage && state.referenceImageData);
  const usage = state.referenceUsage === "explore" ? "explore" : "analyze";
  state.referenceUsage = usage;
  $("referenceUsageAnalyze").checked = usage === "analyze";
  $("referenceUsageExplore").checked = usage === "explore";
  $("referenceUsageField").classList.toggle("hidden", !hasReferenceImage);
  $("referenceUsageSummary").textContent = usage === "explore" ? "将作为图片1参与最终生图" : "仅用于分析提示词";
}

function resetGeneratedDirectionsForSetupChange() {
  renderBlueprintPreview();
}

function setSourcePromptReadOnly(readOnly) {
  const sourcePrompt = $("sourcePrompt");
  sourcePrompt.readOnly = readOnly;
  sourcePrompt.title = readOnly ? "当前输入已锁定，使用“修改输入与设置”后可重新编辑" : "";
  $("sourcePromptStatus").classList.toggle("hidden", !readOnly);
}

function setSetupControlsDisabled(disabled) {
  [taskTypeSelect, $("optionCount"), $("imageResolution"), imageRatioSelect, $("referenceImage"), $("removeFileBtn")]
    .forEach((control) => { control.disabled = disabled; });
  $("contentModeOptions").querySelectorAll("input").forEach((control) => { control.disabled = disabled; });
  dimensionList.querySelectorAll('input[name="dimension"]').forEach((control) => { control.disabled = disabled; });
  document.querySelectorAll('input[name="referenceUsage"]').forEach((control) => { control.disabled = disabled; });
  $("dropzone").classList.toggle("is-disabled", disabled);
  $("dropzone").setAttribute("aria-disabled", String(disabled));
}

function syncSetupLockState() {
  const locked = isSetupLocked();
  setSourcePromptReadOnly(locked);
  setSetupControlsDisabled(locked);
  $("editSetupBtn").classList.toggle("hidden", !state.blueprint || isGeneratingDirections);
}

function openEditSetupDialog() {
  if (!state.blueprint || isGeneratingDirections) return;
  const count = state.blueprint.variants.length;
  $("editSetupDialogDescription").textContent = `修改本轮输入将清空当前 ${count} 个提示词方案。已经提交的图片任务和历史结果不受影响。`;
  showDialogAtTop(editSetupDialog);
  $("cancelEditSetupBtn").focus();
}

function closeEditSetupDialog() {
  editSetupDialog.close();
}

function confirmEditSetup() {
  closeEditSetupDialog();
  state.blueprint = null;
  state.directionCompletionError = "";
  clearRefinementLineage();
  state.selectedVariantIds.clear();
  renderPromptCards();
  syncSetupLockState();
  renderBlueprintPreview();
  $("generateBtnLabel").textContent = "生成视觉方向";
  $("generateHint").textContent = "输入和设置已解锁，请完成修改后重新生成视觉方向。";
  $("sourcePrompt").focus();
  showToast("当前提示词方案已清空，可以修改输入和设置");
}

function getPartialResponseReason(diagnostics = {}) {
  const incompleteReason = String(diagnostics.incompleteReason || "").toLowerCase();
  const status = String(diagnostics.status || "").toLowerCase();
  if (incompleteReason.includes("max_output") || incompleteReason.includes("length")) return "文本输出达到上限";
  if (status && !["completed", "complete", "success", "succeeded"].includes(status)) return "文本服务提前结束";
  return "模型实际返回不足";
}

function setBlueprintCollapsed(collapsed) {
  blueprintSection.classList.toggle("is-collapsed", collapsed);
  blueprintToggle.setAttribute("aria-expanded", String(!collapsed));
  blueprintToggle.setAttribute("aria-label", collapsed ? "展开提示词蓝图" : "折叠提示词蓝图");
}

function syncBlueprintDisclosure() {
  if (!window.matchMedia("(max-width: 600px)").matches) setBlueprintCollapsed(false);
}

function renderPromptCards() {
  const variants = state.blueprint?.variants || [];
  const dimensionName = state.blueprint?.exploration?.dimensionName || selectedDimension().name;
  const requestedOptionCount = Number(state.blueprint?.exploration?.requestedOptionCount) || variants.length;
  const missingOptionCount = Math.max(0, requestedOptionCount - variants.length);
  const isPartial = variants.length > 0 && missingOptionCount > 0;
  const completeButton = $("completeDirectionsBtn");
  $("emptyBoard").classList.toggle("hidden", variants.length > 0);
  $("resultCount").textContent = variants.length;
  $("selectAllBtn").disabled = variants.length === 0;
  completeButton.classList.toggle("hidden", !isPartial);
  completeButton.disabled = !isPartial || isCompletingDirections;
  completeButton.textContent = isCompletingDirections ? "正在补齐…" : `补齐缺少 ${missingOptionCount} 套`;
  $("boardHint").classList.toggle("is-warning", isPartial);
  $("boardHint").textContent = variants.length
    ? isPartial
      ? state.directionCompletionError
        ? `已返回 ${variants.length} / ${requestedOptionCount} 套。补齐失败：${state.directionCompletionError}；现有方案仍可直接使用。`
        : `已返回 ${variants.length} / ${requestedOptionCount} 套（${getPartialResponseReason(state.blueprint?.responseDiagnostics)}）。现有方案可直接使用，也可以补齐缺少的 ${missingOptionCount} 套。`
      : `本轮仅变化：${dimensionName}`
    : "生成后选择需要提交的提示词方案。";
  promptList.dataset.count = String(variants.length);
  promptList.innerHTML = variants.map((variant, index) => {
    const selected = state.selectedVariantIds.has(variant.id);
    const promptPreviewId = `promptPreview${index}`;
    return `
      <article class="prompt-card ${selected ? "selected" : ""}" data-variant-id="${escapeHtml(variant.id)}">
        <label class="prompt-card-selector">
          <input type="checkbox" data-action="select" ${selected ? "checked" : ""}>
          <span><small>方案 ${String(index + 1).padStart(2, "0")}</small><strong>${escapeHtml(variant.title)}</strong></span>
        </label>
        <div class="prompt-card-specs">
          <p class="changed-line"><strong>${escapeHtml(dimensionName)}</strong><span><span class="prompt-exploration-option">${escapeHtml(variant.explorationOption || variant.title)}</span><span class="prompt-change-summary">${escapeHtml(variant.changeSummary)}</span></span></p>
          <p class="locked-line"><strong>固定条件</strong><span>非变量事实、固定限制与画幅比例</span></p>
        </div>
        <div class="prompt-card-actions">
          <button class="button button-quiet prompt-detail-toggle" type="button" data-action="toggle-prompt" aria-expanded="false" aria-controls="${promptPreviewId}">完整提示词</button>
          <button class="button button-quiet prompt-copy" type="button" data-action="copy">复制</button>
        </div>
        <div class="prompt-preview hidden" id="${promptPreviewId}">${escapeHtml(variant.prompt)}</div>
      </article>
    `;
  }).join("");
  syncSubmissionBar();
}

function createLocalPromptPreview() {
  const previews = [
    {
      title: "轻盈编辑感",
      changeSummary: "使用大面积留白、克制衬线标题与单主体构图",
      prompt: "为夏日咖啡店开业海报创作轻盈编辑风视觉。主体是一杯透明高杯冰拿铁，杯壁有自然冷凝水，置于偏左下区域。使用暖白纸张背景、低饱和咖啡棕与少量柠檬黄，保留右上方标题区和底部活动信息区。画面克制、真实、清爽，避免复杂装饰与拥挤文字。"
    },
    {
      title: "复古印刷感",
      changeSummary: "加入网点颗粒、套色偏移与高对比复古配色",
      prompt: "为夏日咖啡店开业海报创作复古印刷风视觉。主体保持为一杯透明高杯冰拿铁，使用橙红、墨绿、奶油白三色套印，加入细腻网点、轻微错版与纸张纤维。采用居中主视觉和上下信息区，标题位置清晰，保留可后期排版空间，不出现现代科技质感。"
    },
    {
      title: "生活方式摄影",
      changeSummary: "转为窗边自然光、真实桌面与松弛生活场景",
      prompt: "为夏日咖啡店开业海报创作生活方式摄影视觉。冰拿铁放在明亮窗边木桌上，午后自然光形成柔和阴影，旁边仅保留一本翻开的杂志与一小枝绿植。色彩自然、颗粒轻微、不过度商业棚拍；主体清晰，左上方保留标题区，底部保留日期和地址信息区。"
    }
  ];
  return {
    schemaVersion: 1,
    taskTypeId: "poster",
    locked: {
      intent: "夏日咖啡店开业海报",
      subject: "透明高杯冰拿铁",
      textLayout: "保留标题与活动信息区域",
      technical: { ratio: "3:4" }
    },
    exploration: {
      dimensionIds: ["visual_style"],
      dimensionName: "设计风格",
      optionCount: previews.length,
      selectedOptions: previews.map((item) => item.title)
    },
    variants: previews.map((item, index) => ({
      id: `local_preview_${index + 1}`,
      ...item,
      explorationOption: item.title,
      artClass: ["art-editorial", "art-retro", "art-lifestyle"][index],
      generation: { ratio: "3:4", resolution: "1K", imageCount: 1 }
    }))
  };
}

function applyLocalPromptPreview() {
  const params = new URLSearchParams(window.location.search);
  const isLocal = ["127.0.0.1", "localhost"].includes(window.location.hostname);
  const previewMode = params.get("preview");
  if (!isLocal || previewMode !== "prompts") return false;
  state.blueprint = createLocalPromptPreview();
  state.selectedVariantIds.clear();
  renderBlueprintPreview();
  renderPromptCards();
  $("boardHint").textContent = "本地预览 · 示例方案不会调用 API 或写入历史";
  goToStage("promptStage", { resetScroll: true });
  return true;
}

function setActiveStage(stageId) {
  stageButtons.forEach((button) => {
    const active = button.dataset.stageTarget === stageId;
    button.classList.toggle("is-active", active);
    if (active) button.setAttribute("aria-current", "step");
    else button.removeAttribute("aria-current");
  });
  ["setupStage", "promptStage", "resultStage"].forEach((id) => {
    document.getElementById(id)?.classList.toggle("is-stage-active", id === stageId);
  });
}

function resetStageScroll(stageId) {
  const stage = document.getElementById(stageId);
  stage?.querySelectorAll(".form-stack, .inline-blueprint, .prompt-scroll-region, .result-scroll-region").forEach((node) => {
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });
}

function goToStage(stageId, { resetScroll = false } = {}) {
  setActiveStage(stageId);
  if (resetScroll) resetStageScroll(stageId);
  if (window.matchMedia("(min-width: 900px)").matches) {
    return;
  }
  document.getElementById(stageId)?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function resetDialogScroll(dialog) {
  dialog?.querySelectorAll(".confirm-dialog-content, .image-preview-stage, .comparison-grid").forEach((node) => {
    node.scrollTop = 0;
    node.scrollLeft = 0;
  });
}

function showDialogAtTop(dialog) {
  dialog.showModal();
  resetDialogScroll(dialog);
}

function updateActiveStageFromScroll() {
  if (!window.matchMedia("(max-width: 600px)").matches) return;
  const available = stageButtons;
  let activeId = available[0]?.dataset.stageTarget || "setupStage";
  available.forEach((button) => {
    const section = document.getElementById(button.dataset.stageTarget);
    if (section?.getBoundingClientRect().top <= 118) activeId = button.dataset.stageTarget;
  });
  setActiveStage(activeId);
}

function syncSubmissionBar() {
  const selectedCount = state.selectedVariantIds.size;
  $("selectedCount").textContent = selectedCount;
  $("submitSelectedBtn").disabled = selectedCount === 0 || isSubmittingSelected;
  $("submitSelectedBtn").textContent = isSubmittingSelected ? "正在提交…" : "提交生成";
  const allSelected = (state.blueprint?.variants.length || 0) > 0 && selectedCount === state.blueprint.variants.length;
  $("selectAllBtn").textContent = allSelected ? "取消全选" : "全选";
}

function groupGenerationEntries(entries = state.generationEntries) {
  const groups = new Map();
  entries.forEach((entry) => {
    const batchId = entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`;
    if (!groups.has(batchId)) groups.set(batchId, {
      id: batchId,
      number: entry.batchNumber || "00",
      createdAt: entry.batchCreatedAt || entry.createdAt || "",
      explorationDimensionName: entry.explorationDimensionName || "",
      entries: []
    });
    groups.get(batchId).entries.push(entry);
  });
  return [...groups.values()];
}

function filterGenerationEntries() {
  const query = state.resultFilters.query.trim().toLocaleLowerCase("zh-CN");
  return state.generationEntries.filter((entry) => {
    const batchId = entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`;
    const matchesBatch = state.resultFilters.batchId === "all" || batchId === state.resultFilters.batchId;
    const matchesStatus = state.resultFilters.status === "all" || entry.status === state.resultFilters.status;
    const searchable = `${entry.variantTitle || ""} ${entry.explorationDimensionName || ""} ${entry.explorationOption || ""} ${entry.changeSummary || ""} ${entry.promptSnapshot || ""}`.toLocaleLowerCase("zh-CN");
    return matchesBatch && matchesStatus && (!query || searchable.includes(query));
  });
}

function syncBatchFilterOptions(batches) {
  const select = $("resultBatchFilter");
  const availableIds = new Set(batches.map((batch) => batch.id));
  if (state.resultFilters.batchId !== "all" && !availableIds.has(state.resultFilters.batchId)) state.resultFilters.batchId = "all";
  select.innerHTML = `<option value="all">全部批次</option>${batches.map((batch) => `<option value="${escapeHtml(batch.id)}">批次 ${escapeHtml(batch.number)}${batch.explorationDimensionName ? ` · ${escapeHtml(batch.explorationDimensionName)}` : ""} · ${escapeHtml(formatBatchTime(batch.createdAt))}</option>`).join("")}`;
  select.value = state.resultFilters.batchId;
}

function formatBatchTime(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return value || "时间未知";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatGenerationElapsed(startedAt, completedAt = "") {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "时间未知";
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} 分 ${seconds % 60} 秒`;
}

function renderGenerationTiming(entry) {
  const totalStart = entry.queuedAt || entry.startedAt;
  if (!totalStart || !entry.completedAt) return "时间未知";
  const total = formatGenerationElapsed(totalStart, entry.completedAt);
  if (!entry.queuedAt || !entry.submittedAt) return `总 ${total}`;
  const queued = formatGenerationElapsed(entry.queuedAt, entry.submittedAt);
  const service = formatGenerationElapsed(entry.submittedAt, entry.completedAt);
  return `总 ${total} · 排队 ${queued} · 服务端 ${service}`;
}

function renderActiveGenerationTiming(entry) {
  const totalStart = entry.queuedAt || entry.startedAt || entry.batchCreatedAt;
  if (entry.submittedAt) {
    return `服务端 <span class="generation-elapsed" data-timing-start="${escapeHtml(entry.submittedAt)}">${formatGenerationElapsed(entry.submittedAt)}</span> · 总 <span class="generation-elapsed" data-timing-start="${escapeHtml(totalStart)}">${formatGenerationElapsed(totalStart)}</span>`;
  }
  return `排队 <span class="generation-elapsed" data-timing-start="${escapeHtml(totalStart)}">${formatGenerationElapsed(totalStart)}</span>`;
}

function updateGenerationElapsed() {
  document.querySelectorAll(".generation-elapsed[data-timing-start]").forEach((element) => {
    element.textContent = formatGenerationElapsed(element.dataset.timingStart);
  });
}

function getBatchStatusCounts(entries) {
  return entries.reduce((counts, entry) => {
    counts[entry.status] += 1;
    return counts;
  }, { ready: 0, error: 0, loading: 0 });
}

function syncGenerationOverview() {
  const counts = getBatchStatusCounts(state.generationEntries);
  const navCount = $("activeGenerationNavCount");
  $("generationOverview").classList.toggle("hidden", state.generationEntries.length === 0);
  $("overviewLoadingCount").textContent = counts.loading;
  $("overviewReadyCount").textContent = counts.ready;
  $("overviewErrorCount").textContent = counts.error;
  navCount.textContent = counts.loading;
  navCount.classList.toggle("hidden", counts.loading === 0);
  const resultStageButton = document.querySelector('[data-stage-target="resultStage"]');
  resultStageButton.classList.toggle("has-active-generation", counts.loading > 0);
  resultStageButton.setAttribute("aria-label", counts.loading ? `结果，${counts.loading} 张图片生成中` : "结果");
  document.querySelectorAll("[data-overview-status]").forEach((button) => {
    button.setAttribute("aria-pressed", String(state.resultFilters.status === button.dataset.overviewStatus));
  });
}

function syncTextTooltipOverflow(root = generationFeed) {
  root.querySelectorAll(".text-tooltip-trigger").forEach((trigger) => {
    const target = trigger.querySelector("[data-tooltip-overflow-target]");
    const tooltip = trigger.querySelector(".text-tooltip");
    if (!target || !tooltip) return;
    let hasOverflow = target.scrollWidth > target.clientWidth + 1 || target.scrollHeight > target.clientHeight + 1;
    if (target.dataset.tooltipOverflowTarget === "multiline") {
      const measurement = target.cloneNode(true);
      measurement.removeAttribute("data-tooltip-overflow-target");
      Object.assign(measurement.style, {
        position: "absolute",
        width: `${target.clientWidth}px`,
        height: "auto",
        overflow: "visible",
        visibility: "hidden",
        pointerEvents: "none",
        display: "block",
        webkitLineClamp: "unset"
      });
      trigger.appendChild(measurement);
      hasOverflow = measurement.scrollHeight > target.clientHeight + 1;
      measurement.remove();
    }
    trigger.classList.toggle("has-overflow", hasOverflow);
    trigger.dataset.tooltipMeasured = "true";
    if (hasOverflow) {
      trigger.tabIndex = 0;
      trigger.setAttribute("aria-describedby", tooltip.id);
    } else {
      trigger.removeAttribute("tabindex");
      trigger.removeAttribute("aria-describedby");
    }
  });
}

function scheduleTextTooltipOverflowSync() {
  window.cancelAnimationFrame(textTooltipSyncFrame);
  textTooltipSyncFrame = window.requestAnimationFrame(() => syncTextTooltipOverflow());
}

function renderGenerationActions(entry) {
 const isReady = entry.status === "ready";
 const isLoading = entry.status === "loading";
 const canRefine = isReady && Boolean(entry.imageUrl || entry.originalImageUrl || entry.imageCacheKey || entry.imageCacheStatus === "ready");
  const outputSaveBusy = entry.outputSaveStatus === "pending" || entry.outputSaveStatus === "saving";
  const canDownloadImage = isReady && Boolean(entry.imageUrl) && !outputSaveBusy;
  const canCopyPrompt = Boolean(entry.promptSnapshot);
  const retryLabel = entry.status === "error" ? "重新尝试" : "重新生成";
  const outputLabel = entry.outputSaveStatus === "saved"
    ? "再次保存"
    : entry.outputSaveStatus === "saving" || entry.outputSaveStatus === "pending"
      ? "保存中…"
      : entry.outputSaveStatus === "error"
        ? "重试保存"
        : "保存本地";
  return `
    <div class="generation-actions" role="group" aria-label="${escapeHtml(entry.variantTitle)}操作">
     <button class="button${canRefine ? " button-primary" : ""}" type="button" data-action="continue" title="${canRefine ? "基于当前结果图片和方案继续细化" : isReady ? "当前结果图片不可用，无法按画面细化" : "图片生成完成后可用"}" ${canRefine ? "" : "disabled"}>基于此结果细化</button>
      <button class="button" type="button" data-action="download-image" title="${outputSaveBusy ? "图片正在自动保存" : canDownloadImage ? isOutputAutoSaveReady() || entry.outputSaveStatus ? "保存到输出目录" : "保存生成图片到本地" : isGeneratedImageMissing(entry) ? "本地图片缓存已丢失，请重新生成" : "图片生成完成后可用"}" ${canDownloadImage ? "" : "disabled"}>${outputLabel}</button>
      <button class="button" type="button" data-action="copy-generation" title="${canCopyPrompt ? "复制完整提示词" : "当前记录缺少提示词"}" ${canCopyPrompt ? "" : "disabled"}>复制提示词</button>
      <button class="button${entry.status === "error" ? " button-primary" : ""}" type="button" data-action="retry" title="${isLoading ? "当前图片生成中" : retryLabel}" ${isLoading ? "disabled" : ""}>${retryLabel}</button>
    </div>
  `;
}

function renderGenerationFeed({ openBatchId = "" } = {}) {
  const allBatches = groupGenerationEntries();
  if (generationHistoryLoaded) pruneOpenGenerationBatchIds(allBatches);
  if (openBatchId) {
    openGenerationBatchIds.add(openBatchId);
    saveOpenGenerationBatchIds();
  } else if (!hasSavedBatchDisclosure && allBatches[0]) {
    openGenerationBatchIds.add(allBatches[0].id);
  }
  syncBatchFilterOptions(allBatches);
  const filteredEntries = filterGenerationEntries();
  const batches = groupGenerationEntries(filteredEntries);
  const hasEntries = state.generationEntries.length > 0;
  $("emptyGenerationBoard").classList.toggle("hidden", hasEntries);
  $("filteredGenerationEmpty").classList.toggle("hidden", !hasEntries || filteredEntries.length > 0);
  $("resultToolbar").classList.toggle("hidden", !hasEntries);
  $("resultFilters").classList.toggle("hidden", !hasEntries);
  $("clearResultFiltersBtn").disabled = !state.resultFilters.query && state.resultFilters.status === "all" && state.resultFilters.batchId === "all";
  generationFeed.classList.toggle("hidden", filteredEntries.length === 0);
  $("generationCount").textContent = state.generationEntries.length;
  syncGenerationOverview();
  if (hasEntries) $("feedHint").textContent = `${filteredEntries.length === state.generationEntries.length ? "" : `显示 ${filteredEntries.length} / ${state.generationEntries.length} · `}${allBatches.length} 个批次 · 当前浏览器`;
  generationFeed.innerHTML = batches.map((batch) => {
    const counts = getBatchStatusCounts(batch.entries);
    const comparableEntries = state.generationEntries.filter((entry) => (entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`) === batch.id && entry.status === "ready" && entry.imageUrl);
    const statusSummary = [
      counts.ready ? `<span class="is-ready">已完成 ${counts.ready}</span>` : "",
      counts.error ? `<span class="is-error">失败 ${counts.error}</span>` : "",
      counts.loading ? `<span class="is-loading">生成中 ${counts.loading}</span>` : ""
    ].filter(Boolean).join("");
    return `
    <details class="generation-batch" data-batch-id="${escapeHtml(batch.id)}" ${openGenerationBatchIds.has(batch.id) ? "open" : ""}>
      <summary class="generation-batch-summary">
        <span><strong class="generation-batch-title">批次 ${escapeHtml(batch.number)}${batch.explorationDimensionName ? `<span class="generation-batch-variable">${escapeHtml(batch.explorationDimensionName)}</span>` : ""}</strong><small>${escapeHtml(formatBatchTime(batch.createdAt))} · ${batch.entries.length} 条结果<span class="generation-batch-stats">${statusSummary}</span></small></span>
      </summary>
      <div class="generation-batch-meta">
        <button class="button button-quiet generation-batch-submission" type="button" data-action="open-batch-submission" aria-label="查看批次 ${escapeHtml(batch.number)} 的提交资料" title="查看并复用本批提交资料">提交资料</button>
        <button class="button button-quiet generation-batch-compare" type="button" data-action="compare-batch" aria-label="对比批次 ${escapeHtml(batch.number)} 的完成结果" title="${comparableEntries.length >= 2 ? `对比 ${comparableEntries.length} 条完成结果` : "至少需要两条完成图片"}" ${comparableEntries.length < 2 ? "disabled" : ""}>对比</button>
        <button class="icon-button generation-batch-delete" type="button" data-action="delete-batch" aria-label="删除批次 ${escapeHtml(batch.number)}，共 ${batch.entries.length} 条结果" title="${counts.loading ? "生成中的批次暂不能删除" : `删除整个批次，共 ${batch.entries.length} 条结果`}" ${counts.loading ? "disabled" : ""}>${renderCloseIcon()}</button>
      </div>
      <div class="generation-batch-grid">
        ${batch.entries.map((entry) => `
    <article class="generation-card${entry.status === "error" ? " is-error" : ""}" data-generation-id="${escapeHtml(entry.id)}">
      <div class="generation-card-head">
        <div class="generation-card-title"><span class="generation-card-title-tooltip text-tooltip-trigger"><strong class="generation-card-title-text" data-tooltip-overflow-target>${escapeHtml(entry.variantTitle)}</strong><span class="generation-card-title-tooltip-content text-tooltip" id="generation-title-${escapeHtml(entry.id)}" role="tooltip">${escapeHtml(entry.variantTitle)}</span></span><small>批次 ${entry.batchNumber} · ${escapeHtml(entry.createdAt)}<span class="generation-status ${escapeHtml(entry.status)}">${entry.status === "ready" ? "已完成" : entry.status === "error" ? "失败" : "生成中"}</span></small></div>
        <div class="generation-card-tools">
          ${entry.status === "ready" ? `<button class="icon-button generation-favorite${entry.favorite ? " is-active" : ""}" type="button" data-action="toggle-favorite" aria-pressed="${Boolean(entry.favorite)}" aria-label="${entry.favorite ? "取消收藏" : "收藏"}${escapeHtml(entry.variantTitle)}" title="${entry.favorite ? "取消收藏" : "收藏候选"}">${renderStarIcon(entry.favorite)}</button>` : ""}
          <button class="icon-button generation-delete" type="button" data-action="delete" aria-label="删除${escapeHtml(entry.variantTitle)}记录" title="${entry.status === "loading" ? "生成中暂不能删除" : "删除这条记录"}" ${entry.status === "loading" ? "disabled" : ""}>${renderCloseIcon()}</button>
        </div>
      </div>
      <div class="generation-art ${escapeHtml(entry.artClass)} ${entry.status === "loading" ? "is-loading" : ""}">
        ${entry.imageUrl ? `<button class="generation-image-open" type="button" data-action="open-image" aria-label="查看${escapeHtml(entry.variantTitle)}大图"><span class="generation-ratio-badge" aria-hidden="true">${escapeHtml(entry.ratio || "未设比例")}</span><span class="generation-image-frame" style="--generation-image-ratio:${getDisplayAspectRatio(entry).toFixed(6)}"><img src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.variantTitle)}生成结果"><span class="generation-image-recovery" role="status"><strong>图片未加载</strong><small>临时链接可能已失效</small></span></span><span class="generation-image-open-label">查看大图</span></button>` : isGeneratedImageMissing(entry) ? `<div class="generation-state error" role="status"><span class="state-marker" aria-hidden="true">!</span><strong>本地图片缓存已丢失</strong><small>可重新生成，或通过恢复选项关联已有备份</small><button class="button button-quiet" type="button" data-action="open-image-recovery">恢复选项</button></div>` : `<div class="generation-state ${escapeHtml(entry.status)}" role="status"><span class="state-marker" aria-hidden="true">${entry.status === "error" ? "!" : "···"}</span><strong>${entry.status === "error" ? "生成未完成" : "正在生成图片"}</strong><small>${entry.status === "error" ? "查看失败原因，再决定是否重试" : "可以离开当前页面继续创建其他方案"}</small></div>`}
      </div>
      <div class="generation-body">
        <div class="generation-card-meta"><span>请求 ${escapeHtml(entry.resolution || "1K")} · ${escapeHtml(entry.ratio || "未设比例")} · ${entry.generationMode === "sync" ? "同步" : "异步"}${entry.referenceUsage === "explore" ? " · 参考图参与" : ""}${entry.actualResponseFormat ? ` · 实际返回 ${entry.actualResponseFormat === "b64_json" ? "Base64" : "URL"}` : ""}</span><span>${entry.status !== "loading" && entry.completedAt ? `耗时 ${escapeHtml(renderGenerationTiming(entry))}` : "等待生成结果"}</span></div>
        ${entry.explorationDimensionName ? `<div class="generation-exploration"><span class="generation-exploration-label">${escapeHtml(entry.explorationDimensionName)}</span><strong class="generation-exploration-value">${escapeHtml(entry.explorationOption || "未记录具体方向")}</strong></div>` : ""}
        ${entry.imageUrl ? `<div class="generation-image-diagnostics">${renderActualImageSize(entry)}${renderGeneratedImageCacheStatus(entry)}${renderGeneratedImageOutputStatus(entry)}</div>` : entry.status === "error" ? `<div class="generation-image-diagnostics"><span class="generation-error-tooltip-trigger text-tooltip-trigger"><span class="generation-error-label">失败原因</span><span class="generation-error-summary" data-tooltip-overflow-target>${escapeHtml(entry.errorMessage || "图片生成失败，请稍后重试")}</span><span class="generation-error-tooltip text-tooltip" id="generation-error-${escapeHtml(entry.id)}" role="tooltip"><strong>失败原因</strong><span>${escapeHtml(entry.errorMessage || "图片生成失败，请稍后重试")}</span>${entry.requestId ? `<small>Request ID：${escapeHtml(entry.requestId)}</small>` : ""}</span></span></div>` : ""}
        ${entry.status === "loading" ? `<div class="generation-progress" role="status"><span class="generation-spinner" aria-hidden="true"></span><span><strong>${escapeHtml(getGenerationProgressLabel(entry))}${entry.taskProgress ? ` · ${escapeHtml(entry.taskProgress)}` : ""}</strong><small>${renderActiveGenerationTiming(entry)}${entry.taskId ? `<span class="generation-task-id">task_id：${escapeHtml(entry.taskId)}</span>` : ""}</small></span></div>` : ""}
        <div class="generation-prompt-snapshot">
          <div class="prompt-preview" tabindex="0" role="region" aria-label="完整提示词">${escapeHtml(entry.promptSnapshot)}</div>
        </div>
        <div class="generation-card-summary"><strong>本轮变化</strong><span class="generation-change-tooltip text-tooltip-trigger"><span class="generation-change-text" data-tooltip-overflow-target="multiline">${escapeHtml(entry.changeSummary)}</span><span class="generation-change-tooltip-content text-tooltip" id="generation-change-${escapeHtml(entry.id)}" role="tooltip">${escapeHtml(entry.changeSummary)}</span></span></div>
        ${renderGenerationActions(entry)}
      </div>
    </article>
        `).join("")}
      </div>
    </details>
  `;
  }).join("");
  scheduleTextTooltipOverflowSync();
}

function shouldSimulateFailure(prompt) {
  return /模拟失败|故意失败/.test(prompt);
}

function getGenerationProgressLabel(entry) {
  if (entry.taskStatus === "pending_submission") return "等待提交";
  if (entry.taskStatus === "retry_wait") return "限流退避中";
  if (entry.taskStatus === "submitting" || !entry.taskStatus) return "正在提交任务";
  if (entry.taskStatus === "queued") return "任务排队中";
  return "服务端生成中";
}

async function requestDirectBlueprint(input) {
  const system = createBlueprintInstructions(input);
  const serializedInput = JSON.stringify({ ...input, referenceImage: undefined, hasReferenceImage: Boolean(input.referenceImage) });
  const maxOutputTokens = getBlueprintMaxOutputTokens(input.optionCount);
  const responseInput = input.referenceImage ? [{
    role: "user",
    content: [
      { type: "input_text", text: serializedInput },
      { type: "input_image", image_url: input.referenceImage, detail: "high" }
    ]
  }] : serializedInput;
  let response;
  try {
    response = await fetch(`${getTextApiBaseUrl()}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${state.apiSettings.textApiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: state.apiSettings.textModel, instructions: system, input: responseInput, max_output_tokens: maxOutputTokens, stream: false })
    });
  } catch {
    throw new Error("文本服务连接失败，请检查 CORS、网络或 API 地址");
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error((typeof payload.error === "string" ? payload.error : payload.error?.message) || payload.message || `文本生成失败（HTTP ${response.status}）`);
  const content = typeof payload.output_text === "string" ? payload.output_text : payload.output
    ?.flatMap((item) => Array.isArray(item.content) ? item.content : [])
    .find((item) => item.type === "output_text" && typeof item.text === "string")?.text;
  if (!content) throw new Error("文本服务未返回可解析的方案内容");
  const responseDiagnostics = {
    status: payload.status,
    incompleteReason: payload.incomplete_details?.reason || payload.incompleteDetails?.reason,
    outputTokens: payload.usage?.output_tokens ?? payload.usage?.outputTokens,
    maxOutputTokens
  };
  try {
    return normalizeBlueprintResponse(JSON.parse(content), input, responseDiagnostics);
  } catch (error) {
    if (error instanceof SyntaxError) {
      const incompleteReason = String(responseDiagnostics.incompleteReason || "").toLowerCase();
      if (incompleteReason.includes("max_output") || incompleteReason.includes("length")) {
        throw new Error("文本输出达到上限且未形成有效方案，请减少生成数量后重试");
      }
      throw new Error("文本服务返回的方案不是有效 JSON");
    }
    throw error;
  }
}

async function pollExistingImageTask(entry, headers) {
  for (let pollAttempt = 0; pollAttempt < IMAGE_POLL_MAX_ATTEMPTS; pollAttempt += 1) {
    let response;
    try {
      response = await fetch(`${getImageApiBaseUrl()}/images/tasks/${encodeURIComponent(entry.taskId)}`, { headers });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_INTERVAL));
      continue;
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 429 || response.status >= 500) {
      await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_INTERVAL));
      continue;
    }
    if (!response.ok) throw new Error((typeof payload.error === "string" ? payload.error : payload.error?.message) || payload.message || `图片任务查询失败（HTTP ${response.status}）`);
    const status = String(payload.status || payload.raw_status || "").toLowerCase();
    if (["failed", "failure", "error", "cancelled", "canceled", "expired"].includes(status)) {
      throw new Error(payload.fail_reason || payload.error?.message || `图片任务失败（${status}）`);
    }
    const result = payload.data?.[0] || payload.result?.data?.[0] || payload.result?.[0] || {};
    const requestId = payload.request_id || payload.requestId || "";
    if (result.b64_json) return { imageUrl: `data:image/png;base64,${result.b64_json}`, requestId, actualResponseFormat: "b64_json" };
    if (result.url) return { imageUrl: result.url, requestId, actualResponseFormat: "url" };
    if (["completed", "succeeded", "success", "done"].includes(status)) throw new Error("图片任务已完成，但服务未返回图片");
    const progress = String(payload.progress ?? "");
    const pendingStatus = status || "processing";
    if (entry.taskStatus !== pendingStatus || entry.taskProgress !== progress) {
      entry.taskStatus = pendingStatus;
      entry.taskProgress = progress;
      renderGenerationFeed();
      await persistGenerationHistory();
    }
    await new Promise((resolve) => setTimeout(resolve, IMAGE_POLL_INTERVAL));
  }
  const error = new Error("图片任务仍在服务端生成，本轮查询已暂停；请稍后刷新页面继续查看原任务");
  error.imageTaskStillPending = true;
  throw error;
}

function shouldFallbackToImageUrl(response, payload) {
  if (![400, 404, 405, 422].includes(response.status)) return false;
  const message = JSON.stringify(payload || {}).toLowerCase();
  return /response[_ ]?format|b64_json|base64|unsupported|not supported|不支持|不兼容/.test(message);
}

async function loadReferenceImageForEntry(entry) {
  if (entry.referenceUsage !== "explore") return null;
  if (!entry.referenceImageCacheKey) {
    const error = new Error("参与生图探索所需的参考图缓存缺失，请重新上传参考图并重新建立方案");
    error.imageCacheErrorCode = "reference_cache_missing";
    throw error;
  }
  const cached = await loadReferenceImageCache(entry.referenceImageCacheKey).catch(() => null);
  if (!(cached?.blob instanceof Blob) || cached.blob.size === 0) {
    const error = new Error("参与生图探索所需的参考图缓存缺失，请重新上传参考图并重新建立方案");
    error.imageCacheErrorCode = "reference_cache_missing";
    throw error;
  }
  return {
    ...cached,
    blob: await addReferenceSafetyMargin(cached.blob)
  };
}

async function requestGeneratedImage(entry) {
  if (shouldSimulateFailure(entry.promptSnapshot)) throw new Error("本地模拟故障：生成服务暂时不可用");
  if (!hasBrowserImageApi()) throw new Error("请先在右上角 API 配置中填写生图服务");
  const generationMode = entry.generationMode === "sync" ? "sync" : "async";
  const referenceUsage = entry.referenceUsage === "explore" ? "explore" : "analyze";
  const endpointPath = getImageEndpointPath({ generationMode, referenceUsage });
  saveLastImageDiagnostic({
    entryId: entry.id,
    requestMode: generationMode === "async" ? "异步" : "同步",
    endpointPath,
    requestedFormat: "Base64",
    actualFormat: "等待响应",
    imageHost: "等待响应",
    storageBackend: "等待保存",
    storageStatus: "等待保存",
    restoreStatus: "尚未验证",
    failureReason: ""
  });
  const authHeaders = { Authorization: `Bearer ${state.apiSettings.imageApiKey}` };
  if (entry.taskId) return pollExistingImageTask(entry, authHeaders);
  const url = `${getImageApiBaseUrl()}${endpointPath}`;
  const referenceImage = await loadReferenceImageForEntry(entry);
  let responseFormat = "b64_json";
  let formatFallbackUsed = false;
  for (let attempt = 0; attempt <= IMAGE_RETRY_DELAYS.length; attempt += 1) {
    const requestOptions = {
      model: resolveImageModel(state.apiSettings, entry.resolution),
      prompt: entry.promptSnapshot,
      ratio: entry.ratio,
      generationMode,
      responseFormat
    };
    const body = referenceImage
      ? createImageEditRequest({
        ...requestOptions,
        image: referenceImage.blob,
        imageName: referenceImage.fileName || "reference.png"
      })
      : JSON.stringify(createImageRequest(requestOptions));
    const headers = referenceImage ? authHeaders : { ...authHeaders, "Content-Type": "application/json" };
    let response;
    if (!entry.submittedAt) entry.submittedAt = new Date().toISOString();
    entry.taskStatus = "submitting";
    entry.taskProgress = "";
    renderGenerationFeed();
    await persistGenerationHistory();
    try {
      response = await fetch(url, { method: "POST", headers, body });
    } catch {
      const error = new Error("生图连接中断，服务端仍可能生成并扣费；请先核对账单，勿立即重试");
      error.remoteStateUncertain = true;
      throw error;
    }
    const payload = await response.json().catch(() => ({}));
    const requestId = response.headers.get("x-request-id") || response.headers.get("request-id") || payload.request_id || payload.requestId || payload.id || "";
    if (response.ok) {
      if (generationMode === "async") {
        const taskId = payload.task_id || payload.id || "";
        if (!taskId) throw new Error("异步生图服务未返回任务 ID");
        entry.taskId = taskId;
        entry.taskStatus = String(payload.status || "queued").toLowerCase();
        entry.taskProgress = String(payload.progress ?? "0%");
        entry.requestId = requestId;
        renderGenerationFeed();
        await persistGenerationHistory();
        return pollExistingImageTask(entry, authHeaders);
      }
      const result = payload.data?.[0] || payload.result?.data?.[0] || payload.result?.[0] || {};
      if (result.b64_json) return { imageUrl: `data:image/png;base64,${result.b64_json}`, requestId, actualResponseFormat: "b64_json" };
      if (result.url) return { imageUrl: result.url, requestId, actualResponseFormat: "url" };
      throw new Error("同步生图服务未返回图片");
    }
    if (!formatFallbackUsed && responseFormat === "b64_json" && shouldFallbackToImageUrl(response, payload)) {
      formatFallbackUsed = true;
      responseFormat = "url";
      saveLastImageDiagnostic({ requestedFormat: "URL（Base64 不兼容后回退）" }, entry.id);
      attempt = -1;
      continue;
    }
    const message = (typeof payload.error === "string" ? payload.error : payload.error?.message) || payload.message || `图片生成失败（HTTP ${response.status}）`;
    if ([429, 502, 503].includes(response.status) && attempt < IMAGE_RETRY_DELAYS.length) {
      if (response.status === 429) reduceGenerationConcurrencyAfterRateLimit();
      entry.taskStatus = "retry_wait";
      entry.taskProgress = "";
      renderGenerationFeed();
      await persistGenerationHistory();
      await new Promise((resolve) => setTimeout(resolve, IMAGE_RETRY_DELAYS[attempt]));
      continue;
    }
    const error = new Error(message);
    error.requestId = requestId;
    error.httpStatus = response.status;
    throw error;
  }
}

function getGenerationToastMessage(entry) {
  if (entry.status === "ready") return "真实图片已生成";
  if (entry.status === "loading" && entry.taskStatus === "polling_paused") return "原任务仍在生成，稍后刷新即可继续查询";
  if (entry.remoteStateUncertain) return "生图连接中断，远端状态未知；请先核对账单，勿立即重试";
  if (entry.httpStatus === 429) return "请求过于频繁，请稍后再试";
  if (entry.httpStatus >= 500) return "生图服务暂不可用，请稍后再试";
  return "图片生成失败，请查看失败原因后重试";
}

async function checkImageService() {
  const status = $("serviceStatus");
  const label = $("serviceStatusText");
  const textReady = hasBrowserTextApi();
  const imageReady = hasBrowserImageApi();
  status.classList.toggle("is-offline", !textReady && !imageReady);
  label.textContent = textReady && imageReady ? "API 已配置" : textReady ? "文本 API 已配置" : imageReady ? "生图 API 已配置" : "请先配置 API";
}

async function runGeneration(entry) {
  let taskStillPending = false;
  try {
    const result = await requestGeneratedImage(entry);
    entry.imageUrl = result.imageUrl;
    entry.actualResponseFormat = result.actualResponseFormat;
    entry.requestId = result.requestId || entry.requestId || "";
    entry.status = "ready";
    entry.taskStatus = "completed";
    entry.taskProgress = "100%";
    entry.errorMessage = "";
    entry.httpStatus = undefined;
    entry.remoteStateUncertain = false;
    saveLastImageDiagnostic({
      actualFormat: result.actualResponseFormat === "b64_json" ? "Base64" : "URL",
      imageHost: result.actualResponseFormat === "b64_json" ? "API 响应" : getDiagnosticImageHost(result.imageUrl),
      storageStatus: "保存中",
      failureReason: ""
    }, entry.id);
    if (isOutputAutoSaveReady()) setEntryOutputSaveState(entry, "pending");
  } catch (error) {
    taskStillPending = Boolean(error.imageTaskStillPending && entry.taskId);
    entry.status = taskStillPending ? "loading" : "error";
    if (taskStillPending) entry.taskStatus = "polling_paused";
    entry.errorMessage = error.message || "图片生成失败，请重试";
    entry.requestId = error.requestId || entry.requestId || "";
    entry.httpStatus = Number.isInteger(error.httpStatus) ? error.httpStatus : undefined;
    entry.remoteStateUncertain = Boolean(error.remoteStateUncertain);
    saveLastImageDiagnostic({
      storageStatus: taskStillPending ? "等待任务完成" : "未开始",
      failureReason: taskStillPending ? "本轮查询已暂停，原任务仍可继续查询" : getDiagnosticFailureReason(error.imageCacheErrorCode || "request_failed")
    }, entry.id);
  }
  entry.completedAt = taskStillPending ? "" : new Date().toISOString();
  renderGenerationFeed();
  await persistGenerationHistory();
  if (entry.status === "ready" && entry.imageUrl) {
    const cachePromise = queueGeneratedImageCache(entry);
    if (entry.outputSaveStatus === "pending") queueGeneratedImageOutput(entry, cachePromise);
  }
  showToast(getGenerationToastMessage(entry));
}

function reduceGenerationConcurrencyAfterRateLimit() {
  const rateLimitUntil = Date.now() + IMAGE_RATE_LIMIT_COOLDOWN;
  generationConcurrency = 1;
  try {
    localStorage.setItem(GLOBAL_RATE_LIMIT_KEY, String(rateLimitUntil));
  } catch {}
  window.clearTimeout(generationConcurrencyRestoreTimer);
  generationConcurrencyRestoreTimer = window.setTimeout(() => {
    generationConcurrency = IMAGE_GENERATION_CONCURRENCY;
    try {
      if (Number(localStorage.getItem(GLOBAL_RATE_LIMIT_KEY)) <= Date.now()) localStorage.removeItem(GLOBAL_RATE_LIMIT_KEY);
    } catch {}
    pumpGenerationQueue();
  }, IMAGE_RATE_LIMIT_COOLDOWN);
}

function getEffectiveGenerationConcurrency() {
  let sharedRateLimitUntil = 0;
  try {
    sharedRateLimitUntil = Number(localStorage.getItem(GLOBAL_RATE_LIMIT_KEY)) || 0;
  } catch {}
  return sharedRateLimitUntil > Date.now() ? 1 : generationConcurrency;
}

function canUseCrossTabGenerationLocks() {
  return typeof navigator !== "undefined" && typeof navigator.locks?.request === "function";
}

async function shouldRunCrossTabGenerationEntry(entry) {
  const saved = await loadGenerationHistory().catch(() => null);
  const latest = saved?.entries?.find((item) => item.id === entry.id);
  if (!latest) return true;
  if (latest.status !== "loading") {
    Object.assign(entry, latest);
    renderGenerationFeed();
    return false;
  }
  if (entry.taskId) return latest.taskId === entry.taskId;
  if (latest.taskId || latest.taskStatus === "submitting" || latest.submittedAt && latest.submittedAt !== entry.submittedAt) {
    Object.assign(entry, latest);
    renderGenerationFeed();
    return false;
  }
  return true;
}

async function runWithCrossTabEntryLock(entry, action) {
  return navigator.locks.request(`${GLOBAL_GENERATION_ENTRY_LOCK_PREFIX}${entry.id}`, { ifAvailable: true }, async (lock) => {
    if (!lock || !await shouldRunCrossTabGenerationEntry(entry)) return;
    return action();
  });
}

async function runWithCrossTabGenerationSlot(entry, action) {
  while (entry.status === "loading") {
    const slotNames = GLOBAL_GENERATION_SLOT_NAMES.slice(0, getEffectiveGenerationConcurrency());
    for (const slotName of slotNames) {
      let acquired = false;
      let result;
      await navigator.locks.request(slotName, { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        acquired = true;
        result = await runWithCrossTabEntryLock(entry, action);
      });
      if (acquired) return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function runWithCrossTabGenerationLock(entry, action) {
  if (!canUseCrossTabGenerationLocks()) return action();
  return runWithCrossTabGenerationSlot(entry, action);
}

function startQueuedGeneration(entry) {
  activeGenerationCount += 1;
  void runWithCrossTabGenerationLock(entry, () => runGeneration(entry)).finally(() => {
    activeGenerationCount -= 1;
    scheduledGenerationIds.delete(entry.id);
    pumpGenerationQueue();
  });
}

function pumpGenerationQueue() {
  while (generationQueue.length) {
    const entry = generationQueue[0];
    if (entry.status !== "loading") {
      generationQueue.shift();
      scheduledGenerationIds.delete(entry.id);
      continue;
    }
    if (activeGenerationCount >= getEffectiveGenerationConcurrency()) return;
    generationQueue.shift();
    startQueuedGeneration(entry);
  }
}

function enqueueGenerationEntries(entries) {
  entries.forEach((entry) => {
    if (!entry?.id || entry.status !== "loading" || scheduledGenerationIds.has(entry.id)) return;
    if (!entry.taskId && !entry.taskStatus) entry.taskStatus = "pending_submission";
    scheduledGenerationIds.add(entry.id);
    generationQueue.push(entry);
  });
  pumpGenerationQueue();
}

async function recordGeneratedImageDimensions(image) {
  const card = image.closest("[data-generation-id]");
  const entry = state.generationEntries.find((item) => item.id === card?.dataset.generationId);
  const width = image.naturalWidth;
  const height = image.naturalHeight;
  if (!entry || !width || !height || entry.imageWidth === width && entry.imageHeight === height) return;
  entry.imageWidth = width;
  entry.imageHeight = height;
  renderGenerationFeed();
  await persistGenerationHistory();
}

function openRetryGenerationDialog(entry) {
  pendingRetryEntryId = entry.id;
  showDialogAtTop(retryGenerationDialog);
  $("cancelRetryGenerationBtn").focus();
}

function closeRetryGenerationDialog() {
  pendingRetryEntryId = "";
  retryGenerationDialog.close();
}

function openImageRecoveryOptions(entry) {
  pendingImageRecoveryEntryId = entry.id;
  $("imageRecoveryOptionsTitle").textContent = `处理“${entry.variantTitle || "失效图片"}”`;
  showDialogAtTop(imageRecoveryOptionsDialog);
  $("regenerateFromRecoveryBtn").focus();
}

function closeImageRecoveryOptions({ clearEntry = true } = {}) {
  imageRecoveryOptionsDialog.close();
  if (clearEntry) pendingImageRecoveryEntryId = "";
}

function recoverImageFromLocalBackup() {
  if (!pendingImageRecoveryEntryId) return;
  closeImageRecoveryOptions({ clearEntry: false });
  $("imageRecoveryFileInput").value = "";
  $("imageRecoveryFileInput").click();
}

function regenerateFromImageRecovery() {
  const entry = state.generationEntries.find((item) => item.id === pendingImageRecoveryEntryId);
  closeImageRecoveryOptions();
  if (entry) openRetryGenerationDialog(entry);
}

function openImagePreview(entry) {
  if (!entry?.imageUrl) return;
  $("imagePreviewTitle").textContent = entry.variantTitle || "生成图片预览";
  $("imagePreviewMeta").textContent = `批次 ${entry.batchNumber || "00"} · ${entry.resolution || "1K"} · ${entry.ratio || "未设比例"}`;
  $("imagePreviewImage").src = entry.imageUrl;
  $("imagePreviewImage").alt = `${entry.variantTitle || "生成结果"}大图预览`;
  $("imageDownloadLink").href = entry.imageUrl;
  $("imageDownloadLink").download = createImageDownloadName(entry);
  showDialogAtTop(imagePreviewDialog);
  $("closeImagePreviewBtn").focus();
}

function closeImagePreview() {
  imagePreviewDialog.close();
}

function getBatchSubmissionEntries(batchId) {
  return state.generationEntries.filter((entry) => (entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`) === batchId);
}

function getBatchSubmissionSnapshot(entries) {
  const first = entries[0];
  const stored = entries.find((entry) => entry.submissionSnapshot)?.submissionSnapshot;
  const blueprint = first?.blueprintSnapshot;
  const taskTypeId = stored?.taskTypeId || blueprint?.taskTypeId || "";
  const taskType = TASK_TYPES.find((item) => item.id === taskTypeId);
  const dimensionId = stored?.explorationDimensionId || first?.explorationDimensionId || Object.keys(blueprint?.dimensions || {})[0] || "";
  const dimension = EXPLORATION_DIMENSIONS.find((item) => item.id === dimensionId);
  const referenceImageCacheKey = entries.find((entry) => entry.referenceImageCacheKey)?.referenceImageCacheKey || "";
  return {
    schemaVersion: stored?.schemaVersion || 0,
    sourcePrompt: stored?.sourcePrompt || blueprint?.source?.prompt || first?.promptSnapshot || "",
    contentMode: stored?.contentMode || blueprint?.source?.contentMode || "concept",
    taskTypeId: taskType?.id || TASK_TYPES[0].id,
    taskTypeName: stored?.taskTypeName || taskType?.name || "旧记录未注明",
    requestedOptionCount: Math.max(1, Number(stored?.requestedOptionCount) || entries.length),
    ratio: stored?.ratio || first?.ratio || "",
    resolution: stored?.resolution || first?.resolution || "",
    generationMode: stored?.generationMode || first?.generationMode || "async",
    referenceUsage: stored?.referenceUsage || first?.referenceUsage || "analyze",
    referenceSource: stored?.referenceSource || blueprint?.source?.referenceSource || "",
    hasReferenceImage: stored ? Boolean(stored.hasReferenceImage) : Boolean(referenceImageCacheKey || first?.referenceUsage === "explore"),
    referenceImageCacheKey,
    explorationDimensionId: dimension?.id || "",
    explorationDimensionName: stored?.explorationDimensionName || first?.explorationDimensionName || dimension?.name || "旧记录未注明",
    isLegacy: !stored
  };
}

function clearBatchSubmissionReferencePreview() {
  if (batchSubmissionReferencePreviewUrl) URL.revokeObjectURL(batchSubmissionReferencePreviewUrl);
  batchSubmissionReferencePreviewUrl = "";
}

function renderBatchSubmissionContent(entries, snapshot, referenceRecord) {
  const hasReferenceRecord = referenceRecord?.blob instanceof Blob && referenceRecord.blob.size > 0;
  let referenceMarkup;
  if (snapshot.hasReferenceImage && hasReferenceRecord) {
    clearBatchSubmissionReferencePreview();
    batchSubmissionReferencePreviewUrl = URL.createObjectURL(referenceRecord.blob);
    referenceMarkup = `
      <div class="batch-submission-reference">
        <img src="${escapeHtml(batchSubmissionReferencePreviewUrl)}" alt="本批提交参考图">
        <span><strong>${escapeHtml(referenceRecord.fileName || "参考图")}</strong><small>${snapshot.referenceUsage === "explore" ? "参与生图探索" : "仅用于分析提示词"} · 已保存在当前浏览器</small></span>
      </div>`;
  } else if (snapshot.hasReferenceImage) {
    referenceMarkup = `
      <div class="batch-submission-reference is-missing">
        <span><strong>参考图未保留或已失效</strong><small>${snapshot.referenceUsage === "explore" ? "复用时将回填其他资料，请重新上传参考图后生成方案。" : "本批提示词仍可复用，但原参考图无法恢复。"}</small></span>
      </div>`;
  } else {
    referenceMarkup = `<p>${snapshot.isLegacy ? "旧记录未保存参考图信息" : "本批未使用参考图"}</p>`;
  }
  $("batchSubmissionContent").innerHTML = `
    <dl class="batch-submission-overview">
      <div><dt>创作类型</dt><dd>${escapeHtml(snapshot.taskTypeName)}</dd></div>
      <div><dt>探索变量</dt><dd>${escapeHtml(snapshot.explorationDimensionName)}</dd></div>
      <div><dt>输出设置</dt><dd>${escapeHtml(snapshot.resolution || "未注明")} · ${escapeHtml(snapshot.ratio || "未注明")}</dd></div>
      <div><dt>生成方式</dt><dd>${snapshot.generationMode === "sync" ? "同步" : "异步"}</dd></div>
    </dl>
    <section class="batch-submission-section">
      <h3>原始输入</h3>
      <p>${escapeHtml(snapshot.sourcePrompt || "旧记录未保存原始输入")}</p>
    </section>
    <section class="batch-submission-section">
      <h3>参考图</h3>
      ${referenceMarkup}
    </section>
    <section class="batch-submission-section">
      <h3>实际提交方案 · ${entries.length}</h3>
      <div class="batch-submission-variants">
        ${entries.map((entry, index) => `
          <article class="batch-submission-variant">
            <div class="batch-submission-variant-head"><strong>${escapeHtml(entry.variantTitle || `方案 ${index + 1}`)}</strong><small>${escapeHtml(entry.explorationOption || entry.changeSummary || "已提交")}</small></div>
            <div class="prompt-preview" tabindex="0" role="region" aria-label="${escapeHtml(entry.variantTitle || `方案 ${index + 1}`)}完整提示词">${escapeHtml(entry.promptSnapshot || "旧记录未保存提示词")}</div>
          </article>`).join("")}
      </div>
    </section>
    <p class="batch-submission-warning hidden" id="batchSubmissionReuseWarning" role="alert"></p>
  `;
}

async function openBatchSubmission(batchId) {
  const entries = getBatchSubmissionEntries(batchId);
  if (!entries.length) return;
  pendingBatchSubmissionId = batchId;
  pendingBatchReuseConfirmed = false;
  const snapshot = getBatchSubmissionSnapshot(entries);
  let referenceRecord = null;
  if (snapshot.referenceImageCacheKey) referenceRecord = await loadReferenceImageCache(snapshot.referenceImageCacheKey).catch(() => null);
  if (pendingBatchSubmissionId !== batchId) return;
  $("batchSubmissionDialogTitle").textContent = `批次 ${entries[0].batchNumber || "00"} 提交资料`;
  $("batchSubmissionDialogMeta").textContent = `${formatBatchTime(entries[0].batchCreatedAt || entries[0].createdAt)} · ${entries.length} 条结果 · 当前浏览器`;
  $("reuseBatchSubmissionBtn").disabled = false;
  $("reuseBatchSubmissionBtn").textContent = "复用到工作台";
  renderBatchSubmissionContent(entries, snapshot, referenceRecord);
  showDialogAtTop(batchSubmissionDialog);
  $("cancelBatchSubmissionBtn").focus();
}

function resetBatchSubmissionDialogState() {
  pendingBatchSubmissionId = "";
  pendingBatchReuseConfirmed = false;
  clearBatchSubmissionReferencePreview();
}

function closeBatchSubmission() {
  batchSubmissionDialog.close();
  resetBatchSubmissionDialogState();
}

function hasCurrentWorkspaceDraft() {
  return Boolean(state.blueprint || $("sourcePrompt").value.trim() || state.referenceImageData);
}

function restoreSubmissionSettings(snapshot, entries) {
  const taskType = TASK_TYPES.find((item) => item.id === snapshot.taskTypeId) || TASK_TYPES[0];
  taskTypeSelect.value = taskType.id;
  renderDimensions();
  const dimension = EXPLORATION_DIMENSIONS.find((item) => item.id === snapshot.explorationDimensionId && taskType.supportedDimensionIds.includes(item.id));
  const dimensionControl = dimensionList.querySelector(`input[value="${CSS.escape(dimension?.id || "")}"]`);
  if (dimensionControl) dimensionControl.checked = true;
  renderOptionCounts();
  const optionCount = String(Math.max(entries.length, Number(snapshot.requestedOptionCount) || entries.length));
  if ([...$("optionCount").options].some((option) => option.value === optionCount)) $("optionCount").value = optionCount;
  if ([...$("imageResolution").options].some((option) => option.value === snapshot.resolution)) $("imageResolution").value = snapshot.resolution;
  if ([...imageRatioSelect.options].some((option) => option.value === snapshot.ratio)) imageRatioSelect.value = snapshot.ratio;
  imageRatioOverridden = true;
  state.contentMode = snapshot.contentMode === "factual" ? "factual" : "concept";
  renderContentModes();
  $("sourcePrompt").value = snapshot.sourcePrompt;
}

async function restoreSubmissionReference(snapshot) {
  referenceImageLoadToken += 1;
  $("referenceImage").value = "";
  state.referenceImage = null;
  state.referenceImageData = "";
  state.referenceImageSource = "";
  state.referenceUsage = snapshot.referenceUsage === "explore" ? "explore" : "analyze";
  $("filePreview").classList.add("hidden");
  $("dropzone").classList.remove("hidden");
  if (!snapshot.hasReferenceImage || !snapshot.referenceImageCacheKey) {
    syncReferenceUsageUI();
    return false;
  }
  const cached = await loadReferenceImageCache(snapshot.referenceImageCacheKey).catch(() => null);
  if (!(cached?.blob instanceof Blob) || !cached.blob.size) {
    syncReferenceUsageUI();
    return false;
  }
  const file = new File([cached.blob], cached.fileName || "reference.png", { type: cached.mimeType || cached.blob.type || "image/png" });
  state.referenceImage = file;
  state.referenceImageData = await resizeReferenceImage(file);
  state.referenceImageSource = snapshot.referenceSource === "generated-result" ? "generated-result" : "user-upload";
  $("filePreviewImage").src = state.referenceImageData;
  $("fileName").textContent = file.name;
  $("filePreview").classList.remove("hidden");
  $("dropzone").classList.add("hidden");
  syncReferenceUsageUI();
  return true;
}

function createReusedBlueprint(snapshot, entries, hasReferenceImage) {
  const dimensionId = snapshot.explorationDimensionId || entries[0]?.explorationDimensionId || selectedDimension().id;
  const dimensionName = snapshot.explorationDimensionName || entries[0]?.explorationDimensionName || selectedDimension().name;
  const firstBlueprint = entries.find((entry) => entry.blueprintSnapshot)?.blueprintSnapshot;
  const variants = entries.map((entry, index) => ({
    id: `reused_${Date.now()}_${index + 1}`,
    title: entry.variantTitle || `方案 ${index + 1}`,
    explorationOption: entry.explorationOption || entry.variantTitle || `方案 ${index + 1}`,
    changed: { [dimensionId]: entry.explorationOption || entry.variantTitle || "" },
    lockedSnapshot: structuredClone(entry.blueprintSnapshot?.locked || firstBlueprint?.locked || {}),
    blueprintSnapshot: entry.blueprintSnapshot ? structuredClone(entry.blueprintSnapshot) : undefined,
    changeSummary: entry.changeSummary || "来自历史提交资料",
    prompt: entry.promptSnapshot || "",
    generation: { ratio: entry.ratio || snapshot.ratio, resolution: entry.resolution || snapshot.resolution, imageCount: 1 },
    artClass: entry.artClass || ["art-editorial", "art-retro", "art-future", "art-lifestyle"][index % 4]
  }));
  return {
    schemaVersion: 1,
    taskTypeId: snapshot.taskTypeId,
    contentMode: snapshot.contentMode,
    source: {
      prompt: snapshot.sourcePrompt,
      referenceImages: hasReferenceImage ? [{ source: "uploaded-reference" }] : [],
      referenceRole: snapshot.referenceUsage === "explore" ? "generation-reference" : "analysis-only",
      referenceSource: snapshot.referenceSource,
      referenceUsage: snapshot.referenceUsage,
      contentMode: snapshot.contentMode
    },
    locked: structuredClone(firstBlueprint?.locked || {}),
    exploration: {
      dimensionIds: [dimensionId],
      dimensionName,
      optionCount: variants.length,
      requestedOptionCount: variants.length,
      missingOptionCount: 0,
      isPartial: false,
      selectedOptions: variants.map((variant) => variant.explorationOption)
    },
    variants
  };
}

async function reuseBatchSubmission() {
  const entries = getBatchSubmissionEntries(pendingBatchSubmissionId);
  if (!entries.length) return;
  if (!pendingBatchReuseConfirmed && hasCurrentWorkspaceDraft()) {
    pendingBatchReuseConfirmed = true;
    $("batchSubmissionReuseWarning").textContent = "当前工作台的输入和提示词方案将被替换，已生成结果和历史记录不受影响。";
    $("batchSubmissionReuseWarning").classList.remove("hidden");
    $("reuseBatchSubmissionBtn").textContent = "确认复用";
    $("reuseBatchSubmissionBtn").focus();
    return;
  }
  const snapshot = getBatchSubmissionSnapshot(entries);
  const button = $("reuseBatchSubmissionBtn");
  button.disabled = true;
  button.textContent = "正在复用…";
  try {
    restoreSubmissionSettings(snapshot, entries);
    clearRefinementLineage();
    const referenceRestored = await restoreSubmissionReference(snapshot);
    const missingRequiredReference = snapshot.hasReferenceImage && snapshot.referenceUsage === "explore" && !referenceRestored;
    state.directionCompletionError = "";
    state.selectedVariantIds.clear();
    if (missingRequiredReference) {
      state.blueprint = null;
      syncSetupLockState();
      renderPromptCards();
      renderBlueprintPreview();
      $("generateBtnLabel").textContent = "生成视觉方向";
      $("generateHint").textContent = "原参考图已失效，请重新上传并选择“参与生图探索”后生成视觉方向。";
      closeBatchSubmission();
      goToStage("setupStage", { resetScroll: true });
      showToast("已回填其他资料，请重新上传并设置参考图用途");
      return;
    }
    state.blueprint = createReusedBlueprint(snapshot, entries, referenceRestored);
    state.selectedVariantIds = new Set(state.blueprint.variants.map((variant) => variant.id));
    syncSetupLockState();
    renderBlueprintPreview();
    renderPromptCards();
    $("generateBtnLabel").textContent = "重新生成方向";
    $("generateHint").textContent = "已从历史批次复用，可调整选择后作为新批次提交。";
    closeBatchSubmission();
    goToStage("promptStage", { resetScroll: true });
    showToast(`已复用批次 ${entries[0].batchNumber || "00"} 的 ${entries.length} 套方案`);
  } catch (error) {
    button.disabled = false;
    button.textContent = "复用到工作台";
    pendingBatchReuseConfirmed = false;
    $("batchSubmissionReuseWarning").textContent = error.message || "提交资料恢复失败，请稍后重试。";
    $("batchSubmissionReuseWarning").classList.remove("hidden");
  }
}

function openBatchComparison(batchId) {
  const entries = state.generationEntries.filter((entry) => (entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`) === batchId && entry.status === "ready" && entry.imageUrl);
  if (entries.length < 2) return;
  $("comparisonTitle").textContent = `批次 ${entries[0].batchNumber || "00"} 对比`;
  $("comparisonMeta").textContent = `${entries.length} 条完成结果 · 点击图片可查看大图`;
  $("comparisonGrid").innerHTML = entries.map((entry) => `
    <article class="comparison-item${entry.favorite ? " is-favorite" : ""}" data-comparison-id="${escapeHtml(entry.id)}">
      <button class="comparison-image" type="button" data-action="open-comparison-image" aria-label="查看${escapeHtml(entry.variantTitle)}大图">
        <img src="${escapeHtml(entry.imageUrl)}" alt="${escapeHtml(entry.variantTitle)}对比图">
      </button>
      <div class="comparison-caption">
        <span><strong>${escapeHtml(entry.variantTitle)}</strong><small>${escapeHtml(entry.resolution || "1K")} · ${escapeHtml(entry.ratio || "未设比例")}</small></span>
        ${entry.favorite ? `<span class="comparison-favorite" aria-label="已收藏">${renderStarIcon(true)}</span>` : ""}
      </div>
    </article>
  `).join("");
  showDialogAtTop(comparisonDialog);
  $("closeComparisonBtn").focus();
}

function closeBatchComparison() {
  comparisonDialog.close();
}

async function confirmRetryGeneration() {
  const entry = state.generationEntries.find((item) => item.id === pendingRetryEntryId);
  closeRetryGenerationDialog();
  if (!entry) return;
  try {
    await loadReferenceImageForEntry(entry);
  } catch (error) {
    const errorMessage = error.message || "参考图缓存缺失，无法重新生成";
    const generationMode = entry.generationMode === "sync" ? "sync" : "async";
    const endpointPath = getImageEndpointPath({ generationMode, referenceUsage: entry.referenceUsage });
    saveLastImageDiagnostic({
      entryId: entry.id,
      requestMode: generationMode === "async" ? "异步" : "同步",
      endpointPath,
      requestedFormat: "Base64",
      actualFormat: "未开始",
      imageHost: "未开始",
      storageBackend: "未开始",
      storageStatus: "未开始",
      restoreStatus: "尚未验证",
      failureReason: getDiagnosticFailureReason(error.imageCacheErrorCode || "reference_cache_missing")
    });
    if (entry.status !== "ready") {
      entry.status = "error";
      entry.errorMessage = errorMessage;
      renderGenerationFeed({ openBatchId: entry.batchId || `legacy_batch_${entry.batchNumber || "00"}` });
      await persistGenerationHistory();
    }
    showToast(errorMessage);
    return;
  }
  deleteGenerationImageCache(entry.id).catch(() => {});
  deleteGeneratedImageOpaqueCache(entry.originalImageUrl || entry.imageUrl).catch(() => false);
  releaseGeneratedImageObjectUrl(entry.id);
  entry.taskId = "";
  entry.taskStatus = "";
  entry.taskProgress = "";
  entry.requestId = "";
  entry.httpStatus = undefined;
  entry.remoteStateUncertain = false;
  entry.imageUrl = "";
  entry.originalImageUrl = "";
  entry.imageCacheKey = "";
  entry.imageCacheBackend = "";
  entry.imageCacheStatus = "";
  entry.imageCacheErrorCode = "";
  entry.imageCacheErrorMessage = "";
  entry.imageMimeType = "";
  entry.imageByteSize = undefined;
  entry.actualResponseFormat = undefined;
  entry.imageWidth = undefined;
  entry.imageHeight = undefined;
  entry.outputSaveStatus = "";
  entry.outputFileName = "";
  entry.outputSavedAt = "";
  entry.outputSaveError = "";
  entry.status = "loading";
  entry.errorMessage = "";
  entry.taskStatus = "pending_submission";
  entry.queuedAt = new Date().toISOString();
  entry.submittedAt = "";
  entry.startedAt = entry.queuedAt;
  entry.completedAt = "";
  renderGenerationFeed();
  persistGenerationHistory();
  enqueueGenerationEntries([entry]);
}

function persistGenerationHistory({ strict = false } = {}) {
  const snapshot = {
    entries: state.generationEntries.map((entry) => ({ ...entry })),
    batchNumber: state.batchNumber,
    savedAt: new Date().toISOString()
  };
  const saveAttempt = historySaveQueue.then(() => saveGenerationHistory(snapshot));
  historySaveQueue = saveAttempt.catch(() => {
    showToast("历史记录保存失败，本次结果仍可继续使用");
  });
  return strict ? saveAttempt : historySaveQueue;
}

function readPendingImageCleanup() {
  try {
    const items = JSON.parse(localStorage.getItem(IMAGE_CLEANUP_KEY) || "[]");
    return Array.isArray(items)
      ? items
        .filter((item) => typeof item?.entryId === "string" && item.entryId && Number.isFinite(Number(item.deleteAfter)))
        .map((item) => ({
          entryId: item.entryId,
          referenceImageCacheKey: typeof item.referenceImageCacheKey === "string" ? item.referenceImageCacheKey : "",
          deleteAfter: Number(item.deleteAfter)
        }))
      : [];
  } catch {
    return [];
  }
}

function writePendingImageCleanup(items) {
  if (items.length) localStorage.setItem(IMAGE_CLEANUP_KEY, JSON.stringify(items));
  else localStorage.removeItem(IMAGE_CLEANUP_KEY);
}

function removePendingImageCleanup(entryId) {
  window.clearTimeout(imageCleanupTimers.get(entryId));
  imageCleanupTimers.delete(entryId);
  pendingOpaqueImageCleanupUrls.delete(entryId);
  writePendingImageCleanup(readPendingImageCleanup().filter((item) => item.entryId !== entryId));
}

async function runPendingImageCleanup(item) {
  const opaqueImageUrl = pendingOpaqueImageCleanupUrls.get(item.entryId) || "";
  removePendingImageCleanup(item.entryId);
  const referenceImageStillRetained = item.referenceImageCacheKey && (
    state.generationEntries.some((entry) => entry.referenceImageCacheKey === item.referenceImageCacheKey)
    || readPendingImageCleanup().some((pending) => pending.referenceImageCacheKey === item.referenceImageCacheKey)
  );
  await Promise.all([
    deleteGenerationImageCache(item.entryId).catch(() => {}),
    deleteGeneratedImageOpaqueCache(opaqueImageUrl).catch(() => false),
    item.referenceImageCacheKey && !referenceImageStillRetained
      ? deleteReferenceImageCache(item.referenceImageCacheKey).catch(() => {})
      : Promise.resolve()
  ]);
  releaseGeneratedImageObjectUrl(item.entryId);
}

function armPendingImageCleanup(item) {
  window.clearTimeout(imageCleanupTimers.get(item.entryId));
  const delay = Math.max(0, Number(item.deleteAfter) - Date.now());
  imageCleanupTimers.set(item.entryId, window.setTimeout(() => runPendingImageCleanup(item), delay));
}

function queueGeneratedImageCleanup(entry, delay = IMAGE_CLEANUP_DELAY) {
  if (!entry?.id) return;
  const opaqueImageUrl = entry.imageCacheBackend === "opaque"
    ? (isRemoteGeneratedImageUrl(entry.originalImageUrl) ? entry.originalImageUrl : entry.imageUrl)
    : "";
  if (opaqueImageUrl) pendingOpaqueImageCleanupUrls.set(entry.id, opaqueImageUrl);
  const item = {
    entryId: entry.id,
    referenceImageCacheKey: entry.referenceImageCacheKey || "",
    deleteAfter: Date.now() + delay
  };
  const items = readPendingImageCleanup().filter((pending) => pending.entryId !== entry.id);
  items.push(item);
  writePendingImageCleanup(items);
  armPendingImageCleanup(item);
}

function resumePendingImageCleanup() {
  readPendingImageCleanup().forEach(armPendingImageCleanup);
}

async function restoreGenerationHistory() {
  try {
    const saved = await loadGenerationHistory();
    const pendingCleanup = readPendingImageCleanup();
    const pendingIds = new Set(pendingCleanup.map((item) => item.entryId));
    let interruptedCount = 0;
    let resumedSubmissionCount = 0;
    const savedEntries = (saved?.entries || []).map((entry) => {
      if (entry.status !== "loading" || entry.taskId) return entry;
      if (["pending_submission", "retry_wait"].includes(entry.taskStatus)) {
        resumedSubmissionCount += 1;
        return entry;
      }
      interruptedCount += 1;
      return { ...entry, status: "error", errorMessage: "页面刷新后无法继续接收原请求结果；服务端可能仍在生成并扣费，请先核对账单。" };
    });
    state.generationEntries = savedEntries.filter((entry) => !pendingIds.has(entry.id));
    state.batchNumber = Number(saved?.batchNumber) || 0;
    const normalizedImageHistory = await restoreGenerationHistoryImages(state.generationEntries);
    await Promise.all([
      cleanupOrphanedGenerationImageCaches(new Set([...state.generationEntries.map((entry) => entry.id), ...pendingIds])),
      cleanupOrphanedGeneratedImageOpaqueCaches(new Set(state.generationEntries
        .filter((entry) => entry.imageCacheBackend === "opaque")
        .map((entry) => entry.originalImageUrl || entry.imageUrl)
        .filter(isRemoteGeneratedImageUrl))).catch(() => {}),
      cleanupOrphanedReferenceImageCaches(new Set([
        ...state.generationEntries.map((entry) => entry.referenceImageCacheKey).filter(Boolean),
        ...pendingCleanup.map((item) => item.referenceImageCacheKey).filter(Boolean)
      ]))
    ]);
    generationHistoryLoaded = true;
    renderGenerationFeed();
    if (saved && (saved.migrated || normalizedImageHistory || interruptedCount || state.generationEntries.length !== savedEntries.length)) await persistGenerationHistory();
    queueGenerationHistoryImageCache(state.generationEntries);
    if (state.generationEntries.length) {
      $("feedHint").textContent = `已恢复 ${state.generationEntries.length} 条 · ${groupGenerationEntries().length} 个批次 · 当前浏览器`;
      if (window.matchMedia("(min-width: 900px)").matches) goToStage("resultStage", { resetScroll: true });
      showToast(interruptedCount
        ? `已恢复记录，其中 ${interruptedCount} 条需核对账单`
        : resumedSubmissionCount
          ? `已恢复记录，${resumedSubmissionCount} 条继续排队提交`
          : `已恢复 ${state.generationEntries.length} 条生成记录`);
    }
    resumePendingImageCleanup();
  } catch {
    generationHistoryLoaded = true;
    $("feedHint").textContent = "历史记录暂时无法恢复";
    resumePendingImageCleanup();
  }
}

function resumePendingGenerationTasks() {
  enqueueGenerationEntries(state.generationEntries.filter((entry) => entry.status === "loading" && (entry.taskId || ["pending_submission", "retry_wait"].includes(entry.taskStatus))));
}

function showToast(message, action) {
  const toast = $("toast");
  const text = document.createElement("span");
  text.textContent = message;
  toast.replaceChildren(text);
  toast.classList.toggle("has-action", Boolean(action));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      window.clearTimeout(showToast.timer);
      action.onClick();
    }, { once: true });
    toast.appendChild(button);
  }
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    toast.classList.remove("show", "has-action");
  }, action ? 5000 : 2200);
}

function formatStorageEstimate(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function openHistoryDialog() {
  const entries = state.generationEntries;
  const batchCount = groupGenerationEntries(entries).length;
  const keepCount = Number($("historyKeepCount").value);
  $("historyEntryCount").textContent = entries.length;
  $("historyBatchCount").textContent = batchCount;
  $("historyImageCount").textContent = entries.filter((entry) => entry.imageCacheStatus === "ready" || entry.imageUrl || entry.originalImageUrl).length;
  $("historyDataSize").textContent = "--";
  $("historyImageCacheSize").textContent = "--";
  $("historyStorageEstimate").textContent = "--";
  const [saved, caches, referenceCaches, estimate] = await Promise.all([
    loadGenerationHistory().catch(() => null),
    listGenerationImageCaches().catch(() => []),
    listReferenceImageCaches().catch(() => []),
    navigator.storage?.estimate ? navigator.storage.estimate().catch(() => null) : null
  ]);
  const storedHistory = saved ? { schemaVersion: saved.schemaVersion, entries: saved.entries, batchNumber: saved.batchNumber, savedAt: saved.savedAt } : null;
  const historyBytes = storedHistory ? new Blob([JSON.stringify(storedHistory)]).size : 0;
  const imageCacheBytes = [...caches, ...referenceCaches].reduce((total, cache) => total + cache.blob.size, 0);
  const opaqueImageCount = entries.filter((entry) => entry.imageCacheBackend === "opaque" && entry.imageCacheStatus === "ready").length;
  $("historyDataSize").textContent = formatStorageEstimate(historyBytes);
  $("historyImageCacheSize").textContent = opaqueImageCount
    ? `${formatStorageEstimate(imageCacheBytes)} + ${opaqueImageCount} 张链接缓存`
    : formatStorageEstimate(imageCacheBytes);
  if (Number.isFinite(estimate?.usage)) $("historyStorageEstimate").textContent = formatStorageEstimate(estimate.usage);
  syncHistoryCleanupState(keepCount);
  showDialogAtTop(historyDialog);
}

function syncHistoryCleanupState(keepCount = Number($("historyKeepCount").value)) {
  const removeCount = Math.max(0, state.generationEntries.length - keepCount);
  $("cleanupHistoryBtn").disabled = removeCount === 0;
  $("cleanupHistoryBtn").textContent = keepCount === 0 ? "全部清空" : "清理旧记录";
  $("historyCleanupHint").textContent = removeCount ? `将清理 ${removeCount} 条最旧记录，保留最新 ${keepCount} 条。` : "当前没有需要清理的旧记录。";
}

async function cleanupOldHistory() {
  const keepCount = Number($("historyKeepCount").value);
  const removedEntries = state.generationEntries.slice(keepCount);
  if (!removedEntries.length) return;
  state.generationEntries = state.generationEntries.slice(0, keepCount);
  removedEntries.forEach((entry) => queueGeneratedImageCleanup(entry));
  renderGenerationFeed();
  await persistGenerationHistory();
  historyDialog.close();
  showToast(`已清理 ${removedEntries.length} 条旧记录`, {
    label: "撤销",
    onClick: async () => {
      removedEntries.forEach((entry) => removePendingImageCleanup(entry.id));
      state.generationEntries.push(...removedEntries);
      renderGenerationFeed();
      await persistGenerationHistory();
      showToast(`已恢复 ${removedEntries.length} 条历史记录`);
    }
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast("提示词已复制");
}

function createBlueprintRequestInput({ optionCount, explorationOptions, completionBase } = {}) {
  const type = getTaskType();
  const dimension = selectedDimension();
  const resolvedOptionCount = Math.max(1, Number(optionCount ?? $("optionCount").value) || 1);
  const resolvedExplorationOptions = Array.isArray(explorationOptions)
    ? explorationOptions
    : getExplorationOptions(dimension, resolvedOptionCount);
  return {
    prompt: $("sourcePrompt").value.trim(),
    taskTypeId: type.id,
    taskTypeName: type.name,
    promptProfile: type.promptProfile,
    requiredFields: type.requiredFields,
    dimensionId: dimension.id,
    dimensionName: dimension.name,
    dimensionDescription: dimension.description,
    lockFields: [...new Set([...(type.baselineLockFields || []), ...dimension.lockFields])],
    explorationOptions: resolvedExplorationOptions,
    explorationGuidance: getExplorationGuidance(dimension, resolvedExplorationOptions),
    dynamicExploration: Boolean(dimension.dynamicOptions),
    optionCount: resolvedOptionCount,
    ratio: imageRatioSelect.value,
    resolution: $("imageResolution").value,
    referenceImage: state.referenceImageData,
    referenceSource: state.referenceImageSource,
    referenceUsage: state.referenceUsage,
    contentMode: state.contentMode,
    refinementBase: state.refinementBase,
    completionBase
  };
}

async function generateDirections() {
  const button = $("generateBtn");
  if (isCompletingDirections) return;
  if (isProcessingReferenceImage) {
    showToast("参考图仍在处理中，请稍候");
    return;
  }
  if (!$("sourcePrompt").value.trim() && !state.referenceImageData) {
    showToast("请先输入原始提示词或上传参考图");
    $("sourcePrompt").focus();
    return;
  }
  if (button.disabled) return;
  button.disabled = true;
  isGeneratingDirections = true;
  setSetupControlsDisabled(true);
  setSourcePromptReadOnly(true);
  $("generateBtnLabel").textContent = "正在梳理提示词…";
  $("generateHint").textContent = "正在提取固定内容并整理本轮变量，请稍候。";
  try {
    const input = createBlueprintRequestInput();
    if (!hasBrowserTextApi()) throw new Error("请先在右上角 API 配置中填写文本服务");
    state.blueprint = await requestDirectBlueprint(input);
    state.directionCompletionError = "";
    state.selectedVariantIds.clear();
    renderBlueprintPreview();
    renderPromptCards();
    syncSetupLockState();
    $("generateBtnLabel").textContent = "重新生成方向";
    const missingOptionCount = Number(state.blueprint.exploration?.missingOptionCount) || 0;
    $("generateHint").textContent = missingOptionCount
      ? `已返回 ${state.blueprint.variants.length} 套，缺少 ${missingOptionCount} 套；现有方案可直接使用或继续补齐。`
      : "已生成方案。请在中间选择一套或多套，再统一提交到右侧。";
    goToStage("promptStage", { resetScroll: true });
    showToast(missingOptionCount ? `已保留 ${state.blueprint.variants.length} 套有效方案` : "已生成 AI 提示词方案");
  } catch (error) {
    syncSetupLockState();
    renderBlueprintPreview();
    $("generateBtnLabel").textContent = state.blueprint ? "重新生成方向" : "重试生成方向";
    $("generateHint").textContent = error.message || "提示词方案生成失败，请重试。";
    showToast(error.message || "提示词方案生成失败");
  } finally {
    isGeneratingDirections = false;
    syncSetupLockState();
    button.disabled = false;
  }
}

function normalizeDirectionKey(value) {
  return String(value || "").replace(/\s+/g, "").toLocaleLowerCase("zh-CN");
}

async function completeMissingDirections() {
  const currentBlueprint = state.blueprint;
  const currentVariants = currentBlueprint?.variants || [];
  const requestedOptionCount = Number(currentBlueprint?.exploration?.requestedOptionCount) || currentVariants.length;
  const missingOptionCount = Math.max(0, requestedOptionCount - currentVariants.length);
  if (!currentBlueprint || !missingOptionCount || isCompletingDirections) return;
  if (!hasBrowserTextApi()) {
    showToast("请先在右上角 API 配置中填写文本服务");
    return;
  }

  const dimension = selectedDimension();
  const existingOptions = currentVariants.map((variant) => variant.explorationOption || variant.title).filter(Boolean);
  const existingOptionKeys = new Set(existingOptions.map(normalizeDirectionKey));
  const existingPromptKeys = new Set(currentVariants.map((variant) => normalizeDirectionKey(variant.prompt)));
  const missingFixedOptions = dimension.dynamicOptions
    ? []
    : getExplorationOptions(dimension, requestedOptionCount).filter((option) => !existingOptionKeys.has(normalizeDirectionKey(option)));
  const completionOptionCount = dimension.dynamicOptions ? missingOptionCount : missingFixedOptions.length;
  if (!completionOptionCount) return;

  isCompletingDirections = true;
  $("generateBtn").disabled = true;
  state.directionCompletionError = "";
  renderPromptCards();
  try {
    const input = createBlueprintRequestInput({
      optionCount: completionOptionCount,
      explorationOptions: dimension.dynamicOptions ? [] : missingFixedOptions,
      completionBase: {
        locked: structuredClone(currentBlueprint.locked),
        existingOptions: [...existingOptions],
        requestedOptionCount
      }
    });
    const supplement = await requestDirectBlueprint(input);
    const additions = supplement.variants.filter((variant) => {
      const optionKey = normalizeDirectionKey(variant.explorationOption || variant.title);
      const promptKey = normalizeDirectionKey(variant.prompt);
      if (!optionKey || existingOptionKeys.has(optionKey) || existingPromptKeys.has(promptKey)) return false;
      existingOptionKeys.add(optionKey);
      existingPromptKeys.add(promptKey);
      return true;
    }).slice(0, missingOptionCount);
    if (!additions.length) throw new Error("文本服务未返回新的、不重复的风格方向");

    const combinedVariants = [...currentVariants, ...additions];
    const remainingOptionCount = Math.max(0, requestedOptionCount - combinedVariants.length);
    state.blueprint = {
      ...currentBlueprint,
      responseDiagnostics: supplement.responseDiagnostics,
      responseHistory: [
        ...(Array.isArray(currentBlueprint.responseHistory)
          ? currentBlueprint.responseHistory
          : currentBlueprint.responseDiagnostics ? [currentBlueprint.responseDiagnostics] : []),
        supplement.responseDiagnostics
      ],
      exploration: {
        ...currentBlueprint.exploration,
        optionCount: combinedVariants.length,
        requestedOptionCount,
        missingOptionCount: remainingOptionCount,
        isPartial: remainingOptionCount > 0,
        selectedOptions: combinedVariants.map((variant) => variant.explorationOption || variant.title)
      },
      variants: combinedVariants
    };
    state.directionCompletionError = "";
    $("generateHint").textContent = remainingOptionCount
      ? `已补充 ${additions.length} 套，当前共 ${combinedVariants.length} 套，仍缺少 ${remainingOptionCount} 套。`
      : `已补齐 ${requestedOptionCount} 套方案，可以继续选择并提交生成。`;
    showToast(remainingOptionCount ? `已补充 ${additions.length} 套，仍缺 ${remainingOptionCount} 套` : `已补齐 ${requestedOptionCount} 套方案`);
  } catch (error) {
    state.directionCompletionError = error.message || "补齐请求失败，请稍后重试";
    $("generateHint").textContent = `补齐失败：${state.directionCompletionError}；现有方案仍可继续使用。`;
    showToast(state.directionCompletionError);
  } finally {
    isCompletingDirections = false;
    $("generateBtn").disabled = false;
    renderPromptCards();
  }
}

function toggleVariant(variantId, checked) {
  if (checked) state.selectedVariantIds.add(variantId);
  else state.selectedVariantIds.delete(variantId);
  renderPromptCards();
}

function handlePromptAction(event) {
  const card = event.target.closest("[data-variant-id]");
  if (!card || !state.blueprint) return;
  const variant = state.blueprint.variants.find((item) => item.id === card.dataset.variantId);
  if (!variant) return;
  const actionNode = event.target.closest("[data-action]");
  if (actionNode?.dataset.action === "select") {
    toggleVariant(variant.id, actionNode.checked);
    return;
  }
  if (actionNode?.dataset.action === "copy") {
    copyText(variant.prompt);
    return;
  }
  if (actionNode?.dataset.action === "toggle-prompt") {
    const preview = card.querySelector(".prompt-preview");
    const expanded = actionNode.getAttribute("aria-expanded") === "true";
    actionNode.setAttribute("aria-expanded", String(!expanded));
    actionNode.textContent = expanded ? "完整提示词" : "收起提示词";
    preview.classList.toggle("hidden", expanded);
    return;
  }
  if (event.target.closest("button, input, label, a, .prompt-preview")) return;
  toggleVariant(variant.id, !state.selectedVariantIds.has(variant.id));
}

async function prepareReferenceImageCache(batchId, referenceUsage, hasReferenceImage) {
  if (!hasReferenceImage) return "";
  if (!(state.referenceImage instanceof Blob) || state.referenceImage.size === 0) {
    if (referenceUsage === "explore") throw new Error("参与生图探索需要重新上传有效的参考图");
    return "";
  }
  const cacheKey = getReferenceImageCacheKey(batchId);
  try {
    await saveReferenceImageCache(batchId, state.referenceImage, state.referenceImage.name || "reference.png");
    const verified = await loadReferenceImageCache(cacheKey);
    if (!(verified?.blob instanceof Blob) || verified.blob.size !== state.referenceImage.size) {
      throw new Error("参考图缓存校验失败");
    }
    return cacheKey;
  } catch (cause) {
    await deleteReferenceImageCache(cacheKey).catch(() => {});
    if (referenceUsage === "explore") throw new Error(cause?.message || "参考图无法保存到浏览器，请检查存储空间");
    return "";
  }
}

async function submitSelected() {
  if (!state.blueprint || state.selectedVariantIds.size === 0 || isSubmittingSelected) return;
  isSubmittingSelected = true;
  syncSubmissionBar();
  const previousBatchNumber = state.batchNumber;
  let referenceImageCacheKey = "";
  let entries = [];
  const selected = state.blueprint.variants.filter((variant) => state.selectedVariantIds.has(variant.id));
  const now = new Date();
  const batchId = `batch_${now.getTime()}`;
  const batchCreatedAt = now.toISOString();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const referenceUsage = state.blueprint.source?.referenceUsage === "explore" ? "explore" : "analyze";
  const hasReferenceImage = Boolean(state.blueprint.source?.referenceImages?.length && state.referenceImageData);
  const taskType = TASK_TYPES.find((item) => item.id === state.blueprint.taskTypeId) || getTaskType();
  const submissionSnapshot = {
    schemaVersion: 1,
    sourcePrompt: state.blueprint.source?.prompt || $("sourcePrompt").value.trim(),
    contentMode: state.blueprint.contentMode === "factual" ? "factual" : "concept",
    taskTypeId: taskType.id,
    taskTypeName: taskType.name,
    requestedOptionCount: Number(state.blueprint.exploration?.requestedOptionCount) || selected.length,
    ratio: selected[0]?.generation?.ratio || imageRatioSelect.value,
    resolution: selected[0]?.generation?.resolution || $("imageResolution").value,
    generationMode: state.apiSettings?.imageGenerationMode === "sync" ? "sync" : "async",
    referenceUsage,
    referenceSource: state.referenceImageSource,
    hasReferenceImage,
    explorationDimensionId: state.blueprint.exploration.dimensionIds[0],
    explorationDimensionName: state.blueprint.exploration.dimensionName
  };
  try {
    referenceImageCacheKey = await prepareReferenceImageCache(batchId, referenceUsage, hasReferenceImage);
    state.batchNumber = previousBatchNumber + 1;
    entries = selected.map((variant, index) => ({
      id: `generation_${Date.now()}_${index}`,
      batchId,
      batchNumber: String(state.batchNumber).padStart(2, "0"),
      batchCreatedAt,
      variantTitle: variant.title,
      changeSummary: variant.changeSummary,
      promptSnapshot: variant.prompt,
      blueprintSnapshot: variant.blueprintSnapshot ? structuredClone(variant.blueprintSnapshot) : undefined,
      submissionSnapshot: structuredClone(submissionSnapshot),
      parentGenerationId: state.refinementParentGenerationId,
      refinementDepth: state.refinementDepth,
      explorationDimensionId: state.blueprint.exploration.dimensionIds[0],
      explorationDimensionName: state.blueprint.exploration.dimensionName,
      explorationOption: variant.explorationOption,
      artClass: variant.artClass,
      ratio: variant.generation.ratio,
      resolution: variant.generation.resolution,
      generationMode: state.apiSettings?.imageGenerationMode === "sync" ? "sync" : "async",
      responseFormat: "url",
      referenceUsage,
      referenceImageCacheKey,
      createdAt: time,
      queuedAt: batchCreatedAt,
      submittedAt: "",
      startedAt: batchCreatedAt,
      completedAt: "",
      status: "loading",
      taskStatus: "pending_submission",
      favorite: false
    }));
    state.generationEntries = [...entries, ...state.generationEntries];
    await persistGenerationHistory({ strict: true });
    resetResultFilters();
    state.selectedVariantIds.clear();
    renderPromptCards();
    renderGenerationFeed({ openBatchId: batchId });
    goToStage("resultStage", { resetScroll: true });
    showToast(`已提交 ${entries.length} 套，后台生成中；可继续创建或提交其他方案`);
    enqueueGenerationEntries(entries);
  } catch (error) {
    if (entries.length) state.generationEntries = state.generationEntries.filter((entry) => !entries.some((item) => item.id === entry.id));
    state.batchNumber = previousBatchNumber;
    if (referenceImageCacheKey) await deleteReferenceImageCache(referenceImageCacheKey).catch(() => {});
    renderGenerationFeed();
    showToast(error.message || "提交失败，请检查浏览器存储后重试");
  } finally {
    isSubmittingSelected = false;
    syncSubmissionBar();
  }
}

function selectAllPrompts() {
  const variants = state.blueprint?.variants || [];
  const allSelected = variants.length > 0 && state.selectedVariantIds.size === variants.length;
  state.selectedVariantIds = new Set(allSelected ? [] : variants.map((item) => item.id));
  renderPromptCards();
}

function clearResultFilters() {
  resetResultFilters();
  renderGenerationFeed();
}

function resetResultFilters() {
  state.resultFilters = { query: "", status: "all", batchId: "all" };
  $("resultSearchInput").value = "";
  $("resultStatusFilter").value = "all";
}

async function restoreGeneratedResultForRefinement(entry) {
  const cached = await loadGenerationImageCache(entry.id).catch(() => null);
  let blob = cached?.blob instanceof Blob && cached.blob.size > 0 ? cached.blob : null;
  const sourceUrl = entry.imageUrl || entry.originalImageUrl || cached?.imageUrl || "";
  if (!blob && sourceUrl && (isGeneratedImageSourceUrl(sourceUrl) || /^blob:/i.test(sourceUrl))) {
    blob = await fetchGeneratedImageBlob(sourceUrl);
    await saveGenerationImageCache(entry.id, sourceUrl, blob).catch(() => {});
  }
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error("当前生成结果图片不可用，无法按画面细化；请先恢复图片或重新生成");
  }
  const file = new File([blob], `${createImageDownloadName(entry).replace(/\.png$/i, "") || "generation-result"}.png`, { type: blob.type || "image/png" });
  state.referenceImage = file;
  state.referenceImageData = await resizeReferenceImage(file);
  state.referenceImageSource = "generated-result";
  state.referenceUsage = "analyze";
  $("filePreviewImage").src = state.referenceImageData;
  $("fileName").textContent = `上一轮结果 · ${file.name}`;
  $("filePreview").classList.remove("hidden");
  $("dropzone").classList.add("hidden");
  syncReferenceUsageUI();
}

async function restoreReferenceForRefinement(entry) {
  await restoreGeneratedResultForRefinement(entry);
}

async function continueFromGeneration(entry) {
  const snapshot = entry.blueprintSnapshot && typeof entry.blueprintSnapshot === "object" ? entry.blueprintSnapshot : null;
  try {
    await restoreReferenceForRefinement(entry);
  } catch (error) {
    showToast(error.message || "无法恢复细化所需的参考图");
    return;
  }
  state.contentMode = snapshot?.source?.contentMode === "factual" ? "factual" : "concept";
  renderContentModes();
  state.refinementBase = snapshot;
  state.refinementParentGenerationId = entry.id;
  state.refinementDepth = (Number.isInteger(entry.refinementDepth) ? entry.refinementDepth : 0) + 1;
  $("sourcePrompt").value = snapshot?.source?.prompt || entry.promptSnapshot;
  state.blueprint = null;
  state.directionCompletionError = "";
  state.selectedVariantIds.clear();
  syncSetupLockState();
  renderBlueprintPreview();
  renderPromptCards();
  goToStage("setupStage", { resetScroll: true });
  showToast(snapshot ? `已继承“${entry.variantTitle}”的视觉基线，请设置下一轮探索` : `已继承“${entry.variantTitle}”，旧记录将按提示词继续细化`);
}

function handleGenerationAction(event) {
  const button = event.target.closest("[data-action]");
  const batchNode = event.target.closest(".generation-batch");
  if (button?.dataset.action === "open-batch-submission" && batchNode) {
    event.preventDefault();
    event.stopPropagation();
    void openBatchSubmission(batchNode.dataset.batchId);
    return;
  }
  if (button?.dataset.action === "compare-batch" && batchNode) {
    event.preventDefault();
    event.stopPropagation();
    openBatchComparison(batchNode.dataset.batchId);
    return;
  }
  if (button?.dataset.action === "delete-batch" && batchNode) {
    event.preventDefault();
    event.stopPropagation();
    const batchId = batchNode.dataset.batchId;
    const deletedEntries = state.generationEntries.filter((entry) => (entry.batchId || `legacy_batch_${entry.batchNumber || "00"}`) === batchId);
    if (!deletedEntries.length) return;
    const firstIndex = state.generationEntries.findIndex((entry) => entry.id === deletedEntries[0].id);
    state.generationEntries = state.generationEntries.filter((entry) => !deletedEntries.some((item) => item.id === entry.id));
    deletedEntries.forEach((entry) => queueGeneratedImageCleanup(entry));
    renderGenerationFeed();
    persistGenerationHistory();
    if (state.generationEntries.length === 0) $("feedHint").textContent = "提交记录会持续保留";
    showToast(`已删除批次 ${deletedEntries[0].batchNumber}（${deletedEntries.length} 条结果）`, {
      label: "撤销",
      onClick: () => {
        deletedEntries.forEach((entry) => removePendingImageCleanup(entry.id));
        state.generationEntries.splice(firstIndex, 0, ...deletedEntries);
        renderGenerationFeed({ openBatchId: batchId });
        persistGenerationHistory();
        showToast(`已恢复批次 ${deletedEntries[0].batchNumber}（${deletedEntries.length} 条结果）`);
      }
    });
    return;
  }
  const card = event.target.closest("[data-generation-id]");
  if (!button || !card) return;
  const entry = state.generationEntries.find((item) => item.id === card.dataset.generationId);
  if (!entry) return;
  if (button.dataset.action === "open-image") {
    openImagePreview(entry);
    return;
  }
  if (button.dataset.action === "recover-image") {
    event.preventDefault();
    event.stopPropagation();
    recoverGeneratedImage(entry);
    return;
  }
  if (button.dataset.action === "download-image") {
    void handleSaveGeneratedImage(entry);
    return;
  }
  if (button.dataset.action === "retry-image-cache") {
    entry.imageCacheStatus = "pending";
    entry.imageCacheErrorCode = "";
    entry.imageCacheErrorMessage = "";
    renderGenerationFeed({ openBatchId: entry.batchId || `legacy_batch_${entry.batchNumber || "00"}` });
    persistGenerationHistory();
    queueGeneratedImageCache(entry);
    showToast("正在重新缓存图片");
    return;
  }
  if (button.dataset.action === "open-image-recovery") {
    openImageRecoveryOptions(entry);
    return;
  }
  if (button.dataset.action === "toggle-favorite") {
    entry.favorite = !entry.favorite;
    renderGenerationFeed({ openBatchId: entry.batchId || `legacy_batch_${entry.batchNumber || "00"}` });
    persistGenerationHistory();
    showToast(entry.favorite ? `已收藏“${entry.variantTitle}”` : `已取消收藏“${entry.variantTitle}”`);
    return;
  }
  if (button.dataset.action === "delete") {
    const deletedIndex = state.generationEntries.findIndex((item) => item.id === entry.id);
    state.generationEntries = state.generationEntries.filter((item) => item.id !== entry.id);
    queueGeneratedImageCleanup(entry);
    renderGenerationFeed();
    persistGenerationHistory();
    if (state.generationEntries.length === 0) $("feedHint").textContent = "提交记录会持续保留";
    showToast(`已删除“${entry.variantTitle}”`, {
      label: "撤销",
      onClick: () => {
        removePendingImageCleanup(entry.id);
        state.generationEntries.splice(deletedIndex, 0, entry);
        renderGenerationFeed();
        persistGenerationHistory();
        $("feedHint").textContent = "提交记录会持续保留";
        showToast(`已恢复“${entry.variantTitle}”`);
      }
    });
    return;
  }
  if (button.dataset.action === "copy-generation") return copyText(entry.promptSnapshot);
  if (button.dataset.action === "continue") {
    void continueFromGeneration(entry);
    return;
  }
  if (button.dataset.action === "retry") {
    openRetryGenerationDialog(entry);
  }
}

async function recoverGeneratedImage(entry) {
  try {
    const cached = await loadGenerationImageCache(entry.id).catch(() => null);
    const blob = cached?.imageUrl === entry.imageUrl && cached.blob instanceof Blob
      ? cached.blob
      : await fetchGeneratedImageBlob(entry.imageUrl);
    const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
    if ((!cached || cached.imageUrl !== entry.imageUrl) && currentEntry?.status === "ready" && currentEntry.imageUrl === entry.imageUrl) {
      await saveGenerationImageCache(currentEntry.id, currentEntry.imageUrl, blob).catch(() => {});
    }
    downloadGeneratedImageBlob(entry, blob);
    showToast("已恢复并开始下载图片");
  } catch {
    showToast("原图链接已失效或被浏览器拦截", {
      label: "重新生成",
      onClick: () => openRetryGenerationDialog(entry)
    });
  }
}

async function cacheGeneratedImageFile(entry, file) {
  if (!(file instanceof File) || !file.type.startsWith("image/") || !file.size) {
    showToast("请选择有效的 PNG、JPEG 或 WebP 图片");
    return;
  }
  const sourceUrl = isRemoteGeneratedImageUrl(entry.imageUrl) ? entry.imageUrl : entry.originalImageUrl;
  const hadRuntimeImage = Boolean(entry.imageUrl);
  try {
    await saveGenerationImageCache(entry.id, sourceUrl, file);
    const verified = await loadGenerationImageCache(entry.id);
    if (!(verified?.blob instanceof Blob) || verified.blob.size !== file.size) throw new Error("本地图片缓存校验失败");
    const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (!currentEntry || currentEntry.status !== "ready") {
      await deleteGenerationImageCache(entry.id).catch(() => {});
      return;
    }
    setGeneratedImageCacheMetadata(currentEntry, verified.blob, sourceUrl);
    await persistGenerationHistory({ strict: true });
    await deleteGeneratedImageOpaqueCache(sourceUrl).catch(() => false);
    attachGeneratedImageBlob(currentEntry, verified.blob, sourceUrl);
    await persistGenerationHistory();
    if (hadRuntimeImage) syncGeneratedImageCacheSuccess(currentEntry);
    else renderGenerationFeed({ openBatchId: currentEntry.batchId || `legacy_batch_${currentEntry.batchNumber || "00"}` });
    showToast("已用本地图片补回缓存");
  } catch {
    await deleteGenerationImageCache(entry.id).catch(() => {});
    const currentEntry = state.generationEntries.find((item) => item.id === entry.id);
    if (currentEntry?.status === "ready") {
      currentEntry.imageCacheKey = "";
      currentEntry.imageCacheBackend = "";
      currentEntry.imageCacheStatus = "error";
      currentEntry.imageCacheErrorCode = "storage_unavailable";
      currentEntry.imageCacheErrorMessage = "本地图片写入 IndexedDB 失败，请检查浏览器存储权限或空间。";
      currentEntry.imageMimeType = "";
      currentEntry.imageByteSize = undefined;
      await persistGenerationHistory();
      renderGenerationFeed({ openBatchId: currentEntry.batchId || `legacy_batch_${currentEntry.batchNumber || "00"}` });
    }
    showToast("本地图片写入失败，请检查浏览器存储");
  }
}

async function handleGeneratedImageRecoveryFile(file) {
  const entry = state.generationEntries.find((item) => item.id === pendingImageRecoveryEntryId);
  pendingImageRecoveryEntryId = "";
  if (!entry || !file) return;
  await cacheGeneratedImageFile(entry, file);
}

function resizeReferenceImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("参考图无法解析"));
      image.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext("2d").drawImage(image, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", .84));
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

function addReferenceSafetyMargin(blob) {
  return new Promise((resolve, reject) => {
    if (!(blob instanceof Blob) || blob.size === 0) {
      reject(new Error("参考图内容无效"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("参考图读取失败"));
    reader.onload = () => {
      const image = new Image();
      image.onerror = () => reject(new Error("参考图无法解析"));
      image.onload = () => {
        const scale = Math.min(1, 1280 / Math.max(image.naturalWidth, image.naturalHeight));
        const width = Math.max(1, Math.round(image.naturalWidth * scale));
        const height = Math.max(1, Math.round(image.naturalHeight * scale));
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        if (!context) {
          reject(new Error("参考图安全边距处理失败"));
          return;
        }
        const marginX = Math.max(1, Math.round(width * 0.1));
        const marginY = Math.max(1, Math.round(height * 0.1));
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(
          image,
          marginX,
          marginY,
          Math.max(1, width - marginX * 2),
          Math.max(1, height - marginY * 2)
        );
        canvas.toBlob((paddedBlob) => {
          if (paddedBlob) resolve(paddedBlob);
          else reject(new Error("参考图安全边距处理失败"));
        }, "image/png");
      };
      image.src = reader.result;
    };
    reader.readAsDataURL(blob);
  });
}

async function handleFile(file) {
  if (isSetupLocked()) return;
  if (!file || !file.type.startsWith("image/")) return;
  clearRefinementLineage();
  const loadToken = ++referenceImageLoadToken;
  isProcessingReferenceImage = true;
  state.referenceImage = file;
  try {
    const referenceImageData = await resizeReferenceImage(file);
    if (loadToken !== referenceImageLoadToken) return;
    state.referenceImageData = referenceImageData;
    state.referenceImageSource = "user-upload";
    state.referenceUsage = "analyze";
    $("filePreviewImage").src = state.referenceImageData;
    $("fileName").textContent = file.name;
    $("filePreview").classList.remove("hidden");
    $("dropzone").classList.add("hidden");
    syncReferenceUsageUI();
    renderBlueprintPreview();
    showToast("参考图已加入本轮输入");
  } catch (error) {
    if (loadToken !== referenceImageLoadToken) return;
    state.referenceImage = null;
    state.referenceImageData = "";
    state.referenceImageSource = "";
    state.referenceUsage = "analyze";
    syncReferenceUsageUI();
    showToast(error.message || "参考图处理失败");
  } finally {
    if (loadToken === referenceImageLoadToken) isProcessingReferenceImage = false;
  }
}

function handlePaste(event) {
  if (isSetupLocked()) return;
  const imageFile = [...(event.clipboardData?.items || [])]
    .find((item) => item.kind === "file" && item.type.startsWith("image/"))
    ?.getAsFile();
  if (!imageFile) return;
  event.preventDefault();
  handleFile(imageFile);
}

function removeReferenceImage() {
  if (isSetupLocked()) return;
  clearRefinementLineage();
  referenceImageLoadToken += 1;
  isProcessingReferenceImage = false;
  $("referenceImage").value = "";
  state.referenceImage = null;
  state.referenceImageData = "";
  state.referenceImageSource = "";
  state.referenceUsage = "analyze";
  $("filePreview").classList.add("hidden");
  $("dropzone").classList.remove("hidden");
  syncReferenceUsageUI();
  renderBlueprintPreview();
  showToast("已移除参考图");
}

function openResetDialog() {
  showDialogAtTop(resetDialog);
  $("cancelResetBtn").focus();
}

function closeResetDialog() {
  $("resetDialog").close();
}

async function loadSavedApiSettings() {
  state.apiSettings = await loadApiSettings().catch(() => null);
  fillApiSettingsForm(state.apiSettings || {});
}

async function loadSavedOutputSettings() {
  const saved = await loadOutputSettings().catch(() => null);
  state.outputSettings = normalizeOutputSettings(saved || {});
}

function setOutputSettingsError(message = "") {
  const error = $("outputSettingsError");
  if (!error) return;
  error.textContent = message;
  error.classList.toggle("hidden", !message);
}

function openOutputSettings() {
  outputSettingsDraft = normalizeOutputSettings(state.outputSettings);
  setOutputSettingsError("");
  renderOutputDirectoryStatus(outputSettingsDraft, isOutputDirectoryHandle(outputSettingsDraft.directoryHandle) ? "checking" : "");
  showDialogAtTop(outputSettingsDialog);
  void refreshOutputDirectoryStatus(outputSettingsDraft);
  $("chooseOutputDirectoryBtn").focus();
}

function closeOutputSettings() {
  outputSettingsDraft = null;
  outputSettingsDialog.close();
}

async function chooseOutputDirectory() {
  const draft = outputSettingsDraft || normalizeOutputSettings(state.outputSettings);
  outputSettingsDraft = draft;
  const button = $("chooseOutputDirectoryBtn");
  button.disabled = true;
  button.textContent = "正在授权…";
  setOutputSettingsError("");
  try {
    if (isOutputDirectoryHandle(draft.directoryHandle)) {
      const permission = await requestOutputDirectoryPermission(draft.directoryHandle);
      if (permission === "granted") {
        renderOutputDirectoryStatus(draft, permission);
        return;
      }
    }
    if (!canUseOutputDirectoryPicker()) throw new Error("当前浏览器不支持选择输出目录");
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    if (!isOutputDirectoryHandle(handle)) throw new Error("未获得有效的输出目录授权");
    draft.directoryHandle = handle;
    draft.directoryName = String(handle.name || "已选择目录").trim();
    draft.autoSaveEnabled = true;
    renderOutputDirectoryStatus(draft, "checking");
    await refreshOutputDirectoryStatus(draft);
  } catch (error) {
    if (error?.name !== "AbortError") setOutputSettingsError(error.message || "输出目录选择失败，请重试");
  } finally {
    button.disabled = false;
    renderOutputDirectoryStatus(draft, isOutputDirectoryHandle(draft.directoryHandle) ? await getOutputDirectoryPermission(draft.directoryHandle) : "");
  }
}

async function saveOutputSettingsDraft() {
  const draft = normalizeOutputSettings(outputSettingsDraft || state.outputSettings);
  setOutputSettingsError("");
  if (draft.autoSaveEnabled && !isOutputDirectoryHandle(draft.directoryHandle)) {
    setOutputSettingsError("启用自动保存前，请先选择输出目录。");
    $("chooseOutputDirectoryBtn").focus();
    return;
  }
  if (draft.autoSaveEnabled) {
    const permission = await getOutputDirectoryPermission(draft.directoryHandle);
    if (permission !== "granted") {
      setOutputSettingsError("输出目录尚未授权，请先点击“选择目录”完成授权。");
      await refreshOutputDirectoryStatus(draft);
      $("chooseOutputDirectoryBtn").focus();
      return;
    }
  }
  const button = $("saveOutputSettingsBtn");
  button.disabled = true;
  button.textContent = "保存中…";
  try {
    await saveOutputSettings(draft);
    state.outputSettings = draft;
    outputSettingsDraft = null;
    outputSettingsDialog.close();
    showToast(state.outputSettings.autoSaveEnabled ? `已启用自动保存 · ${state.outputSettings.directoryName}` : "输出设置已保存");
  } catch (error) {
    setOutputSettingsError(error.message || "输出设置保存失败，请检查浏览器存储权限");
  } finally {
    button.disabled = false;
    button.textContent = "保存设置";
  }
}

function clearApiBaseUrlError(kind) {
  $(`${kind}BaseUrlInput`).removeAttribute("aria-invalid");
  $(`${kind}BaseUrlError`).classList.add("hidden");
}

function clearApiBaseUrlErrors() {
  clearApiBaseUrlError("text");
  clearApiBaseUrlError("image");
}

function showApiBaseUrlError(kind, focus = true) {
  $(`${kind}BaseUrlInput`).setAttribute("aria-invalid", "true");
  $(`${kind}BaseUrlError`).classList.remove("hidden");
  if (focus) $(`${kind}BaseUrlInput`).focus();
}

async function saveBrowserApiSettings() {
  const nextSettings = readApiSettingsForm();
  clearApiBaseUrlErrors();
  let invalid = false;
  if (nextSettings.textApiKey && !nextSettings.textBaseUrl) {
    showApiBaseUrlError("text");
    invalid = true;
  }
  if (nextSettings.imageApiKey && !nextSettings.imageBaseUrl) {
    showApiBaseUrlError("image", !invalid);
    invalid = true;
  }
  if (invalid) {
    showToast("请补充对应服务的 API 地址");
    return;
  }
  state.apiSettings = nextSettings;
  await saveApiSettings(state.apiSettings);
  apiSettingsDialog.close();
  await checkImageService();
  showToast("浏览器 API 配置已保存");
}

function openClearApiSettingsDialog() {
  apiSettingsDialog.close();
  showDialogAtTop(clearApiSettingsDialog);
  $("cancelClearApiSettingsBtn").focus();
}

function cancelClearApiSettings() {
  clearApiSettingsDialog.close();
  showDialogAtTop(apiSettingsDialog);
  $("clearApiSettingsBtn").focus();
}

async function clearBrowserApiSettings() {
  clearApiSettingsDialog.close();
  await clearApiSettings();
  state.apiSettings = null;
  fillApiSettingsForm({});
  apiSettingsDialog.close();
  await checkImageService();
  showToast("浏览器 API 配置已清除");
}

async function reset() {
  const removedEntries = [...state.generationEntries];
  referenceImageLoadToken += 1;
  isProcessingReferenceImage = false;
  $("sourcePrompt").value = "";
  $("referenceImage").value = "";
  state.referenceImage = null;
  state.referenceImageData = "";
  state.referenceImageSource = "";
  state.referenceUsage = "analyze";
  state.contentMode = "concept";
  renderContentModes();
  state.blueprint = null;
  state.directionCompletionError = "";
  clearRefinementLineage();
  state.selectedVariantIds.clear();
  syncSetupLockState();
  state.generationEntries = [];
  openGenerationBatchIds.clear();
  saveOpenGenerationBatchIds();
  resetResultFilters();
  state.batchNumber = 0;
  $("filePreview").classList.add("hidden");
  $("dropzone").classList.remove("hidden");
  syncReferenceUsageUI();
  renderBlueprintEmpty();
  renderPromptCards();
  renderGenerationFeed();
  try {
    await clearGenerationHistory();
    removedEntries.forEach((entry) => queueGeneratedImageCleanup(entry, 0));
    $("feedHint").textContent = "提交记录会持续保留";
  } catch {
    closeResetDialog();
    showToast("工作台已重置，但浏览器历史清理失败");
    return;
  }
  $("generateBtnLabel").textContent = "生成视觉方向";
  $("generateHint").textContent = "输入提示词或上传参考图后，生成可比较的方向方案。";
  goToStage("setupStage", { resetScroll: true });
  closeResetDialog();
  showToast("已重置工作台");
}

taskTypeSelect.addEventListener("change", () => {
  clearRefinementLineage();
  renderDimensions();
  renderOptionCounts();
  syncDefaultImageRatio();
  resetGeneratedDirectionsForSetupChange();
});
dimensionList.addEventListener("change", () => {
  renderOptionCounts();
  resetGeneratedDirectionsForSetupChange();
});
imageRatioSelect.addEventListener("change", () => { imageRatioOverridden = true; resetGeneratedDirectionsForSetupChange(); });
$("contentModeOptions").addEventListener("change", (event) => {
  if (isSetupLocked()) return;
  state.contentMode = event.target.value === "factual" ? "factual" : "concept";
  clearRefinementLineage();
  renderBlueprintPreview();
});
$("sourcePrompt").addEventListener("input", () => {
  const inheritedPrompt = state.refinementBase?.source?.prompt;
  if (inheritedPrompt && $("sourcePrompt").value.trim() !== inheritedPrompt) {
    clearRefinementLineage();
  }
  renderBlueprintPreview();
});
$("optionCount").addEventListener("change", resetGeneratedDirectionsForSetupChange);
$("imageResolution").addEventListener("change", resetGeneratedDirectionsForSetupChange);
document.querySelectorAll('input[name="referenceUsage"]').forEach((control) => {
  control.addEventListener("change", (event) => {
    if (isSetupLocked()) return;
    state.referenceUsage = event.target.value === "explore" ? "explore" : "analyze";
    syncReferenceUsageUI();
    resetGeneratedDirectionsForSetupChange();
  });
});
$("generateBtn").addEventListener("click", generateDirections);
$("editSetupBtn").addEventListener("click", openEditSetupDialog);
$("cancelEditSetupBtn").addEventListener("click", closeEditSetupDialog);
$("confirmEditSetupBtn").addEventListener("click", confirmEditSetup);
$("submitSelectedBtn").addEventListener("click", submitSelected);
$("selectAllBtn").addEventListener("click", selectAllPrompts);
$("completeDirectionsBtn").addEventListener("click", completeMissingDirections);
$("resetBtn").addEventListener("click", openResetDialog);
$("outputSettingsBtn").addEventListener("click", openOutputSettings);
$("apiSettingsBtn").addEventListener("click", () => {
  fillApiSettingsForm(state.apiSettings || {});
  clearApiBaseUrlErrors();
  setApiTestStatus("text", "neutral", "未测试");
  setApiTestStatus("image", "neutral", "未测试");
  renderLastImageDiagnostic();
  showDialogAtTop(apiSettingsDialog);
  $("textBaseUrlInput").focus();
});
$("textBaseUrlInput").addEventListener("input", () => clearApiBaseUrlError("text"));
$("imageBaseUrlInput").addEventListener("input", () => clearApiBaseUrlError("image"));
document.querySelectorAll("[data-api-key-input]").forEach((button) => {
  button.addEventListener("click", () => setApiKeyVisibility(button, button.getAttribute("aria-pressed") !== "true"));
});
$("saveApiSettingsBtn").addEventListener("click", saveBrowserApiSettings);
$("testApiConnectionBtn").addEventListener("click", testApiConnections);
[["text", ["textBaseUrlInput", "textApiKeyInput", "textModelInput"]], ["image", ["imageBaseUrlInput", "imageApiKeyInput", "imageModelInput"]]].forEach(([kind, ids]) => {
  ids.forEach((id) => $(id).addEventListener("input", () => resetApiTestStatus(kind)));
});
$("clearApiSettingsBtn").addEventListener("click", openClearApiSettingsDialog);
$("cancelClearApiSettingsBtn").addEventListener("click", cancelClearApiSettings);
$("confirmClearApiSettingsBtn").addEventListener("click", clearBrowserApiSettings);
$("cancelOutputSettingsBtn").addEventListener("click", closeOutputSettings);
$("chooseOutputDirectoryBtn").addEventListener("click", chooseOutputDirectory);
$("saveOutputSettingsBtn").addEventListener("click", saveOutputSettingsDraft);
$("outputAutoSaveInput").addEventListener("change", (event) => {
  if (!outputSettingsDraft) return;
  outputSettingsDraft.autoSaveEnabled = event.target.checked;
  setOutputSettingsError("");
  void refreshOutputDirectoryStatus(outputSettingsDraft);
});
outputSettingsDialog.addEventListener("close", () => { outputSettingsDraft = null; });
$("historyManageBtn").addEventListener("click", openHistoryDialog);
$("historyKeepCount").addEventListener("change", (event) => syncHistoryCleanupState(Number(event.target.value)));
$("cleanupHistoryBtn").addEventListener("click", cleanupOldHistory);
$("cancelHistoryBtn").addEventListener("click", () => historyDialog.close());
$("cancelBatchSubmissionBtn").addEventListener("click", closeBatchSubmission);
$("reuseBatchSubmissionBtn").addEventListener("click", reuseBatchSubmission);
batchSubmissionDialog.addEventListener("close", resetBatchSubmissionDialogState);
$("cancelRetryGenerationBtn").addEventListener("click", closeRetryGenerationDialog);
$("confirmRetryGenerationBtn").addEventListener("click", confirmRetryGeneration);
$("cancelImageRecoveryBtn").addEventListener("click", () => closeImageRecoveryOptions());
$("recoverImageFromFileBtn").addEventListener("click", recoverImageFromLocalBackup);
$("regenerateFromRecoveryBtn").addEventListener("click", regenerateFromImageRecovery);
document.querySelectorAll("[data-dialog-close]").forEach((button) => {
  button.addEventListener("click", () => {
    const dialog = button.closest("dialog");
    if (dialog === retryGenerationDialog) closeRetryGenerationDialog();
    else if (dialog === imageRecoveryOptionsDialog) closeImageRecoveryOptions();
    else if (dialog === clearApiSettingsDialog) cancelClearApiSettings();
    else if (dialog === outputSettingsDialog) closeOutputSettings();
    else if (dialog === editSetupDialog) closeEditSetupDialog();
    else if (dialog === batchSubmissionDialog) closeBatchSubmission();
    else dialog?.close();
  });
});
$("comparisonGrid").addEventListener("click", (event) => {
  const button = event.target.closest('[data-action="open-comparison-image"]');
  const item = event.target.closest("[data-comparison-id]");
  if (!button || !item) return;
  const entry = state.generationEntries.find((candidate) => candidate.id === item.dataset.comparisonId);
  if (!entry) return;
  closeBatchComparison();
  openImagePreview(entry);
});
$("cancelResetBtn").addEventListener("click", closeResetDialog);
$("confirmResetBtn").addEventListener("click", reset);
$("referenceImage").addEventListener("change", (event) => handleFile(event.target.files?.[0]));
$("imageRecoveryFileInput").addEventListener("change", (event) => handleGeneratedImageRecoveryFile(event.target.files?.[0]));
$("removeFileBtn").addEventListener("click", removeReferenceImage);
blueprintToggle.addEventListener("click", () => setBlueprintCollapsed(blueprintToggle.getAttribute("aria-expanded") === "true"));
$("dropzone").addEventListener("dragover", (event) => { event.preventDefault(); if (!isSetupLocked()) $("dropzone").classList.add("is-dragging"); });
$("dropzone").addEventListener("dragleave", () => $("dropzone").classList.remove("is-dragging"));
$("dropzone").addEventListener("drop", (event) => { event.preventDefault(); $("dropzone").classList.remove("is-dragging"); if (!isSetupLocked()) handleFile(event.dataTransfer.files?.[0]); });
document.addEventListener("paste", handlePaste);
promptList.addEventListener("change", handlePromptAction);
promptList.addEventListener("click", handlePromptAction);
generationFeed.addEventListener("click", handleGenerationAction);
generationFeed.addEventListener("keydown", (event) => {
  const recovery = event.target.closest("[data-action='recover-image']");
  if (!recovery || !["Enter", " "].includes(event.key)) return;
  event.preventDefault();
  recovery.click();
});
generationFeed.addEventListener("toggle", (event) => {
  const batch = event.target.closest(".generation-batch");
  if (!batch || event.target !== batch || !batch.isConnected) return;
  if (batch.open) openGenerationBatchIds.add(batch.dataset.batchId);
  else openGenerationBatchIds.delete(batch.dataset.batchId);
  saveOpenGenerationBatchIds();
  if (batch.open) scheduleTextTooltipOverflowSync();
}, true);
generationFeed.addEventListener("load", (event) => {
  if (event.target instanceof HTMLImageElement) recordGeneratedImageDimensions(event.target);
}, true);
generationFeed.addEventListener("error", (event) => {
  if (!(event.target instanceof HTMLImageElement)) return;
  const frame = event.target.closest(".generation-image-frame");
  const card = event.target.closest("[data-generation-id]");
  if (!frame || !card) return;
  frame.classList.add("is-image-error");
  if (card.querySelector("[data-action='recover-image'], [data-action='open-image-recovery']")) return;
  const entry = state.generationEntries.find((item) => item.id === card.dataset.generationId);
  if (!entry) return;
  const recovery = frame.querySelector(".generation-image-recovery");
  const useRecoveryOptions = entry.imageCacheErrorCode === "remote_unavailable";
  recovery?.insertAdjacentHTML("beforeend", `<button class="button button-quiet" type="button" data-action="${useRecoveryOptions ? "open-image-recovery" : "recover-image"}">${useRecoveryOptions ? "恢复选项" : "下载恢复"}</button>`);
}, true);
$("resultSearchInput").addEventListener("input", (event) => { state.resultFilters.query = event.target.value; renderGenerationFeed(); });
$("resultStatusFilter").addEventListener("change", (event) => { state.resultFilters.status = event.target.value; renderGenerationFeed(); });
$("resultBatchFilter").addEventListener("change", (event) => { state.resultFilters.batchId = event.target.value; renderGenerationFeed(); });
$("generationOverview").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-overview-status]");
  if (!button) return;
  state.resultFilters.status = state.resultFilters.status === button.dataset.overviewStatus ? "all" : button.dataset.overviewStatus;
  $("resultStatusFilter").value = state.resultFilters.status;
  renderGenerationFeed();
});
$("clearResultFiltersBtn").addEventListener("click", clearResultFilters);
document.querySelector(".stage-nav").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-stage-target]");
  if (!button) return;
  goToStage(button.dataset.stageTarget);
});
window.addEventListener("scroll", () => window.requestAnimationFrame(updateActiveStageFromScroll), { passive: true });
window.addEventListener("resize", scheduleTextTooltipOverflowSync, { passive: true });
window.matchMedia("(max-width: 600px)").addEventListener("change", () => {
  updateActiveStageFromScroll();
  syncBlueprintDisclosure();
});

renderTaskTypes();
renderContentModes();
renderDimensions();
renderOptionCounts();
syncDefaultImageRatio();
syncReferenceUsageUI();
setActiveStage("setupStage");
renderPromptCards();
renderGenerationFeed();
renderLastImageDiagnostic();
Promise.all([loadSavedApiSettings(), loadSavedOutputSettings()]).then(async () => {
  checkImageService();
  registerGeneratedImageServiceWorker()?.catch(() => {});
  await restoreGenerationHistory();
  if (!applyLocalPromptPreview()) resumePendingGenerationTasks();
});
updateActiveStageFromScroll();
setBlueprintCollapsed(window.matchMedia("(max-width: 600px)").matches);
window.setInterval(updateGenerationElapsed, 1000);
window.addEventListener("storage", (event) => {
  if (event.key === GLOBAL_RATE_LIMIT_KEY) pumpGenerationQueue();
});
