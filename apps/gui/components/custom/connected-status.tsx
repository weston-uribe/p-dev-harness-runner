import { FaCheckCircle } from "react-icons/fa";
import { cn } from "@/lib/utils";

export function ConnectedStatusMessage({
  message,
  failed = false,
  className,
}: {
  message: string;
  failed?: boolean;
  className?: string;
}) {
  return (
    <p
      className={cn(
        "flex items-center gap-2 text-sm",
        failed ? "text-destructive" : "text-muted-foreground",
        className,
      )}
    >
      {!failed ? (
        <FaCheckCircle
          className="size-4 shrink-0 text-green-600"
          aria-hidden="true"
        />
      ) : null}
      <span>{message}</span>
    </p>
  );
}
