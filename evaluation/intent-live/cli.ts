import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import {
  INTENT_PROMPT_VERSION,
  TokenHubConfigurationError,
  createTokenHubIntentInterpreter,
  loadTokenHubConfig,
} from "../../packages/intent-engine/src/index.js";
import { formatBenchmarkSummary, serializeBenchmarkReport } from "./report.js";
import {
  BenchmarkSelectionError,
  createSafeBenchmarkConfiguration,
  runIntentBenchmark,
  selectBenchmarkFixtures,
} from "./runner.js";

interface CliOptions {
  readonly selection: string;
  readonly outputPath?: string;
  readonly help: boolean;
}

const REPOSITORY_ROOT = findRepositoryRoot(process.cwd());

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }

  const apiKey = process.env.TOKENHUB_API_KEY;
  if (apiKey === undefined || apiKey.trim().length === 0) {
    throw new TokenHubConfigurationError("TOKENHUB_API_KEY must be set before running the live intent benchmark.");
  }

  // Resolve selection before constructing the provider client, so invalid filters make no requests.
  selectBenchmarkFixtures(options.selection);
  const providerConfig = loadTokenHubConfig(process.env);
  const configuration = createSafeBenchmarkConfiguration(providerConfig, INTENT_PROMPT_VERSION, options.selection);
  const interpreter = createTokenHubIntentInterpreter();
  const report = await runIntentBenchmark({ interpreter, selection: options.selection, configuration });
  const outputPath = resolveOutputPath(options.outputPath, report.generatedAt);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeBenchmarkReport(report, [apiKey]), "utf8");

  console.log(formatBenchmarkSummary(report, [apiKey]));
  console.log(`\nJSON report: ${outputPath}`);
  if (report.cases.some((result) => result.status === "FAIL")) process.exitCode = 1;
}

export function parseCliOptions(args: readonly string[]): CliOptions {
  let selection: string | undefined;
  let outputPath: string | undefined;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--") {
      continue;
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--output") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) throw new BenchmarkSelectionError("--output requires a file path.");
      outputPath = value;
      index += 1;
    } else if (argument?.startsWith("--") === true) {
      throw new BenchmarkSelectionError(`Unknown live benchmark option: ${argument}`);
    } else if (argument !== undefined) {
      if (selection !== undefined) throw new BenchmarkSelectionError("Specify only one benchmark selection.");
      selection = argument;
    }
  }
  return {
    selection: selection ?? "all",
    ...(outputPath === undefined ? {} : { outputPath }),
    help,
  };
}

function resolveOutputPath(requestedPath: string | undefined, generatedAt: string): string {
  if (requestedPath !== undefined) return isAbsolute(requestedPath) ? requestedPath : resolve(REPOSITORY_ROOT, requestedPath);
  const timestamp = generatedAt.replaceAll(/[:.]/g, "-");
  return resolve(REPOSITORY_ROOT, `evaluation/results/tokenhub-intent-${timestamp}.json`);
}

function findRepositoryRoot(start: string): string {
  let candidate = resolve(start);
  const filesystemRoot = parse(candidate).root;
  while (!existsSync(resolve(candidate, "pnpm-workspace.yaml"))) {
    if (candidate === filesystemRoot) throw new BenchmarkSelectionError("Could not locate the repository root.");
    candidate = dirname(candidate);
  }
  return candidate;
}

function usage(): string {
  return [
    "Usage: pnpm eval:intent:live -- [all|semantic|adversarial|fixture-id] [--output path]",
    "",
    "The command is opt-in and requires TOKENHUB_API_KEY.",
    "Recommended benchmark configuration: TOKENHUB_MODEL=hy3 TOKENHUB_THINKING=disabled.",
  ].join("\n");
}

void main().catch((error: unknown) => {
  if (error instanceof TokenHubConfigurationError || error instanceof BenchmarkSelectionError) {
    console.error(`TokenHub live intent benchmark failed: ${error.message}`);
  } else {
    // Unknown errors may contain provider headers or credentials; never print them.
    console.error("TokenHub live intent benchmark failed before a safe report could be written.");
  }
  process.exitCode = 1;
});
