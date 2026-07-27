function createOutputError(message, code = "output_failed") {
  const error = new Error(message);
  error.outputErrorCode = code;
  return error;
}

export function canUseOutputDirectoryPicker() {
  return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function isOutputDirectoryHandle(handle) {
  return Boolean(handle && typeof handle.getFileHandle === "function");
}

export async function getOutputDirectoryPermission(handle) {
  if (!isOutputDirectoryHandle(handle)) return "denied";
  if (typeof handle.queryPermission !== "function") return "prompt";
  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function requestOutputDirectoryPermission(handle) {
  if (!isOutputDirectoryHandle(handle)) return "denied";
  if (typeof handle.requestPermission !== "function") return getOutputDirectoryPermission(handle);
  try {
    return await handle.requestPermission({ mode: "readwrite" });
  } catch {
    return "denied";
  }
}

export async function writeBlobToOutputDirectory(directoryHandle, fileName, blob) {
  if (!isOutputDirectoryHandle(directoryHandle)) throw createOutputError("输出目录尚未选择", "directory_missing");
  if (!(blob instanceof Blob) || blob.size === 0) throw createOutputError("图片内容为空，无法保存", "image_missing");
  const permission = await getOutputDirectoryPermission(directoryHandle);
  if (permission !== "granted") throw createOutputError("输出目录尚未授权，请在“输出设置”中重新选择目录", "permission_required");
  const fileHandle = await directoryHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  try {
    await writable.write(blob);
    await writable.close();
  } catch (cause) {
    try {
      await writable.abort?.();
    } catch {}
    throw createOutputError(cause?.message || "图片写入输出目录失败", "write_failed");
  }
  return { fileName, byteSize: blob.size };
}

export function getOutputImageExtension(mimeType = "") {
  const normalized = String(mimeType || "").toLowerCase();
  if (normalized === "image/jpeg" || normalized === "image/jpg") return "jpg";
  if (normalized === "image/webp") return "webp";
  if (normalized === "image/gif") return "gif";
  return "png";
}

function sanitizeFilePart(value, fallback) {
  const clean = String(value || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return clean || fallback;
}

export function createOutputImageFileName(entry, mimeType = "image/png") {
  const date = String(entry?.batchCreatedAt || "").slice(0, 10).replace(/-/g, "") || "undated";
  const batch = String(entry?.batchNumber || "00").padStart(2, "0");
  const title = sanitizeFilePart(entry?.variantTitle, "生成图片");
  const id = sanitizeFilePart(String(entry?.id || "image").replace(/[^a-z0-9_-]/gi, "").slice(-6), "image");
  return `VisPath_${date}_B${batch}_${title}_${id}.${getOutputImageExtension(mimeType)}`;
}
