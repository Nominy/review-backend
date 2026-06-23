import type { OpenRouterReasoningEffort, OpenRouterServiceTier } from "../../shared/openrouter-client";

export type { OpenRouterReasoningEffort, OpenRouterServiceTier };

export type DraftingProjectPresetId = "ru-gold-2sp-v1";
export type DraftReasoningEffort = "default" | OpenRouterReasoningEffort;

export interface DraftingTranscriptRowInput {
  rowId: string;
  speakerKey: string;
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
  index: number;
}

export interface GenerateDraftRequest {
  projectPreset: DraftingProjectPresetId;
  jobId: string;
  draftSessionId?: string;
  rows: DraftingTranscriptRowInput[];
  openRouterApiKey?: string;
  model?: string;
  serviceTier?: OpenRouterServiceTier;
  reasoningEffort?: DraftReasoningEffort;
}

export interface AudioCueAudioTrackInput {
  trackId: string;
  speakerKey?: string;
  trackLabel?: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

export interface AudioCueDraftRequest extends GenerateDraftRequest {
  audioTracks: AudioCueAudioTrackInput[];
}

export interface AudioCueClipInput {
  trackId: string;
  speakerKey?: string;
  trackLabel?: string;
  clipStartSeconds?: number;
  clipEndSeconds?: number;
  truncatedAtEnd?: boolean;
  format: string;
  base64: string;
}

export interface BrokerTranscriptSegment {
  rowId: string;
  speakerKey: string;
  startSeconds: number;
  endSeconds: number;
}

export interface BrokerTranscribeSegmentRequest {
  openRouterApiKey: string;
  model?: string;
  serviceTier?: OpenRouterServiceTier;
  reasoningEffort?: DraftReasoningEffort;
  segment: BrokerTranscriptSegment;
}

export interface BrokerTranscribeSegmentResponse {
  text: string;
  model: string;
}

export interface BrokerRedistributionSegment {
  id: string;
  index: number;
  speakerKey: string;
  startSeconds: number | null;
  endSeconds: number | null;
  text: string;
}

export interface BrokerRedistributionAllocation {
  segmentId: string;
  text: string;
}

export interface BrokerRedistributionGroup {
  groupId: string;
  speakerKey: string;
  fullText: string;
  segments: BrokerRedistributionSegment[];
  draftAllocations: BrokerRedistributionAllocation[];
}

export interface BrokerRedistributionMove {
  fromIndex: number;
  toIndex: number;
  sentenceCount: number;
}

export interface BrokerRedistributionReview {
  acceptDraft: boolean;
  moves: BrokerRedistributionMove[];
  notes?: string;
}

export interface BrokerRedistributeTextRequest {
  openRouterApiKey: string;
  model?: string;
  serviceTier?: OpenRouterServiceTier;
  reasoningEffort?: DraftReasoningEffort;
  groups: BrokerRedistributionGroup[];
}

export type BrokerRedistributeTextResult =
  | {
      groupId: string;
      ok: true;
      review: BrokerRedistributionReview;
      model: string;
    }
  | {
      groupId: string;
      ok: false;
      error: string;
    };

export interface BrokerRedistributeTextResponse {
  model: string;
  results: BrokerRedistributeTextResult[];
}

export interface AudioCueRewriteContext extends RowRewriteContext {
  audioClips: AudioCueClipInput[];
  tagSystem: string;
}

export type DraftRowStatus = "rewritten" | "unchanged" | "failed";

export interface DraftRowResult {
  rowId: string;
  rewrittenText: string;
  status: DraftRowStatus;
  warnings: string[];
}

export interface DraftSummary {
  totalRows: number;
  rewrittenRows: number;
  unchangedRows: number;
  failedRows: number;
  anomalyCounts: Record<string, number>;
}

export interface DraftGenerationMeta {
  model: string;
  rulePackVersion: string;
  generatedAt: string;
}

export interface GenerateDraftResponse {
  draftRows: DraftRowResult[];
  summary: DraftSummary;
  generationMeta: DraftGenerationMeta;
}

export interface RulePackFile {
  id: DraftingProjectPresetId;
  version: string;
  title: string;
  sourceGuidePath: string;
  constraints: string[];
  rules: string[];
}

export interface ExamplePair {
  input: string;
  output: string;
  rationale: string;
}

export interface LoadedProjectPreset {
  id: DraftingProjectPresetId;
  version: string;
  title: string;
  sourceGuidePath: string;
  constraints: string[];
  rules: string[];
  examples: ExamplePair[];
}

export interface RowRewriteContext {
  currentRow: DraftingTranscriptRowInput;
  audioClips?: AudioCueClipInput[];
  tagSystem?: string;
}

export interface RowValidationResult {
  acceptedText: string;
  status: DraftRowStatus;
  warnings: string[];
  usedFallback: boolean;
}

export interface RewriteRowDeps {
  systemPrompt: string;
  preset: LoadedProjectPreset;
  model: string;
  serviceTier?: OpenRouterServiceTier;
  reasoningEffort?: OpenRouterReasoningEffort;
  testMode: boolean;
}
