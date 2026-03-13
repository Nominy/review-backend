import type { NormalizedState } from "./types";
import { writeStructuredLog } from "./structured-logger";

type ReviewPairLogEntry = {
  logType: "review_pair";
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
}): Promise<void> {
  const entry: ReviewPairLogEntry = {
    logType: "review_pair",
    loggedAt: new Date().toISOString(),
    reviewActionId: input.reviewActionId,
    originalCapturedAt: input.original.capturedAt || "",
    currentCapturedAt: input.current.capturedAt || "",
    originalText: stateToText(input.original),
    reviewedText: stateToText(input.current)
  };

  writeStructuredLog(entry);
}
