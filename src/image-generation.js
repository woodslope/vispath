const IMAGE_SIZE_BY_RATIO = Object.freeze({
  "1:1": "1024x1024",
  "16:9": "1792x1024",
  "9:16": "1024x1792",
  "4:3": "1024x768",
  "3:4": "768x1024",
  "3:2": "1536x1024",
  "2:3": "1024x1536",
  "21:9": "1344x576"
});

function getImageSizeForRatio(ratio) {
  return IMAGE_SIZE_BY_RATIO[ratio] || IMAGE_SIZE_BY_RATIO["1:1"];
}

export function createImageRequest({ model, prompt, ratio, generationMode = "async", responseFormat = "b64_json" }) {
  const request = {
    model,
    prompt,
    n: 1,
    size: getImageSizeForRatio(ratio),
    aspect_ratio: ratio || "1:1",
    response_format: responseFormat === "url" ? "url" : "b64_json",
    output_format: "png"
  };
  if (generationMode === "sync") {
    request.quality = "standard";
  }
  return request;
}

export function getImageEndpointPath({ generationMode = "async", referenceUsage = "analyze" } = {}) {
  const resource = referenceUsage === "explore" ? "edits" : "generations";
  return `/images/${resource}${generationMode === "async" ? "/async" : ""}`;
}

export function createImageEditRequest({ image, imageName = "reference.png", ...options }) {
  if (!(image instanceof Blob) || image.size === 0) throw new Error("参与生图探索需要有效的参考图");
  const request = createImageRequest(options);
  const formData = new FormData();
  for (const [key, value] of Object.entries(request)) formData.append(key, String(value));
  formData.append("image", image, String(imageName || "reference.png"));
  return formData;
}
