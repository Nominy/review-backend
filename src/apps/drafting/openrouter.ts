import { requestOpenRouterChat } from "../../shared/openrouter-client";
import type { RowRewriteContext, RewriteRowDeps } from "./types";
import { buildUserPrompt } from "./prompt";

function parseResponseText(content: string): string {
  const parsed = JSON.parse(content) as { rewrittenText?: unknown };
  if (!parsed || typeof parsed.rewrittenText !== "string") {
    throw new Error("Model response is not valid row rewrite JSON.");
  }
  return parsed.rewrittenText;
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

  const userPrompt = buildUserPrompt(context);
  const content = await requestOpenRouterChat({
    apiKey: deps.apiKey,
    model: deps.model,
    messages: [
      { role: "system", content: deps.systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.15,
    title: "Babel Gold Drafting"
  });

  return parseResponseText(content);
}
