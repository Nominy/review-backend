import type { PromptPacket } from "./types";

/**
 * Hard-coded threshold checks that bypass the LLM.
 *
 * Only two rules live here — both are pure arithmetic comparisons
 * that a small model consistently fails at:
 *   - precision < 0.99 → timestamp_accuracy.nizkiy_precision
 *   - recall    < 0.99 → timestamp_accuracy.nizkiy_recall
 *
 * Everything else stays in the LLM classifier.
 */

const PRECISION_THRESHOLD = 0.99;
const RECALL_THRESHOLD = 0.99;

export function runDeterministicRules(packet: PromptPacket): string[] {
  const findings: string[] = [];

  const ts = packet.structuralDiff?.timestamp?.overview;
  if (!ts) return findings;

  if (typeof ts.precision === "number" && ts.precision < PRECISION_THRESHOLD) {
    findings.push("timestamp_accuracy.nizkiy_precision");
  }

  if (typeof ts.recall === "number" && ts.recall < RECALL_THRESHOLD) {
    findings.push("timestamp_accuracy.nizkiy_recall");
  }

  return findings;
}
