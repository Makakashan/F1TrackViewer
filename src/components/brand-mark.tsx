import { cn } from "@/lib/utils";

/** The project's mark: a racing F, and a banana standing where the numeral goes. */
/** The banana on its own, for setting inside a line of text as the numeral. */
export function BananaGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="64 2 34 38"
      className={cn("block", className)}
      aria-hidden
      fill="currentColor"
    >
      <path d={BANANA} />
    </svg>
  );
}

const BANANA =
  "M79.5 3 H89.5 C96 21 89.5 34.5 69.5 38.6 C67.3 39.4 66 36.6 68.2 35.4 C81.5 28.5 85 18 83 8 L79.5 8 Z";

export default function BrandMark({
  className,
  title,
}: {
  className?: string;
  title?: string;
}) {
  return (
    <svg
      viewBox="0 0 100 40"
      className={cn("block", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      fill="currentColor"
    >
      {title && <title>{title}</title>}
      {/* The F, sheared forward: stem, then two arms running off it. */}
      <path d="M20 2 h16 l-9 36 h-16 z" />
      <path d="M30 2 h30 l-3 10 h-30 z" />
      <path d="M26 16 h26 l-3 10 h-26 z" />
      {/* The banana as the one. Outer curve down the front, inner curve back
          up, and a stem squared off at the top where a numeral would have its
          flag. */}
      <path d={BANANA} />
    </svg>
  );
}
