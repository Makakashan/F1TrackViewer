import { cn } from "@/lib/utils";

/**
 * The project's mark: a banana where the racing wordmark keeps its letter,
 * followed by the numeral, cut by the same speed wedge.
 *
 * Deliberately not a copy of the championship's own logo — that is a trademark
 * and this app is unofficial. What it borrows is the idea every motorsport mark
 * uses: a shape leaning into its own slipstream with the air torn off behind
 * it. The banana is the joke and the brand at once.
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
      viewBox="0 0 96 40"
      className={cn("block", className)}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {/* The slipstream: bars torn off the mark, shortest furthest back. */}
      <g fill="#e10600">
        <path d="M0 9 H16 L11 16 H-5 Z" />
        <path d="M2 20 H20 L15 27 H-3 Z" />
        <path d="M6 31 H26 L21 38 H1 Z" />
      </g>
      {/* The banana, leaning the way the letter it replaces leans. */}
      <g transform="rotate(-12 46 20)">
        <path
          d="M28 5c-2 13 3 24 14 28 8 3 16 2 20-2-7 1-13-1-18-6-6-6-9-13-9-20 0-1-1-2-3-2-2 0-4 1-4 2z"
          fill="#ffd12e"
        />
        <path
          d="M28 5c-2 13 3 24 14 28 3 1 6 2 9 2-8-3-14-9-17-17-2-5-3-10-2-15 0-1-1-1-2-1s-2 1-2 3z"
          fill="#e8b71d"
        />
        <path d="M27 7c-1-3 0-5 2-5s3 2 3 4z" fill="#4a3b1a" />
        <path d="M60 30c2-1 3 0 3 1 0 2-2 3-4 2z" fill="#4a3b1a" />
      </g>
      {/* The numeral, in the same forward lean. It takes the ink colour of
          whatever it is placed on rather than a fixed white, so the mark works
          on the dark overlay and on a light page without a second file. */}
      <path d="M76 3 h19 l-10 34 h-19 l7-24 -9 4 2-9 z" fill="currentColor" />
    </svg>
  );
}
