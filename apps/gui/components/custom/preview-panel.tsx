import { RESPONSIVE, SPACING } from "@/lib/constants";
import { cn } from "@/lib/utils";

interface PreviewPanelProps {
  title: string;
  content?: string;
  className?: string;
}

export function PreviewPanel({ title, content, className }: PreviewPanelProps) {
  return (
    <div className={cn(SPACING.stackSm, className)}>
      <p className="text-sm font-medium">{title}</p>
      <pre className={cn(RESPONSIVE.previewPanel, "font-mono whitespace-pre-wrap")}>
        {content ?? "No preview available."}
      </pre>
    </div>
  );
}
