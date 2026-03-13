import { getTemplateRegistry } from "./template-registry";
import type { ReviewTemplate, TemplateSearchResponse, TemplateSearchResult } from "./types";

function normalizeText(value: string): string {
  return String(value || "")
    .toLocaleLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(/\s+/).filter(Boolean) : [];
}

function buildBigrams(value: string): string[] {
  const compact = normalizeText(value).replace(/\s+/g, "");
  if (!compact) {
    return [];
  }
  if (compact.length === 1) {
    return [compact];
  }

  const bigrams: string[] = [];
  for (let index = 0; index < compact.length - 1; index += 1) {
    bigrams.push(compact.slice(index, index + 2));
  }
  return bigrams;
}

function diceCoefficient(left: string, right: string): number {
  const leftBigrams = buildBigrams(left);
  const rightBigrams = buildBigrams(right);
  if (!leftBigrams.length || !rightBigrams.length) {
    return 0;
  }

  const remaining = new Map<string, number>();
  for (const item of rightBigrams) {
    remaining.set(item, (remaining.get(item) || 0) + 1);
  }

  let overlap = 0;
  for (const item of leftBigrams) {
    const count = remaining.get(item) || 0;
    if (count > 0) {
      overlap += 1;
      if (count === 1) {
        remaining.delete(item);
      } else {
        remaining.set(item, count - 1);
      }
    }
  }

  return (2 * overlap) / (leftBigrams.length + rightBigrams.length);
}

function bestTokenSimilarity(queryToken: string, candidateTokens: string[]): number {
  let best = 0;
  for (const candidate of candidateTokens) {
    if (queryToken === candidate) {
      return 1;
    }
    if (candidate.startsWith(queryToken) || queryToken.startsWith(candidate)) {
      best = Math.max(best, 0.94);
      continue;
    }
    if (candidate.includes(queryToken) || queryToken.includes(candidate)) {
      best = Math.max(best, 0.82);
      continue;
    }

    const fuzzy = diceCoefficient(queryToken, candidate);
    if (fuzzy > best) {
      best = fuzzy;
    }
  }
  return best >= 0.48 ? best : 0;
}

function scoreField(queryTokens: string[], rawField: string, weight: number): number {
  const normalizedField = normalizeText(rawField);
  if (!normalizedField) {
    return 0;
  }

  let score = 0;
  const fieldTokens = tokenize(normalizedField);
  const queryPhrase = queryTokens.join(" ");

  if (queryPhrase && normalizedField.includes(queryPhrase)) {
    score += 30 * weight;
  }

  for (const token of queryTokens) {
    score += bestTokenSimilarity(token, fieldTokens) * 16 * weight;
  }

  score += diceCoefficient(queryPhrase, normalizedField) * 6 * weight;
  return score;
}

function scoreTemplate(queryTokens: string[], template: ReviewTemplate): number {
  const reportText = Array.isArray(template.reportTexts) ? template.reportTexts.join(" ") : "";

  let score = 0;
  score += scoreField(queryTokens, template.id, 1.2);
  score += scoreField(queryTokens, template.title, 1.7);
  score += scoreField(queryTokens, template.description, 1.45);
  score += scoreField(queryTokens, reportText, 1.15);
  score += scoreField(queryTokens, template.category, 0.75);
  score += Math.max(0, template.priority) / 1000;
  return score;
}

function toSearchResult(template: ReviewTemplate, score: number): TemplateSearchResult {
  return {
    id: template.id,
    title: template.title,
    description: template.description,
    category: template.category,
    reportTexts: Array.isArray(template.reportTexts) ? [...template.reportTexts] : [],
    score: Number(score.toFixed(3))
  };
}

export function searchTemplates(query: string, limit = 8): TemplateSearchResponse {
  const normalizedQuery = String(query || "").trim();
  const queryTokens = tokenize(normalizedQuery);
  if (!queryTokens.length) {
    return {
      query: normalizedQuery,
      results: []
    };
  }

  const registry = getTemplateRegistry();
  const results = [...registry.templatesById.values()]
    .map((template) => {
      const score = scoreTemplate(queryTokens, template);
      return { template, score };
    })
    .filter((item) => item.score > 8)
    .sort((left, right) => right.score - left.score || right.template.priority - left.template.priority)
    .slice(0, Math.max(1, Math.min(25, Math.trunc(limit) || 8)))
    .map((item) => toSearchResult(item.template, item.score));

  return {
    query: normalizedQuery,
    results
  };
}
