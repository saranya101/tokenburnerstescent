// Parse real FastAPI wire output through unchanged TypeScript consumer contracts.
import { strict as assert } from "node:assert";
import { hashGoalBundleContract } from "../../../packages/contracts/src/goal-bundle-hash.server.ts";
import { readFileSync } from "node:fs";
import {
  CompileGoalBundleRequestV1, CompileGoalBundleResultV1, CompilerResultV1,
} from "../../../packages/contracts/src/index.ts";

const evidence = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const bundles = evidence.bundles ?? [...evidence.successFixtures, ...evidence.refusalFixtures];
for (const item of bundles) {
  if (item.httpStatus === 422) continue;
  const parsed = CompileGoalBundleRequestV1.parse(item.request);
  assert.equal(parsed.goalBundle.contractHash, hashGoalBundleContract(parsed.goalBundle));
  if ("status" in item.response) CompilerResultV1.parse(item.response);
  else CompileGoalBundleResultV1.parse(item.response);
}
for (const single of evidence.singles ?? []) CompilerResultV1.parse(single);
