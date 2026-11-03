import { describe, expect, test } from "bun:test";
import { maxSliceImagePx, resolveGeometry, type Geometry } from "./geometry.ts";
import { maxTop, visibleImageKeys, type SyncedLayout } from "./layout.ts";
import { MARK_MS, Scheduler, type Action, type ScrollDelta, type SchedulerEvent, type Step } from "./scheduler.ts";
import { GEO } from "./test-geometry.ts";

interface Spec {
  key: string;
  height: number;
}

function synced(specs: readonly Spec[], g: Geometry): SyncedLayout {
  let y = 32;
  const blocks = specs.map((s, i) => {
    if (i > 0) y += 16;
    const block = { key: s.key, topCss: y, heightCss: s.height };
    y += s.height;
    return block;
  });
  return { raster: g.raster, theme: "light", blocks, docHeightCss: y + 32 };
}

const paragraphs = (n: number, prefix = "p", height = 60): Spec[] =>
  Array.from({ length: n }, (_, i) => ({ key: `${prefix}${i}`, height }));

type CaptureAction = Extract<Action, { type: "capture" }>;

class Session {
  readonly s: Scheduler;
  geometry: Geometry;
  doc: Spec[] = [];
  t = 0;
  syncs = 0;
  captures: CaptureAction[] = [];
  captured: string[] = [];
  terminal = new Map<number, number>();
  usedIds = new Set<number>();
  last: Step = { actions: [], wakeAt: null };

  constructor(geometry: Geometry = GEO) {
    this.geometry = geometry;
    this.s = new Scheduler(geometry);
  }

  get view() {
    return this.s.view();
  }

  send(event: SchedulerEvent): Step {
    this.t = Math.max(this.t, event.at);
    const step = this.s.dispatch(event);
    for (const a of step.actions) {
      if (a.type === "sync") this.syncs++;
      else if (a.type === "evict") for (const id of a.ids) this.terminal.delete(id);
      else {
        expect(this.usedIds.has(a.id)).toBe(false);
        this.usedIds.add(a.id);
        this.captures.push(a);
      }
    }
    this.check();
    this.last = step;
    return step;
  }

  private check(): void {
    const v = this.view;
    expect(this.syncs).toBeLessThanOrEqual(1);
    expect(this.captures.length).toBeLessThanOrEqual(1);
    if (!this.syncs && !this.captures.length) expect(["scrolling", "updating", "rendering"]).not.toContain(v.status);
    for (const { id } of v.images.values()) expect(this.terminal.has(id)).toBe(true);
    expect(this.terminal.size).toBe(v.images.size);
    const inflight = this.captures.reduce((n, a) => n + maxSliceImagePx(a.ref.lengthCss, v.geometry.raster) * v.geometry.imgWidthPx * 4, 0);
    let held = 0;
    for (const { id } of v.images.values()) held += this.terminal.get(id)!;
    expect(held + inflight).toBeLessThanOrEqual(v.geometry.storageBytes);
  }

  tick(ms = 1): number {
    return (this.t += ms);
  }

  save(doc?: Spec[]): Step {
    if (doc) this.doc = doc;
    return this.send({ type: "fileChanged", at: this.tick() });
  }

  sync(): Step {
    expect(this.syncs).toBe(1);
    this.syncs--;
    return this.send({ type: "synced", layout: synced(this.doc, this.geometry), at: this.tick() });
  }

  deliver(): Step {
    const a = this.captures.shift()!;
    const heightImgPx = maxSliceImagePx(a.ref.lengthCss, this.geometry.raster);
    this.terminal.set(a.id, heightImgPx * this.geometry.imgWidthPx * 4);
    this.captured.push(a.imageKey);
    const image = { contentTopImgPx: this.geometry.raster.cellHpx * 1.5, heightImgPx };
    return this.send({ type: "captured", imageKey: a.imageKey, id: a.id, image, at: this.tick() });
  }

  fail(gone: boolean): Step {
    const a = this.captures.shift()!;
    return this.send({ type: "captureFailed", imageKey: a.imageKey, id: a.id, gone, at: this.tick() });
  }

  deliverAll(limit = 10_000): void {
    for (let i = 0; i < limit && (this.captures.length || this.syncs); i++) {
      if (this.syncs) this.sync();
      else this.deliver();
    }
  }

  key(delta: ScrollDelta): Step {
    return this.send({ type: "key", delta, at: this.tick() });
  }

  resize(screen: { cols: number; rows: number }, cell = { cellHpx: 20, cellWpx: 10 }): Step {
    this.geometry = resolveGeometry(screen, cell, { frameBytes: null, storageBytes: this.geometry.storageBytes });
    return this.send({ type: "resize", geometry: this.geometry, at: this.tick() });
  }

  covered(): boolean {
    const v = this.view;
    if (!v.shown) return false;
    return [...visibleImageKeys(v.shown, v.top, v.geometry.viewRows)].every((k) => v.images.has(k));
  }

  topBlock(): string | undefined {
    const v = this.view;
    return v.shown?.units.find((u) => u.rowEnd > v.top)?.members[0]?.key;
  }
}

function withStorage(bytes: number): Geometry {
  return resolveGeometry({ cols: 80, rows: 51 }, { cellHpx: 20, cellWpx: 10 }, { frameBytes: null, storageBytes: bytes });
}

describe("rendering", () => {
  test("the first save syncs, captures what is visible, then shows it", () => {
    const s = new Session();
    expect(s.save(paragraphs(3)).actions).toEqual([{ type: "sync" }]);
    expect(s.view.status).toBe("rendering");
    s.sync();
    expect(s.view.shown).toBeNull();
    s.deliverAll();
    expect(s.view.shown!.blockKeys).toEqual(["p0", "p1", "p2"]);
    expect(s.covered()).toBe(true);
    expect(s.view.status).toBe("idle");
  });

  test("an edit captures only the changed block; the rest keep their images", () => {
    const s = new Session();
    s.save(paragraphs(5));
    s.deliverAll();
    const before = s.captured.length;
    const edited = paragraphs(5);
    edited[2] = { key: "p2-edited", height: 60 };
    s.save(edited);
    s.deliverAll();
    expect(s.captured.slice(before)).toEqual([expect.stringMatching(/^p2-edited\//)]);
    expect(s.view.shown!.blockKeys[2]).toBe("p2-edited");
  });

  test("undoing an edit finds the old pixels without capturing", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.deliverAll();
    s.save([{ key: "x", height: 60 }, ...paragraphs(3).slice(1)]);
    s.deliverAll();
    const before = s.captured.length;
    s.save(paragraphs(3));
    s.deliverAll();
    expect(s.captured.length).toBe(before);
    expect(s.view.shown!.blockKeys).toEqual(["p0", "p1", "p2"]);
  });

  test("saves during a sync coalesce into one more sync of the latest text", () => {
    const s = new Session();
    s.save(paragraphs(2));
    expect(s.save(paragraphs(3)).actions).toEqual([]);
    expect(s.save(paragraphs(4)).actions).toEqual([]);
    expect(s.sync().actions.filter((a) => a.type === "sync")).toHaveLength(1);
    s.deliverAll();
    expect(s.view.shown!.blockKeys).toHaveLength(4);
  });

  test("the old display stays until every visible slice of the update is in the terminal", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.deliverAll();
    s.save([{ key: "a", height: 60 }, { key: "b", height: 60 }, ...paragraphs(3)]);
    s.sync();
    s.deliver();
    expect(s.view.shown!.blockKeys).toEqual(["p0", "p1", "p2"]);
    s.deliver();
    expect(s.view.shown!.blockKeys[0]).toBe("a");
  });

  test("changed blocks are marked, the scheduler asks to be woken, and the mark expires", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.deliverAll();
    expect(s.view.marks.size).toBe(0);
    s.save([...paragraphs(3), { key: "new", height: 60 }]);
    s.deliverAll();
    expect([...s.view.marks]).toEqual(["new"]);
    const wakeAt = s.last.wakeAt!;
    expect(wakeAt).toBe(s.t + MARK_MS - 0);
    s.send({ type: "tick", at: wakeAt });
    expect(s.view.marks.size).toBe(0);
    expect(s.last.wakeAt).toBeNull();
  });

  test("latency runs from the first save to the frame that shows its content", () => {
    const s = new Session();
    s.save(paragraphs(2));
    const start = s.t;
    s.deliverAll();
    expect(s.view.latencyMs).toBe(s.t - start);
  });
});

describe("scrolling", () => {
  test("text inserted above the view keeps the reader's rows", () => {
    const s = new Session();
    s.save(paragraphs(60));
    s.deliverAll();
    s.key({ kind: "lines", n: 100 });
    s.deliverAll();
    const anchored = s.topBlock();
    const offset = s.view.top - s.view.shown!.units.find((u) => u.members[0]!.key === anchored)!.rowStart;
    s.save([{ key: "inserted", height: 400 }, ...paragraphs(60)]);
    s.deliverAll();
    expect(s.topBlock()).toBe(anchored);
    const unit = s.view.shown!.units.find((u) => u.members[0]!.key === anchored)!;
    expect(s.view.top - unit.rowStart).toBe(offset);
  });

  test("at the very top, text inserted above shows instead of being scrolled past", () => {
    const s = new Session();
    s.save(paragraphs(60));
    s.deliverAll();
    s.save([{ key: "title", height: 40 }, ...paragraphs(60)]);
    s.deliverAll();
    expect(s.view.top).toBe(0);
    expect(s.topBlock()).toBe("title");
  });

  test("a scroll waits for the new rows' images, then moves", () => {
    const g = withStorage(12_000_000);
    const t = new Session(g);
    t.save(paragraphs(80));
    t.deliverAll();
    t.key({ kind: "bottom" });
    expect(t.captures.length).toBe(1);
    expect(t.view.status).toBe("scrolling");
    expect(t.view.top).toBe(0);
    t.deliverAll();
    expect(t.view.top).toBe(maxTop(t.view.shown!, g.viewRows));
    expect(t.covered()).toBe(true);
  });

  test("G follows the end of a growing document; scrolling up stops following", () => {
    const s = new Session();
    s.save(paragraphs(60));
    s.deliverAll();
    s.key({ kind: "bottom" });
    s.deliverAll();
    expect(s.view.follow).toBe(true);
    s.save(paragraphs(70));
    s.deliverAll();
    expect(s.view.top).toBe(maxTop(s.view.shown!, GEO.viewRows));
    s.key({ kind: "lines", n: -1 });
    expect(s.view.follow).toBe(false);
  });

  test("storage holds across a long scroll: far images are evicted, the visible ones never", () => {
    const g = withStorage(8_000_000);
    const s = new Session(g);
    s.save(paragraphs(300));
    s.deliverAll();
    for (let i = 0; i < 40; i++) {
      s.key({ kind: "halfpage", dir: 1 });
      s.deliverAll();
      expect(s.covered()).toBe(true);
    }
  });

  test("when the old and the new screen do not fit together, the old one gives way and the update lands", () => {
    const g = withStorage(5_000_000);
    const s = new Session(g);
    s.save(paragraphs(40, "old-"));
    s.deliverAll();
    s.save(paragraphs(40, "new-"));
    s.deliverAll();
    expect(s.view.shown!.blockKeys[0]).toBe("new-0");
    expect(s.view.status).toBe("idle");
    expect(s.covered()).toBe(true);
  });

  test("an update that does not fit even alone keeps the old screen whole", () => {
    const g = withStorage(3_000_000);
    const s = new Session(g);
    s.save(paragraphs(3, "p", 30));
    s.deliverAll();
    const held = [...s.view.images.values()].map((i) => i.id);
    s.save([{ key: "huge", height: 3000 }]);
    s.deliverAll();
    const ids = [...s.view.images.values()].map((i) => i.id);
    expect(held.every((id) => ids.includes(id))).toBe(true);
    expect(s.covered()).toBe(true);
    expect(s.view.status).toBe("update failed");
  });

  test("a move the storage cannot hold is abandoned without dropping the display", () => {
    const g = withStorage(3_000_000);
    const s = new Session(g);
    s.save(paragraphs(3, "p", 30));
    s.deliverAll();
    s.save([{ key: "huge", height: 3000 }]);
    s.deliverAll();
    expect(s.view.shown!.blockKeys).toEqual(["p0", "p1", "p2"]);
    expect(s.view.status).toBe("update failed");
  });
});

describe("resizes and failures", () => {
  test("a resize that only changes the rows keeps every image", () => {
    const s = new Session();
    s.save(paragraphs(10));
    s.deliverAll();
    const before = s.captured.length;
    s.resize({ cols: 80, rows: 30 });
    s.deliverAll();
    expect(s.captured.length).toBe(before);
    expect(s.covered()).toBe(true);
  });

  test("a new width re-syncs, and a layout or capture from the old width is thrown away", () => {
    const s = new Session();
    s.save(paragraphs(10));
    s.sync();
    expect(s.captures).toHaveLength(1);
    const stale = synced(s.doc, s.geometry);
    s.resize({ cols: 100, rows: 51 });
    const landed = s.captures[0]!.id;
    s.deliver();
    expect(s.terminal.has(landed)).toBe(false);
    expect(s.syncs).toBe(1);
    s.syncs--;
    s.send({ type: "synced", layout: stale, at: s.tick() });
    expect(s.syncs).toBe(1);
    s.deliverAll();
    expect(s.view.shown!.raster.contentCols).toBe(99);
    expect(s.covered()).toBe(true);
  });

  test("a capture whose blocks moved re-syncs instead of retrying the stale layout", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.sync();
    s.fail(true);
    expect(s.syncs).toBe(1);
    s.deliverAll();
    expect(s.covered()).toBe(true);
  });

  test("a failed capture keeps the display, reports the failure, and the next save recovers", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.deliverAll();
    s.save([{ key: "bad", height: 60 }, ...paragraphs(3)]);
    s.sync();
    s.fail(false);
    expect(s.view.shown!.blockKeys).toEqual(["p0", "p1", "p2"]);
    expect(s.view.status).toBe("update failed");
    s.save([{ key: "good", height: 60 }, ...paragraphs(3)]);
    s.deliverAll();
    expect(s.view.shown!.blockKeys[0]).toBe("good");
    expect(s.view.status).toBe("idle");
  });

  test("a failed render is reported and the next save retries", () => {
    const s = new Session();
    s.save(paragraphs(3));
    s.syncs--;
    s.send({ type: "syncFailed", at: s.tick() });
    expect(s.view.status).toBe("render failed");
    s.save();
    s.deliverAll();
    expect(s.view.status).toBe("idle");
  });
});

describe("random interleavings", () => {
  function rng(seed: number): () => number {
    let x = seed >>> 0;
    return () => {
      x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
      return x / 2 ** 32;
    };
  }

  test("invariants hold under any order of edits, scrolls, resizes and failures, and the view converges", () => {
    for (let seed = 1; seed <= 90; seed++) {
      const random = rng(seed);
      const pick = <T,>(xs: readonly T[]) => xs[Math.floor(random() * xs.length)]!;
      const storage = seed % 3 === 0 ? 4_000_000 : pick([12_000_000, 320_000_000]);
      const s = new Session(withStorage(storage));
      let doc = paragraphs(20 + Math.floor(random() * 40), "p", 40);
      let serial = 0;
      s.save(doc);
      for (let step = 0; step < 200; step++) {
        const r = random();
        if (r < 0.15) {
          doc = [...doc];
          const i = Math.floor(random() * (doc.length + 1));
          const op = random();
          if (op < 0.4 || doc.length < 3) doc.splice(i, 0, { key: `n${serial++}`, height: 20 + random() * 200 });
          else if (op < 0.7) doc.splice(Math.min(i, doc.length - 1), 1);
          else doc[Math.min(i, doc.length - 1)] = { key: `e${serial++}`, height: 20 + random() * 200 };
          s.save(doc);
        } else if (r < 0.3 && s.syncs) s.sync();
        else if (r < 0.65 && s.captures.length) s.deliver();
        else if (r < 0.68 && s.captures.length) s.fail(random() < 0.5);
        else if (r < 0.85) {
          s.key(pick<ScrollDelta>([
            { kind: "lines", n: 3 },
            { kind: "lines", n: -3 },
            { kind: "halfpage", dir: 1 },
            { kind: "halfpage", dir: -1 },
            { kind: "top" },
            { kind: "bottom" },
          ]));
        } else if (r < 0.9) s.resize({ cols: 80, rows: 20 + Math.floor(random() * 40) });
        else if (r < 0.92) s.resize({ cols: pick([70, 80, 90]), rows: 51 });
        else s.send({ type: "tick", at: s.tick(500) });
      }
      s.save(doc);
      s.deliverAll();
      if (storage < 12_000_000) continue;
      expect(s.view.shown?.blockKeys ?? []).toEqual(doc.map((d) => d.key));
      expect(s.covered()).toBe(true);
      expect(s.view.status).toBe("idle");
    }
  });
});
