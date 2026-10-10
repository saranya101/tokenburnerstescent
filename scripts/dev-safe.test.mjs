import assert from "node:assert/strict";
import test from "node:test";
import { REQUIRED_SERVICES, classifyStack, nextBankStateVersion, restorableBankState, sameRegistryGeneration, startAttempt, stopOwnedGroups, updateFailureWindows, verifyServiceProcessGroup } from "./dev-safe-core.mjs";

const clear = () => REQUIRED_SERVICES.map((service) => ({ ...service, occupied: false, owned: false, healthy: false, identityVerified: false }));
const healthy = (owned = true) => REQUIRED_SERVICES.map((service, index) => ({ ...service, occupied: true, pid: 100 + index, pgid: 200 + index, owned, healthy: true, identityVerified: true }));
const registry = { services: REQUIRED_SERVICES.map((service, index) => ({ ...service, pgid: 200 + index, groupAlive: true })) };

test("clean startup launches and records all four services", async () => {
  const spawned = []; const writes = [];
  const records = await startAttempt(REQUIRED_SERVICES, {
    spawnService: async (service) => { spawned.push(service.name); return { ...service, pgid: 300 + spawned.length }; },
    writeRegistry: async (current) => { writes.push([...current]); },
    waitUntilReady: async (current) => assert.equal(current.length, 4),
    stopCreated: async () => assert.fail("cleanup should not run"),
  });
  assert.deepEqual(spawned, ["web", "api", "mock-bank", "compiler"]);
  assert.equal(records.length, 4); assert.equal(writes.length, 4);
});

test("repeated dev:safe invocation recognizes a healthy stack", () => {
  assert.deepEqual(classifyStack(healthy(true), registry), { kind: "RUNNING_OWNED" });
  assert.deepEqual(classifyStack(healthy(false), undefined), { kind: "RUNNING_UNMANAGED" });
});

test("partially running registered Parlance stack is recoverable", () => {
  const observations = clear(); Object.assign(observations[0], { occupied: true, owned: true, healthy: true, identityVerified: true, pid: 100, pgid: 200 });
  assert.deepEqual(classifyStack(observations, registry), { kind: "RECOVERABLE_PARTIAL" });
});

test("unrelated process on a required port blocks startup", () => {
  const observations = clear(); Object.assign(observations[2], { occupied: true, owned: false, healthy: false, identityVerified: false, pid: 999 });
  assert.deepEqual(classifyStack(observations, undefined), { kind: "BLOCKED", blockers: [{ name: "mock-bank", port: 4002, pid: 999 }] });
});

test("graceful shutdown signals only recorded process groups", async () => {
  const signals = [];
  const stopped = await stopOwnedGroups(registry, {
    signalGroup: (pgid, signal) => signals.push([pgid, signal]),
    waitForGroups: async () => true,
  });
  assert.equal(stopped, true);
  assert.deepEqual(signals, [[200, "SIGINT"], [201, "SIGINT"], [202, "SIGINT"], [203, "SIGINT"]]);
});

test("startup failure cleans up only children from that attempt", async () => {
  const stopped = [];
  await assert.rejects(startAttempt(REQUIRED_SERVICES, {
    spawnService: async (service) => { if (service.name === "mock-bank") throw new Error("startup failed"); return { ...service, pgid: service.port }; },
    writeRegistry: async () => {}, waitUntilReady: async () => {},
    stopCreated: async (records) => stopped.push(...records.map(({ name }) => name)),
  }), /startup failed/u);
  assert.deepEqual(stopped, ["web", "api"]);
});

test("safe restart restores authoritative balances and holdings before shutdown", async () => {
  const restored = restorableBankState({
    userId: "demo-user", stateVersion: 11,
    accounts: [
      { id: "acc-sgd", ledgerMinorUnits: "1720000", availableMinorUnits: "1720000" },
      { id: "acc-usd", ledgerMinorUnits: "478900", availableMinorUnits: "478900" },
    ],
    holdings: [{ assetId: "asset-aapl", quantity: "1" }],
  }, "demo-user", 11);
  assert.deepEqual(restored, { balances: { "acc-sgd": "1720000", "acc-usd": "478900" }, holdings: { "asset-aapl": "1" } });
});

test("restart refuses incomplete or unsupported holding restoration", () => {
  const base = { userId: "demo-user", stateVersion: 11, accounts: [{ id: "acc-sgd", ledgerMinorUnits: "1", availableMinorUnits: "1" }, { id: "acc-usd", ledgerMinorUnits: "1", availableMinorUnits: "1" }] };
  assert.throws(() => restorableBankState(base, "demo-user", 11), /LATEST_SNAPSHOT_INCOMPLETE/u);
  assert.throws(() => restorableBankState({ ...base, holdings: [{ assetId: "asset-unknown", quantity: "1" }] }, "demo-user", 11), /LATEST_SNAPSHOT_UNSUPPORTED_HOLDING/u);
});

test("Uvicorn reloader and server listeners verify as one owned process group", () => {
  const createdAt = "2026-10-10T12:00:00.000Z";
  const result = verifyServiceProcessGroup({
    health: true,
    metadata: [
      { pid: 10, pgid: 10, cwd: "/repo/services/compiler", command: "python uvicorn app.main:app --reload", startedAt: new Date(createdAt) },
      { pid: 11, pgid: 10, cwd: "/repo/services/compiler", command: "python -c multiprocessing.spawn", startedAt: new Date(createdAt) },
    ],
    expectedCwd: "/repo/services/compiler",
    signature: /uvicorn|app\.main/u,
    tracked: { pgid: 10 },
    registryCreatedAt: createdAt,
  });
  assert.deepEqual(result, { pgid: 10, identityVerified: true, owned: true });
});

test("watcher child replacement retains ownership through the stable process group", () => {
  const createdAt = "2026-10-10T12:00:00.000Z";
  const verify = (pid) => verifyServiceProcessGroup({
    health: true,
    metadata: [{ pid, pgid: 20, cwd: "/repo/apps/api", command: "node tsx watch src/server.ts", startedAt: new Date("2026-10-10T12:00:02.000Z") }],
    expectedCwd: "/repo/apps/api",
    signature: /tsx|server\.ts/u,
    tracked: { pgid: 20 },
    registryCreatedAt: createdAt,
  });
  assert.equal(verify(21).owned, true);
  assert.equal(verify(22).owned, true);
});

test("transient reload health loss does not become a service failure", () => {
  let result = updateFailureWindows(new Map(), [{ name: "api", occupied: false, healthy: false, identityVerified: false, owned: false }], 1_000, 15_000);
  assert.deepEqual(result.failed, []);
  result = updateFailureWindows(result.windows, [{ name: "api", occupied: true, healthy: true, identityVerified: true, owned: true }], 5_000, 15_000);
  assert.deepEqual(result.failed, []);
  assert.equal(result.windows.size, 0);
});

test("sustained unhealthy service produces an actionable failure", () => {
  const observation = [{ name: "api", occupied: false, healthy: false, identityVerified: false, owned: false }];
  const started = updateFailureWindows(new Map(), observation, 1_000, 15_000);
  const failed = updateFailureWindows(started.windows, observation, 16_000, 15_000);
  assert.deepEqual(failed.failed, ["api"]);
});

test("stale configured state versions are replaced by the authoritative monotonic successor", () => {
  assert.equal(nextBankStateVersion(10), 11);
  assert.equal(nextBankStateVersion(11), 12);
  assert.throws(() => nextBankStateVersion(Number.MAX_SAFE_INTEGER), /LATEST_STATE_VERSION_INVALID/u);
});

test("an old launcher cannot delete a newer ownership registry", () => {
  const oldRegistry = { launcherPid: 1, createdAt: "old" };
  assert.equal(sameRegistryGeneration(oldRegistry, oldRegistry), true);
  assert.equal(sameRegistryGeneration({ launcherPid: 2, createdAt: "new" }, oldRegistry), false);
});
