import { createServer } from "node:net";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function getFreePort() {
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      await fetch(url);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("测试服务启动超时");
}

const port = await getFreePort();
const root = fileURLToPath(new URL("../", import.meta.url));
const generatedDir = join(root, "generated");
const filename = `delete-test-${Date.now()}.png`;
const filePath = join(generatedDir, filename);
const server = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"]
});

try {
  await mkdir(generatedDir, { recursive: true });
  await writeFile(filePath, Buffer.from("delete-test"));
  await waitForServer(`http://127.0.0.1:${port}/api/status`);

  const deleted = await fetch(`http://127.0.0.1:${port}/api/images/file`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: `/generated/${filename}` })
  });
  assert(deleted.status === 204, `合法图片删除应返回 204，实际为 ${deleted.status}`);
  await assert(access(filePath).then(() => false, () => true), "合法图片文件仍然存在");

  const repeated = await fetch(`http://127.0.0.1:${port}/api/images/file`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: `/generated/${filename}` })
  });
  assert(repeated.status === 204, `重复删除应保持幂等，实际为 ${repeated.status}`);

  const rejected = await fetch(`http://127.0.0.1:${port}/api/images/file`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrl: "/generated/../server.mjs" })
  });
  assert(rejected.status === 400, `越界路径应返回 400，实际为 ${rejected.status}`);
  console.log("generated image delete test passed");
} finally {
  server.kill("SIGTERM");
  await unlink(filePath).catch(() => {});
}
