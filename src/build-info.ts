import { spawnSync } from "node:child_process";

export type BuildInfo = {
  commit: string;
  shortCommit: string;
  branch: string;
  source: "env" | "git" | "unknown";
};

function readGitValue(args: string[]): string {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function normalizeCommit(value: string): string {
  return /^[0-9a-f]{7,40}$/i.test(value) ? value : "";
}

export function getBuildInfo(): BuildInfo {
  const envCommit = normalizeCommit(process.env.GIT_COMMIT || process.env.GITHUB_SHA || "");
  const gitCommit = envCommit || normalizeCommit(readGitValue(["rev-parse", "HEAD"]));
  const branch =
    process.env.GIT_BRANCH ||
    process.env.GITHUB_REF_NAME ||
    readGitValue(["branch", "--show-current"]) ||
    "unknown";

  return {
    commit: gitCommit || "unknown",
    shortCommit: gitCommit ? gitCommit.slice(0, 12) : "unknown",
    branch,
    source: envCommit ? "env" : gitCommit ? "git" : "unknown"
  };
}
