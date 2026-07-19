export type HarnessProductInitializationStatus = "uninitialized" | "initialized";

export interface HarnessProjectMetadata {
  targetRepo?: string;
  productInitialization?: HarnessProductInitializationStatus;
}

const HARNESS_METADATA_HEADER = "Harness metadata:";

function parseMetadataLine(line: string): { key: string; value: string } | null {
  const match = line.match(/^([A-Za-z][A-Za-z ]*):\s*(.+)$/);
  if (!match) {
    return null;
  }
  return {
    key: match[1]!.trim().toLowerCase(),
    value: match[2]!.trim(),
  };
}

export function parseHarnessProjectMetadata(
  description: string | null | undefined,
): HarnessProjectMetadata {
  if (!description?.trim()) {
    return {};
  }

  const lines = description.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === HARNESS_METADATA_HEADER.toLowerCase(),
  );
  if (headerIndex === -1) {
    return {};
  }

  const metadata: HarnessProjectMetadata = {};
  for (let index = headerIndex + 1; index < lines.length; index += 1) {
    const trimmed = lines[index]!.trim();
    if (!trimmed) {
      break;
    }
    if (trimmed.startsWith("#")) {
      break;
    }
    if (trimmed.startsWith("##")) {
      break;
    }

    const parsed = parseMetadataLine(trimmed);
    if (!parsed) {
      continue;
    }

    if (parsed.key === "target repo") {
      metadata.targetRepo = parsed.value.replace(/^`|`$/g, "");
    } else if (parsed.key === "product initialization") {
      if (parsed.value === "uninitialized" || parsed.value === "initialized") {
        metadata.productInitialization = parsed.value;
      }
    }
  }

  return metadata;
}

export function formatHarnessMetadataBlock(
  metadata: HarnessProjectMetadata,
): string {
  const lines = [HARNESS_METADATA_HEADER];
  if (metadata.targetRepo) {
    lines.push(`Target repo: ${metadata.targetRepo}`);
  }
  if (metadata.productInitialization) {
    lines.push(`Product initialization: ${metadata.productInitialization}`);
  }
  return lines.join("\n");
}

export function upsertHarnessMetadataInDescription(
  description: string | null | undefined,
  patch: Partial<HarnessProjectMetadata>,
): string {
  const existing = parseHarnessProjectMetadata(description);
  const merged: HarnessProjectMetadata = {
    ...existing,
    ...patch,
  };
  const block = formatHarnessMetadataBlock(merged);

  if (!description?.trim()) {
    return `${block}\n`;
  }

  const lines = description.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === HARNESS_METADATA_HEADER.toLowerCase(),
  );

  if (headerIndex === -1) {
    const suffix = description.endsWith("\n") ? "" : "\n";
    return `${description}${suffix}\n${block}\n`;
  }

  let endIndex = headerIndex + 1;
  while (endIndex < lines.length) {
    const trimmed = lines[endIndex]!.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      break;
    }
    endIndex += 1;
  }

  const before = lines.slice(0, headerIndex);
  const after = lines.slice(endIndex);
  const rebuilt = [...before, block, ...after].join("\n").replace(/\n{3,}/g, "\n\n");
  return rebuilt.endsWith("\n") ? rebuilt : `${rebuilt}\n`;
}

export function removeHarnessMetadataFromDescription(
  description: string | null | undefined,
): string {
  if (!description?.trim()) {
    return "";
  }

  const lines = description.split("\n");
  const headerIndex = lines.findIndex(
    (line) => line.trim().toLowerCase() === HARNESS_METADATA_HEADER.toLowerCase(),
  );
  if (headerIndex === -1) {
    return description.endsWith("\n") ? description : `${description}\n`;
  }

  let endIndex = headerIndex + 1;
  while (endIndex < lines.length) {
    const trimmed = lines[endIndex]!.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      break;
    }
    endIndex += 1;
  }

  const before = lines.slice(0, headerIndex);
  const after = lines.slice(endIndex);
  const rebuilt = [...before, ...after].join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return rebuilt ? `${rebuilt}\n` : "";
}
