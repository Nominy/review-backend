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

export type EditSeverity = "minor" | "material" | "severe";

export type PromptSample = {
  kind: string;
  severity: EditSeverity;
  annotationId: string;
  linkedAnnotationId?: string;
  note: string;
  before?: string;
  after?: string;
};

export type PromptCategoryEvidence = {
  count: number;
  dominantKinds: string[];
  samples: PromptSample[];
};

export type PromptPacket = {
  session: {
    actionId: string;
    metricsVersion: string;
    promptVersion: string;
  };
  editFootprint: {
    stableMatchedSegments: number;
    changedSegments: number;
    changedSegmentRatio: number;
    segmentCountDelta: number;
    isMicroEdit: boolean;
  };
  ownershipSummary: {
    wordOwned: number;
    timestampOwned: number;
    punctuationOwned: number;
    tagsOwned: number;
    segmentationOwned: number;
  };
  categoryEvidence: {
    wordAccuracy: PromptCategoryEvidence;
    timestampAccuracy: PromptCategoryEvidence;
    punctuationFormatting: PromptCategoryEvidence;
    tagsEmphasis: PromptCategoryEvidence;
    segmentation: PromptCategoryEvidence;
  };
  scoreCaps: Record<CategoryName, 1 | 2 | 3>;
};

export type PreparedPayload = {
  preparedAt: string;
  stats: Record<string, unknown>;
  featurePacket: Record<string, unknown>;
  promptPacket: PromptPacket;
  metricsVersion: string;
  promptVersion: string;
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

export type SubmitTranscriptReviewAnalyticsResponse = {
  ok: true;
  savedAt: string;
  reviewActionId: string;
  prepared: PreparedPayload;
};
