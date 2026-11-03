---
name: verify-scheduler
description: Model-check mdpx's scheduler (src/scheduler.ts) against its safety and liveness properties by exploring every order of saves, syncs, captures, failures, keys and resizes up to a depth. Use whenever a change touches src/scheduler.ts, the layout functions it calls in src/layout.ts, or sameRaster/resolveGeometry in src/geometry.ts, and before merging such a change.
---

# Verify the scheduler

`src/scheduler.ts` decides what to sync, what to capture, what to evict and when the screen
moves, while syncs, captures and their failures come back in any order. Unit tests cover the
orders someone thought of. `verification/scheduler.check.ts` runs the real `Scheduler` class
through every order of events in a small world, breadth first, and checks every step.

## What it proves

Each property, with the harm when it breaks:

| Property | Harm if broken |
| --- | --- |
| A block shows without its image only after a resize, or after the old screen gave way because it and the target (the update or scroll being fetched) do not fit in storage together | the screen shows a block as blank page for no reason |
| An image the screen goes on showing is evicted only in that same crowded case | a block vanishes mid-read for no reason |
| With nothing in flight, every block on screen has its image, unless the screen alone exceeds storage or that block's capture failed | a hole stays on screen for good |
| Images held plus the capture in flight stay within terminal storage | the terminal drops images, or the herdr relay stalls |
| The terminal holds exactly the ids the scheduler believes are resident | leaked images fill storage, or placements point at nothing |
| At most one sync and one capture are in flight; a new id is never one the terminal holds | page work interleaves; an upload overwrites a live image |
| With nothing in flight, the status is never "scrolling", "updating" or "rendering" | a scroll or an update waits forever for work that never starts |
| With room for two screens, one more save followed by answers without failure shows the current document, covered, status idle | an edit never reaches the screen |

The world: 5 documents (insert at the top, edit, delete with a duplicate, two blocks merged into
one unit, a block cut into 3 slices), 3 screens (base, more rows, wider), 6 keys, Ctrl-R, and a
page that may answer a sync at the old or the new screen, fail it, deliver a capture, or fail it
as "blocks moved" or as a content error. It runs twice: storage for 4 slices, which evicts
constantly and must stay safe, and storage for 9, which must also let every update through.

Assumptions: each event is atomic, as it is in `src/pipeline.ts` (a capture is transmitted
right before `captured` is dispatched); the clock, change marks and latency are left out because
they only feed the status line and the wake-up time; image ids are compared up to renaming.

Not covered: `src/pipeline.ts` itself, the page (`src/page.ts`), what the screen draws
(`src/screen.ts`, `cropOf`), documents or screens outside the world above, and orders longer
than the depth. A pass covers that world and depth, not the whole program.

## Run it

```sh
bun run verify
```

The default depth is 8 (about 20 seconds; every order of up to 8 events). Before merging a
scheduler change, go deeper:

```sh
bun run verify --depth 10
```

Depth 10 explores about 800,000 states in about 3 minutes per storage setting. Exit status 0
means every property held; 1 means a violation, printed with the shortest event sequence that
reaches it, for example:

```
VIOLATION (storage "tight"): nothing is in flight, yet the status says "scrolling": that work never happens
   1. start: the file holds doc 0, mdpx dispatches its first save
   ...
   8. page fails B/1/75 (content error)
```

Replay the steps in a scheduler test (`src/scheduler.test.ts`, the `Session` harness has a
method for each event) to see it fail, fix the scheduler, and keep the test.

## A real bug or a modeling error?

- `Scheduler fields changed (...)`: the class gained or lost a field. Add it to `FIELDS`, copy it
  in `cloneScheduler` (deeply, if it is a mutable collection), and add it to `stateKey` unless it
  only feeds the status line. This is never a scheduler bug.
- A trace with a step the real pipeline cannot produce is a modeling error: fix the move in
  `moves()`. For example, a `captured` for an id that was never requested.
- Otherwise it is a real bug. Do not weaken a property or shrink the world to make it pass.
  If a change is meant to alter a property, such as letting the screen show a hole in a new
  situation, change the property in `checkState` and this file together, and say why in the
  commit.

## When the scheduler changes on purpose

- A new event type: add a move in `moves()` that the real pipeline or user could produce.
- A new field: see above.
- A new action: handle it in `perform()`, and check there whatever it must not do.
- A new layout feature the scheduler depends on (a new kind of block, unit or slice): add a
  document to `DOCS` that exercises it.

Then show the check still bites: break the line that guards one property in a scratch copy of
`src/` (for example, delete `if (!this.covers(next, top)) return;` in `settle`), run the checker
against the copy, confirm it reports the violation, and discard the copy.

## Coverage and sync

| Check | Code it covers |
| --- | --- |
| all properties | `Scheduler` in `src/scheduler.ts`: `dispatch`, `view`, and every private method |
| visibility and anchors | `buildLayout`, `visibleImageKeys`, `maxTop`, `clampTop`, `anchorAt`, `topFor`, `headingRows`, `prefetchOrder` in `src/layout.ts` |
| screens | `resolveGeometry`, `sameRaster`, `maxSliceImagePx`, `maxSliceImageRows`, `captureGridCss` in `src/geometry.ts` (and `Theme` in `src/theme.ts`, by type only) |

Last confirmed against the code at commit `363c15e`. When any covered code has changed since
that commit, run the check. Once it passes and you have confirmed that the world and the
properties above still describe the code, move this commit forward. Do not move it otherwise.
