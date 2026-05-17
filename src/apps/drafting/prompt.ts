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
      "Audio clips for this exact row are attached to the same request.",
      "Use the audio only to add conservative audible-cue tags to the final Gold row.",
      "Scan the whole attached row clip before deciding that no tag is needed.",
      "When a clear allowed audible cue is present, add the appropriate tag; do not leave clear laughter, coughs, crying, or other allowed audible events untagged just because tags are rare.",
      "Conservative does not mean silently ignoring clear audible events. It means using only allowed tags, avoiding weak guesses, and placing each tag exactly where the event belongs.",
      "Do not tag ordinary breathing, microphone noise, pauses, or unclear background texture.",
      "Most added audio cues should be laughter tags. Other audible-event tags are much rarer and require very clear evidence.",
      "If no useful cue is obvious, do not add any audio cue tag.",
      "Use only exact tag spellings from the audio tag system below, and preserve all existing tags literally.",
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
        }`
      ),
      "",
      "Audio tag system:",
      context.tagSystem || "(not supplied)"
    ]
    : [];

  return [
    "Преобразуй только текущую строку по правилам выше.",
    "Сохраняй исходные слова и порядок слов максимально близко к оригиналу.",
    "Do not replace transcript words. Trust the human-written words over the audio and over your own transcription guess. The audio is only evidence for tags and very small formatting choices.",
    "Allowed edits are only tags, punctuation, and numeric normalization. Do not rewrite vocabulary, do not replace short interjections, and do not turn one word into a different word.",
    "Не удаляй, не переформулируй и не переставляй никакие теги, которые уже были в исходной строке. Сохрани их буквально, включая скобки, регистр, пробелы и позицию относительно слов.",
    "Если сомневаешься между '-' и '--', предпочитай '--', кроме явного заикания внутри того же слова.",
    "Будь внимателен к пунктуации, особенно вокруг междометий и частиц вроде 'ну', 'а', 'э'. Не превращай их в заикание без явного основания.",
    "Comma-isolate standalone interjections and filler particles. For a row-start interjection, put a comma after it: 'Ну, я думаю'. For a middle interjection, put commas on both sides: 'Я, ну, думаю'. For sentence-final interjections, keep the normal sentence punctuation after the interjection.",
    "Treat standalone forms like 'ну', 'а', 'э', 'мгм', 'угу', 'ага', 'ой', 'ах', 'эх', and 'о' this way when they function as interjections or fillers.",
    "Обращай внимание и на цифры, и на числительные, написанные словами.",
    "Если встречается обычное число, процент, диапазон или время без речевого искажения, нормализуй его как '123 {СКАЗ: ...}', '100 % {СКАЗ: процентов}', '1-2 {СКАЗ: один два}', '4:30 {СКАЗ: четыре тридцать}'. Если число в исходнике написано словом, сначала переведи его в цифры, а потом дай чтение в теге: 'две' -> '2 {СКАЗ: две}'.",
    "Never insert ... inside the row text. Only use ... at the very beginning of a row when the row continues from a cut previous segment. Do not use ... for pauses, hesitation, uncertainty, trailing off, laughter, or missing audio inside the row.",
    "Almost never write М-м. Do not use М-м as a generic hesitation, filler, or replacement for unclear audio. Use it only when the speaker clearly says exactly 'М-м' as a meaningful interjection; otherwise prefer the closest existing words/interjections or leave the text unchanged.",
    ...audioCueLines,
    `Текущая строка: ${JSON.stringify(context.currentRow.text)}`
  ].join("\n");
}
