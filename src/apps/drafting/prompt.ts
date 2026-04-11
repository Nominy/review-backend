import type { LoadedProjectPreset, RowRewriteContext } from "./types";

const RESPONSE_SCHEMA = "{\"rewrittenText\":\"...\"}";

function formatRows(rows: Array<{ index: number; speakerKey: string; text: string }>): string {
  if (!rows.length) {
    return "(none)";
  }

  return rows
    .map((row) => `[${row.index + 1}] speaker=${row.speakerKey || "unknown"} text=${JSON.stringify(row.text)}`)
    .join("\n");
}

export function buildSystemPrompt(preset: LoadedProjectPreset): string {
  const exampleLines = preset.examples
    .map((example, index) => {
      return [
        `Example ${index + 1}:`,
        `Input: ${JSON.stringify(example.input)}`,
        `Output: ${JSON.stringify(example.output)}`,
        `Reason: ${example.rationale}`
      ].join("\n");
    })
    .join("\n\n");

  return [
    `You are a Silver-to-Gold transcript rewriting model for ${preset.title}.`,
    `Rule pack version: ${preset.version}.`,
    `Source guide path: ${preset.sourceGuidePath}.`,
    "",
    "Hard constraints:",
    ...preset.constraints.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    "Project rules:",
    ...preset.rules.map((rule, index) => `${index + 1}. ${rule}`),
    "",
    "Examples:",
    exampleLines,
    "",
    "Output rules:",
    "- Return strict JSON only.",
    `- Use exactly this schema: ${RESPONSE_SCHEMA}`,
    "- Do not include any explanation, markdown, or surrounding text."
  ].join("\n");
}

export function buildUserPrompt(context: RowRewriteContext): string {
  return [
    "Rewrite only the current row into Gold style.",
    "",
    "Previous original rows:",
    formatRows(context.previousOriginalRows),
    "",
    "Previous accepted rewritten rows:",
    formatRows(
      context.previousRewrittenRows.map((row, index) => ({
        index,
        speakerKey: "",
        text: row.rewrittenText
      }))
    ),
    "",
    "Current row:",
    formatRows([context.currentRow]),
    "",
    "Next original rows:",
    formatRows(context.nextOriginalRows),
    "",
    "Return only the rewritten text for the current row."
  ].join("\n");
}
