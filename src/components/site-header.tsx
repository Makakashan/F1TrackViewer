"use client";

import type { ReactNode } from "react";
import { BrandMark, GithubMark, REPO_URL } from "@/components/brand";
import SettingsMenu from "@/components/settings-menu";

/** The two button sizes the chrome uses: 32px in a header, 40px in the hero. */
export const buttons = {
  primary:
    "inline-flex h-8 items-center justify-center gap-2 rounded-[10px] bg-primary px-3.5 text-[13px] font-medium text-primary-foreground hover:opacity-90",
  secondary:
    "inline-flex h-8 items-center justify-center gap-2 rounded-[10px] border border-border px-3 text-[13px] text-muted-foreground hover:bg-secondary hover:text-foreground",
};

/** The bar every screen shares: the brand and an optional crumb on the left, links, actions on the right. */
export function SiteHeader({
  crumb,
  onBrand,
  nav,
  children,
}: {
  crumb?: string;
  onBrand?: () => void;
  nav?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="absolute inset-x-0 top-0 z-30 h-[calc(57px+env(safe-area-inset-top))] border-b border-border bg-(--header-bg) pt-[env(safe-area-inset-top)] backdrop-blur-md">
      <div className="flex h-[57px] items-center justify-between gap-4 px-[clamp(12px,2vw,24px)]">
        <div className="flex min-w-0 items-center gap-9">
          <div className="flex min-w-0 items-center gap-[9px] text-[15px] font-semibold tracking-[-0.02em]">
            <button onClick={onBrand} className="flex shrink-0 items-center gap-[9px]">
              <BrandMark className="h-5 w-5" /> Boxlane
            </button>
            {crumb && (
              <>
                <span className="font-normal text-muted-foreground/60">/</span>
                <span className="truncate font-medium">{crumb}</span>
              </>
            )}
          </div>
          {nav && <nav className="hidden gap-[22px] text-[13px] text-muted-foreground md:flex">{nav}</nav>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <a href={REPO_URL} className={`${buttons.secondary} max-md:hidden`}>
            <GithubMark /> GitHub
          </a>
          {children}
          <SettingsMenu />
        </div>
      </div>
    </header>
  );
}
