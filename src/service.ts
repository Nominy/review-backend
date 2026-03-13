import { computeReviewMetrics } from "./metrics";
import { buildPrompts } from "./prompt";
import { sendToOpenRouter } from "./openrouter";
import { runDeterministicRules } from "./deterministic-rules";
import { config } from "./config";
import { logReviewTextPair } from "./review-pair-logger";
import { logReviewAnalytics } from "./analytics-logger";
import { getTemplateRegistry } from "./template-registry";
import {
  createReviewSession as createStoredReviewSession,
  getReviewSession,
  updateReviewSession
} from "./review-sessions";
import { appendPendingTemplateProposal } from "./pending-template-proposals";
import { renderFeedbackFromTemplateMatches, renderTemplateOpinionText } from "./template-renderer";
import { extractChanges } from "./change-extractor";
import { generateTemplateSuggestions } from "./template-suggestion-engine";
import type {
  AnalyticsEventType,
  BabelDiffPayload,
  CreateReviewSessionResponse,
  FinalizeReviewSessionResponse,
  GenerateResponse,
  NormalizedState,
  PendingTemplateProposalQueueItem,
  PreparedPayload,
  ReviewClassification,
  ReviewSessionCard,
  ReviewSessionRecord,
  SubmitTranscriptReviewAnalyticsResponse,
  TemplateSuggestionProposal
} from "./types";

function buildPreparedPayload(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
}): PreparedPayload {
  const computed = computeReviewMetrics(
    input.original,
    input.current,
    input.reviewActionId,
    input.babelDiff
  );
  const registry = getTemplateRegistry();
  const prompts = buildPrompts(computed.promptPacket, registry.promptCatalog);

  return {
    preparedAt: new Date().toISOString(),
    stats: computed.stats,
    featurePacket: computed.featurePacket,
    promptPacket: computed.promptPacket,
    metricsVersion: computed.metricsVersion,
    promptVersion: computed.promptPacket.session.promptVersion,
    prompts
  };
}

async function safeLogAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  prepared: PreparedPayload;
  babelDiff?: BabelDiffPayload | null;
  aiReview?: unknown;
  inputBoxes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  eventType: AnalyticsEventType;
}): Promise<void> {
  try {
    await logReviewAnalytics({
      eventType: input.eventType,
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      prepared: input.prepared,
      babelDiff: input.babelDiff,
      aiReview: input.aiReview,
      inputBoxes: input.inputBoxes,
      metadata: input.metadata,
      logPath: config.analyticsLogPath
    });
  } catch (error) {
    console.error(
      `[babel-review-backend] failed to write analytics log: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

function toSessionResponse(session: ReviewSessionRecord): CreateReviewSessionResponse {
  const registry = getTemplateRegistry();
  return {
    sessionId: session.sessionId,
    reviewActionId: session.reviewActionId,
    prepared: session.prepared,
    changes: session.changes,
    cards: session.cards,
    categoryFeedback: session.categoryFeedback,
    comments: session.comments,
    suggestions: session.proposals,
    proposals: session.proposals,
    aiReview: {
      feedback: session.categoryFeedback,
      rawContent: "",
      model: config.openRouterTestMode ? "session-store" : config.openRouterModel,
      latencyMs: 0,
      receivedAt: session.updatedAt,
      matchedTemplateIds: session.matchedTemplateIds,
      classifications: session.classifications,
      templateRegistryVersion: registry.registryVersion
    }
  };
}

function buildCardRationale(card: {
  templateTitle: string | null;
  templateDescription: string | null;
  matchedTemplateId: string | null;
}): string {
  if (!card.matchedTemplateId) {
    return "No system issue selected for this change yet.";
  }

  if (card.templateTitle && card.templateDescription) {
    return `${card.templateTitle}: ${card.templateDescription}`;
  }
  if (card.templateTitle) {
    return card.templateTitle;
  }
  if (card.templateDescription) {
    return card.templateDescription;
  }
  return `Matched template ${card.matchedTemplateId}.`;
}

function buildSessionCards(input: {
  reviewActionId: string;
  changes: CreateReviewSessionResponse["changes"];
  classifications: ReviewClassification[];
}): ReviewSessionCard[] {
  const registry = getTemplateRegistry();
  const byChange = new Map<number, ReviewClassification>();
  for (const classification of input.classifications) {
    if (!byChange.has(classification.change)) {
      byChange.set(classification.change, classification);
    }
  }

  return input.changes.map((change) => {
    const match = byChange.get(change.index) || null;
    const template = match ? registry.templatesById.get(match.templateId) || null : null;
    const opinionText = template
      ? renderTemplateOpinionText(template, input.reviewActionId)
      : "No system issue selected.";
    const card: ReviewSessionCard = {
      id: `change-${change.index}`,
      changeIndex: change.index,
      type: change.type,
      summary: change.summary,
      ...(change.beforeText ? { beforeText: change.beforeText } : {}),
      ...(change.afterText ? { afterText: change.afterText } : {}),
      categories: change.categories,
      matchedTemplateId: template?.id || null,
      templateTitle: template?.title || null,
      templateDescription: template?.description || null,
      opinionText,
      rationale: ""
    };
    card.rationale = buildCardRationale(card);
    return card;
  });
}

function buildLlmResult(input: {
  reviewActionId: string;
  prepared: PreparedPayload;
  rawContent: string;
  model: string;
  latencyMs: number;
  receivedAt: string;
  matchedTemplateIds: string[];
  classifications: ReviewClassification[];
  repaired?: boolean;
}): GenerateResponse {
  const registry = getTemplateRegistry();
  const rendered = renderFeedbackFromTemplateMatches(
    input.reviewActionId,
    input.matchedTemplateIds,
    registry
  );

  return {
    prepared: input.prepared,
    llm: {
      feedback: rendered.feedback,
      rawContent: input.rawContent,
      model: input.model,
      latencyMs: input.latencyMs,
      receivedAt: input.receivedAt,
      matchedTemplateIds: rendered.matchedTemplateIds,
      classifications: input.classifications,
      templateRegistryVersion: registry.registryVersion,
      ...(input.repaired ? { repaired: true } : {})
    }
  };
}

async function computeReviewOutcome(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
}): Promise<{
  prepared: PreparedPayload;
  llm: GenerateResponse["llm"];
  changes: CreateReviewSessionResponse["changes"];
  cards: ReviewSessionCard[];
}> {
  const prepared = buildPreparedPayload(input);
  const deterministicFindings = runDeterministicRules(prepared.promptPacket);
  const changes = extractChanges(prepared.promptPacket);

  let rawContent = JSON.stringify({ classifications: [] });
  let model = config.openRouterTestMode ? "test-mode" : config.openRouterModel;
  let latencyMs = 0;
  let receivedAt = new Date().toISOString();
  let classifications: ReviewClassification[] = [];
  let llmFindings: string[] = [];
  let repaired = false;

  if (!config.openRouterTestMode) {
    const llmSelection = await sendToOpenRouter({
      apiKey: config.openRouterApiKey,
      model: config.openRouterModel,
      prompts: prepared.prompts,
      registry: getTemplateRegistry()
    });

    rawContent = llmSelection.rawContent;
    model = llmSelection.model;
    latencyMs = llmSelection.latencyMs;
    receivedAt = llmSelection.receivedAt;
    classifications = llmSelection.classifications;
    llmFindings = llmSelection.findings;
    repaired = !!llmSelection.repaired;
  }

  const seen = new Set<string>(deterministicFindings);
  const mergedFindings = [...deterministicFindings];
  for (const id of llmFindings) {
    if (!seen.has(id)) {
      seen.add(id);
      mergedFindings.push(id);
    }
  }

  const result = buildLlmResult({
    reviewActionId: input.reviewActionId,
    prepared,
    rawContent,
    model,
    latencyMs,
    receivedAt,
    matchedTemplateIds: mergedFindings,
    classifications,
    repaired
  });

  return {
    prepared: result.prepared,
    llm: result.llm,
    changes,
    cards: buildSessionCards({
      reviewActionId: input.reviewActionId,
      changes,
      classifications
    })
  };
}

export { buildPreparedPayload };

export async function generateFeedback(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
}): Promise<GenerateResponse> {
  try {
    await logReviewTextPair({
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      logPath: config.reviewPairLogPath
    });
  } catch (error) {
    console.error(
      `[babel-review-backend] failed to write review pair log: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  const outcome = await computeReviewOutcome(input);
  const result: GenerateResponse = {
    prepared: outcome.prepared,
    llm: outcome.llm
  };

  await safeLogAnalytics({
    eventType: "review_generate",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
    prepared: result.prepared,
    aiReview: result.llm,
    metadata: {
      source: "generateFeedback",
      testMode: config.openRouterTestMode,
      templateRegistryVersion: result.llm.templateRegistryVersion
    }
  });

  return result;
}

export async function createInteractiveReviewSession(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
}): Promise<CreateReviewSessionResponse> {
  const outcome = await computeReviewOutcome(input);
  const session = await createStoredReviewSession(config.reviewSessionsDir, {
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
    prepared: outcome.prepared,
    changes: outcome.changes,
    cards: outcome.cards,
    categoryFeedback: outcome.llm.feedback,
    matchedTemplateIds: outcome.llm.matchedTemplateIds,
    classifications: outcome.llm.classifications
  });

  await safeLogAnalytics({
    eventType: "review_session_created",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
    prepared: outcome.prepared,
    aiReview: {
      feedback: outcome.llm.feedback,
      matchedTemplateIds: outcome.llm.matchedTemplateIds,
      classifications: outcome.llm.classifications,
      templateRegistryVersion: outcome.llm.templateRegistryVersion
    },
    metadata: {
      sessionId: session.sessionId,
      cardCount: session.cards.length
    }
  });

  return toSessionResponse(session);
}

export async function getInteractiveReviewSession(sessionId: string): Promise<CreateReviewSessionResponse> {
  const session = await getReviewSession(config.reviewSessionsDir, sessionId);
  if (!session) {
    throw new Error("Review session not found.");
  }

  await safeLogAnalytics({
    eventType: "review_session_opened",
    reviewActionId: session.reviewActionId,
    original: session.original,
    current: session.current,
    babelDiff: session.babelDiff,
    prepared: session.prepared,
    aiReview: {
      feedback: session.categoryFeedback,
      matchedTemplateIds: session.matchedTemplateIds,
      classifications: session.classifications
    },
    metadata: {
      sessionId: session.sessionId
    }
  });

  return toSessionResponse(session);
}

export async function updateInteractiveReviewSessionComments(input: {
  sessionId: string;
  cardComments?: Record<string, unknown>;
  sessionComment?: string;
}): Promise<CreateReviewSessionResponse> {
  const session = await updateReviewSession(config.reviewSessionsDir, input.sessionId, (current) => {
    const nextCardComments = { ...current.comments.cardComments };
    if (input.cardComments && typeof input.cardComments === "object") {
      for (const [cardId, value] of Object.entries(input.cardComments)) {
        const text = typeof value === "string" ? value.trim() : "";
        if (text) {
          nextCardComments[cardId] = text;
        } else {
          delete nextCardComments[cardId];
        }
      }
    }

    return {
      ...current,
      comments: {
        sessionComment:
          typeof input.sessionComment === "string"
            ? input.sessionComment.trim()
            : current.comments.sessionComment,
        cardComments: nextCardComments
      }
    };
  });

  await safeLogAnalytics({
    eventType: "review_card_commented",
    reviewActionId: session.reviewActionId,
    original: session.original,
    current: session.current,
    babelDiff: session.babelDiff,
    prepared: session.prepared,
    metadata: {
      sessionId: session.sessionId,
      commentedCardIds: Object.keys(input.cardComments || {}),
      hasSessionComment: typeof input.sessionComment === "string" && !!input.sessionComment.trim()
    }
  });

  return toSessionResponse(session);
}

export async function generateInteractiveTemplateSuggestions(input: {
  sessionId: string;
}): Promise<CreateReviewSessionResponse> {
  const existing = await getReviewSession(config.reviewSessionsDir, input.sessionId);
  if (!existing) {
    throw new Error("Review session not found.");
  }

  const proposals = await generateTemplateSuggestions({
    session: existing,
    openRouterApiKey: config.openRouterApiKey,
    model: config.openRouterModel,
    testMode: config.openRouterTestMode
  });

  const session = await updateReviewSession(config.reviewSessionsDir, input.sessionId, (current) => ({
    ...current,
    proposals
  }));

  await safeLogAnalytics({
    eventType: "template_suggestions_generated",
    reviewActionId: session.reviewActionId,
    original: session.original,
    current: session.current,
    babelDiff: session.babelDiff,
    prepared: session.prepared,
    aiReview: {
      proposals: session.proposals
    },
    metadata: {
      sessionId: session.sessionId,
      proposalCount: session.proposals.length
    }
  });

  return toSessionResponse(session);
}

export async function decideInteractiveTemplateSuggestion(input: {
  sessionId: string;
  proposalId: string;
  decision: "approved" | "rejected";
}): Promise<CreateReviewSessionResponse> {
  const session = await updateReviewSession(config.reviewSessionsDir, input.sessionId, (current) => {
    const proposals = current.proposals.map((proposal) => {
      if (proposal.proposalId !== input.proposalId) {
        return proposal;
      }
      return {
        ...proposal,
        decision: input.decision,
        decidedAt: new Date().toISOString()
      };
    });

    return {
      ...current,
      proposals
    };
  });

  const proposal = session.proposals.find((item) => item.proposalId === input.proposalId);
  if (!proposal) {
    throw new Error("Template suggestion not found.");
  }

  if (input.decision === "approved") {
    const queueItem: PendingTemplateProposalQueueItem = {
      queueId: proposal.proposalId,
      approvedAt: proposal.decidedAt || new Date().toISOString(),
      sessionId: session.sessionId,
      reviewActionId: session.reviewActionId,
      proposal
    };
    await appendPendingTemplateProposal(config.pendingTemplateProposalPath, queueItem);
  }

  await safeLogAnalytics({
    eventType:
      input.decision === "approved"
        ? "template_suggestion_approved"
        : "template_suggestion_rejected",
    reviewActionId: session.reviewActionId,
    original: session.original,
    current: session.current,
    babelDiff: session.babelDiff,
    prepared: session.prepared,
    aiReview: {
      proposal
    },
    metadata: {
      sessionId: session.sessionId,
      proposalId: proposal.proposalId,
      operation: proposal.operation
    }
  });

  return toSessionResponse(session);
}

export async function finalizeInteractiveReviewSession(input: {
  sessionId: string;
  mode: "skip" | "apply";
}): Promise<FinalizeReviewSessionResponse> {
  const session = await getReviewSession(config.reviewSessionsDir, input.sessionId);
  if (!session) {
    throw new Error("Review session not found.");
  }

  await safeLogAnalytics({
    eventType: input.mode === "skip" ? "interactive_session_skipped" : "interactive_review_applied",
    reviewActionId: session.reviewActionId,
    original: session.original,
    current: session.current,
    babelDiff: session.babelDiff,
    prepared: session.prepared,
    aiReview: {
      feedback: session.categoryFeedback,
      proposals: session.proposals
    },
    metadata: {
      sessionId: session.sessionId,
      mode: input.mode
    }
  });

  return {
    sessionId: session.sessionId,
    reviewActionId: session.reviewActionId,
    categoryFeedback: session.categoryFeedback,
    appliedAt: new Date().toISOString(),
    mode: input.mode,
    aiReview: toSessionResponse(session).aiReview
  };
}

export async function submitTranscriptReviewActionAnalytics(input: {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
  inputBoxes?: Record<string, unknown>;
  aiReview?: unknown;
  metadata?: Record<string, unknown>;
}): Promise<SubmitTranscriptReviewAnalyticsResponse> {
  const prepared = buildPreparedPayload({
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff
  });

  await safeLogAnalytics({
    eventType: "submit_transcript_review_action",
    reviewActionId: input.reviewActionId,
    original: input.original,
    current: input.current,
    babelDiff: input.babelDiff,
    prepared,
    aiReview: input.aiReview ?? null,
    inputBoxes: input.inputBoxes ?? {},
    metadata: input.metadata ?? {}
  });

  return {
    ok: true,
    savedAt: new Date().toISOString(),
    reviewActionId: input.reviewActionId,
    prepared
  };
}

