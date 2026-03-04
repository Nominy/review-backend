export type CategoryName =
  | "Word Accuracy"
  | "Timestamp Accuracy"
  | "Punctuation & Formatting"
  | "Tags & Emphasis"
  | "Segmentation";

export type FeedbackItem = {
  category: CategoryName;
  note: string;
};

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

export type PromptTextDiff = {
  oldId: string;
  newId: string;
  before: string;
  after: string;
  oldStartTimeInSeconds: number;
  oldEndTimeInSeconds: number;
  newStartTimeInSeconds: number;
  newEndTimeInSeconds: number;
};

export type PromptTimingDiff = {
  oldId: string;
  newId: string;
  text: string;
  startShiftMs: number;
  endShiftMs: number;
};

export type PromptSegmentSample = {
  id: string;
  text: string;
  startTimeInSeconds: number;
  endTimeInSeconds: number;
};

export type PromptPacket = {
  session: {
    actionId: string;
    metricsVersion: string;
    promptVersion: string;
  };
  overview: {
    originalSegments: number;
    currentSegments: number;
    stablePairs: number;
    textDiffCount: number;
    timingDiffCount: number;
    unmatchedOriginalCount: number;
    unmatchedCurrentCount: number;
  };
  textDiffs: PromptTextDiff[];
  timingDiffs: PromptTimingDiff[];
  segmentationDiffs: {
    segmentCountDelta: number;
    unmatchedOriginal: PromptSegmentSample[];
    unmatchedCurrent: PromptSegmentSample[];
  };
};

export type TemplateCategory = CategoryName;

export type TemplateDefinition = {
  id: string;
  title: string;
  description: string;
  reportText: string;
  priority: number;
  enabled: boolean;
};

export type ReviewTemplate = TemplateDefinition & {
  category: TemplateCategory;
};

export type TemplateRegistryFile = {
  category: TemplateCategory;
  version: number;
  defaultText: string;
  templates: TemplateDefinition[];
};

export type TemplatePromptEntry = {
  id: string;
  description: string;
};

export type TemplatePromptCatalog = Record<TemplateCategory, TemplatePromptEntry[]>;

export type TemplateSelectionResponse = {
  findings: string[];
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
    feedback: FeedbackItem[];
    rawContent: string;
    model: string;
    latencyMs: number;
    receivedAt: string;
    matchedTemplateIds: string[];
    templateRegistryVersion: string;
    repaired?: boolean;
  };
};

export type SubmitTranscriptReviewAnalyticsResponse = {
  ok: true;
  savedAt: string;
  reviewActionId: string;
  prepared: PreparedPayload;
};
