import {
  buildCachedOpenRouterTextContent,
  requestOpenRouterChat,
  shouldUseGeminiPromptCaching,
  type OpenRouterContentPart
} from "../../shared/openrouter-client";
import type { RowRewriteContext, RewriteRowDeps } from "./types";
import { buildUserPrompt } from "./prompt";

function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function tryParseJsonResponse(content: string): string {
  const parsed = JSON.parse(content) as { rewrittenText?: unknown };
  if (!parsed || typeof parsed.rewrittenText !== "string") {
    throw new Error("Model response is not valid row rewrite JSON.");
  }
  return parsed.rewrittenText;
}

function tryRecoverSingleFieldResponse(content: string): string | null {
  const match = content.match(/"rewrittenText"\s*:\s*"([\s\S]*)"\s*}\s*$/);
  if (!match) {
    return null;
  }

  return match[1]
    .replace(/\\"/g, "\"")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");
}

export function parseResponseText(content: string): string {
  const normalized = stripCodeFences(content);

  try {
    return tryParseJsonResponse(normalized);
  } catch (error) {
    const recovered = tryRecoverSingleFieldResponse(normalized);
    if (typeof recovered === "string") {
      return recovered;
    }

    return normalized;
  }
}

function audioClipPromptLine(clip: NonNullable<RowRewriteContext["audioClips"]>[number], index: number): string {
  return `${index + 1}. trackId=${clip.trackId}${clip.speakerKey ? ` speakerKey=${clip.speakerKey}` : ""}${
    clip.trackLabel ? ` trackLabel=${clip.trackLabel}` : ""
  }`;
}

function buildDynamicAudioPrompt(context: RowRewriteContext, fullPromptLines: string[]): string {
  const currentRowText = JSON.stringify(context.currentRow.text);
  const currentRowLine = fullPromptLines.find((line) => line.includes(currentRowText)) || `Current row: ${currentRowText}`;
  return [
    "Audio clips:",
    ...(context.audioClips || []).map(audioClipPromptLine),
    currentRowLine
  ].join("\n");
}

function buildCachedAudioPromptPrefix(context: RowRewriteContext, fullPromptLines: string[]): string {
  const currentRowText = JSON.stringify(context.currentRow.text);
  const dynamicClipLines = new Set((context.audioClips || []).map(audioClipPromptLine));
  return fullPromptLines
    .filter((line) => line !== "Audio clips:")
    .filter((line) => !dynamicClipLines.has(line))
    .filter((line) => !line.includes(currentRowText))
    .join("\n");
}

function buildAudioAttachments(context: RowRewriteContext): OpenRouterContentPart[] {
  return (context.audioClips || []).flatMap((clip, index) => [
    {
      type: "text" as const,
      text: `Audio clip ${index + 1}: trackId=${clip.trackId}${
        clip.speakerKey ? `, speakerKey=${clip.speakerKey}` : ""
      }${clip.trackLabel ? `, trackLabel=${clip.trackLabel}` : ""}.`
    },
    {
      type: "input_audio" as const,
      input_audio: {
        data: clip.base64,
        format: clip.format
      }
    }
  ]);
}

function buildUserContent(context: RowRewriteContext, model: string): string | OpenRouterContentPart[] {
  const userPrompt = buildUserPrompt(context);
  if (!context.audioClips?.length) {
    return userPrompt;
  }
  if (!shouldUseGeminiPromptCaching(model)) {
    return [{ type: "text", text: userPrompt }, ...buildAudioAttachments(context)];
  }
  const userPromptLines = userPrompt.split("\n");

  return [
    buildCachedOpenRouterTextContent(buildCachedAudioPromptPrefix(context, userPromptLines)),
    { type: "text", text: buildDynamicAudioPrompt(context, userPromptLines) },
    ...buildAudioAttachments(context)
  ];
}

function buildSystemContent(systemPrompt: string, model: string): string | OpenRouterContentPart[] {
  return shouldUseGeminiPromptCaching(model) ? [buildCachedOpenRouterTextContent(systemPrompt)] : systemPrompt;
}

function deterministicRewrite(text: string): string {
  let next = text.trim().replace(/\s{2,}/g, " ");
  next = next.replace(/\s+,/g, ",").replace(/,(?!\s|$)/g, ", ");
  if (next && !/[.!?"…-]$/.test(next)) {
    next += ".";
  }
  if (next) {
    next = next[0].toLocaleUpperCase() + next.slice(1);
  }
  return next;
}

export async function rewriteRowWithModel(
  context: RowRewriteContext,
  deps: RewriteRowDeps & { apiKey: string }
): Promise<string> {
  if (deps.testMode) {
    return deterministicRewrite(context.currentRow.text);
  }

  const content = await requestOpenRouterChat({
    apiKey: deps.apiKey,
    model: deps.model,
    messages: [
      { role: "system", content: buildSystemContent(deps.systemPrompt, deps.model) },
      { role: "user", content: buildUserContent(context, deps.model) }
    ],
    providerSort: "latency",
    reasoningEffort: deps.reasoningEffort,
    serviceTier: deps.serviceTier,
    temperature: 0.15,
    title: "Babel Gold Drafting"
  });

  const rewrittenText = parseResponseText(content);
  if (!rewrittenText.trim()) {
    throw new Error("empty_model_output");
  }

  return rewrittenText;
}
