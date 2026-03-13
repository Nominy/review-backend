import { writeFileSync } from "node:fs";
import { CATEGORIES } from "./rules";
import {
  getTemplateRegistry,
  readTemplateRegistryFiles,
  resetTemplateRegistryCache,
  validateTemplateId,
  validateTemplateRegistryFileData
} from "./template-registry";
import { config } from "./config";
import { listPendingTemplateProposals } from "./pending-template-proposals";
import type { CategoryName, TemplateDefinition, TemplateRegistryFile } from "./types";

type TemplateFileWithMeta = TemplateRegistryFile & {
  fileName: string;
  filePath: string;
};

type CreateTemplateInput = {
  category: string;
  name: string;
  errorDescription: string;
  templateTexts: string[];
};

type UpdateTemplateInput = {
  id: string;
  name: string;
  errorDescription: string;
  templateTexts: string[];
  enabled: boolean;
};

type ImportRowResult = {
  rowNumber: number;
  status: "created" | "updated";
  id: string;
  category: CategoryName;
};

type SaveTemplateDraftCategoryInput = {
  category: string;
  fileVersion: number;
  defaultText: string;
  templates: TemplateDefinition[];
};

const CATEGORY_PREFIXES: Record<CategoryName, string> = {
  "Word Accuracy": "word_accuracy",
  "Timestamp Accuracy": "timestamp_accuracy",
  "Punctuation & Formatting": "punctuation_formatting",
  "Tags & Emphasis": "tags_emphasis",
  Segmentation: "segmentation"
};

const CYRILLIC_TO_LATIN: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "kh",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "shch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya"
};

let writeQueue: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const next = writeQueue.then(fn, fn);
  writeQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

function withStatusCode(error: unknown, statusCode: number): Error & { statusCode: number } {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return Object.assign(normalized, {
    statusCode:
      "statusCode" in normalized && Number.isInteger((normalized as { statusCode?: unknown }).statusCode)
        ? Number((normalized as { statusCode?: unknown }).statusCode)
        : statusCode
  });
}

function assertCategory(value: unknown): CategoryName {
  if (typeof value !== "string") {
    throw new Error("category must be a string.");
  }
  const trimmed = value.trim();
  if (!CATEGORIES.includes(trimmed as CategoryName)) {
    throw new Error(`category must be one of: ${CATEGORIES.join(", ")}`);
  }
  return trimmed as CategoryName;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} must be a non-empty string.`);
  }
  return value.trim();
}

function assertNonEmptyStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array.`);
  }

  const normalized = value
    .map((item, index) => assertNonEmptyString(item, `${field}[${index}]`))
    .filter(Boolean);
  if (!normalized.length) {
    throw new Error(`${field} must contain at least one non-empty string.`);
  }
  return normalized;
}

function assertBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

function assertPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive integer.`);
  }
  return parsed;
}

function sortTemplates(
  left: TemplateDefinition & { category?: CategoryName },
  right: TemplateDefinition & { category?: CategoryName }
): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }
  return left.id.localeCompare(right.id);
}

function normalizeTemplateFiles(files: TemplateFileWithMeta[]): TemplateFileWithMeta[] {
  const validatedFiles = files.map((file) => {
    const validated = validateTemplateRegistryFileData(file.fileName, {
      category: file.category,
      version: file.version,
      defaultText: file.defaultText,
      templates: file.templates
    });

    return {
      ...validated,
      fileName: file.fileName,
      filePath: file.filePath
    };
  });

  const seenCategories = new Set<CategoryName>();
  const seenIds = new Set<string>();

  for (const file of validatedFiles) {
    if (seenCategories.has(file.category)) {
      throw new Error(`Duplicate template file category: ${file.category}`);
    }
    seenCategories.add(file.category);

    for (const template of file.templates) {
      if (seenIds.has(template.id)) {
        throw new Error(`Duplicate template id: ${template.id}`);
      }
      seenIds.add(template.id);
    }
  }

  for (const category of CATEGORIES) {
    if (!seenCategories.has(category)) {
      throw new Error(`Missing template file for category: ${category}`);
    }
  }

  return validatedFiles;
}

function writeTemplateFiles(
  files: TemplateFileWithMeta[],
  categoriesToWrite?: Set<CategoryName>
): string {
  const normalizedFiles = normalizeTemplateFiles(files);

  for (const file of normalizedFiles) {
    if (categoriesToWrite && !categoriesToWrite.has(file.category)) {
      continue;
    }
    const sortedTemplates = [...file.templates].sort(sortTemplates);
    writeFileSync(
      file.filePath,
      `${JSON.stringify(
        {
          category: file.category,
          version: file.version,
          defaultText: file.defaultText,
          templates: sortedTemplates
        },
        null,
        2
      )}\n`,
      "utf8"
    );
  }

  resetTemplateRegistryCache();
  return getTemplateRegistry().registryVersion;
}

function findFileByCategory(files: TemplateFileWithMeta[], category: CategoryName): TemplateFileWithMeta {
  const file = files.find((item) => item.category === category);
  if (!file) {
    throw new Error(`Missing template file for category: ${category}`);
  }
  return file;
}

function transliterateChar(char: string): string {
  if (/[a-z0-9]/.test(char)) {
    return char;
  }
  if (char in CYRILLIC_TO_LATIN) {
    return CYRILLIC_TO_LATIN[char];
  }
  if (/\s/.test(char) || /[.,/#!$%^&*;:{}=\-`~()"'?<>@[\]+\\|]/.test(char)) {
    return "_";
  }
  const codePoint = char.codePointAt(0);
  if (typeof codePoint === "number") {
    return `u${codePoint.toString(16)}`;
  }
  return "_";
}

function slugifyName(name: string): string {
  const raw = Array.from(name.trim().toLowerCase())
    .map((char) => transliterateChar(char))
    .join("");

  return raw
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function buildTemplateId(category: CategoryName, name: string): string {
  const slug = slugifyName(name);
  if (!slug) {
    throw new Error("name does not produce a usable template id. Use at least one letter or number.");
  }
  return validateTemplateId(
    `${CATEGORY_PREFIXES[category]}.${slug}`,
    "generated template id"
  );
}

function getNextPriority(file: TemplateFileWithMeta): number {
  if (!file.templates.length) {
    return 100;
  }
  return Math.min(...file.templates.map((template) => template.priority)) - 1;
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];

    if (inQuotes) {
      if (char === "\"" && next === "\"") {
        cell += "\"";
        index += 1;
        continue;
      }
      if (char === "\"") {
        inQuotes = false;
        continue;
      }
      cell += char;
      continue;
    }

    if (char === "\"") {
      inQuotes = true;
      continue;
    }
    if (char === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (char === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    if (char === "\r") {
      continue;
    }
    cell += char;
  }

  if (inQuotes) {
    throw new Error("CSV contains an unclosed quoted field.");
  }

  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}

function normalizeCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function cloneTemplateFiles(): TemplateFileWithMeta[] {
  return readTemplateRegistryFiles().map((file) => ({
    ...file,
    templates: file.templates.map((template) => ({ ...template }))
  }));
}

export async function listTemplatesLabData(): Promise<{
  ok: true;
  registryVersion: string;
  categories: Array<{
    category: CategoryName;
    fileVersion: number;
    defaultText: string;
    templates: TemplateDefinition[];
  }>;
  pendingSuggestions: Awaited<ReturnType<typeof listPendingTemplateProposals>>;
}> {
  const files = normalizeTemplateFiles(readTemplateRegistryFiles());
  const pendingSuggestions = await listPendingTemplateProposals(config.pendingTemplateProposalPath);
  return {
    ok: true,
    registryVersion: getTemplateRegistry().registryVersion,
    categories: files
      .sort((left, right) => CATEGORIES.indexOf(left.category) - CATEGORIES.indexOf(right.category))
      .map((file) => ({
        category: file.category,
        fileVersion: file.version,
          defaultText: file.defaultText,
          templates: [...file.templates].sort(sortTemplates)
        })),
    pendingSuggestions
  };
}

export async function saveTemplatesLabDraft(input: {
  categories: SaveTemplateDraftCategoryInput[];
}): Promise<{
  ok: true;
  touchedCategories: CategoryName[];
  registryVersion: string;
}> {
  return withWriteLock(async () => {
    if (!Array.isArray(input.categories)) {
      throw withStatusCode(new Error("categories must be an array."), 400);
    }

    let submittedCategories: SaveTemplateDraftCategoryInput[];
    try {
      submittedCategories = input.categories.map((categoryInput, index) => {
        if (!categoryInput || typeof categoryInput !== "object" || Array.isArray(categoryInput)) {
          throw new Error(`categories[${index}] must be an object.`);
        }

        const record = categoryInput as Record<string, unknown>;
        if (!Array.isArray(record.templates)) {
          throw new Error(`categories[${index}].templates must be an array.`);
        }

        return {
          category: assertNonEmptyString(record.category, `categories[${index}].category`),
          fileVersion: assertPositiveInteger(
            record.fileVersion,
            `categories[${index}].fileVersion`
          ),
          defaultText: assertNonEmptyString(
            record.defaultText,
            `categories[${index}].defaultText`
          ),
          templates: record.templates as TemplateDefinition[]
        };
      });
    } catch (error) {
      throw withStatusCode(error, 400);
    }

    const diskFiles = cloneTemplateFiles();
    const submittedByCategory = new Map<CategoryName, SaveTemplateDraftCategoryInput>();

    try {
      for (const categoryInput of submittedCategories) {
        const category = assertCategory(categoryInput.category);
        if (submittedByCategory.has(category)) {
          throw new Error(`Duplicate category in save payload: ${category}`);
        }
        submittedByCategory.set(category, categoryInput);
      }

      for (const category of CATEGORIES) {
        if (!submittedByCategory.has(category)) {
          throw new Error(`Missing category in save payload: ${category}`);
        }
      }
    } catch (error) {
      throw withStatusCode(error, 400);
    }

    const nextFiles: TemplateFileWithMeta[] = [];
    const touchedCategories = new Set<CategoryName>();

    try {
      for (const category of CATEGORIES) {
        const currentFile = findFileByCategory(diskFiles, category);
        const submitted = submittedByCategory.get(category);
        if (!submitted) {
          throw new Error(`Missing category in save payload: ${category}`);
        }

        if (submitted.fileVersion !== currentFile.version) {
          const error = new Error(
            `Template file ${category} changed on disk. Refresh Templates Lab before saving.`
          );
          (error as Error & { statusCode?: number }).statusCode = 409;
          throw error;
        }

        const validated = validateTemplateRegistryFileData(currentFile.fileName, {
          category,
          version: currentFile.version,
          defaultText: submitted.defaultText,
          templates: submitted.templates
        });

        const currentComparable = JSON.stringify({
          category: currentFile.category,
          defaultText: currentFile.defaultText,
          templates: [...currentFile.templates].sort(sortTemplates)
        });
        const nextComparable = JSON.stringify({
          category: validated.category,
          defaultText: validated.defaultText,
          templates: [...validated.templates].sort(sortTemplates)
        });

        const changed = currentComparable !== nextComparable;
        if (changed) {
          touchedCategories.add(category);
        }

        nextFiles.push({
          ...validated,
          version: changed ? currentFile.version + 1 : currentFile.version,
          fileName: currentFile.fileName,
          filePath: currentFile.filePath
        });
      }
    } catch (error) {
      throw withStatusCode(error, getErrorStatusCode(error));
    }

    if (!touchedCategories.size) {
      return {
        ok: true,
        touchedCategories: [],
        registryVersion: getTemplateRegistry().registryVersion
      };
    }

    const registryVersion = writeTemplateFiles(nextFiles, touchedCategories);
    return {
      ok: true,
      touchedCategories: [...touchedCategories],
      registryVersion
    };
  });
}

function getErrorStatusCode(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error) {
    const parsed = Number((error as { statusCode?: unknown }).statusCode);
    if (Number.isInteger(parsed) && parsed >= 100) {
      return parsed;
    }
  }
  return 400;
}

export async function createTemplateForLab(input: CreateTemplateInput): Promise<{
  ok: true;
  template: TemplateDefinition & { category: CategoryName };
  registryVersion: string;
}> {
  return withWriteLock(async () => {
    let name = "";
    let category: CategoryName;
    let description = "";
    let reportTexts: string[] = [];

    try {
      name = assertNonEmptyString(input.name, "name");
      category = assertCategory(input.category);
      description = assertNonEmptyString(input.errorDescription, "errorDescription");
      reportTexts = assertNonEmptyStringArray(input.templateTexts, "templateTexts");
    } catch (error) {
      throw withStatusCode(error, 400);
    }

    const files = cloneTemplateFiles();
    const id = buildTemplateId(category, name);

    for (const file of files) {
      if (file.templates.some((template) => template.id === id)) {
        const error = new Error(`Template id already exists: ${id}`);
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }
    }

    const file = findFileByCategory(files, category);
    const createdTemplate: TemplateDefinition = {
      id,
      title: name,
      description,
      reportTexts,
      priority: getNextPriority(file),
      enabled: true
    };

    file.templates.push(createdTemplate);
    file.version += 1;

    const registryVersion = writeTemplateFiles(files);
    return {
      ok: true,
      template: {
        ...createdTemplate,
        category
      },
      registryVersion
    };
  });
}

export async function updateTemplateForLab(input: UpdateTemplateInput): Promise<{
  ok: true;
  template: TemplateDefinition & { category: CategoryName };
  registryVersion: string;
}> {
  return withWriteLock(async () => {
    let id = "";
    let title = "";
    let description = "";
    let reportTexts: string[] = [];
    let enabled = false;

    try {
      id = assertNonEmptyString(input.id, "id");
      title = assertNonEmptyString(input.name, "name");
      description = assertNonEmptyString(input.errorDescription, "errorDescription");
      reportTexts = assertNonEmptyStringArray(input.templateTexts, "templateTexts");
      enabled = assertBoolean(input.enabled, "enabled");
    } catch (error) {
      throw withStatusCode(error, 400);
    }

    const files = cloneTemplateFiles();

    for (const file of files) {
      const template = file.templates.find((item) => item.id === id);
      if (!template) {
        continue;
      }

      template.title = title;
      template.description = description;
      template.reportTexts = reportTexts;
      template.enabled = enabled;
      file.version += 1;

      const registryVersion = writeTemplateFiles(files);
      return {
        ok: true,
        template: {
          ...template,
          category: file.category
        },
        registryVersion
      };
    }

    const error = new Error(`Template not found: ${id}`);
    (error as Error & { statusCode?: number }).statusCode = 404;
    throw error;
  });
}

export async function importTemplatesFromCsv(csvText: string): Promise<{
  ok: true;
  touchedCategories: CategoryName[];
  created: number;
  updated: number;
  rows: ImportRowResult[];
  registryVersion: string;
}> {
  return withWriteLock(async () => {
    const operationsById = new Map<
      string,
      {
        rowNumber: number;
        category: CategoryName;
        id: string;
        title: string;
        description: string;
        reportTexts: string[];
      }
    >();

    try {
      const rows = parseCsv(assertNonEmptyString(csvText, "csv"));
      if (!rows.length) {
        throw new Error("CSV is empty.");
      }

      const headers = rows[0].map((value) => normalizeCsvHeader(value));
      const expectedHeaders = ["category", "name", "error description"];

      if (headers.length < expectedHeaders.length + 1) {
        throw new Error(
          "CSV header must include category,name,error description and at least one template text column."
        );
      }
      if (headers.some((value, index) => index < expectedHeaders.length && value !== expectedHeaders[index])) {
        throw new Error(
          "CSV header must start with: category,name,error description."
        );
      }
      const variantHeaders = headers.slice(expectedHeaders.length);
      const invalidVariantHeader = variantHeaders.find(
        (value, index) => value !== `template text ${index + 1}`
      );
      if (invalidVariantHeader) {
        throw new Error(
          "Template text headers must be named in order: template text 1, template text 2, ..."
        );
      }

      for (let index = 1; index < rows.length; index += 1) {
        const row = rows[index];
        if (!row.some((value) => value.trim())) {
          continue;
        }
        if (row.length < 4) {
          throw new Error(`CSV row ${index + 1} must have at least 4 columns.`);
        }

        const category = assertCategory(row[0]);
        const title = assertNonEmptyString(row[1], `CSV row ${index + 1} name`);
        const description = assertNonEmptyString(
          row[2],
          `CSV row ${index + 1} error description`
        );
        const reportTexts = row
          .slice(3)
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (!reportTexts.length) {
          throw new Error(`CSV row ${index + 1} must contain at least one template text.`);
        }
        const id = buildTemplateId(category, title);

        operationsById.set(id, {
          rowNumber: index + 1,
          category,
          id,
          title,
          description,
          reportTexts
        });
      }
    } catch (error) {
      throw withStatusCode(error, 400);
    }

    const files = cloneTemplateFiles();
    const touchedCategories = new Set<CategoryName>();
    const results: ImportRowResult[] = [];
    let created = 0;
    let updated = 0;

    for (const operation of operationsById.values()) {
      const file = findFileByCategory(files, operation.category);
      const existing = file.templates.find((template) => template.id === operation.id);

      if (existing) {
        existing.title = operation.title;
        existing.description = operation.description;
        existing.reportTexts = operation.reportTexts;
        updated += 1;
        results.push({
          rowNumber: operation.rowNumber,
          status: "updated",
          id: operation.id,
          category: operation.category
        });
      } else {
        file.templates.push({
          id: operation.id,
          title: operation.title,
          description: operation.description,
          reportTexts: operation.reportTexts,
          priority: getNextPriority(file),
          enabled: true
        });
        created += 1;
        results.push({
          rowNumber: operation.rowNumber,
          status: "created",
          id: operation.id,
          category: operation.category
        });
      }

      touchedCategories.add(operation.category);
    }

    for (const category of touchedCategories) {
      findFileByCategory(files, category).version += 1;
    }

    const registryVersion = writeTemplateFiles(files);
    return {
      ok: true,
      touchedCategories: [...touchedCategories],
      created,
      updated,
      rows: results,
      registryVersion
    };
  });
}
