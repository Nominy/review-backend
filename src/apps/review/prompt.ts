import { guidelinesPrompt, REVIEW_DATA_BOUNDARY, REVIEW_INTERPRETATION, CATEGORY_LABELS } from "../../shared/guidelines";
import { extractChanges, getRelevantCategories } from "./change-extractor";
import type { Change, PromptPacket, TemplatePromptCatalog } from "./types";

/**
 * Builds the system + user prompts using the change-list approach.
 *
 * Instead of dumping the full PromptPacket as JSON, we:
 * 1. Extract a flat, numbered Change[] list from the packet
 * 2. Build a human-readable numbered list in the user prompt
 * 3. Include only the template catalog sections relevant to the change types present
 * 4. Ask the LLM to classify each change by number -> templateId
 */

const RESPONSE_SCHEMA = '{"classifications": [{"change": 1, "templateId": "category.template_id"}]}';

export function buildSystemPrompt(): string {
  return [
    "Ты проверяешь ошибки транскрипции Babel Audio и сопоставляешь обоснованные замечания с каталогом шаблонов.",
    "Исходная версия — работа L1; исправленная — версия L2. Версия L2 считается эталоном.",
    REVIEW_INTERPRETATION,
    "Структурные типы изменений — технические метки: TEXT CHANGE — текст; TIMESTAMP SHIFT — границы устойчивого сегмента 1:1; SEG ADDED/DELETED/SPLIT/MERGED — добавление, удаление, разбиение или объединение.",
    "Используй только идентификаторы из каталога. На одну правку выбирай не более одного наиболее точного шаблона. Один шаблон может объяснять несколько правок. Не добавляй общее замечание, если ту же ошибку уже объясняет специальное.",
    "Пропускай служебные действия без штрафа по руководству и правки, для которых нет подходящего шаблона. Не переоценивай правильность L2.",
    REVIEW_DATA_BOUNDARY,
    "Верни только строгий JSON без Markdown и пояснений вне JSON по схеме:",
    RESPONSE_SCHEMA,
    'Если замечаний нет, верни {"classifications": []}.'
  ].join("\n");
}

function formatChangeList(changes: Change[]): string {
  if (changes.length === 0) {
    return "(изменений нет)";
  }

  return changes
    .map((c) => `${c.index}. [${c.type}] ${c.description}`)
    .join("\n");
}

function buildScopedCatalog(
  changes: Change[],
  fullCatalog: TemplatePromptCatalog
): string {
  const relevant = getRelevantCategories(changes);

  const sections: string[] = [];

  for (const category of Object.keys(fullCatalog) as Array<keyof TemplatePromptCatalog>) {
    if (!relevant.has(category)) continue;

    const templates = fullCatalog[category];
    if (!templates || templates.length === 0) continue;

    const lines = templates.map((t) => `  - ${t.id}: ${t.description}`);
    sections.push(`${CATEGORY_LABELS[category]} (${category}):\n${lines.join("\n")}`);
  }

  if (sections.length === 0) {
    return "(подходящих шаблонов нет)";
  }

  return sections.join("\n\n");
}

function buildUserPrompt(
  changes: Change[],
  fullCatalog: TemplatePromptCatalog
): string {
  return [
    "Сопоставь каждое исправление L2 с подходящим шаблоном из каталога.",
    "",
    "Изменения:",
    formatChangeList(changes),
    "",
    "Каталог шаблонов:",
    buildScopedCatalog(changes, fullCatalog),
    "", guidelinesPrompt(), REVIEW_DATA_BOUNDARY,
  ].join("\n");
}

export function buildPrompts(
  promptPacket: PromptPacket,
  templateCatalog: TemplatePromptCatalog
): {
  systemPrompt: string;
  userPrompt: string;
  preview: string;
} {
  const changes = extractChanges(promptPacket);
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(changes, templateCatalog);

  return {
    systemPrompt,
    userPrompt,
    preview: `СИСТЕМНЫЕ ИНСТРУКЦИИ:\n${systemPrompt}\n\nДАННЫЕ ПРОВЕРКИ:\n${userPrompt}`,
  };
}
