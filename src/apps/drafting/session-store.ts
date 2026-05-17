import type { DraftingTranscriptRowInput, GenerateDraftRequest, GenerateDraftResponse } from "./types";

type DraftSessionStatus = "running" | "done" | "error";

type DraftSession = {
  id: string;
  fingerprint: string;
  promise: Promise<GenerateDraftResponse>;
  status: DraftSessionStatus;
  response?: GenerateDraftResponse;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

const DRAFT_SESSION_TTL_MS = 30 * 60 * 1000;
const draftSessions = new Map<string, DraftSession>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeRowForFingerprint(row: DraftingTranscriptRowInput): DraftingTranscriptRowInput {
  return {
    rowId: row.rowId,
    speakerKey: row.speakerKey,
    startSeconds: row.startSeconds,
    endSeconds: row.endSeconds,
    text: row.text,
    index: row.index
  };
}

function getDraftSessionFingerprint(request: GenerateDraftRequest): string {
  return JSON.stringify({
    projectPreset: request.projectPreset,
    jobId: request.jobId,
    model: typeof request.model === "string" ? request.model.trim() : "",
    rows: request.rows.map(normalizeRowForFingerprint)
  });
}

function getDraftSessionId(request: GenerateDraftRequest): string {
  return typeof request.draftSessionId === "string" ? request.draftSessionId.trim() : "";
}

function pruneExpiredDraftSessions(now = Date.now()): void {
  for (const [sessionId, session] of draftSessions.entries()) {
    if (now - session.updatedAt > DRAFT_SESSION_TTL_MS) {
      draftSessions.delete(sessionId);
    }
  }
}

export function clearDraftSessionsForTest(): void {
  draftSessions.clear();
}

export function getOrStartDraftSession(
  request: GenerateDraftRequest,
  start: () => Promise<GenerateDraftResponse>
): Promise<GenerateDraftResponse> {
  pruneExpiredDraftSessions();

  const sessionId = getDraftSessionId(request);
  if (!sessionId) {
    return start();
  }

  const fingerprint = getDraftSessionFingerprint(request);
  const existing = draftSessions.get(sessionId);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      throw new Error("draftSessionId must not be reused for a different draft request.");
    }
    existing.updatedAt = Date.now();
    return existing.promise;
  }

  const now = Date.now();
  const session: DraftSession = {
    id: sessionId,
    fingerprint,
    promise: Promise.resolve({} as GenerateDraftResponse),
    status: "running",
    createdAt: now,
    updatedAt: now
  };

  session.promise = Promise.resolve()
    .then(start)
    .then(
      (response) => {
        session.status = "done";
        session.response = response;
        session.updatedAt = Date.now();
        return response;
      },
      (error) => {
        session.status = "error";
        session.error = errorMessage(error);
        session.updatedAt = Date.now();
        throw error;
      }
    );

  draftSessions.set(sessionId, session);
  return session.promise;
}
