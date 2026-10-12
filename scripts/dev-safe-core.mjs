export const REQUIRED_SERVICES = Object.freeze([
  { name: "web", port: 3000 },
  { name: "api", port: 4001 },
  { name: "mock-bank", port: 4002 },
  { name: "compiler", port: 8001 },
]);

export function classifyStack(observations, registry) {
  const occupied = observations.filter((item) => item.occupied);
  const liveOwnedGroups = registry?.services?.filter((service) => service.groupAlive) ?? [];
  if (occupied.length === 0 && liveOwnedGroups.length === 0) return { kind: "CLEAR" };
  if (
    occupied.length === REQUIRED_SERVICES.length
    && occupied.every((item) => item.healthy && item.identityVerified)
  ) {
    return {
      kind: occupied.every((item) => item.owned) ? "RUNNING_OWNED" : "RUNNING_UNMANAGED",
    };
  }
  if (occupied.every((item) => item.owned) && liveOwnedGroups.length > 0) {
    return { kind: "RECOVERABLE_PARTIAL" };
  }
  return {
    kind: "BLOCKED",
    blockers: occupied.filter((item) => !item.owned).map(({ name, port, pid }) => ({ name, port, pid })),
  };
}

export function restorableBankState(snapshot, expectedUserId, expectedStateVersion) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) throw new Error("LATEST_SNAPSHOT_MALFORMED");
  if (snapshot.userId !== expectedUserId || snapshot.stateVersion !== expectedStateVersion) throw new Error("LATEST_SNAPSHOT_IDENTITY_MISMATCH");
  if (!Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.holdings)) throw new Error("LATEST_SNAPSHOT_INCOMPLETE");
  const expectedAccounts = new Set(["acc-sgd", "acc-usd"]);
  const balances = {};
  for (const account of snapshot.accounts) {
    if (!account || typeof account !== "object" || !expectedAccounts.delete(account.id)) throw new Error("LATEST_SNAPSHOT_UNEXPECTED_ACCOUNT");
    if (typeof account.availableMinorUnits !== "string" || !/^(0|[1-9]\d*)$/u.test(account.availableMinorUnits)) throw new Error("LATEST_SNAPSHOT_INVALID_BALANCE");
    if (account.ledgerMinorUnits !== account.availableMinorUnits) throw new Error("LATEST_SNAPSHOT_RESERVED_FUNDS_UNSUPPORTED");
    balances[account.id] = account.availableMinorUnits;
  }
  if (expectedAccounts.size !== 0) throw new Error("LATEST_SNAPSHOT_MISSING_ACCOUNT");
  const holdings = {};
  for (const holding of snapshot.holdings) {
    if (!holding || typeof holding !== "object" || holding.assetId !== "asset-aapl" || holdings[holding.assetId] !== undefined) throw new Error("LATEST_SNAPSHOT_UNSUPPORTED_HOLDING");
    if (typeof holding.quantity !== "string" || !/^(0|[1-9]\d*)(?:\.\d+)?$/u.test(holding.quantity)) throw new Error("LATEST_SNAPSHOT_INVALID_HOLDING");
    holdings[holding.assetId] = holding.quantity;
  }
  return { balances, holdings };
}

export function nextBankStateVersion(maxPersistedStateVersion) {
  if (!Number.isSafeInteger(maxPersistedStateVersion) || maxPersistedStateVersion < 0 || maxPersistedStateVersion === Number.MAX_SAFE_INTEGER) throw new Error("LATEST_STATE_VERSION_INVALID");
  return maxPersistedStateVersion + 1;
}

export function verifyServiceProcessGroup({ health, metadata, expectedCwd, signature, tracked, registryCreatedAt }) {
  const groups = new Set(metadata.map(({ pgid }) => pgid).filter(Number.isSafeInteger));
  const processGroupId = groups.size === 1 ? [...groups][0] : undefined;
  const identityVerified = Boolean(
    health
    && metadata.length > 0
    && processGroupId
    && metadata.every(({ cwd }) => cwd === expectedCwd)
    && metadata.some(({ command }) => signature.test(command ?? "")),
  );
  const earliestAllowedStart = Date.parse(registryCreatedAt ?? "") - 5_000;
  const owned = Boolean(
    tracked
    && identityVerified
    && tracked.pgid === processGroupId
    && metadata.every(({ startedAt }) => startedAt instanceof Date && startedAt.getTime() >= earliestAllowedStart),
  );
  return { pgid: processGroupId, identityVerified, owned };
}

export function updateFailureWindows(previous, observations, now, graceMilliseconds) {
  const windows = new Map(previous);
  const failed = [];
  for (const observation of observations) {
    const ready = observation.occupied && observation.healthy && observation.identityVerified && observation.owned;
    if (ready) {
      windows.delete(observation.name);
      continue;
    }
    const since = windows.get(observation.name) ?? now;
    windows.set(observation.name, since);
    if (now - since >= graceMilliseconds) failed.push(observation.name);
  }
  return { windows, failed };
}

export function sameRegistryGeneration(left, right) {
  return Boolean(left && right && left.launcherPid === right.launcherPid && left.createdAt === right.createdAt);
}

export async function stopOwnedGroups(registry, dependencies) {
  const groups = [...new Set((registry?.services ?? []).map(({ pgid }) => pgid).filter(Number.isSafeInteger))];
  for (const pgid of groups) dependencies.signalGroup(pgid, "SIGINT");
  if (await dependencies.waitForGroups(groups, 5_000)) return true;
  for (const pgid of groups) dependencies.signalGroup(pgid, "SIGTERM");
  return dependencies.waitForGroups(groups, 5_000);
}

export async function startAttempt(services, dependencies) {
  const records = [];
  try {
    for (const service of services) {
      const record = await dependencies.spawnService(service);
      records.push(record);
      await dependencies.writeRegistry(records);
    }
    await dependencies.waitUntilReady(records);
    return records;
  } catch (error) {
    await dependencies.stopCreated(records);
    throw error;
  }
}
