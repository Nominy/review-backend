export type CategoryName =
  | "Word Accuracy"
  | "Timestamp Accuracy"
  | "Punctuation & Formatting"
  | "Tags & Emphasis"
  | "Segmentation";

export type Annotation = {
  id: string;
  reviewActionId: string;
  type: string;
  content: string;
  processedRecordingId: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
  metadata: Record<string, unknown> | null;
};

export type Recording = {
  id: string;
  transcriptionChunkId: string;
  processedRecordingId: string;
  speaker: number;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
};

export type LintError = {
  annotationId: string;
  reason: string;
  severity: string;
};

export type NormalizedState = {
  actionId: string;
  actionLevel: number;
  actionDecision: string;
  annotations: Annotation[];
  recordings: Recording[];
  lintErrors: LintError[];
  capturedAt: string;
};

export type PreparedPayload = {
  preparedAt: string;
  stats: Record<string, unknown>;
  featurePacket: Record<string, unknown>;
  prompts: {
    systemPrompt: string;
    userPrompt: string;
    preview: string;
  };
};

export type GenerateResponse = {
  prepared: PreparedPayload;
  llm: {
    feedback: Array<{
      category: CategoryName;
      score: number;
      note: string;
    }>;
    rawContent: string;
    model: string;
    latencyMs: number;
    receivedAt: string;
    repaired?: boolean;
  };
};

