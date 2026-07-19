import { createHash } from "node:crypto";
import { z } from "zod";

export const PRODUCT_MARKER_PATH = ".p-dev/product.json";
export const PRODUCT_README_PATH = "README.md";
export const TARGET_REPO_MAIN_BRANCH = "main";
export const TARGET_REPO_DEV_BRANCH = "dev";

const approvedArchitectureSchema = z.object({
  platformRuntime: z.string().min(1),
  languageFramework: z.string().min(1),
  repositoryStructure: z.string().optional(),
  testingStrategy: z.string().optional(),
  ciStrategy: z.string().optional(),
});

export const productMarkerSchema = z.object({
  schemaVersion: z.literal(1),
  createdBy: z.literal("p-dev"),
  initializationStatus: z.enum(["uninitialized", "initialized"]),
  createdAt: z.string().datetime(),
  operationId: z.string().min(1),
  creationActionId: z.string().min(1),
  approvedArchitecture: approvedArchitectureSchema.optional(),
});

export type ProductMarkerV1 = z.infer<typeof productMarkerSchema>;

export function buildProductReadme(productName: string): string {
  return `# ${productName}

This product repository was created by PDev.

The product architecture has not been selected yet. Describe the product you want to build in Linear and begin with planning.
`;
}

export function buildUninitializedProductMarker(input: {
  createdAt: string;
  operationId: string;
  creationActionId: string;
}): ProductMarkerV1 {
  return {
    schemaVersion: 1,
    createdBy: "p-dev",
    initializationStatus: "uninitialized",
    createdAt: input.createdAt,
    operationId: input.operationId,
    creationActionId: input.creationActionId,
  };
}

export function serializeProductMarker(marker: ProductMarkerV1): string {
  return `${JSON.stringify(marker, null, 2)}\n`;
}

export function parseProductMarkerJson(
  content: string,
): { ok: true; marker: ProductMarkerV1 } | { ok: false; reason: string } {
  try {
    const parsed = productMarkerSchema.safeParse(JSON.parse(content));
    if (!parsed.success) {
      return {
        ok: false,
        reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      };
    }
    return { ok: true, marker: parsed.data };
  } catch {
    return { ok: false, reason: "Product marker is not valid JSON." };
  }
}

export function hashProductMarkerContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
