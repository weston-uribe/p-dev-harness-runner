import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function OperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string; fixture?: string; scope?: string }>;
}) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.source) {
    query.set("source", params.source);
  }
  if (params.fixture) {
    query.set("fixture", params.fixture);
  }
  if (params.scope) {
    query.set("scope", params.scope);
  }
  const suffix = query.toString();
  redirect(suffix ? `/workflow?${suffix}` : "/workflow");
}
