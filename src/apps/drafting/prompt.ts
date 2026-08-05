import type { LoadedProjectPreset, RowRewriteContext } from "./types";

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
    "- Верни только готовую Gold-строку целиком, обычным текстом.",
    "- Не используй JSON, markdown, пояснения, префиксы или кавычки вокруг всей строки.",
    "- Не добавляй никакого лишнего текста."
  ].join("\n");
}

export function buildUserPrompt(context: RowRewriteContext): string {
  const audioCueLines = context.audioClips?.length
    ? [
      "",
      "Audio clips include the exact row plus boundary context. The row timestamps below define which words and events belong to the current row.",
      "Use audio as primary evidence for audible-event tags, punctuation, clearly misheard words, and short boundary interjections.",
      "Scan the whole attached clip, but never copy speech from a neighboring row into the current row.",
      "Correct transcript words only when the audio evidence is clear and the change is small. Recover a missing short interjection such as 'мгм', 'угу', or 'да' only when it is clearly audible inside the current row timing.",
      "Never paraphrase, expand an uncertain phrase, or replace a plausible human word merely because another wording is possible.",
      "When a clear allowed audible cue is present, add the appropriate tag; do not leave clear laughter, coughs, crying, or other allowed audible events untagged just because tags are rare.",
      "Conservative does not mean silently ignoring clear audible events. It means using only allowed tags, avoiding weak guesses, and placing each tag exactly where the event belongs.",
      "Do not tag ordinary breathing, microphone noise, pauses, or unclear background texture.",
      "Most added audio cues should be laughter tags. Other audible-event tags are much rarer and require very clear evidence.",
      "If no useful correction or cue is obvious, leave the row unchanged.",
      "Preserve existing tags unless the audio clearly proves that a tag's type or placement is wrong. A proven correction may relocate or replace that tag only within the current row; never delete a tag merely because evidence is uncertain.",
      "",
      "Audio tag placement grammar:",
      "- Square-bracket tags like [смех] mark a separate audible event. Put them only immediately before the audible event begins. If the event happens after the spoken words, the tag can be at the end of the row because it is still before that event. Do not use square brackets to wrap words.",
      "- Angle tags like <смех-в-речи> ... </смех-в-речи> wrap exactly the words spoken during that vocal event. Use them only when the speech itself is affected, for example words spoken while laughing. Do not wrap silent laughter, background sounds, or unrelated words.",
      "- Do not put separate square laughter tags inside an angle-tagged speech span. If there is separate laughter before or after laughing speech, keep the square tag outside the angle tag.",
      "- Curly-brace tags like {СКАЗ: ...} are not audio-event tags. They belong to text/number normalization only. Never add a curly-brace tag because of the audio, and never invent tags like {смех}.",
      "- Prefer no new tag over a badly placed tag. If timing is unclear, leave the row unchanged.",
      "",
      "Placement examples:",
      "- Laughter before speech: [смех] Да.",
      "- Laughter after speech: Да. [смех]",
      "- Laughing while speaking: Это <смех-в-речи> вопрос. </смех-в-речи>",
      "- Separate laughter plus laughing speech: [смешок] <смех-в-речи> Это смешно. </смех-в-речи> [смех]",
      "- Number reading, not an audio cue: 12 {СКАЗ: двенадцать}",
      "Audio clips:",
      ...context.audioClips.map((clip, index) =>
        `${index + 1}. trackId=${clip.trackId}${clip.speakerKey ? ` speakerKey=${clip.speakerKey}` : ""}${
          clip.trackLabel ? ` trackLabel=${clip.trackLabel}` : ""
        }${clip.clipStartSeconds !== undefined ? ` clipStartSeconds=${clip.clipStartSeconds}` : ""}${
          clip.clipEndSeconds !== undefined ? ` clipEndSeconds=${clip.clipEndSeconds}` : ""
        }`
      ),
      "",
      "Audio tag system:",
      context.tagSystem || "(not supplied)"
    ]
    : [];

  const neighborContextLines = [
    "Контекст соседних строк того же говорящего (только для понимания; не копируй из них слова в текущую строку):",
    context.previousRow
      ? `Предыдущая: time=${context.previousRow.startSeconds ?? "?"}-${context.previousRow.endSeconds ?? "?"} text=${JSON.stringify(context.previousRow.text)}`
      : "Предыдущая: (нет)",
    context.nextRow
      ? `Следующая: time=${context.nextRow.startSeconds ?? "?"}-${context.nextRow.endSeconds ?? "?"} text=${JSON.stringify(context.nextRow.text)}`
      : "Следующая: (нет)",
    ""
  ];

  return [
    "Преобразуй только текущую строку по правилам выше.",
    ...neighborContextLines,
    "Сохраняй исходные слова и порядок слов максимально близко к оригиналу.",
    ...(context.audioClips?.length
      ? [
          "For this audio-backed row, make only evidence-backed word corrections and boundary-interjection recovery described below.",
          "Do not import words or events that fall outside the current row timestamps."
        ]
      : [
          "Do not replace transcript words. Trust the human-written words over any transcription guess.",
          "Allowed edits without audio are only tags, punctuation, and numeric normalization. Do not rewrite vocabulary or turn one word into a different word."
        ]),
    ...(context.audioClips?.length
      ? []
      : [
          "Не удаляй, не переформулируй и не переставляй никакие теги, которые уже были в исходной строке. Сохрани их буквально, включая скобки, регистр, пробелы и позицию относительно слов."
        ]),
    "Если сомневаешься между '-' и '--', предпочитай '--', кроме явного заикания внутри того же слова.",
    "Будь внимателен к пунктуации, особенно вокруг междометий и частиц вроде 'ну', 'а', 'э'. Не превращай их в заикание без явного основания.",
    "Comma-isolate standalone interjections and filler particles. For a row-start interjection, put a comma after it: 'Ну, я думаю'. For a middle interjection, put commas on both sides: 'Я, ну, думаю'. For sentence-final interjections, keep the normal sentence punctuation after the interjection.",
    "Treat standalone forms like 'ну', 'а', 'э', 'мгм', 'угу', 'ага', 'ой', 'ах', 'эх', and 'о' this way when they function as interjections or fillers.",
    "Обращай внимание и на цифры, и на числительные, написанные словами.",
    "Если встречается обычное число, процент, диапазон или время без речевого искажения, нормализуй его как '123 {СКАЗ: ...}', '100 % {СКАЗ: процентов}', '1-2 {СКАЗ: один два}', '4:30 {СКАЗ: четыре тридцать}'. Если число в исходнике написано словом, сначала переведи его в цифры, а потом дай чтение в теге: 'две' -> '2 {СКАЗ: две}'.",
    "Ellipsis rule (strict): never keep or insert '...' in the middle or at the end of the row. Mid/end '...' must become '--' (cut-off) or normal punctuation/removal (mere pause). The ONLY legal '...' is at the very start of the current row, and only when the previous same-speaker segment ends with '--' as a logical continuation: '...continued text'. If the previous segment does not end with '--', strip any leading '...'. Do not use '...' for hesitation, trailing off, uncertainty, or style.",
    "Almost never write М-м. Do not use М-м as a generic hesitation, filler, or replacement for unclear audio. Use it only when the speaker clearly says exactly 'М-м' as a meaningful interjection; otherwise prefer the closest existing words/interjections or leave the text unchanged.",
    ...audioCueLines,
    `Текущая строка: ${JSON.stringify(context.currentRow.text)}`
  ].join("\n");
}
