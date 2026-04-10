import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PendingTemplateProposalQueueItem, TemplateDefinition } from "./types";

process.env.OPENROUTER_TEST_MODE = "true";

const pendingModule = await import("./pending-template-proposals");
const templateAdminModule = await import("./template-admin");

const {
  appendPendingTemplateProposal,
  listPendingTemplateProposals,
  removePendingTemplateProposal,
  removePendingTemplateProposals
} = pendingModule;
const { findPersistedPendingSuggestionQueueIds } = templateAdminModule;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, {
        recursive: true,
        force: true
      })
    )
  );
});

async function createQueuePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pending-template-proposals-"));
  tempDirs.push(dir);
  return join(dir, "pending-template-proposals.json");
}

function buildQueueItem(
  overrides: Partial<PendingTemplateProposalQueueItem> = {}
): PendingTemplateProposalQueueItem {
  const proposal = {
    proposalId: "proposal-1",
    operation: "create_template" as const,
    category: "Word Accuracy" as const,
    title: "Joined Word",
    description: "Words should be joined.",
    reportTexts: ["Join the word."],
    reason: "Derived from reviewer feedback.",
    sourceCardIds: ["change-1"],
    decision: "approved" as const,
    decidedAt: "2026-03-14T12:00:00.000Z",
    ...(overrides.proposal || {})
  };

  return {
    queueId: "queue-1",
    approvedAt: "2026-03-14T12:00:00.000Z",
    sessionId: "session-1",
    reviewActionId: "review-1",
    ...overrides,
    proposal
  };
}

function template(
  id: string,
  overrides: Partial<TemplateDefinition> = {}
): TemplateDefinition {
  return {
    id,
    title: "Template",
    description: "Description",
    reportTexts: ["Text"],
    priority: 100,
    enabled: true,
    ...overrides
  };
}

describe("pending template proposal queue", () => {
  test("removes a single queue item and returns false when repeated", async () => {
    const queuePath = await createQueuePath();

    await appendPendingTemplateProposal(queuePath, buildQueueItem({ queueId: "queue-a" }));
    await appendPendingTemplateProposal(queuePath, buildQueueItem({ queueId: "queue-b" }));

    expect(await removePendingTemplateProposal(queuePath, "queue-a")).toBe(true);
    expect(await removePendingTemplateProposal(queuePath, "queue-a")).toBe(false);

    const items = await listPendingTemplateProposals(queuePath);
    expect(items.map((item) => item.queueId)).toEqual(["queue-b"]);
  });

  test("removes a batch atomically and ignores missing ids", async () => {
    const queuePath = await createQueuePath();

    await appendPendingTemplateProposal(queuePath, buildQueueItem({ queueId: "queue-a" }));
    await appendPendingTemplateProposal(queuePath, buildQueueItem({ queueId: "queue-b" }));
    await appendPendingTemplateProposal(queuePath, buildQueueItem({ queueId: "queue-c" }));

    const removed = await removePendingTemplateProposals(queuePath, [
      "queue-a",
      "queue-c",
      "queue-missing",
      "queue-a"
    ]);

    expect(removed).toEqual(["queue-c", "queue-a"]);
    expect((await listPendingTemplateProposals(queuePath)).map((item) => item.queueId)).toEqual([
      "queue-b"
    ]);
  });
});

describe("persisted pending suggestion matching", () => {
  test("matches create_template when the staged template was saved", () => {
    const item = buildQueueItem({
      queueId: "queue-create",
      proposal: {
        proposalId: "proposal-create",
        operation: "create_template",
        category: "Word Accuracy",
        title: "Joined Word",
        description: "Words should be joined.",
        reportTexts: ["Join the word."],
        reason: "Reason",
        sourceCardIds: ["change-1"],
        decision: "approved"
      }
    });

    const queueIds = findPersistedPendingSuggestionQueueIds(
      [
        {
          category: "Word Accuracy",
          templates: [
            template("word_accuracy.joined_word", {
              title: "Joined Word",
              description: "Words should be joined.",
              reportTexts: ["Join the word."],
              enabled: true
            })
          ]
        }
      ],
      [item]
    );

    expect(queueIds).toEqual(["queue-create"]);
  });

  test("matches update_template and disable_template only when the saved draft reflects them", () => {
    const updateItem = buildQueueItem({
      queueId: "queue-update",
      proposal: {
        proposalId: "proposal-update",
        operation: "update_template",
        category: "Punctuation & Formatting",
        targetTemplateId: "punctuation_formatting.missing_dash",
        title: "Missing Dash",
        description: "A dash is required here.",
        reportTexts: ["Add the missing dash."],
        reason: "Reason",
        sourceCardIds: ["change-2"],
        decision: "approved"
      }
    });
    const disableItem = buildQueueItem({
      queueId: "queue-disable",
      proposal: {
        proposalId: "proposal-disable",
        operation: "disable_template",
        category: "Tags & Emphasis",
        targetTemplateId: "tags_emphasis.redundant_style_tag",
        title: "Redundant Style Tag",
        description: "Should be disabled.",
        reportTexts: [],
        reason: "Reason",
        sourceCardIds: ["change-3"],
        decision: "approved"
      }
    });
    const staleItem = buildQueueItem({
      queueId: "queue-stale",
      proposal: {
        proposalId: "proposal-stale",
        operation: "update_template",
        category: "Word Accuracy",
        targetTemplateId: "word_accuracy.stale",
        title: "Stale",
        description: "Expected",
        reportTexts: ["Expected text"],
        reason: "Reason",
        sourceCardIds: ["change-4"],
        decision: "approved"
      }
    });

    const queueIds = findPersistedPendingSuggestionQueueIds(
      [
        {
          category: "Punctuation & Formatting",
          templates: [
            template("punctuation_formatting.missing_dash", {
              title: "Missing Dash",
              description: "A dash is required here.",
              reportTexts: ["Add the missing dash."]
            })
          ]
        },
        {
          category: "Tags & Emphasis",
          templates: [
            template("tags_emphasis.redundant_style_tag", {
              title: "Redundant Style Tag",
              description: "Should be disabled.",
              enabled: false
            })
          ]
        },
        {
          category: "Word Accuracy",
          templates: [
            template("word_accuracy.stale", {
              title: "Stale",
              description: "Different description",
              reportTexts: ["Expected text"]
            })
          ]
        }
      ],
      [updateItem, disableItem, staleItem]
    );

    expect(queueIds).toEqual(["queue-update", "queue-disable"]);
  });

  test("integration: remove only the queue items represented by the saved draft", async () => {
    const queuePath = await createQueuePath();
    const persistedCreate = buildQueueItem({
      queueId: "queue-create",
      proposal: {
        proposalId: "proposal-create",
        operation: "create_template",
        category: "Word Accuracy",
        title: "Joined Word",
        description: "Words should be joined.",
        reportTexts: ["Join the word."],
        reason: "Reason",
        sourceCardIds: ["change-1"],
        decision: "approved"
      }
    });
    const pendingUpdate = buildQueueItem({
      queueId: "queue-update",
      proposal: {
        proposalId: "proposal-update",
        operation: "update_template",
        category: "Punctuation & Formatting",
        targetTemplateId: "punctuation_formatting.missing_dash",
        title: "Missing Dash",
        description: "A dash is required here.",
        reportTexts: ["Add the missing dash."],
        reason: "Reason",
        sourceCardIds: ["change-2"],
        decision: "approved"
      }
    });

    await appendPendingTemplateProposal(queuePath, persistedCreate);
    await appendPendingTemplateProposal(queuePath, pendingUpdate);

    const queueIds = findPersistedPendingSuggestionQueueIds(
      [
        {
          category: "Word Accuracy",
          templates: [
            template("word_accuracy.joined_word", {
              title: "Joined Word",
              description: "Words should be joined.",
              reportTexts: ["Join the word."]
            })
          ]
        },
        {
          category: "Punctuation & Formatting",
          templates: [
            template("punctuation_formatting.missing_dash", {
              title: "Missing Dash",
              description: "Old description",
              reportTexts: ["Old text"]
            })
          ]
        }
      ],
      await listPendingTemplateProposals(queuePath)
    );

    expect(queueIds).toEqual(["queue-create"]);
    expect(await removePendingTemplateProposals(queuePath, queueIds)).toEqual(["queue-create"]);
    expect((await listPendingTemplateProposals(queuePath)).map((item) => item.queueId)).toEqual([
      "queue-update"
    ]);
  });
});
