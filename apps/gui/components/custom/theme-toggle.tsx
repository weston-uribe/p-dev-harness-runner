"use client";

import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useThemeToggle } from "@/lib/use-theme-toggle";

export function ThemeToggle() {
  const { mounted, isDark, toggleTheme } = useThemeToggle();

  if (!mounted) {
    return (
      <Button type="button" variant="ghost" size="sm" className="h-8 w-8 px-0" disabled>
        <span className="sr-only">Toggle theme</span>
      </Button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="inline-flex h-8 items-center gap-2 px-2"
      onClick={toggleTheme}
    >
      {isDark ? (
        <Sun className="h-4 w-4" aria-hidden />
      ) : (
        <Moon className="h-4 w-4" aria-hidden />
      )}
      <span className="text-sm">{isDark ? "Light" : "Dark"}</span>
      <span className="sr-only">Toggle theme</span>
    </Button>
  );
}
