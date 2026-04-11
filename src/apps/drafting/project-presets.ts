import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  DraftingProjectPresetId,
  ExamplePair,
  LoadedProjectPreset,
  RulePackFile
} from "./types";

function resolveFromDraftingRoot(...parts: string[]): string {
  return resolve(import.meta.dirname, "data", ...parts);
}

function loadJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

export function getProjectPresetOrThrow(id: DraftingProjectPresetId): LoadedProjectPreset {
  if (id !== "ru-gold-2sp-v1") {
    throw new Error(`Unsupported project preset: ${id}`);
  }

  const rulePackPath = resolveFromDraftingRoot("rule-packs", `${id}.json`);
  const examplesPath = resolveFromDraftingRoot("examples", `${id}.examples.json`);
  const rulePack = loadJsonFile<RulePackFile>(rulePackPath);
  const examples = loadJsonFile<ExamplePair[]>(examplesPath);

  return {
    ...rulePack,
    examples
  };
}
