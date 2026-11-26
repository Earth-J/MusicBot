import { describe, expect, test } from "bun:test";
import {
  HISTORY_PAGE_SIZE,
  buildHistoryPanel,
  historyPageCount,
  parseHistoryId,
} from "../src/music/controls.ts";
import type { HistoryEntry, HistorySort } from "../src/music/history.ts";

const entry = (i: number): HistoryEntry => ({
  videoId: String(i).padStart(11, "A"),
  title: `song ${i}`,
  author: "artist",
  lengthMs: 180_000,
  plays: 1,
  lastPlayedAt: 1_700_000_000_000,
});

/** Every component with a custom_id in a built panel (buttons + dropdown), with its disabled flag. */
function components(node: unknown, out: { id: string; disabled: boolean }[] = []) {
  if (Array.isArray(node)) node.forEach((n) => components(n, out));
  else if (node && typeof node === "object") {
    const o = node as Record<string, unknown>;
    if (typeof o.custom_id === "string") out.push({ id: o.custom_id, disabled: o.disabled === true });
    for (const v of Object.values(o)) if (v && typeof v === "object") components(v, out);
  }
  return out;
}

describe("history panel", () => {
  test("no two components share a custom_id, on every page of every size (Discord rejects duplicates)", () => {
    for (const total of [1, 2, 26, 30, 50, 51, 75, 100, 264]) {
      const pages = historyPageCount(total);
      for (const sort of ["recent", "plays"] as HistorySort[]) {
        for (let page = 0; page < pages; page++) {
          const n = Math.min(HISTORY_PAGE_SIZE, total - page * HISTORY_PAGE_SIZE);
          const entries = Array.from({ length: n }, (_, i) => entry(page * HISTORY_PAGE_SIZE + i));
          const ids = components(buildHistoryPanel({ entries, sort, page, pages, total }).toJSON()).map((c) => c.id);
          expect(new Set(ids).size, `total=${total} sort=${sort} page=${page}: ${ids.join(" ")}`).toBe(ids.length);
        }
      }
    }
  });

  test("every clickable button parses, and lands on a page that exists", () => {
    const total = 120;
    const pages = historyPageCount(total);
    for (let page = 0; page < pages; page++) {
      const entries = Array.from({ length: Math.min(HISTORY_PAGE_SIZE, total - page * HISTORY_PAGE_SIZE) }, (_, i) =>
        entry(i),
      );
      for (const c of components(buildHistoryPanel({ entries, sort: "recent", page, pages, total }).toJSON())) {
        if (c.disabled) continue;
        const act = parseHistoryId(c.id);
        expect(act, c.id).not.toBeNull();
        if (act!.kind === "page") expect(act!.page).toBeLessThan(pages);
      }
    }
  });

  test("ids from the previous version still parse", () => {
    expect(parseHistoryId("mh:page:p:3")).toEqual({ kind: "page", sort: "plays", page: 3, videoId: null });
    expect(parseHistoryId("mh:pick:r:0")?.kind).toBe("pick");
    expect(parseHistoryId("mh:play:r:2:AAAAAAAAAAA")?.videoId).toBe("AAAAAAAAAAA");
    expect(parseHistoryId("mh:sort:p:0")).toEqual({ kind: "page", sort: "plays", page: 0, videoId: null });
    expect(parseHistoryId("mh:noop")).toBeNull();
  });
});
