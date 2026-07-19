import { redirect } from "next/navigation";
import { resolvePackagedDefaultRoute } from "@harness/setup/packaged-default-route";
import { resolveHarnessWorkspaceDir } from "@harness/gui/repo-root";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const workspaceDir = resolveHarnessWorkspaceDir();
  const { route } = await resolvePackagedDefaultRoute(workspaceDir);
  redirect(route);
}
