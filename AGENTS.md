# AGENTS.md

## Where things are

- `README.md` — what the app does, the source layout, every `bun run` script, the URL
  parameters, and where the data comes from.
- `docs/architecture.md` — how the modes route, how track data flows into the scene,
  the one curvature profile every corner-shaped thing reads, the terrain sampler, the
  race simulation, and the caching order.

Read the section that covers the area you are about to change before changing it.

## When the ask is unclear

Run `grill-me` (the `grilling` skill) instead of picking a reading and building on it.
It interviews the user in rounds until the design is settled, which is what an
ambiguous request or a decision that is theirs to make needs — a guess here is work
thrown away later.

## Conventions

- **Strings.** UI text lives in `src/lib/i18n.ts` and reaches the screen through
  `useAppPref().t`. Every key exists in both `en` and `ru`.
- **State a link should carry** belongs in `src/lib/url-state.ts`. Everything the app
  shows is reachable by URL, and that is a feature, not a side effect.
- **The canvas runs `frameloop="demand"`.** Anything that changes the scene outside a
  React render — a ref write, a key handler, an imperative camera move — calls
  `invalidate()`, or the change is computed and never drawn.
- **`public/**` is generated** by `scripts/**`. Fix the generator and rerun it; edits
  made to its output by hand disappear on the next run.
- **`src/lib/race/race-sim.ts` is deterministic**: fixed `dt`, a seed per circuit, no
  `Math.random`, no `Date.now`, no allocation per step. The same link has to show the
  same race.
- **"Like the real thing" is a research task.** When the ask is to match reality — a
  livery, a number, a broadcast graphic, a circuit detail, a rule — search the web
  and cite what you found instead of answering from memory. Memory of a 2025 livery
  is a guess dressed as a fact. Say which parts the sources confirmed and which are
  still your best approximation.
- **Use the MCP tools freely.** Playwright drives the dev server — open the page,
  take the screenshot, read the console rather than reasoning about what the change
  probably looks like. context7 answers library questions (three.js, R3F, Next.js)
  against current docs. Neither needs permission.
- **Check port 4000 before starting anything.** `ss -ltn | grep :4000` — a listener
  there is the user's own dev server, so point the browser at
  `http://localhost:4000` and leave it running. Start `bun run dev` only when the
  port is free, and stop it when you are done. Close the pages you opened either
  way: this machine's GPU driver does not enjoy a pile of live WebGL tabs.
- **Frame rate is the default priority.** A change that makes the scene prettier and
  the frame longer is the wrong trade unless the user asked for image quality. The
  levers already exist — the `quality` URL setting, car LODs, the instanced fleet,
  `frameloop="demand"` — so a new effect goes behind them rather than on top of
  everyone. Budget it: how many draw calls, how much per frame, on the mobile path
  too.
- **Write the simplest version that keeps the performance.** This scene runs per
  frame and the simulation steps at a fixed `dt`, so the hot paths earn their
  complexity — everything else takes the plain formulation.
- **Leave the tree clean.** Delete what a change makes dead: the replaced branch, the
  unused constant, the field nothing reads, the scratch file. Dead code left behind
  reads as live code to whoever comes next.
- **Spotted an optimisation outside the task? Say so, do not fold it in.** Name the
  file, the cost, and what it would take, and let the user decide whether it is worth
  a change.
- **Comments say why, in a line or two.** When you touch code that has a longer
  comment beside it, cut that comment down to its point.

## Git

- One commit per reason to change. Several small commits beat one wide one.
- Subject: lowercase `feat|fix|refactor|docs|test:` followed by what the change makes
  true — `fix: roads lie on the terrain instead of hovering over it`.
- No `Co-Authored-By` trailer and no AI attribution anywhere in a commit or PR.
- Work on a branch off `main`.
- Commit and push only when asked to. Finished work waits in the working tree until
  the user says to commit it.

## Done means

- `bun run typecheck` and `bun run lint` are clean.
- The audit for what you touched has run: `bun run race:kerbs` for corner detection
  and kerbs, `bun run race:gaps` for timing-tower gaps, `bun run race:audit` for the
  field over a full race, `bun run race:laptimes` for the speed model,
  `bun run env:audit <circuitId>` for a baked city.
- You say which of those you ran and what they reported.
