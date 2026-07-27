import assert from "node:assert/strict";
import {
  createOutputImageFileName,
  getOutputDirectoryPermission,
  requestOutputDirectoryPermission,
  writeBlobToOutputDirectory
} from "../src/output-storage.js";

function expectOutputError(action, code) {
  return action().then(
    () => { throw new Error(`应抛出 ${code} 错误`); },
    (error) => {
      assert.equal(error.outputErrorCode, code);
      return error;
    }
  );
}

const fileName = createOutputImageFileName({
  id: "entry:abc/123",
  batchNumber: "3",
  batchCreatedAt: "2026-07-23T12:34:56.000Z",
  variantTitle: "夏日 / 开业海报"
}, "image/jpeg");
assert.equal(fileName, "VisPath_20260723_B03_夏日-开业海报_abc123.jpg");

const written = [];
const writable = {
  async write(value) { written.push(value); },
  async close() { this.closed = true; },
  async abort() { this.aborted = true; }
};
const directoryHandle = {
  name: "VisPath 输出",
  async queryPermission() { return "granted"; },
  async requestPermission() { return "granted"; },
  async getFileHandle(name, options) {
    assert.equal(options.create, true);
    this.fileName = name;
    return { async createWritable() { return writable; } };
  }
};
const blob = new Blob(["image-bytes"], { type: "image/jpeg" });
const writeResult = await writeBlobToOutputDirectory(directoryHandle, fileName, blob);
assert.deepEqual(writeResult, { fileName, byteSize: blob.size });
assert.equal(directoryHandle.fileName, fileName);
assert.equal(written.length, 1);
assert.equal(await written[0].text(), "image-bytes");
assert.equal(writable.closed, true);
assert.equal(writable.aborted, undefined);
assert.equal(await getOutputDirectoryPermission(directoryHandle), "granted");
assert.equal(await requestOutputDirectoryPermission(directoryHandle), "granted");

const deniedDirectory = {
  async queryPermission() { return "denied"; },
  async getFileHandle() { throw new Error("不应在未授权时创建文件"); }
};
await expectOutputError(
  () => writeBlobToOutputDirectory(deniedDirectory, "blocked.png", new Blob(["x"], { type: "image/png" })),
  "permission_required"
);

let aborted = false;
const failingDirectory = {
  async queryPermission() { return "granted"; },
  async getFileHandle() {
    return {
      async createWritable() {
        return {
          async write() { throw new Error("磁盘写入失败"); },
          async close() { throw new Error("不应关闭失败的流"); },
          async abort() { aborted = true; }
        };
      }
    };
  }
};
const writeError = await expectOutputError(
  () => writeBlobToOutputDirectory(failingDirectory, "failed.png", new Blob(["x"], { type: "image/png" })),
  "write_failed"
);
assert.match(writeError.message, /磁盘写入失败/);
assert.equal(aborted, true);

console.log("output settings test passed");
