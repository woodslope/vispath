import assert from "node:assert/strict";
import { sanitizeGenerationHistory } from "../src/history-store.js";

const startedAt = "2026-07-25T01:00:00.000Z";
const submittedAt = "2026-07-25T01:00:12.000Z";
const completedAt = "2026-07-25T01:01:02.000Z";
const baseEntry = {
  id: "generation_timing",
  batchId: "batch_timing",
  batchNumber: "01",
  startedAt,
  completedAt,
  status: "ready",
  generationMode: "async"
};

const migrated = sanitizeGenerationHistory({ schemaVersion: 16, batchNumber: 1, entries: [baseEntry] });
assert.equal(migrated.schemaVersion, 17, "历史结构应升级到 v17");
assert.equal(migrated.entries[0].queuedAt, startedAt, "旧记录应使用 startedAt 回填总耗时起点");
assert.equal(migrated.entries[0].submittedAt, "", "旧记录不应伪造服务端提交时间");

const current = sanitizeGenerationHistory({
  schemaVersion: 17,
  batchNumber: 1,
  entries: [{ ...baseEntry, queuedAt: startedAt, submittedAt }]
});
assert.equal(current.entries[0].queuedAt, startedAt, "排队起点应持久化");
assert.equal(current.entries[0].submittedAt, submittedAt, "服务端提交时间应持久化");
assert.equal(current.entries[0].completedAt, completedAt, "完成时间应持久化");

console.log("generation timing test passed");
