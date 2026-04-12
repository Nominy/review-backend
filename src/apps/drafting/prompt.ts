import type { LoadedProjectPreset, RowRewriteContext } from "./types";

const RESPONSE_SCHEMA = "{\"rewrittenText\":\"...\"}";

export function buildSystemPrompt(preset: LoadedProjectPreset): string {
  const exampleLines = preset.examples
    .map((example, index) =>
      [
        `Пример ${index + 1}:`,
        `Silver: ${JSON.stringify(example.input)}`,
        `Gold: ${JSON.stringify(example.output)}`,
        `Пояснение: ${example.rationale}`
      ].join("\n")
    )
    .join("\n\n");

  return [
    `Ты приводишь одну строку транскрипта из Silver к Gold для проекта ${preset.title}.`,
    `Версия rule pack: ${preset.version}.`,
    "",
    "Ниже приведены правила, которым нужно следовать строго.",
    "",
    "Правила и ограничения:",
    ...preset.constraints.map((rule, index) => `${index + 1}. ${rule}`),
    ...preset.rules.map((rule, index) => `${preset.constraints.length + index + 1}. ${rule}`),
    "",
    "Примеры:",
    exampleLines,
    "",
    "Формат ответа:",
    "- Верни строго JSON.",
    `- Используй ровно такую схему: ${RESPONSE_SCHEMA}`,
    "- Не добавляй никакого лишнего текста."
  ].join("\n");
}

export function buildUserPrompt(context: RowRewriteContext): string {
  return [
    "Преобразуй только текущую строку по правилам выше.",
    "Сохраняй исходные слова и порядок слов максимально близко к оригиналу.",
    "Если сомневаешься между '-' и '--', предпочитай '--', кроме явного заикания внутри того же слова.",
    "Будь внимателен к пунктуации, особенно вокруг междометий и частиц вроде 'ну', 'а', 'э'. Не превращай их в заикание без явного основания.",
    "Обращай внимание и на цифры, и на числительные, написанные словами.",
    "Если встречается обычное число, процент, диапазон или время без речевого искажения, нормализуй его как '123 {СКАЗ: ...}', '100 % {СКАЗ: процентов}', '1-2 {СКАЗ: один два}', '4:30 {СКАЗ: четыре тридцать}'.",
    `Текущая строка: ${JSON.stringify(context.currentRow.text)}`
  ].join("\n");
}
