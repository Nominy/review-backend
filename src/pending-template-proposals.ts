import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  CategoryName,
  PendingTemplateProposalQueueItem,
  TemplateSuggestionDecision,
  TemplateSuggestionOperation,
  TemplateSuggestionProposal
} from "./types";

let writeQueueState: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = writeQueueState.then(fn, fn);
  writeQueueState = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseDecision(value: unknown): TemplateSuggestionDecision {
  return value === "approved" || value === "rejected" ? value : "pending";
}

function parseOperation(value: unknown): TemplateSuggestionOperation {
  if (
    value === "create_template" ||
    value === "update_template" ||
    value === "disable_template"
  ) {
    return value;
  }
  throw new Error(`Unsupported proposal operation: ${String(value)}`);
}

function parseProposal(value: unknown): TemplateSuggestionProposal {
  if (!isObject(value)) {
    throw new Error("Proposal must be an object.");
  }

  const category = String(value.category || "").trim() as CategoryName;
  return {
    proposalId: String(value.proposalId || "").trim(),
    operation: parseOperation(value.operation),
    category,
    ...(typeof value.targetTemplateId === "string" && value.targetTemplateId.trim()
      ? { targetTemplateId: value.targetTemplateId.trim() }
      : {}),
    title: String(value.title || "").trim(),
    description: String(value.description || "").trim(),
    reportTexts: toStringArray(value.reportTexts),
    reason: String(value.reason || "").trim(),
    sourceCardIds: toStringArray(value.sourceCardIds),
    decision: parseDecision(value.decision),
    ...(typeof value.decidedAt === "string" && value.decidedAt.trim()
      ? { decidedAt: value.decidedAt.trim() }
      : {})
  };
}

function parseQueueItem(value: unknown): PendingTemplateProposalQueueItem {
  if (!isObject(value)) {
    throw new Error("Queue item must be an object.");
  }

  return {
    queueId: String(value.queueId || "").trim(),
    approvedAt: String(value.approvedAt || "").trim(),
    sessionId: String(value.sessionId || "").trim(),
    reviewActionId: String(value.reviewActionId || "").trim(),
    proposal: parseProposal(value.proposal)
  };
}

async function readQueue(filePath: string): Promise<PendingTemplateProposalQueueItem[]> {
  try {
    const raw = await readFile(resolve(filePath), "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.map(parseQueueItem);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return [];
    }
    throw error;
  }
}

async function writeQueueFile(filePath: string, items: PendingTemplateProposalQueueItem[]): Promise<void> {
  const resolved = resolve(filePath);
  await mkdir(dirname(resolved), { recursive: true });
  await writeFile(resolved, `${JSON.stringify(items, null, 2)}\n`, "utf8");
}

export async function listPendingTemplateProposals(
  filePath: string
): Promise<PendingTemplateProposalQueueItem[]> {
  return readQueue(filePath);
}

export async function appendPendingTemplateProposal(
  filePath: string,
  item: PendingTemplateProposalQueueItem
): Promise<void> {
  await withWriteLock(async () => {
    const items = await readQueue(filePath);
    const existingIndex = items.findIndex((entry) => entry.queueId === item.queueId);
    if (existingIndex >= 0) {
      items[existingIndex] = item;
    } else {
      items.unshift(item);
    }
    await writeQueueFile(filePath, items);
  });
}

export async function removePendingTemplateProposal(
  filePath: string,
  queueId: string
): Promise<boolean> {
  const removed = await removePendingTemplateProposals(filePath, [queueId]);
  return removed.length > 0;
}

export async function removePendingTemplateProposals(
  filePath: string,
  queueIds: string[]
): Promise<string[]> {
  const normalizedIds = [...new Set(queueIds.map((item) => String(item || "").trim()).filter(Boolean))];
  if (!normalizedIds.length) {
    return [];
  }

  return withWriteLock(async () => {
    const items = await readQueue(filePath);
    const queueIdSet = new Set(normalizedIds);
    const keptItems = items.filter((entry) => !queueIdSet.has(entry.queueId));
    if (keptItems.length === items.length) {
      return [];
    }

    await writeQueueFile(filePath, keptItems);
    return items
      .map((entry) => entry.queueId)
      .filter((queueId) => queueIdSet.has(queueId));
  });
}
