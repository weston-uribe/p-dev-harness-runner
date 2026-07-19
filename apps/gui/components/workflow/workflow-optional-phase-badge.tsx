/**
 * Reusable optional-phase badge for workflow cards.
 */

export function WorkflowOptionalPhaseBadge(props: {
  visible?: boolean;
  label?: string;
  tone?: "default" | "setup" | "active";
}) {
  if (!props.visible) return null;
  const toneClass =
    props.tone === "active"
      ? "border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
      : props.tone === "setup"
        ? "border-amber-500/40 text-amber-700 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span
      className={`workflow-optional-phase-badge rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${toneClass}`}
      data-testid="optional-phase-badge"
    >
      {props.label ?? "Optional"}
    </span>
  );
}
