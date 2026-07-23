import { NextRequest, NextResponse } from "next/server";
import { guardCursorUsageGet } from "@/lib/cursor-usage-request-guard";
import { resolveCursorUsageServerContext } from "@/lib/cursor-usage-server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const guard = await guardCursorUsageGet(request);
  if (!guard.ok) {
    return guard.response;
  }

  const ctx = await resolveCursorUsageServerContext();
  const d = ctx.discovery;
  return NextResponse.json({
    langfuseConfigured: d.langfuseConfigured,
    configurationStatus: d.configurationStatus,
    providerConfigured: d.providerConfigured,
    credentialsConfigured: d.credentialsConfigured,
    namespaceConfigured: d.namespaceConfigured,
    namespace: d.namespace,
    environment: d.environmentFilter,
    environmentFilterExplicit: d.environmentFilterExplicit,
    langfuseHost: d.langfuseHost,
    errorCode: d.errorCode,
    errorMessage: d.errorMessage,
    adminKeyConfigured: ctx.adminKeyConfigured,
  });
}
