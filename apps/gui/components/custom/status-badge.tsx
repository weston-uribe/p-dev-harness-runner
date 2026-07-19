import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type StatusVariant = "success" | "warning" | "destructive" | "secondary";

interface StatusBadgeProps {
  label: string;
  variant?: StatusVariant;
  className?: string;
}

export function StatusBadge({
  label,
  variant = "secondary",
  className,
}: StatusBadgeProps) {
  return (
    <Badge variant={variant} className={cn(className)}>
      {label}
    </Badge>
  );
}
