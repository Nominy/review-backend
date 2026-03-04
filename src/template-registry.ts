import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES } from "./rules";
import type {
  CategoryName,
  ReviewTemplate,
  TemplatePromptCatalog,
  TemplatePromptEntry,
  TemplateRegistryFile
} from "./types";

export type LoadedTemplateRegistry = {
  templatesById: Map<string, ReviewTemplate>;
  templatesByCategory: Record<CategoryName, ReviewTemplate[]>;
  defaultTextByCategory: Record<CategoryName, string>;
  promptCatalog: TemplatePromptCatalog;
  registryVersion: string;
};

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));

let cachedRegistry: LoadedTemplateRegistry | null = null;

function createCategoryRecord<T>(factory: () => T): Record<CategoryName, T> {
  return CATEGORIES.reduce((acc, category) => {
    acc[category] = factory();
    return acc;
  }, {} as Record<CategoryName, T>);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertCategory(value: unknown, context: string): CategoryName {
  if (typeof value !== "string" || !CATEGORIES.includes(value as CategoryName)) {
    throw new Error(`${context} must be one of: ${CATEGORIES.join(", ")}`);
  }
  return value as CategoryName;
}

function assertString(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${context} must be a non-empty string.`);
  }
  return value.trim();
}

function assertBoolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context} must be a boolean.`);
  }
  return value;
}

function assertPriority(value: unknown, context: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${context} must be a finite number.`);
  }
  return parsed;
}

function parseRegistryFile(fileName: string, raw: string): TemplateRegistryFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Could not parse template file ${fileName}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  if (!isObject(parsed)) {
    throw new Error(`Template file ${fileName} must contain an object.`);
  }

  const category = assertCategory(parsed.category, `${fileName}.category`);
  const version = Number(parsed.version);
  if (!Number.isInteger(version) || version <= 0) {
    throw new Error(`${fileName}.version must be a positive integer.`);
  }

  const defaultText = assertString(parsed.defaultText, `${fileName}.defaultText`);
  if (!Array.isArray(parsed.templates)) {
    throw new Error(`${fileName}.templates must be an array.`);
  }

  const templates = parsed.templates.map((template, index) => {
    if (!isObject(template)) {
      throw new Error(`${fileName}.templates[${index}] must be an object.`);
    }

    return {
      id: assertString(template.id, `${fileName}.templates[${index}].id`),
      description: assertString(
        template.description,
        `${fileName}.templates[${index}].description`
      ),
      reportText: assertString(template.reportText, `${fileName}.templates[${index}].reportText`),
      priority: assertPriority(template.priority, `${fileName}.templates[${index}].priority`),
      enabled: assertBoolean(template.enabled, `${fileName}.templates[${index}].enabled`)
    };
  });

  return {
    category,
    version,
    defaultText,
    templates
  };
}

function validateTemplateId(id: string, context: string): string {
  if (!/^[a-z0-9._-]+$/.test(id)) {
    throw new Error(`${context} must use only lowercase ASCII letters, digits, dots, underscores, and dashes.`);
  }
  return id;
}

function toPromptEntry(template: ReviewTemplate): TemplatePromptEntry {
  return {
    id: template.id,
    description: template.description
  };
}

function sortTemplates(left: ReviewTemplate, right: ReviewTemplate): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.id.localeCompare(right.id);
}

function loadTemplateRegistry(): LoadedTemplateRegistry {
  const templateFiles = readdirSync(TEMPLATE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const templatesById = new Map<string, ReviewTemplate>();
  const templatesByCategory = createCategoryRecord<ReviewTemplate[]>(() => []);
  const defaultTextByCategory = createCategoryRecord<string>(() => "");
  const promptCatalog = createCategoryRecord<TemplatePromptEntry[]>(() => []);
  const seenCategories = new Set<CategoryName>();
  const versionParts: string[] = [];

  for (const fileName of templateFiles) {
    const raw = readFileSync(join(TEMPLATE_DIR, fileName), "utf8");
    const parsed = parseRegistryFile(fileName, raw);

    if (seenCategories.has(parsed.category)) {
      throw new Error(`Duplicate template file category: ${parsed.category}`);
    }
    seenCategories.add(parsed.category);
    defaultTextByCategory[parsed.category] = parsed.defaultText;
    versionParts.push(`${parsed.category}:${parsed.version}`);

    for (let index = 0; index < parsed.templates.length; index += 1) {
      const template = parsed.templates[index];
      const id = validateTemplateId(template.id, `${fileName}.templates[${index}].id`);

      if (templatesById.has(id)) {
        throw new Error(`Duplicate template id: ${id}`);
      }

      const fullTemplate: ReviewTemplate = {
        ...template,
        id,
        category: parsed.category
      };

      if (!fullTemplate.enabled) {
        continue;
      }

      templatesById.set(id, fullTemplate);
      templatesByCategory[parsed.category].push(fullTemplate);
      promptCatalog[parsed.category].push(toPromptEntry(fullTemplate));
    }
  }

  for (const category of CATEGORIES) {
    if (!seenCategories.has(category)) {
      throw new Error(`Missing template file for category: ${category}`);
    }
    if (!defaultTextByCategory[category]) {
      throw new Error(`Missing defaultText for category: ${category}`);
    }
    templatesByCategory[category].sort(sortTemplates);
    promptCatalog[category].sort((left, right) => {
      const leftTemplate = templatesById.get(left.id);
      const rightTemplate = templatesById.get(right.id);
      if (!leftTemplate || !rightTemplate) {
        return left.id.localeCompare(right.id);
      }
      return sortTemplates(leftTemplate, rightTemplate);
    });
  }

  return {
    templatesById,
    templatesByCategory,
    defaultTextByCategory,
    promptCatalog,
    registryVersion: versionParts.sort((a, b) => a.localeCompare(b)).join("|")
  };
}

export function getTemplateRegistry(): LoadedTemplateRegistry {
  if (!cachedRegistry) {
    cachedRegistry = loadTemplateRegistry();
  }
  return cachedRegistry;
}
