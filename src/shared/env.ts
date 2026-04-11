import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function unquote(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}

function parseEnvFile(content: string): Array<[string, string]> {
  const lines = content.split(/\r?\n/);
  const pairs: Array<[string, string]> = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const sep = normalized.indexOf("=");
    if (sep <= 0) continue;

    const key = normalized.slice(0, sep).trim();
    const value = unquote(normalized.slice(sep + 1).trim());
    if (!key) continue;

    pairs.push([key, value]);
  }

  return pairs;
}

export function loadEnvFile(fileName = ".env"): void {
  const fullPath = resolve(process.cwd(), fileName);
  if (!existsSync(fullPath)) return;

  const content = readFileSync(fullPath, "utf8");
  for (const [key, value] of parseEnvFile(content)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function loadDefaultEnvFiles(): void {
  loadEnvFile(".env.runtime");

  const mode = (process.env.NODE_ENV || "").trim();
  if (mode) {
    loadEnvFile(`.env.runtime.${mode}`);
  }
}

export function requireEnv(name: string): string {
  const value = (process.env[name] || "").trim();
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function optionalEnv(name: string, fallback: string): string {
  const value = (process.env[name] || "").trim();
  return value || fallback;
}

export function booleanEnv(name: string, fallback = false): boolean {
  const value = (process.env[name] || "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function parseCorsOriginEnv(name: string): true | string[] {
  const raw = (process.env[name] || "").trim();
  if (!raw || raw === "*") return true;

  const list = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return list.length ? list : true;
}
