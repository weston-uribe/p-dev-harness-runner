import type { IncomingMessage, ServerResponse } from "node:http";
import { handleLinearWebhook } from "../src/webhook/handle-linear-webhook.js";

type VercelRequest = IncomingMessage & {
  method?: string;
  headers: Record<string, string | string[] | undefined>;
};

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function getHeader(req: VercelRequest, name: string): string | null {
  const value = req.headers[name.toLowerCase()] ?? req.headers[name];
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value ?? null;
}

export default async function handler(
  req: VercelRequest,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const rawBody = method === "POST" ? await readRawBody(req) : "";

  const result = await handleLinearWebhook({
    method,
    rawBody,
    headerGetter: (name) => getHeader(req, name),
  });

  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(result.body));
}
