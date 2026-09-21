import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync } from "node:fs";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
try {
  process.loadEnvFile(path.join(root, ".env"));
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}

const dataDirectory = path.resolve(process.env.KSTOCK_DATA_DIR ?? path.join(root, "data"));
const logDirectory = path.join(dataDirectory, "logs");
const stateFile = path.join(dataDirectory, ".desktop-processes.json");
const instanceFile = path.join(dataDirectory, ".installation-id");
const lockFile = path.join(dataDirectory, ".desktop-launch.lock");
const upgradeRequestFile = path.join(dataDirectory, ".desktop-upgrade-request");
const buildManifestFile = path.join(root, ".kstock-build.json");
const webHost = process.env.WEB_HOST ?? "127.0.0.1";
const webPort = process.env.WEB_PORT ?? "3100";
const engineHost = process.env.ENGINE_HOST ?? "127.0.0.1";
const enginePort = process.env.ENGINE_PORT ?? "3210";
const webUrl = `http://${webHost === "0.0.0.0" ? "127.0.0.1" : webHost}:${webPort}`;
const engineUrl = `http://${engineHost === "0.0.0.0" ? "127.0.0.1" : engineHost}:${enginePort}`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const execFileAsync = promisify(execFile);

function assertNodeVersion() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (!Number.isSafeInteger(major) || major < 22) {
    throw new Error(`Node.js 22 이상이 필요합니다. 현재 버전: ${process.versions.node}`);
  }
}

function isProcessRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function webInstanceMatches(instanceId) {
  if (typeof instanceId !== "string" || instanceId.length === 0) return false;
  try {
    const response = await fetch(`${webUrl}/health`, {
      signal: AbortSignal.timeout(1_500),
      cache: "no-store",
    });
    if (!response.ok) return false;
    const payload = await response.json();
    return payload?.service === "kstock-web" && payload?.instanceId === instanceId;
  } catch {
    return false;
  }
}

async function processLooksOwned(pid, service, instanceId) {
  if (!isProcessRunning(pid)) return false;
  try {
    const { stdout } = process.platform === "win32"
      ? await execFileAsync("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\").CommandLine`,
        ], { timeout: 2_000 })
      : await execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "command="], { timeout: 2_000 });
    const command = String(stdout).replaceAll("\\", "/").toLowerCase();
    const normalizedRoot = root.replaceAll("\\", "/").toLowerCase();
    if (service === "engine") return command.includes("trading-engine/dist/index.js");
    if (service === "web") {
      const isManagedWrapper =
        command.includes("web/scripts/next-run.mjs") && command.includes(normalizedRoot);
      const isDirectNextCommand =
        command.includes("next/dist/bin/next") &&
        command.includes(`--port ${webPort}`) &&
        command.includes(normalizedRoot);
      // Next.js replaces its process title with `next-server` after startup,
      // so the original command line is no longer available to `ps`. Confirm
      // the installation id through the local health endpoint before treating
      // that renamed process as ours.
      const isRenamedNextServer = command.includes("next-server");
      if (isManagedWrapper || isDirectNextCommand) return true;
      if (!isRenamedNextServer) return false;
      return instanceId !== undefined && await webInstanceMatches(instanceId);
    }
    return command.includes("scripts/desktop-launcher.mjs");
  } catch {
    return false;
  }
}

async function terminateOwnedProcess(pid, service, instanceId) {
  if (!await processLooksOwned(pid, service, instanceId)) return false;
  process.kill(pid, "SIGTERM");
  // Engine shutdown closes broker sockets and persists buffered market data
  // before releasing the database lease. Five seconds was too short during
  // market hours, so the launcher could SIGKILL a healthy shutdown and leave
  // the 30-second lease behind. Give it enough time to stop cleanly.
  const deadline = Date.now() + (service === "engine" ? 40_000 : 10_000);
  while (Date.now() < deadline && isProcessRunning(pid)) await delay(100);
  if (isProcessRunning(pid) && await processLooksOwned(pid, service, instanceId)) {
    process.kill(pid, "SIGKILL");
  }
  return true;
}

function localJsonRequest(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const headers = { ...options.headers, connection: "close" };
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: "GET", headers, agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > 2 * 1024 * 1024) {
          request.destroy(new Error("Local health response exceeded 2 MiB"));
          return;
        }
        chunks.push(chunk);
      });
      response.once("end", () => {
        try {
          const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, payload });
        } catch (error) {
          reject(error);
        }
      });
      response.once("error", reject);
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error(`Local request timed out after ${timeoutMs}ms`)));
    request.once("error", reject);
    request.end();
  });
}

async function readJson(filename, fallback = null) {
  try {
    return JSON.parse(await readFile(filename, "utf8"));
  } catch {
    return fallback;
  }
}

async function atomicWrite(filename, value, mode = 0o600) {
  await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode, flag: "wx" });
  await rename(temporary, filename);
}

async function readState() {
  return (await readJson(stateFile, {})) ?? {};
}

async function writeState(state) {
  await atomicWrite(stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

async function ensureInstallationId() {
  try {
    const current = (await readFile(instanceFile, "utf8")).trim();
    if (/^[0-9a-f-]{36}$/i.test(current)) return current;
    throw new Error("설치 식별자 파일이 손상되었습니다.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const created = randomUUID();
  try {
    await writeFile(instanceFile, `${created}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    return created;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const concurrent = (await readFile(instanceFile, "utf8")).trim();
    if (!/^[0-9a-f-]{36}$/i.test(concurrent)) throw new Error("설치 식별자 파일이 손상되었습니다.");
    return concurrent;
  }
}

const BUILD_INPUT_ROOTS = ["shared", "database", "strategies", "broker-adapters", "trading-engine", "web", "scripts"];
const BUILD_EXCLUDED_DIRECTORIES = new Set(["node_modules", "dist", ".next", "coverage", "test", "tests"]);
const BUILD_ROOT_FILES = ["package.json", "package-lock.json", "tsconfig.base.json"];

async function listBuildInputs(directory) {
  const rows = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== ".env.example") continue;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!BUILD_EXCLUDED_DIRECTORIES.has(entry.name)) rows.push(...await listBuildInputs(absolute));
    } else if (entry.isFile() && !entry.name.endsWith(".tsbuildinfo")) {
      rows.push(absolute);
    }
  }
  return rows;
}

async function buildFingerprint() {
  const files = BUILD_ROOT_FILES.map((name) => path.join(root, name));
  for (const name of BUILD_INPUT_ROOTS) files.push(...await listBuildInputs(path.join(root, name)));
  files.sort((left, right) => left.localeCompare(right));
  const hash = createHash("sha256");
  for (const filename of files) {
    hash.update(path.relative(root, filename));
    hash.update("\0");
    hash.update(await readFile(filename));
    hash.update("\0");
  }
  return hash.digest("hex");
}

async function markBuild() {
  const fingerprint = await buildFingerprint();
  await atomicWrite(buildManifestFile, `${JSON.stringify({ version: 1, fingerprint, builtAt: new Date().toISOString() }, null, 2)}\n`);
  // A manually completed production build must also wake an already-running
  // launcher. The launcher removes this marker after it has adopted the new
  // fingerprint, so normal launcher-owned builds follow the same path safely.
  await writeFile(upgradeRequestFile, `${fingerprint}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return fingerprint;
}

async function currentBuildFingerprint() {
  const manifest = await readJson(buildManifestFile);
  if (manifest?.version !== 1 || typeof manifest.fingerprint !== "string") return null;
  const fingerprint = await buildFingerprint();
  return fingerprint === manifest.fingerprint ? fingerprint : null;
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

async function runBuild(logFd) {
  const outputsExist = existsSync(path.join(root, "trading-engine", "dist", "index.js")) && existsSync(path.join(root, "web", ".next", "BUILD_ID"));
  const existingFingerprint = outputsExist ? await currentBuildFingerprint() : null;
  if (existingFingerprint) return { fingerprint: existingFingerprint, rebuilt: false };
  await new Promise((resolve, reject) => {
    const child = spawn(npmCommand(), ["run", "build"], {
      cwd: root,
      env: process.env,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`앱 빌드에 실패했습니다 (종료 코드 ${code ?? "unknown"})`)));
  });
  const fingerprint = await currentBuildFingerprint();
  if (!fingerprint) throw new Error("빌드 검증 정보가 생성되지 않았습니다.");
  return { fingerprint, rebuilt: true };
}

async function serviceHealth(url, expectedService, instanceId, fingerprint) {
  try {
    // Do not reuse pooled fetch sockets for watchdog probes. One half-closed
    // keep-alive connection previously caused every later probe to queue
    // behind it, making the launcher kill an otherwise responsive engine.
    const response = await localJsonRequest(url);
    if (!response.ok) return false;
    const payload = response.payload;
    return payload?.ok === true && payload?.service === expectedService && payload?.instanceId === instanceId && payload?.buildFingerprint === fingerprint;
  } catch {
    return false;
  }
}

async function adminToken() {
  const configured = process.env.KSTOCK_ADMIN_TOKEN?.trim();
  if (configured) return configured;
  try {
    return (await readFile(path.join(dataDirectory, ".admin-token"), "utf8")).trim();
  } catch {
    return null;
  }
}

async function engineHealthy(instanceId, fingerprint) {
  if (!await serviceHealth(`${engineUrl}/health`, "kstock-trading-engine", instanceId, fingerprint)) return false;
  const token = await adminToken();
  if (!token) return false;
  try {
    const response = await localJsonRequest(`${engineUrl}/api/settings`, {
      headers: { "x-kstock-admin-token": token },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function webHealthy(instanceId, fingerprint) {
  return serviceHealth(`${webUrl}/health`, "kstock-web", instanceId, fingerprint);
}

async function tryAcquireLock() {
  const nonce = randomUUID();
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = `${lockFile}.${process.pid}.${nonce}.candidate`;
    try {
      await writeFile(candidate, `${JSON.stringify({ pid: process.pid, nonce, startedAt: new Date().toISOString() })}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await link(candidate, lockFile);
      return nonce;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const owner = await readJson(lockFile, {});
      if (await processLooksOwned(owner?.pid, "launcher")) return null;
      await unlink(lockFile).catch(() => undefined);
    } finally {
      await unlink(candidate).catch(() => undefined);
    }
  }
  return null;
}

async function releaseLock(nonce) {
  const owner = await readJson(lockFile, {});
  if (owner?.pid !== process.pid || owner?.nonce !== nonce) return;
  await unlink(lockFile).catch(() => undefined);
}

function startDetached(command, args, cwd, logFd, extraEnvironment = {}) {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    env: { ...process.env, ...extraEnvironment },
    stdio: ["ignore", logFd, logFd],
    windowsHide: true,
  });
  if (!child.pid) throw new Error(`${command} 프로세스를 시작하지 못했습니다.`);
  child.once("error", () => undefined);
  child.unref();
  return child.pid;
}

function runtimeEnvironment(instanceId, fingerprint) {
  return { KSTOCK_DATA_DIR: dataDirectory, KSTOCK_INSTANCE_ID: instanceId, KSTOCK_BUILD_FINGERPRINT: fingerprint };
}

function startEngine(logFd, instanceId, fingerprint) {
  return startDetached(process.execPath, [path.join(root, "trading-engine", "dist", "index.js")], root, logFd, {
    ...runtimeEnvironment(instanceId, fingerprint), ENGINE_HOST: engineHost, ENGINE_PORT: enginePort,
  });
}

function startWeb(logFd, instanceId, fingerprint) {
  const wrapper = path.join(root, "web", "scripts", "next-run.mjs");
  return startDetached(process.execPath, [wrapper, "start"], path.join(root, "web"), logFd, {
    ...runtimeEnvironment(instanceId, fingerprint),
    ENGINE_URL: engineUrl,
    WEB_HOST: webHost,
    WEB_PORT: webPort,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  });
}

async function stopOwnedProcesses(state, instanceId) {
  if (state.instanceId !== instanceId) return;
  await Promise.all([
    terminateOwnedProcess(state.enginePid, "engine", instanceId),
    terminateOwnedProcess(state.webPid, "web", instanceId),
  ]);
}

async function showError(message) {
  const safeMessage = `${message}\n\n로그: ${path.join(logDirectory, "desktop.log")}`;
  if (process.platform === "darwin") {
    const script = `display alert "KStock Trader 실행 실패" message ${JSON.stringify(safeMessage)} as critical`;
    const child = spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" });
    child.once("error", () => undefined);
    child.unref();
  } else if (process.platform === "win32") {
    const escapedMessage = safeMessage.replaceAll("'", "''");
    const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show('${escapedMessage}', 'KStock Trader 실행 실패', 'OK', 'Error')`;
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", () => undefined);
    child.unref();
  }
}

function openBrowser() {
  let command;
  let args;
  if (process.platform === "darwin") {
    command = "open";
    args = [webUrl];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/d", "/s", "/c", "start", "", webUrl];
  } else {
    command = "xdg-open";
    args = [webUrl];
  }
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.once("error", () => undefined);
  child.unref();
}

function validateInstallation() {
  const engineEntry = path.join(root, "trading-engine", "dist", "index.js");
  const webBuild = path.join(root, "web", ".next", "BUILD_ID");
  if (!existsSync(engineEntry) || !existsSync(webBuild)) throw new Error("운영 빌드가 없습니다. 앱을 처음 열면 자동으로 빌드됩니다.");
  const requireFromWeb = createRequire(path.join(root, "web", "package.json"));
  requireFromWeb.resolve("next/dist/bin/next");
  return { root, engineEntry, webBuild, webUrl, engineUrl };
}

async function waitForExistingLauncher(instanceId) {
  const deadline = Date.now() + 300_000;
  let expectedFingerprint = await currentBuildFingerprint();
  let nextFingerprintCheck = Date.now();
  if (!expectedFingerprint) {
    await atomicWrite(upgradeRequestFile, `${JSON.stringify({ requestedAt: new Date().toISOString() })}\n`);
  }
  while (Date.now() < deadline) {
    if (Date.now() >= nextFingerprintCheck) {
      expectedFingerprint = await currentBuildFingerprint();
      nextFingerprintCheck = Date.now() + 2_000;
    }
    if (expectedFingerprint && await engineHealthy(instanceId, expectedFingerprint) && await webHealthy(instanceId, expectedFingerprint)) {
      openBrowser();
      return true;
    }
    const owner = await readJson(lockFile, {});
    if (!await processLooksOwned(owner?.pid, "launcher")) return false;
    await delay(500);
  }
  throw new Error("이미 실행 중인 앱이 준비 시간 안에 응답하지 않았습니다.");
}

function createControllers() {
  return {
    engine: { failures: 0, nextAttemptAt: 0, unhealthySince: 0, identityChecked: false, hasBeenReady: false },
    web: { failures: 0, nextAttemptAt: 0, unhealthySince: 0, identityChecked: false, hasBeenReady: false },
  };
}

async function maintainService(service, ready, state, controller, logFd, instanceId, fingerprint) {
  const pidKey = service === "engine" ? "enginePid" : "webPid";
  if (ready) {
    controller.failures = 0;
    controller.unhealthySince = 0;
    controller.identityChecked = false;
    controller.hasBeenReady = true;
    return false;
  }

  const now = Date.now();
  let changed = false;
  let pid = state[pidKey];
  if (isProcessRunning(pid)) {
    if (!controller.identityChecked) {
      controller.identityChecked = true;
      if (!await processLooksOwned(pid, service, instanceId)) {
        state[pidKey] = undefined;
        pid = undefined;
        changed = true;
      } else if (!controller.unhealthySince) {
        controller.unhealthySince = now;
      }
    }
    const unhealthyLimitMs = controller.hasBeenReady
      ? 30_000
      : service === "engine"
        ? 180_000
        : 60_000;
    if (
      isProcessRunning(pid) &&
      controller.unhealthySince > 0 &&
      now - controller.unhealthySince >= unhealthyLimitMs
    ) {
      await terminateOwnedProcess(pid, service, instanceId);
      state[pidKey] = undefined;
      pid = undefined;
      changed = true;
      controller.identityChecked = false;
      controller.unhealthySince = 0;
    }
  } else {
    if (state[pidKey] !== undefined) changed = true;
    state[pidKey] = undefined;
    controller.identityChecked = false;
  }

  if (!isProcessRunning(pid) && now >= controller.nextAttemptAt) {
    state[pidKey] = service === "engine"
      ? startEngine(logFd, instanceId, fingerprint)
      : startWeb(logFd, instanceId, fingerprint);
    controller.failures += 1;
    controller.nextAttemptAt = now + Math.min(60_000, 1_000 * 2 ** Math.min(controller.failures, 6));
    controller.unhealthySince = now;
    controller.identityChecked = true;
    state.restartedAt = new Date().toISOString();
    changed = true;
  }
  return changed;
}

async function maintainServices(state, controllers, logFd, instanceId, fingerprint) {
  const [engineReady, webReady] = await Promise.all([
    engineHealthy(instanceId, fingerprint),
    webHealthy(instanceId, fingerprint),
  ]);
  const [engineChanged, webChanged] = await Promise.all([
    maintainService("engine", engineReady, state, controllers.engine, logFd, instanceId, fingerprint),
    maintainService("web", webReady, state, controllers.web, logFd, instanceId, fingerprint),
  ]);
  if (engineChanged || webChanged) await writeState(state);
  return { engineReady, webReady };
}

async function ensureServicesReady(state, controllers, logFd, instanceId, fingerprint) {
  const deadline = Date.now() + 240_000;
  let readiness = { engineReady: false, webReady: false };
  while (Date.now() < deadline) {
    readiness = await maintainServices(state, controllers, logFd, instanceId, fingerprint);
    if (readiness.engineReady && readiness.webReady) return readiness;
    await delay(500);
  }
  return readiness;
}

async function supervise(state, logFd, instanceId, initialFingerprint, controllers) {
  let stopping = false;
  process.once("SIGINT", () => { stopping = true; });
  process.once("SIGTERM", () => { stopping = true; });
  let fingerprint = initialFingerprint;
  let nextSourceCheckAt = Date.now() + 60_000;
  while (!stopping) {
    await delay(5_000);
    const upgradeRequested = existsSync(upgradeRequestFile) || Date.now() >= nextSourceCheckAt;
    if (upgradeRequested) {
      const current = await currentBuildFingerprint();
      nextSourceCheckAt = Date.now() + 60_000;
      if (!current || current !== fingerprint) {
        await stopOwnedProcesses(state, instanceId);
        state.enginePid = undefined;
        state.webPid = undefined;
        const nextBuild = current
          ? { fingerprint: current, rebuilt: false }
          : await runBuild(logFd);
        fingerprint = nextBuild.fingerprint;
        state.buildFingerprint = fingerprint;
        state.updatedAt = new Date().toISOString();
        controllers = createControllers();
        await writeState(state);
      }
      await unlink(upgradeRequestFile).catch(() => undefined);
    }
    await maintainServices(state, controllers, logFd, instanceId, fingerprint);
  }
}

async function launch() {
  assertNodeVersion();
  await mkdir(logDirectory, { recursive: true, mode: 0o700 });
  const instanceId = await ensureInstallationId();
  let lockNonce = await tryAcquireLock();
  if (!lockNonce) {
    if (await waitForExistingLauncher(instanceId)) return;
    lockNonce = await tryAcquireLock();
    if (!lockNonce) throw new Error("앱 실행 잠금을 획득하지 못했습니다.");
  }
  const logFd = openSync(path.join(logDirectory, "desktop.log"), "a", 0o600);
  try {
    const build = await runBuild(logFd);
    await unlink(upgradeRequestFile).catch(() => undefined);
    validateInstallation();
    const previous = await readState();
    // A build can be produced manually before the launcher starts. In that
    // case runBuild() correctly reports rebuilt=false, but any detached
    // services recorded with the previous fingerprint still have to be
    // replaced or the browser keeps serving the old UI and engine bundle.
    if (previous.buildFingerprint !== build.fingerprint) {
      await stopOwnedProcesses(previous, instanceId);
    }
    const state = {
      enginePid: previous.instanceId === instanceId ? previous.enginePid : undefined,
      webPid: previous.instanceId === instanceId ? previous.webPid : undefined,
      buildFingerprint: build.fingerprint,
      instanceId,
      startedAt: new Date().toISOString(),
    };
    await writeState(state);
    const controllers = createControllers();
    const readiness = await ensureServicesReady(state, controllers, logFd, instanceId, build.fingerprint);
    if (!readiness.engineReady || !readiness.webReady) {
      throw new Error(`서비스 준비 시간 초과 (엔진: ${readiness.engineReady ? "정상" : "실패"}, 화면: ${readiness.webReady ? "정상" : "실패"}). 3100/3210 포트를 다른 프로그램이 쓰는지 확인하세요.`);
    }
    openBrowser();
    await supervise(state, logFd, instanceId, build.fingerprint, controllers);
  } finally {
    closeSync(logFd);
    await releaseLock(lockNonce);
  }
}

const command = process.argv[2];
let operation;
if (command === "--mark-build") {
  operation = markBuild().then((fingerprint) => process.stdout.write(`${fingerprint}\n`));
} else if (command === "--check") {
  operation = Promise.all([currentBuildFingerprint(), ensureInstallationId()]).then(([fingerprint, instanceId]) => {
    process.stdout.write(`${JSON.stringify({ ...validateInstallation(), instanceId, buildFingerprint: fingerprint }, null, 2)}\n`);
    if (!fingerprint) throw new Error("현재 소스와 일치하는 운영 빌드가 없습니다.");
  });
} else {
  operation = launch();
}

operation.catch(async (error) => {
  const message = error instanceof Error ? error.message : String(error);
  await showError(message);
  process.exitCode = 1;
});
