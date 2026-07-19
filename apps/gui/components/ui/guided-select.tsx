import * as React from "react";

import { cn } from "@/lib/utils";
import { FORM } from "@/lib/constants/form";

const GuidedSelect = React.forwardRef<
  HTMLSelectElement,
  React.ComponentProps<"select">
>(({ className, children, ...props }, ref) => {
  return (
    <select
      className={cn(FORM.guidedSelect, className)}
      ref={ref}
      {...props}
    >
      {children}
    </select>
  );
});
GuidedSelect.displayName = "GuidedSelect";

export { GuidedSelect };
