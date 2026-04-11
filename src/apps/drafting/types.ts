export type DraftingProjectPresetId = "ru-gold-2sp-v1";

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
  rows: DraftingTranscriptRowInput[];
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
  testMode: boolean;
}
