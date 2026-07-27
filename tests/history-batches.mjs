import { sanitizeGenerationHistory } from "../src/history-store.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const migrated = sanitizeGenerationHistory({
  schemaVersion: 2,
  batchNumber: 2,
  savedAt: "2026-07-12T16:56:00.000Z",
  entries: [
    { id: "one", batchNumber: "02", createdAt: "00:56", status: "ready", imageUrl: "https://example.com/one.png", promptSnapshot: "one" },
    { id: "two", batchNumber: "02", createdAt: "00:56", status: "loading", taskId: "task_resume", promptSnapshot: "two" }
  ]
});

assert(migrated.schemaVersion === 17, "历史结构未升级到 v17");
assert(migrated.entries.every((entry) => entry.favorite === false), "旧历史未补齐默认收藏状态");
assert(migrated.migrated, "旧历史未标记为需要迁移");
assert(migrated.entries.every((entry) => entry.batchId === "legacy_batch_02"), "同一旧批次未获得相同批次标识");
assert(migrated.entries[0].imageUrl === "https://example.com/one.png", "迁移丢失历史图片");
assert(migrated.entries[0].actualResponseFormat === "url", "旧 URL 历史未推导实际返回格式");
assert(migrated.entries[1].status === "loading", "迁移改变生成状态");
assert(migrated.entries[1].taskId === "task_resume", "迁移丢失异步任务 ID");
assert(migrated.entries[1].promptSnapshot === "two", "迁移丢失提示词快照");
assert(migrated.entries.every((entry) => entry.referenceUsage === "analyze"), "旧历史未默认迁移为仅分析提示词");
assert(migrated.entries.every((entry) => entry.referenceImageCacheKey === ""), "旧历史不应产生不存在的参考图缓存键");

const exploreHistory = sanitizeGenerationHistory({
  schemaVersion: 15,
  batchNumber: 3,
  savedAt: "2026-07-18T00:00:00.000Z",
  entries: [{
    id: "explore",
    batchId: "batch_explore",
    batchNumber: "03",
    status: "error",
    referenceUsage: "explore",
    referenceImageCacheKey: "reference-image-cache:batch_explore",
    blueprintSnapshot: {
      schemaVersion: 1,
      source: { prompt: "原始简单输入", referenceUsage: "explore", contentMode: "concept" },
      dimensions: { visual_style: "极简编辑感" },
      acceptedPrompt: "完整首轮提示词"
    }
  }]
});
assert(exploreHistory.entries[0].referenceUsage === "explore", "参与生图探索模式未被历史记录保留");
assert(exploreHistory.entries[0].referenceImageCacheKey === "reference-image-cache:batch_explore", "参考图缓存键未被历史记录保留");
assert(exploreHistory.entries[0].blueprintSnapshot.source.prompt === "原始简单输入", "历史记录未保留结构化蓝图的原始输入");
assert(exploreHistory.entries[0].blueprintSnapshot.source.contentMode === "concept", "历史记录未保留内容模式");
assert(exploreHistory.entries[0].blueprintSnapshot.acceptedPrompt === "完整首轮提示词", "历史记录未保留已确认的丰富提示词");

const submissionHistory = sanitizeGenerationHistory({
  schemaVersion: 15,
  batchNumber: 4,
  entries: [{
    id: "submission",
    batchId: "batch_submission",
    batchNumber: "04",
    status: "ready",
    referenceUsage: "analyze",
    referenceImageCacheKey: "reference-image-cache:batch_submission",
    submissionSnapshot: {
      sourcePrompt: "咖啡店夏日海报",
      contentMode: "factual",
      taskTypeId: "poster",
      taskTypeName: "海报",
      requestedOptionCount: 3,
      ratio: "3:4",
      resolution: "1K",
      generationMode: "sync",
      referenceUsage: "analyze",
      referenceSource: "user-upload",
      hasReferenceImage: true,
      explorationDimensionId: "visual_style",
      explorationDimensionName: "设计风格"
    }
  }]
});
assert(submissionHistory.entries[0].submissionSnapshot.sourcePrompt === "咖啡店夏日海报", "提交快照未保留原始输入");
assert(submissionHistory.entries[0].submissionSnapshot.hasReferenceImage, "提交快照未保留参考图存在状态");
assert(submissionHistory.entries[0].referenceImageCacheKey === "reference-image-cache:batch_submission", "分析模式参考图缓存键不应被清除");

console.log("history batch migration test passed");
