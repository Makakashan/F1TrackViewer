"use client";

export default function ErrorBanner({ error }: { error: string }) {
	return (
		<div className="absolute left-1/2 top-4 z-10 -translate-x-1/2 rounded-md border border-destructive/60 bg-destructive/15 px-4 py-2 text-xs text-destructive backdrop-blur">
			{error}
		</div>
	);
}
