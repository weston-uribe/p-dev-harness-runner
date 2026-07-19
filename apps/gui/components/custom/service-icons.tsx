import type { ServiceKey } from "@/components/custom/environment-config-form";
import { SiCursor, SiGithub, SiLinear, SiVercel } from "react-icons/si";
import { cn } from "@/lib/utils";

const ICON_CLASS = "size-4 shrink-0 text-muted-foreground";

export function ServiceIcon({
  serviceKey,
  className,
}: {
  serviceKey: ServiceKey;
  className?: string;
}) {
  const iconClass = cn(ICON_CLASS, className);

  switch (serviceKey) {
    case "LINEAR_API_KEY":
      return <SiLinear className={iconClass} aria-hidden="true" />;
    case "CURSOR_API_KEY":
      return <SiCursor className={iconClass} aria-hidden="true" />;
    case "GITHUB_TOKEN":
      return <SiGithub className={iconClass} aria-hidden="true" />;
    case "VERCEL_TOKEN":
      return <SiVercel className={iconClass} aria-hidden="true" />;
  }
}

export function RepoIcon({ className }: { className?: string }) {
  return <SiGithub className={cn(ICON_CLASS, className)} aria-hidden="true" />;
}
