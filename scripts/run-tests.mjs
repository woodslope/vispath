import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
let appServer;

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...options.env },
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${args.at(-1)} 执行失败（${signal || `退出码 ${code}`}）`));
    });
  });
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (appServer?.exitCode !== null) throw new Error("测试服务器提前退出");
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`测试服务器启动超时：${url}`);
}

function stopServer() {
  if (appServer && appServer.exitCode === null) appServer.kill("SIGTERM");
}

process.once("SIGINT", () => {
  stopServer();
  process.exitCode = 130;
});
process.once("SIGTERM", () => {
  stopServer();
  process.exitCode = 143;
});

try {
  console.log("\n[1/3] 构建浏览器展示包");
  await run(process.execPath, ["scripts/build-browser-bundle.mjs"]);

  const port = await findAvailablePort();
  const appUrl = `http://127.0.0.1:${port}/`;
  console.log(`\n[2/3] 启动临时测试服务器：${appUrl}`);
  appServer = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AI_API_KEY: "",
      MONOND_API_KEY: "",
      TEXT_API_KEY: "",
      IMAGE_API_KEY: ""
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  appServer.stdout.on("data", (chunk) => process.stdout.write(`[server] ${chunk}`));
  appServer.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  await waitForServer(appUrl);

  const tests = (await readdir(new URL("../tests/", import.meta.url)))
    .filter((name) => name.endsWith(".mjs"))
    .sort();
  console.log(`\n[3/3] 运行 ${tests.length} 项回归测试`);
  for (const [index, test] of tests.entries()) {
    console.log(`\n[${index + 1}/${tests.length}] ${test}`);
    await run(process.execPath, [`tests/${test}`], { env: { APP_URL: appUrl } });
  }
  console.log(`\n全部 ${tests.length} 项测试通过。`);
} finally {
  stopServer();
}
