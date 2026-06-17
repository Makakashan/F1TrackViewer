"use client";

import { useState } from "react";
import { Settings, Check, Languages, Sun, Moon, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAppPref } from "@/components/app-pref-provider";
import { LANGS, THEMES, type Lang, type Theme } from "@/lib/i18n";

export default function SettingsMenu() {
  const { lang, setLang, theme, setTheme, t } = useAppPref();
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-foreground"
          aria-label={t.settings}
        >
          <Settings className="h-4 w-4" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-64 p-0 bg-popover border-border"
      >
        {/* Language section */}
        <div className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Languages className="h-3 w-3" />
            {t.language}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {LANGS.map((l) => (
              <button
                key={l.code}
                onClick={() => setLang(l.code as Lang)}
                className={cn(
                  "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                  lang === l.code
                    ? "bg-primary/15 text-foreground"
                    : "text-foreground/80 hover:bg-accent",
                )}
              >
                <span className="text-base leading-none">{l.flag}</span>
                <span className="flex-1 text-left">{l.label}</span>
                {lang === l.code && (
                  <Check className="h-3.5 w-3.5 text-primary" />
                )}
              </button>
            ))}
          </div>
        </div>

        <Separator />

        {/* Theme section */}
        <div className="p-3">
          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
            <Sun className="h-3 w-3" />
            {t.theme}
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {THEMES.map((th) => {
              const Icon =
                th.code === "light"
                  ? Sun
                  : th.code === "dark"
                    ? Moon
                    : Monitor;
              return (
                <button
                  key={th.code}
                  onClick={() => setTheme(th.code as Theme)}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                    theme === th.code
                      ? "bg-primary/15 text-foreground"
                      : "text-foreground/80 hover:bg-accent",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span className="flex-1 text-left">
                    {(t as any)[th.labelKey]}
                  </span>
                  {theme === th.code && (
                    <Check className="h-3.5 w-3.5 text-primary" />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
