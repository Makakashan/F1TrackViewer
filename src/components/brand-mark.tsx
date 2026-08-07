import { cn } from "@/lib/utils";

/**
 * The project's mark: a racing F, and a banana standing where the numeral goes.
 *
 * Deliberately not a copy of the championship's own logo — that is a trademark
 * and this app is unofficial. What it borrows is the idea every motorsport mark
 * uses: letterforms sheared into their own slipstream. The banana is both the
 * joke and the one, and it curves the same way the F leans.
 *
 * One colour throughout, taken from `currentColor`: the mark has to sit on the
 * dark overlay and on a light page, and a two-tone banana turns to mud at the
 * size a tab icon gets.
 */
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
      <path d="M79.5 3 H89.5 C96 21 89.5 34.5 69.5 38.6 C67.3 39.4 66 36.6 68.2 35.4 C81.5 28.5 85 18 83 8 L79.5 8 Z" />
    </svg>
  );
}
