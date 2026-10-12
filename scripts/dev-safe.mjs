import { accessSync, constants, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { REQUIRED_SERVICES, classifyStack, nextBankStateVersion, restorableBankState, sameRegistryGeneration, startAttempt, stopOwnedGroups, updateFailureWindows, verifyServiceProcessGroup } from "./dev-safe-core.mjs";

const execFileAsync = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stateDirectory = join(root, ".parlance");
const registryPath = join(stateDirectory, "dev-safe.json");
const restartRequested = process.argv.includes("--restart");
const preflightOnly = process.argv.includes("--preflight-only");
const launchedAt = Date.now();
const redactor = createRedactor(process.env);
let registry = readRegistry();
let shuttingDown = false;
let resolveLifetime;
const lifetime = new Promise((resolvePromise) => { resolveLifetime = resolvePromise; });

try {
  if (preflightOnly) {
    await verifySafeEnvironment();
    console.log("[dev:safe] Database isolation and complete mock-bank balance/holding continuity validated. Worker excluded.");
    process.exit(0);
  }
  const worker = await inspectPort({ name: "worker", port: 4003 });
  if (worker.occupied) throw new Error(`Worker port 4003 is occupied by PID ${worker.pid ?? "unknown"}; dev:safe never starts or stops the worker.`);
  let observations = await inspectRequiredPorts(registry);
  const classification = classifyStack(observations, registry);
  if ((classification.kind === "RUNNING_OWNED" || classification.kind === "RUNNING_UNMANAGED") && !restartRequested) {
    console.log("[dev:safe] A healthy Parlance development stack is already running. Frontend: http://127.0.0.1:3000/chat");
    process.exit(0);
  }
  if (classification.kind === "RUNNING_UNMANAGED" && restartRequested) throw new Error("A healthy Parlance stack is running, but no matching dev:safe ownership record exists. Refusing to terminate it; stop that terminal directly, then retry dev:restart.");
  if (classification.kind === "BLOCKED") {
    const detail = classification.blockers.map(({ name, port, pid }) => `${name} :${port} (PID ${pid ?? "unknown"})`).join(", ");
    throw new Error(`Required ports are occupied by processes that cannot be verified as dev:safe-owned: ${detail}. Stop them from their original terminal or inspect them with lsof.`);
  }

  const preflight = await verifySafeEnvironment();
  if (classification.kind === "RUNNING_OWNED" || classification.kind === "RECOVERABLE_PARTIAL") {
    console.log(`[dev:safe] ${restartRequested ? "Restarting" : "Recovering partial"} verified Parlance development processes...`);
    if (!await stopRegistryGroups(registry)) throw new Error("Verified Parlance processes did not stop after SIGINT and SIGTERM. Ownership record retained; no replacement stack was started.");
    removeRegistry();
    registry = undefined;
    observations = await inspectRequiredPorts(undefined);
    if (observations.some((item) => item.occupied)) throw new Error("A required port remained occupied after verified shutdown; refusing duplicate startup.");
  }

  const childEnvironment = {
    ...process.env,
    DATABASE_URL: preflight.testDatabaseUrl,
    DIRECT_URL: preflight.testDatabaseUrl,
    PARLANCE_LOCAL_TEST_MODE: "true",
    PARLANCE_MOCK_BANK_INITIAL_STATE_VERSION: String(preflight.initialStateVersion),
    PARLANCE_MOCK_BANK_INITIAL_BALANCES: JSON.stringify(preflight.bankState.balances),
    PARLANCE_MOCK_BANK_INITIAL_HOLDINGS: JSON.stringify(preflight.bankState.holdings),
  };
  const sanitize = createRedactor(childEnvironment);
  registry = { schemaVersion: 1, repoRoot: root, launcherPid: process.pid, createdAt: new Date(launchedAt).toISOString(), services: [] };
  const serviceDefinitions = buildServiceDefinitions();
  installSignalHandlers();
  console.log("[dev:safe] Safety checks passed; starting web, API, mock bank, and compiler. Worker excluded.");
  await startAttempt(serviceDefinitions, {
    spawnService: (service) => spawnService(service, childEnvironment, sanitize),
    writeRegistry: (records) => writeRegistry(records),
    waitUntilReady: (records) => waitUntilReady(records),
    stopCreated: async (records) => {
      const stopped = await stopRegistryGroups({ ...registry, services: records });
      if (stopped) removeRegistry();
      else throw new Error("Startup failed and one or more newly created process groups did not stop; ownership record retained.");
    },
  });
  console.log("[dev:safe] Parlance is ready. Frontend: http://127.0.0.1:3000/chat");
  void superviseServices();
  await lifetime;
} catch (error) {
  console.error(`[dev:safe] ${redactor(error instanceof Error ? error.message : String(error))}`);
  process.exitCode = 1;
}

function buildServiceDefinitions() {
  const compiler = join(root, "services/compiler/.venv/bin/uvicorn");
  try { accessSync(compiler, constants.X_OK); } catch { throw new Error("Compiler virtual environment is unavailable or not executable."); }
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  return [
    { name: "web", port: 3000, command: pnpm, args: ["--filter", "@parlance/web", "dev"], cwd: root },
    { name: "api", port: 4001, command: pnpm, args: ["--filter", "@parlance/api", "dev"], cwd: root },
    { name: "mock-bank", port: 4002, command: pnpm, args: ["--filter", "@parlance/mock-bank", "dev"], cwd: root },
    { name: "compiler", port: 8001, command: compiler, args: ["app.main:app", "--reload", "--port", "8001"], cwd: join(root, "services/compiler") },
  ];
}

async function verifySafeEnvironment() {
  const testDatabaseUrl = configured("TEST_DATABASE_URL");
  const developmentDatabaseUrl = configured("DATABASE_URL");
  const developmentDirectUrl = configured("DIRECT_URL");
  const customerUserId = configured("PARLANCE_CUSTOMER_USER_ID");
  if (!testDatabaseUrl) throw new Error("TEST_DATABASE_URL is missing or empty.");
  if (!developmentDatabaseUrl) throw new Error("DATABASE_URL is missing, so the test database cannot be distinguished from the development database.");
  if (!customerUserId) throw new Error("PARLANCE_CUSTOMER_USER_ID is missing or empty.");
  const testTarget = databaseTarget("TEST_DATABASE_URL", testDatabaseUrl);
  const developmentTargets = [databaseTarget("DATABASE_URL", developmentDatabaseUrl), ...(developmentDirectUrl ? [databaseTarget("DIRECT_URL", developmentDirectUrl)] : [])];
  if (developmentTargets.includes(testTarget)) throw new Error("TEST_DATABASE_URL identifies the same database target as a development database URL.");
  const requireFromDatabasePackage = createRequire(join(root, "packages/db/package.json"));
  const { PrismaClient } = requireFromDatabasePackage("@prisma/client");
  const database = new PrismaClient({ datasourceUrl: testDatabaseUrl });
  let latest;
  try {
    latest = await database.bankStateSnapshot.findFirst({ where: { userId: customerUserId }, orderBy: { stateVersion: "desc" }, select: { stateVersion: true, snapshot: true } });
  } catch {
    throw new Error("Unable to verify the persisted bank state in TEST_DATABASE_URL.");
  } finally {
    await database.$disconnect();
  }
  const maxPersistedStateVersion = latest?.stateVersion ?? 0;
  const initialStateVersion = nextBankStateVersion(maxPersistedStateVersion);
  const bankState = latest ? restorableBankState(latest.snapshot, customerUserId, latest.stateVersion) : { balances: { "acc-sgd": "2000000", "acc-usd": "500000" }, holdings: {} };
  return { testDatabaseUrl, initialStateVersion, bankState };
}

async function inspectRequiredPorts(currentRegistry) {
  const records = currentRegistry?.repoRoot === root ? currentRegistry.services ?? [] : [];
  if (currentRegistry) currentRegistry.services = records.map((record) => ({ ...record, groupAlive: groupAlive(record.pgid) }));
  return Promise.all(REQUIRED_SERVICES.map(async (service) => {
    const observation = await inspectPort(service);
    if (!observation.occupied || !observation.pid) return observation;
    const metadata = await Promise.all(observation.pids.map((pid) => processMetadata(pid)));
    const health = await serviceHealth(service.name);
    const expectedCwd = service.name === "web" ? join(root, "apps/web") : service.name === "api" ? join(root, "apps/api") : service.name === "mock-bank" ? join(root, "services/mock-bank") : join(root, "services/compiler");
    const signature = service.name === "web" ? /next/u : service.name === "compiler" ? /uvicorn|app\.main/u : /tsx|server\.ts/u;
    const tracked = records.find((record) => record.name === service.name);
    const verification = verifyServiceProcessGroup({ health, metadata, expectedCwd, signature, tracked, registryCreatedAt: currentRegistry?.createdAt });
    return { ...observation, ...verification, healthy: health };
  }));
}

async function inspectPort(service) {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", `-iTCP:${service.port}`, "-sTCP:LISTEN", "-Fp"]);
    const pids = [...new Set(stdout.split(/\r?\n/u).filter((line) => /^p\d+$/u.test(line)).map((line) => Number(line.slice(1))))];
    return { ...service, occupied: pids.length > 0, pid: pids[0], pids, healthy: false, identityVerified: false, owned: false };
  } catch (error) {
    if (error?.code === 1) return { ...service, occupied: false, pids: [], healthy: false, identityVerified: false, owned: false };
    throw new Error(`Unable to inspect port ${service.port}.`);
  }
}

async function processMetadata(pid) {
  try {
    const [{ stdout: psOutput }, { stdout: cwdOutput }] = await Promise.all([execFileAsync("ps", ["-ww", "-p", String(pid), "-o", "pgid=,lstart=,command="]), execFileAsync("lsof", ["-nP", "-a", "-p", String(pid), "-d", "cwd", "-Fn"])]);
    const match = psOutput.trim().match(/^(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.+)$/u);
    const cwd = cwdOutput.split(/\r?\n/u).find((line) => line.startsWith("n"))?.slice(1);
    return match ? { pgid: Number(match[1]), startedAt: new Date(match[2]), command: match[3], cwd: resolve(cwd ?? "") } : { pgid: undefined, startedAt: undefined, command: undefined, cwd: resolve(cwd ?? "") };
  } catch { return { pgid: undefined, startedAt: undefined, command: undefined, cwd: undefined }; }
}

async function serviceHealth(name) {
  const path = name === "web" ? "/chat" : "/health";
  const port = REQUIRED_SERVICES.find((service) => service.name === name)?.port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1_500) });
    if (!response.ok) return false;
    if (name === "web") return (await response.text()).includes("Parlance");
    const payload = await response.json();
    return payload?.status === "ok" && payload?.service === name;
  } catch { return false; }
}

async function spawnService(service, environment, sanitize) {
  const child = spawn(service.command, service.args, { cwd: service.cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise((resolvePromise, reject) => { child.once("spawn", resolvePromise); child.once("error", reject); });
  prefixOutput(child.stdout, process.stdout, service.name, sanitize);
  prefixOutput(child.stderr, process.stderr, service.name, sanitize);
  const record = { name: service.name, port: service.port, pid: child.pid, pgid: child.pid, cwd: service.cwd };
  child.once("exit", () => {
    if (shuttingDown) return;
    console.error(`[dev:safe] ${service.name} command wrapper exited; monitoring its owned process group and health before deciding whether the service failed.`);
  });
  return record;
}

async function waitUntilReady(records) {
  const deadline = Date.now() + Number(process.env.PARLANCE_DEV_SAFE_STARTUP_TIMEOUT_MS ?? 30_000);
  let latest = [];
  while (Date.now() < deadline) {
    latest = await inspectRequiredPorts(registry);
    if (latest.every((item) => item.occupied && item.healthy && item.identityVerified && item.owned)) return;
    if (records.some((record) => !groupAlive(record.pgid))) throw new Error("A service process group exited during startup.");
    await delay(250);
  }
  const detail = latest.filter((item) => !(item.occupied && item.healthy && item.identityVerified && item.owned)).map((item) => `${item.name} (listening=${item.occupied}, healthy=${item.healthy}, identity=${item.identityVerified}, owned=${item.owned}, pids=${item.pids?.join(",") || "none"})`).join("; ");
  throw new Error(`Timed out waiting for all four Parlance services to become healthy: ${detail}.`);
}

async function superviseServices() {
  const graceMilliseconds = positiveSafeInteger("PARLANCE_DEV_SAFE_FAILURE_GRACE_MS", configured("PARLANCE_DEV_SAFE_FAILURE_GRACE_MS")) ?? 15_000;
  let failureWindows = new Map();
  while (!shuttingDown) {
    await delay(5_000);
    if (shuttingDown) return;
    const dead = registry?.services?.find((service) => !groupAlive(service.pgid));
    if (dead) {
      await shutdown(1, `${dead.name} process group exited unexpectedly`);
      return;
    }
    const observations = await inspectRequiredPorts(registry);
    const result = updateFailureWindows(failureWindows, observations, Date.now(), graceMilliseconds);
    failureWindows = result.windows;
    if (result.failed.length > 0) {
      await shutdown(1, `${result.failed.join(", ")} remained unhealthy or unverifiable for ${graceMilliseconds}ms`);
      return;
    }
  }
}

function writeRegistry(records) {
  mkdirSync(stateDirectory, { recursive: true });
  registry = { ...registry, services: records };
  const temporary = `${registryPath}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, registryPath);
}

function readRegistry() { try { const parsed = JSON.parse(readFileSync(registryPath, "utf8")); return parsed?.schemaVersion === 1 && parsed.repoRoot === root && Array.isArray(parsed.services) ? parsed : undefined; } catch { return undefined; } }
function removeRegistry() {
  const current = readRegistry();
  if (sameRegistryGeneration(current, registry)) rmSync(registryPath, { force: true });
}
function groupAlive(pgid) { if (!Number.isSafeInteger(pgid)) return false; try { process.kill(-pgid, 0); return true; } catch { return false; } }
function signalGroup(pgid, signal) { try { process.kill(-pgid, signal); } catch (error) { if (error?.code !== "ESRCH") throw error; } }
async function waitForGroups(groups, timeout) { const deadline = Date.now() + timeout; while (Date.now() < deadline) { if (groups.every((group) => !groupAlive(group))) return true; await delay(100); } return groups.every((group) => !groupAlive(group)); }
async function stopRegistryGroups(value) { return stopOwnedGroups(value, { signalGroup, waitForGroups }); }
function delay(milliseconds) { return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)); }

function installSignalHandlers() {
  process.on("SIGINT", () => { void shutdown(130, "SIGINT received"); });
  process.on("SIGTERM", () => { void shutdown(143, "SIGTERM received"); });
  process.on("SIGHUP", () => { void shutdown(129, "terminal closed"); });
}

async function shutdown(exitCode, reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev:safe] ${reason}; stopping verified service process groups...`);
  const stopped = await stopRegistryGroups(registry);
  if (stopped) removeRegistry(); else console.error("[dev:safe] Some verified service descendants did not stop after SIGINT and SIGTERM; ownership record was retained.");
  process.exitCode = stopped ? exitCode : 1;
  resolveLifetime?.();
}

function prefixOutput(stream, destination, service, sanitize) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => { buffered += chunk; const lines = buffered.split(/\r?\n/u); buffered = lines.pop() ?? ""; for (const line of lines) destination.write(`[${service}] ${sanitize(line)}\n`); });
  stream.on("end", () => { if (buffered) destination.write(`[${service}] ${sanitize(buffered)}\n`); });
}

function createRedactor(environment) {
  const sensitiveValues = Object.entries(environment).filter(([key, value]) => value && /(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL|DATABASE_URL|DIRECT_URL|REDIS_URL|INITIAL_BALANCES|INITIAL_HOLDINGS)/u.test(key)).map(([, value]) => value).sort((left, right) => right.length - left.length);
  return (input) => { let output = String(input); for (const value of sensitiveValues) output = output.replaceAll(value, "[REDACTED]"); return output.replace(/\b(?:postgres(?:ql)?|mysql):\/\/[^\s'"]+/giu, "[REDACTED_DATABASE_URL]"); };
}

function databaseTarget(name, value) {
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error(`${name} is not a valid database URL; its value was not printed.`); }
  if (!new Set(["postgres:", "postgresql:"]).has(parsed.protocol) || !parsed.hostname) throw new Error(`${name} is not a valid PostgreSQL URL; its value was not printed.`);
  const database = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/gu, "");
  if (!database) throw new Error(`${name} does not identify a database; its value was not printed.`);
  return `${parsed.hostname.toLowerCase()}:${parsed.port || "5432"}/${database}`;
}

function configured(name) { const value = process.env[name]?.trim(); return value || undefined; }
function positiveSafeInteger(name, value) { if (value === undefined) return undefined; if (!/^[1-9]\d*$/u.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${name} must be a positive safe integer.`); return Number(value); }
