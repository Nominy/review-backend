import { requestOpenRouterChat, type OpenRouterContentPart } from "../../shared/openrouter-client";
import type { RowRewriteContext, RewriteRowDeps } from "./types";
import { buildUserPrompt } from "./prompt";

function stripCodeFences(content: string): string {
  const trimmed = content.trim();
  const fencedMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fencedMatch ? fencedMatch[1].trim() : trimmed;
}

function tryParseJsonResponse(content: string): string | null {
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
    const parsed = tryParseJsonResponse(normalized);
    return typeof parsed === "string" ? parsed : normalized;
  } catch (error) {
    const recovered = tryRecoverSingleFieldResponse(normalized);
    if (typeof recovered === "string") {
      return recovered;
    }

    return normalized;
  }
}

function buildUserContent(context: RowRewriteContext): string | OpenRouterContentPart[] {
  const userPrompt = buildUserPrompt(context);
  if (!context.audioClips?.length) {
    return userPrompt;
  }

  return [
    { type: "text", text: userPrompt },
    ...context.audioClips.flatMap((clip, index) => [
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
    ])
  ];
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
      { role: "system", content: deps.systemPrompt },
      { role: "user", content: buildUserContent(context) }
    ],
    providerSort: "latency",
    reasoningEffort: "low",
    serviceTier: deps.serviceTier,
    temperature: 0.15,
    title: "Babel Gold Drafting"
  });

  return parseResponseText(content);
}
