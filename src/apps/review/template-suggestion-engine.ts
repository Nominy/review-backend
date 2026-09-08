import { guidelinesPrompt, REVIEW_DATA_BOUNDARY, REVIEW_INTERPRETATION } from "../../shared/guidelines";
import { randomUUID } from "node:crypto";
import { requestOpenRouter, parseModelJson } from "./openrouter";
import { CATEGORIES } from "./rules";
import { getTemplateRegistry } from "./template-registry";
import { isObject } from "../../shared/http";
import type {
  CategoryName,
  ReviewSessionCard,
  ReviewSessionRecord,
  TemplateSuggestionOperation,
  TemplateSuggestionProposal
} from "./types";

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isCategory(value: string): value is CategoryName {
  return CATEGORIES.includes(value as CategoryName);
}

function validateOperation(value: unknown): TemplateSuggestionOperation | null {
  if (
    value === "create_template" ||
    value === "update_template" ||
    value === "disable_template"
  ) {
    return value;
  }
  return null;
}

function normalizeProposal(raw: unknown): TemplateSuggestionProposal | null {
  if (!isObject(raw)) {
    return null;
  }

  const operation = validateOperation(raw.operation);
  const category = String(raw.category || "").trim();
  const title = String(raw.title || "").trim();
  const description = String(raw.description || "").trim();
  const reason = String(raw.reason || "").trim();
  const reportTexts = toStringArray(raw.reportTexts);
  const sourceCardIds = toStringArray(raw.sourceCardIds);
  const targetTemplateId = String(raw.targetTemplateId || "").trim();

  if (!operation || !isCategory(category) || !title || !description || !reason || !sourceCardIds.length) {
    return null;
  }
  if (operation !== "disable_template" && !reportTexts.length) {
    return null;
  }
  if ((operation === "update_template" || operation === "disable_template") && !targetTemplateId) {
    return null;
  }

  return {
    proposalId: randomUUID(),
    operation,
    category,
    ...(targetTemplateId ? { targetTemplateId } : {}),
    title,
    description,
    reportTexts,
    reason,
    sourceCardIds,
    decision: "pending"
  };
}

function describeCard(card: ReviewSessionCard): string {
  if (card.evidence) {
    return `${card.summary} | Evidence: ${card.evidence}`;
  }
  return card.summary;
}

function hasManualTemplateSignal(card: ReviewSessionCard): boolean {
  return card.matchSource === "manual" || card.matchSource === "manual_cleared";
}

function getTemplateSnapshot(input: {
  templateId: string | null;
  title: string | null;
  description: string | null;
}): Record<string, unknown> | null {
  if (!input.templateId && !input.title && !input.description) {
    return null;
  }

  const registry = getTemplateRegistry();
  const liveTemplate = input.templateId ? registry.templatesById.get(input.templateId) || null : null;
  return {
    id: input.templateId,
    title: input.title || liveTemplate?.title || null,
    description: input.description || liveTemplate?.description || null,
    category: liveTemplate?.category || null,
    reportTexts: liveTemplate?.reportTexts || []
  };
}

function buildSessionCommentBundle(session: ReviewSessionRecord): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const card of session.cards) {
    const comment = String(session.comments.cardComments[card.id] || "").trim();
    const manualSignal = hasManualTemplateSignal(card);
    if (!comment && !manualSignal) {
      continue;
    }

    items.push({
      cardId: card.id,
      changeIndex: card.changeIndex,
      type: card.type,
      summary: card.summary,
      evidence: card.evidence,
      categories: card.categories,
      matchSource: card.matchSource,
      matchedTemplateId: card.matchedTemplateId,
      templateTitle: card.templateTitle,
      templateDescription: card.templateDescription,
      initialMatchedTemplate: getTemplateSnapshot({
        templateId: card.initialMatchedTemplateId,
        title: card.initialTemplateTitle,
        description: card.initialTemplateDescription
      }),
      currentMatchedTemplate: getTemplateSnapshot({
        templateId: card.matchedTemplateId,
        title: card.templateTitle,
        description: card.templateDescription
      }),
      opinionText: card.opinionText,
      reviewerComment: comment || null
    });
  }

  if (session.comments.sessionComment.trim()) {
    items.push({
      cardId: "session",
      reviewerComment: session.comments.sessionComment.trim()
    });
  }

  return items;
}

function buildDeterministicSuggestions(session: ReviewSessionRecord): TemplateSuggestionProposal[] {
  const proposals: TemplateSuggestionProposal[] = [];

  for (const card of session.cards) {
    const comment = String(session.comments.cardComments[card.id] || "").trim();
    const manualSignal = hasManualTemplateSignal(card);
    if (!comment && !manualSignal) {
      continue;
    }

    const cardDescription = describeCard(card);
    const reviewerSignal = comment || `Manual template review on ${card.id}.`;

    if (card.matchSource === "manual_cleared" && card.initialMatchedTemplateId) {
      proposals.push({
        proposalId: randomUUID(),
        operation: "disable_template",
        category: card.categories[0] || "Word Accuracy",
        targetTemplateId: card.initialMatchedTemplateId,
        title: card.initialTemplateTitle || `Disable ${card.initialMatchedTemplateId}`,
        description: `Reviewer cleared the matched template for: ${cardDescription}`,
        reportTexts: [],
        reason: `Derived from manual template removal on ${card.id}.`,
        sourceCardIds: [card.id],
        decision: "pending"
      });
      continue;
    }

    if (card.matchedTemplateId) {
      proposals.push({
        proposalId: randomUUID(),
        operation: "update_template",
        category: card.categories[0] || "Word Accuracy",
        targetTemplateId: card.matchedTemplateId,
        title: card.templateTitle || `Update ${card.matchedTemplateId}`,
        description: `Reviewer requested a clearer template for: ${cardDescription}`,
        reportTexts: [reviewerSignal],
        reason: `Derived from reviewer feedback on ${card.id}.`,
        sourceCardIds: [card.id],
        decision: "pending"
      });
    } else {
      proposals.push({
        proposalId: randomUUID(),
        operation: "create_template",
        category: card.categories[0] || "Word Accuracy",
        title: `New pattern from ${card.id}`,
        description: `Reviewer highlighted an uncovered issue for: ${cardDescription}`,
        reportTexts: [reviewerSignal],
        reason: `Derived from reviewer feedback on unmatched ${card.id}.`,
        sourceCardIds: [card.id],
        decision: "pending"
      });
    }
  }

  return proposals;
}

function validateResponse(payload: unknown): TemplateSuggestionProposal[] {
  if (!isObject(payload) || !Array.isArray(payload.proposals)) {
    throw new Error("Template suggestion response must contain a proposals array.");
  }

  const proposals = payload.proposals
    .map((item) => normalizeProposal(item))
    .filter((item): item is TemplateSuggestionProposal => !!item);

  return proposals;
}

export async function generateTemplateSuggestions(args: {
  session: ReviewSessionRecord;
  openRouterApiKey: string;
  model: string;
  testMode: boolean;
}): Promise<TemplateSuggestionProposal[]> {
  const signal = buildSessionCommentBundle(args.session);
  if (!signal.length) {
    return [];
  }

  if (args.testMode) {
    return buildDeterministicSuggestions(args.session);
  }

  const systemPrompt = [
    "Ты предлагаешь улучшения шаблонов замечаний по транскрипции. Заголовки, описания, тексты замечаний и причины пиши по-русски.",
    "Используй комментарии проверяющего и явный ручной выбор или снятие шаблона как основания для предложения.",
    "Допустимы только операции create_template, update_template, disable_template. Идентификаторы и ключи JSON сохраняй без перевода.",
    "Не предлагай менять промпты, шкалу оценивания, классификатор или пороги.",
    "Верни только строгий JSON.", REVIEW_INTERPRETATION, REVIEW_DATA_BOUNDARY
  ].join("\n");

  const userPrompt = [
    guidelinesPrompt(), "Контекст проверки:",
    JSON.stringify(
      {
        reviewActionId: args.session.reviewActionId,
        comments: signal
      },
      null,
      2
    ),
    "",
    "Верни JSON строго по схеме:",
    '{"proposals":[{"operation":"create_template","category":"Word Accuracy","targetTemplateId":"optional","title":"...","description":"...","reportTexts":["..."],"reason":"...","sourceCardIds":["change-1"]}]}',
    "",
    "Правила:",
    "- Предложения должны быть конкретными и применимыми.",
    "- Используй только перечисленные категории с неизменными идентификаторами.",
    "- sourceCardIds ссылается только на идентификаторы карточек из контекста.",
    "- Ручной выбор означает, что проверяющий связал исправление с выбранным шаблоном.",
    "- Ручное снятие означает, что проверяющий отклонил прежний шаблон для этого исправления.",
    "- disable_template используй только если снятие или комментарий указывают на систематическое ложное применение шаблона к несвязанным правкам.",
    "- В остальных случаях уточняй область применения или текст с помощью update_template.",
    "- reportTexts — краткие практические замечания для транскрибатора на русском."
  ].join("\n");

  const content = await requestOpenRouter(args.openRouterApiKey, args.model, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ]);
  const parsed = parseModelJson(content);
  return validateResponse(parsed);
}
