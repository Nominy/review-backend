import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NormalizedState } from "./types";

type ReviewPairLogEntry = {
  loggedAt: string;
  reviewActionId: string;
  originalCapturedAt: string;
  currentCapturedAt: string;
  originalText: string;
  reviewedText: string;
};

function stateToText(state: NormalizedState): string {
  if (!Array.isArray(state.annotations) || state.annotations.length === 0) {
    return "";
  }

  const ordered = [...state.annotations].sort((a, b) => {
    if (a.startTimeInSeconds !== b.startTimeInSeconds) {
      return a.startTimeInSeconds - b.startTimeInSeconds;
    }
    return a.id.localeCompare(b.id);
  });

  return ordered.map((annotation) => annotation.content || "").join("\n").trim();
}

export async function logReviewTextPair(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  logPath: string;
}): Promise<void> {
  const entry: ReviewPairLogEntry = {
    loggedAt: new Date().toISOString(),
    reviewActionId: input.reviewActionId,
    originalCapturedAt: input.original.capturedAt || "",
    currentCapturedAt: input.current.capturedAt || "",
    originalText: stateToText(input.original),
    reviewedText: stateToText(input.current)
  };

  await mkdir(dirname(input.logPath), { recursive: true });
  await appendFile(input.logPath, `${JSON.stringify(entry)}\n`, "utf8");
}
