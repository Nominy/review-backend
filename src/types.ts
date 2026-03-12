export type CategoryName =
  | "Word Accuracy"
  | "Timestamp Accuracy"
  | "Punctuation & Formatting"
  | "Tags & Emphasis"
  | "Segmentation";

export type FeedbackItem = {
  category: CategoryName;
  score: number;
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
  before: string;
  after: string;
  beforeTagCount: number;
  afterTagCount: number;
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
    originalWords: number;
    currentWords: number;
    segmentCountDelta: number;
    localTextChangeCount: number;
    localTagChangeCount: number;
    hasBabelDiff: boolean;
  };
  localTextEvidence: {
    changedPairs: PromptTextDiff[];
    originalTagSamples: PromptSegmentSample[];
    currentTagSamples: PromptSegmentSample[];
    originalOnlySamples: PromptSegmentSample[];
    currentOnlySamples: PromptSegmentSample[];
    originalTagSegmentCount: number;
    currentTagSegmentCount: number;
  };
  babelDiff?: {
    referenceReviewActionId: string;
    currentReviewActionId: string;
    segmentation: {
      overview: {
        mappingCount: number;
        unchangedCount: number;
        modifiedCount: number;
        splitCount: number;
        mergeCount: number;
        addedCount: number;
        deletedCount: number;
      };
      samples: Array<{
        relationship: string;
        referenceText: string;
        hypothesisText: string;
        referenceSegmentCount: number;
        hypothesisSegmentCount: number;
        substitutions: number;
        insertions: number;
        deletions: number;
      }>;
    };
    timestamp: {
      overview: {
        precision: number | null;
        recall: number | null;
        f1: number | null;
        totalSegments: number | null;
        matchedSegments: number | null;
        unmatchedSegments: number | null;
        avgShiftMs: number | null;
        within50ms: number | null;
        within100ms: number | null;
        within200ms: number | null;
      };
      samples: Array<{
        refText: string;
        startShiftMs: number;
        endShiftMs: number;
        avgShiftMs: number;
        quality: string;
      }>;
    };
    wordAccuracy: {
      overview: {
        overallWordErrorRate: number | null;
        totalReferenceWords: number | null;
        totalHypothesisWords: number | null;
        totalInsertions: number | null;
        totalDeletions: number | null;
        totalSubstitutions: number | null;
      };
      speakerBreakdown: Array<{
        processedRecordingId: string;
        wordErrorRate: number | null;
        totalReferenceWords: number | null;
        totalHypothesisWords: number | null;
        insertions: number | null;
        deletions: number | null;
        substitutions: number | null;
      }>;
      wordDiffSamples: Array<{
        processedRecordingId: string;
        referenceText: string;
        hypothesisText: string;
        changedTokens: Array<{
          value: string;
          status: string;
        }>;
      }>;
    };
  };
};

export type BabelDiffPayload = {
  reviewActionsPayload?: unknown;
  diffPayload?: unknown;
  referenceReviewActionId?: string;
  currentReviewActionId?: string;
  transcriptionChunkId?: string;
  reviewActionsUrl?: string;
  diffUrl?: string;
  capturedAt?: string;
};

export type TemplateCategory = CategoryName;

export type TemplateDefinition = {
  id: string;
  title: string;
  description: string;
  reportTexts: string[];
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
