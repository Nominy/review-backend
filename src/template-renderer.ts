import { CATEGORIES } from "./rules";
import { getTemplateRegistry, type LoadedTemplateRegistry } from "./template-registry";
import type { CategoryName, FeedbackItem, ReviewTemplate } from "./types";

function sortTemplates(left: ReviewTemplate, right: ReviewTemplate): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.id.localeCompare(right.id);
}

function clipNote(note: string, maxLen = 500): string {
  const clean = note.trim();
  if (clean.length <= maxLen) {
    return clean;
  }

  const candidate = clean.slice(0, maxLen);
  const cutIndex = candidate.lastIndexOf(" ");
  if (cutIndex >= 0) {
    return candidate.slice(0, cutIndex).trim();
  }
  return candidate.trim();
}

export function renderFeedbackFromTemplateMatches(
  matchedTemplateIds: string[],
  registry: LoadedTemplateRegistry = getTemplateRegistry()
): {
  feedback: FeedbackItem[];
  matchedTemplateIds: string[];
} {
  const seen = new Set<string>();
  const matchedTemplatesByCategory = CATEGORIES.reduce((acc, category) => {
    acc[category] = [];
    return acc;
  }, {} as Record<CategoryName, ReviewTemplate[]>);
  const normalizedMatchedTemplateIds: string[] = [];

  for (const rawId of matchedTemplateIds) {
    if (typeof rawId !== "string") {
      continue;
    }
    const templateId = rawId.trim();
    if (!templateId || seen.has(templateId)) {
      continue;
    }
    const template = registry.templatesById.get(templateId);
    if (!template) {
      continue;
    }

    seen.add(templateId);
    normalizedMatchedTemplateIds.push(templateId);
    matchedTemplatesByCategory[template.category].push(template);
  }

  const feedback: FeedbackItem[] = [];

  for (const category of CATEGORIES) {
    const matches = [...matchedTemplatesByCategory[category]].sort(sortTemplates);
    const baseNote = matches.length
      ? matches.map((template) => template.reportText.trim()).filter(Boolean).join(" ")
      : registry.defaultTextByCategory[category];
    const note = clipNote(baseNote);

    feedback.push({
      category,
      note
    });
  }

  return {
    feedback,
    matchedTemplateIds: normalizedMatchedTemplateIds
  };
}
