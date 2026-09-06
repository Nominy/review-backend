import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { isObject } from "./shared/http";
import type {
  BabelDiffPayload,
  ChangeEvidence,
  Change,
  CreateReviewSessionResponse,
  FeedbackItem,
  NormalizedState,
  PreparedPayload,
  ReviewClassification,
  ReviewSessionCard,
  ReviewSessionComments,
  ReviewSessionRecord,
  TemplateMatchSource,
  TemplateSuggestionProposal
} from "./types";

type CreateSessionInput = {
  reviewActionId: string;
  original: NormalizedState;
  current: NormalizedState;
  babelDiff?: BabelDiffPayload | null;
  prepared: PreparedPayload;
  changes: CreateReviewSessionResponse["changes"];
  cards: ReviewSessionCard[];
  categoryFeedback: FeedbackItem[];
  matchedTemplateIds: string[];
  classifications: ReviewClassification[];
};

let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function sessionPath(directory: string, sessionId: string): string {
  return resolve(directory, `${sessionId}.json`);
}

function asOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function parseEvidenceDetail(value: unknown): ChangeEvidence | undefined {
  if (!isObject(value)) {
    return undefined;
  }

  if (value.kind === "text-diff") {
    return {
      kind: "text-diff",
      before: String(value.before || ""),
      after: String(value.after || ""),
      ...(asOptionalString(value.inlineDiff) ? { inlineDiff: asOptionalString(value.inlineDiff) } : {})
    };
  }

  if (value.kind === "raw") {
    return {
      kind: "raw",
      text: String(value.text || "")
    };
  }

  return undefined;
}

function parseComments(value: unknown): ReviewSessionComments {
  if (!isObject(value)) {
    return { sessionComment: "", cardComments: {} };
  }

  const cardComments = isObject(value.cardComments)
    ? Object.fromEntries(
        Object.entries(value.cardComments)
          .filter((entry) => typeof entry[1] === "string")
          .map(([key, item]) => [key, String(item).trim()])
          .filter((entry) => !!entry[1])
      )
    : {};

  return {
    sessionComment: typeof value.sessionComment === "string" ? value.sessionComment.trim() : "",
    cardComments
  };
}

function parseProposals(value: unknown): TemplateSuggestionProposal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item) => isObject(item)) as TemplateSuggestionProposal[];
}

function parseChange(value: unknown): Change | null {
  if (!isObject(value)) {
    return null;
  }

  const description = String(value.description || "").trim();
  const summary = String(value.summary || description || "Change").trim();
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((item): item is Change["categories"][number] => typeof item === "string")
    : [];

  return {
    index: Number(value.index) || 0,
    type: String(value.type || "TEXT") as Change["type"],
    categories,
    summary,
    evidence: String(value.evidence || description || "").trim(),
    ...(parseEvidenceDetail(value.evidenceDetail) ? { evidenceDetail: parseEvidenceDetail(value.evidenceDetail) } : {}),
    description
  };
}

function parseCard(value: unknown): ReviewSessionCard | null {
  if (!isObject(value)) {
    return null;
  }

  const legacyDescription = String(value.description || "").trim();
  const summary = String(value.summary || legacyDescription || "Change").trim();
  const categories = Array.isArray(value.categories)
    ? value.categories.filter((item): item is ReviewSessionCard["categories"][number] => typeof item === "string")
    : [];

  return {
    id: String(value.id || "").trim(),
    changeIndex: Number(value.changeIndex) || 0,
    type: String(value.type || "TEXT") as ReviewSessionCard["type"],
    summary,
    evidence: String(value.evidence || value.beforeText || legacyDescription || "").trim(),
    ...(parseEvidenceDetail(value.evidenceDetail) ? { evidenceDetail: parseEvidenceDetail(value.evidenceDetail) } : {}),
    categories,
    matchedTemplateId: asOptionalString(value.matchedTemplateId) || null,
    templateTitle: asOptionalString(value.templateTitle) || null,
    templateDescription: asOptionalString(value.templateDescription) || null,
    initialMatchedTemplateId:
      asOptionalString(value.initialMatchedTemplateId) ||
      asOptionalString(value.matchedTemplateId) ||
      null,
    initialTemplateTitle:
      asOptionalString(value.initialTemplateTitle) ||
      asOptionalString(value.templateTitle) ||
      null,
    initialTemplateDescription:
      asOptionalString(value.initialTemplateDescription) ||
      asOptionalString(value.templateDescription) ||
      null,
    matchSource:
      (asOptionalString(value.matchSource) as TemplateMatchSource | undefined) ||
      (asOptionalString(value.matchedTemplateId) ? "model" : "unmatched"),
    opinionText: String(value.opinionText || "").trim(),
    rationale: String(value.rationale || "").trim()
  };
}

function parseSession(value: unknown): ReviewSessionRecord {
  if (!isObject(value)) {
    throw new Error("Session payload must be an object.");
  }

  const changes = Array.isArray(value.changes)
    ? value.changes.map((item) => parseChange(item)).filter((item): item is Change => !!item)
    : [];
  const changesByIndex = new Map(changes.map((change) => [change.index, change]));
  const cards = Array.isArray(value.cards)
    ? value.cards
        .map((item) => parseCard(item))
        .filter((item): item is ReviewSessionCard => !!item)
        .map((card) => {
          const matchingChange = changesByIndex.get(card.changeIndex);
          return {
            ...card,
            summary:
              card.summary && card.summary !== "Change"
                ? card.summary
                : matchingChange?.summary || card.summary,
            ...(!card.evidenceDetail && matchingChange?.evidenceDetail
              ? { evidenceDetail: matchingChange.evidenceDetail }
              : {}),
            ...(!card.evidence && matchingChange?.evidence
              ? { evidence: matchingChange.evidence }
              : {})
          };
        })
    : [];

  return {
    sessionId: String(value.sessionId || "").trim(),
    createdAt: String(value.createdAt || "").trim(),
    updatedAt: String(value.updatedAt || "").trim(),
    reviewActionId: String(value.reviewActionId || "").trim(),
    original: value.original as NormalizedState,
    current: value.current as NormalizedState,
    ...(value.babelDiff ? { babelDiff: value.babelDiff as BabelDiffPayload } : {}),
    prepared: value.prepared as PreparedPayload,
    changes,
    cards,
    categoryFeedback: Array.isArray(value.categoryFeedback) ? (value.categoryFeedback as FeedbackItem[]) : [],
    matchedTemplateIds: Array.isArray(value.matchedTemplateIds)
      ? value.matchedTemplateIds.filter((item): item is string => typeof item === "string")
      : [],
    classifications: Array.isArray(value.classifications)
      ? (value.classifications as ReviewClassification[])
      : [],
    comments: parseComments(value.comments),
    proposals: parseProposals(value.proposals)
  };
}

async function writeSession(directory: string, session: ReviewSessionRecord): Promise<void> {
  const filePath = sessionPath(directory, session.sessionId);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export async function createReviewSession(
  directory: string,
  input: CreateSessionInput
): Promise<ReviewSessionRecord> {
  return withWriteLock(async () => {
    const now = new Date().toISOString();
    const session: ReviewSessionRecord = {
      sessionId: randomUUID(),
      createdAt: now,
      updatedAt: now,
      reviewActionId: input.reviewActionId,
      original: input.original,
      current: input.current,
      ...(input.babelDiff ? { babelDiff: input.babelDiff } : {}),
      prepared: input.prepared,
      changes: input.changes,
      cards: input.cards,
      categoryFeedback: input.categoryFeedback,
      matchedTemplateIds: input.matchedTemplateIds,
      classifications: input.classifications,
      comments: {
        sessionComment: "",
        cardComments: {}
      },
      proposals: []
    };

    await writeSession(directory, session);
    return session;
  });
}

export async function getReviewSession(
  directory: string,
  sessionId: string
): Promise<ReviewSessionRecord | null> {
  try {
    const raw = await readFile(sessionPath(directory, sessionId), "utf8");
    return parseSession(JSON.parse(raw) as unknown);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function updateReviewSession(
  directory: string,
  sessionId: string,
  updater: (session: ReviewSessionRecord) => ReviewSessionRecord
): Promise<ReviewSessionRecord> {
  return withWriteLock(async () => {
    const session = await getReviewSession(directory, sessionId);
    if (!session) {
      throw new Error("Review session not found.");
    }

    const next = updater(session);
    next.updatedAt = new Date().toISOString();
    await writeSession(directory, next);
    return next;
  });
}

