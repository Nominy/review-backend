type StructuredLogLevel = "info" | "error";

export function writeStructuredLog(
  entry: Record<string, unknown>,
  level: StructuredLogLevel = "info"
): void {
  const line = JSON.stringify(entry);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}
