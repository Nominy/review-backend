import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildPrompts } from "./prompt";
import { computeReviewMetrics } from "./metrics";
import { sendToOpenRouter } from "./openrouter";
import { runDeterministicRules } from "./deterministic-rules";
import { getTemplateRegistry } from "./template-registry";
import { loadDefaultEnvFiles, loadEnvFile } from "./load-env";
import type { Annotation, NormalizedState } from "./types";

type EvalSegment = {
  id: string;
  text: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
};

type EvalCase = {
  id: string;
  summary: string;
  requiredFindings: string[];
  allowedFindings?: string[];
  originalSegments: EvalSegment[];
  currentSegments: EvalSegment[];
};

type EvalResult = {
  id: string;
  status: "PASS" | "FAIL" | "ERROR" | "DRY";
  promptChars: number;
  required: string[];
  predicted: string[];
  missing: string[];
  unexpected: string[];
  latencyMs: number;
  repaired: boolean;
  error?: string;
};

const FIXTURE_PATH = fileURLToPath(new URL("./smoke-eval-cases.json", import.meta.url));
const DEFAULT_MODEL = "openai/gpt-oss-120b";

function loadCases(): EvalCase[] {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
  if (!Array.isArray(raw)) {
    throw new Error("Smoke eval fixtures must be an array.");
  }
  return raw as EvalCase[];
}

function makeAnnotation(reviewActionId: string, segment: EvalSegment): Annotation {
  return {
    id: segment.id,
    reviewActionId,
    type: "transcription",
    content: segment.text,
    processedRecordingId: `${reviewActionId}-recording`,
    startTimeInSeconds: segment.startTimeInSeconds,
    endTimeInSeconds: segment.endTimeInSeconds,
    metadata: null
  };
}

function makeState(reviewActionId: string, segments: EvalSegment[]): NormalizedState {
  return {
    actionId: reviewActionId,
    actionLevel: 1,
    actionDecision: "pending",
    annotations: segments.map((segment) => makeAnnotation(reviewActionId, segment)),
    recordings: [],
    lintErrors: [],
    capturedAt: "2026-03-04T00:00:00.000Z"
  };
}

function parseArgs(argv: string[]): {
  dryRun: boolean;
  onlyCaseId: string | null;
} {
  let dryRun = false;
  let onlyCaseId: string | null = null;

  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("--case=")) {
      const value = arg.slice("--case=".length).trim();
      onlyCaseId = value || null;
    }
  }

  return { dryRun, onlyCaseId };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function evaluateFindings(testCase: EvalCase, predicted: string[]): {
  missing: string[];
  unexpected: string[];
  status: "PASS" | "FAIL";
} {
  const predictedSet = new Set(predicted);
  const requiredSet = new Set(testCase.requiredFindings);
  const allowedSet = new Set([
    ...testCase.requiredFindings,
    ...(Array.isArray(testCase.allowedFindings) ? testCase.allowedFindings : [])
  ]);

  const missing = testCase.requiredFindings.filter((item) => !predictedSet.has(item));
  const unexpected = predicted.filter((item) => !allowedSet.has(item));
  const status = missing.length === 0 && unexpected.length === 0 ? "PASS" : "FAIL";

  return {
    missing,
    unexpected,
    status
  };
}

function formatList(values: string[]): string {
  return values.length ? values.join(", ") : "-";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = getTemplateRegistry();
  const allCases = loadCases();
  const cases = args.onlyCaseId ? allCases.filter((item) => item.id === args.onlyCaseId) : allCases;

  if (!cases.length) {
    throw new Error(args.onlyCaseId ? `No fixture found for case: ${args.onlyCaseId}` : "No fixtures found.");
  }

  let apiKey = "";
  let model = DEFAULT_MODEL;

  if (!args.dryRun) {
    loadEnvFile(".env");
    loadDefaultEnvFiles();

    apiKey = (process.env.OPENROUTER_API_KEY || "").trim();
    model = (process.env.OPENROUTER_MODEL || "").trim() || DEFAULT_MODEL;

    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY is required for smoke eval. Use --dry-run to skip model calls.");
    }
  }

  const results: EvalResult[] = [];

  for (const testCase of cases) {
    const original = makeState(`${testCase.id}-original`, testCase.originalSegments);
    const current = makeState(`${testCase.id}-current`, testCase.currentSegments);
    const computed = computeReviewMetrics(original, current, testCase.id);
    const prompts = buildPrompts(computed.promptPacket, registry.promptCatalog);
    const promptChars = prompts.systemPrompt.length + prompts.userPrompt.length;

    if (args.dryRun) {
      const deterministicFindings = runDeterministicRules(computed.promptPacket);
      results.push({
        id: testCase.id,
        status: "DRY",
        promptChars,
        required: testCase.requiredFindings,
        predicted: deterministicFindings,
        missing: [],
        unexpected: [],
        latencyMs: 0,
        repaired: false
      });
      continue;
    }

    try {
      const deterministicFindings = runDeterministicRules(computed.promptPacket);
      const response = await sendToOpenRouter({
        apiKey,
        model,
        prompts,
        registry
      });

      // Merge deterministic + LLM findings, deduplicated
      const seen = new Set<string>(deterministicFindings);
      const mergedFindings = [...deterministicFindings];
      for (const id of response.findings) {
        if (!seen.has(id)) {
          seen.add(id);
          mergedFindings.push(id);
        }
      }

      const graded = evaluateFindings(testCase, mergedFindings);

      results.push({
        id: testCase.id,
        status: graded.status,
        promptChars,
        required: sorted(new Set(testCase.requiredFindings)),
        predicted: sorted(new Set(mergedFindings)),
        missing: sorted(new Set(graded.missing)),
        unexpected: sorted(new Set(graded.unexpected)),
        latencyMs: response.latencyMs,
        repaired: !!response.repaired
      });
    } catch (error) {
      results.push({
        id: testCase.id,
        status: "ERROR",
        promptChars,
        required: sorted(new Set(testCase.requiredFindings)),
        predicted: [],
        missing: [],
        unexpected: [],
        latencyMs: 0,
        repaired: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  let strictPasses = 0;
  let requiredTotal = 0;
  let requiredHits = 0;
  let totalPromptChars = 0;
  let totalLatencyMs = 0;
  let repairCount = 0;

  for (const result of results) {
    totalPromptChars += result.promptChars;
    totalLatencyMs += result.latencyMs;
    if (result.repaired) {
      repairCount += 1;
    }

    const caseRequiredCount = result.required.length;
    const caseRequiredHits = result.required.filter((item) => result.predicted.includes(item)).length;
    requiredTotal += caseRequiredCount;
    requiredHits += caseRequiredHits;

    if (result.status === "PASS") {
      strictPasses += 1;
    }

    console.log(
      [
        `[${result.status}]`,
        result.id,
        `promptChars=${result.promptChars}`,
        `latencyMs=${result.latencyMs}`,
        `repaired=${result.repaired ? "yes" : "no"}`
      ].join(" ")
    );
    console.log(`  required:   ${formatList(result.required)}`);
    console.log(`  predicted:  ${formatList(result.predicted)}`);
    console.log(`  missing:    ${formatList(result.missing)}`);
    console.log(`  unexpected: ${formatList(result.unexpected)}`);
    if (result.error) {
      console.log(`  error:      ${result.error}`);
    }
  }

  const errorCount = results.filter((item) => item.status === "ERROR").length;
  const evaluatedCount = results.length - errorCount;
  const strictRate = results.length ? Math.round((strictPasses / results.length) * 100) : 0;
  const recallRate = requiredTotal ? Math.round((requiredHits / requiredTotal) * 100) : 0;
  const avgPromptChars = results.length ? Math.round(totalPromptChars / results.length) : 0;
  const avgLatencyMs = evaluatedCount ? Math.round(totalLatencyMs / evaluatedCount) : 0;

  console.log("");
  console.log(
    [
      "Summary:",
      `cases=${results.length}`,
      `strictPasses=${strictPasses}`,
      `strictRate=${strictRate}%`,
      `requiredHitRate=${requiredHits}/${requiredTotal} (${recallRate}%)`,
      `avgPromptChars=${avgPromptChars}`,
      `avgLatencyMs=${avgLatencyMs}`,
      `repairs=${repairCount}`,
      `errors=${errorCount}`
    ].join(" ")
  );
}

await main();
