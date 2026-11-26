import { describe, expect, test } from "bun:test";
import {
  TrackQueue,
  NOW_PLAYING_EMOJI,
  buildPlayerSections,
  buildQueueListEmbed,
  buildQueueListText,
  thumbnailFor,
} from "../src/music/queue.ts";

const t = (title: string, lengthMs = 185_000) => ({ title, lengthMs });

describe("TrackQueue", () => {
  test("push / remove by 1-based number / shift", () => {
    const q = new TrackQueue<string>(5);
    expect(q.push("a")).toBe(1);
    expect(q.push("b")).toBe(2);
    expect(q.push("c")).toBe(3);
    expect(q.remove(2)).toBe("b");
    expect(q.list()).toEqual(["a", "c"]);
    expect(q.remove(0)).toBeNull();
    expect(q.remove(3)).toBeNull();
    expect(q.remove(1.5)).toBeNull();
    expect(q.shift()).toBe("a");
    expect(q.list()).toEqual(["c"]);
  });

  test("full queue rejects, clear empties", () => {
    const q = new TrackQueue<number>(2);
    q.push(1);
    q.push(2);
    expect(q.push(3)).toBeNull();
    q.clear();
    expect(q.length).toBe(0);
  });

  test("list() is a copy", () => {
    const q = new TrackQueue<number>();
    q.push(1);
    q.list().push(99);
    expect(q.length).toBe(1);
  });
});

describe("buildQueueListEmbed (📋 popup)", () => {
  test("now playing + numbered queue", () => {
    const e = buildQueueListEmbed(t("Now"), [t("One", 60_000), t("Two")]);
    expect(e.title).toContain("คิวเพลง");
    expect(e.description).toContain("กำลังเล่น");
    expect(e.description).toContain("Now `3:05`");
    expect(e.description).toContain("`1.` One `1:00`");
    expect(e.description).toContain("`2.` Two `3:05`");
    expect(e.description).toContain("คิว** (2)");
  });

  test("empty queue / nothing playing", () => {
    const e = buildQueueListEmbed(null, []);
    expect(e.description).toContain("ไม่ได้เล่นเพลง");
    expect(e.description).toContain("ว่าง");
  });

  test("markdown in titles is escaped", () => {
    const e = buildQueueListEmbed(t("a_b*c [x]"), []);
    expect(e.description).toContain("a\\_b\\*c \\[x\\]");
  });

  test("long queues show 25 lines and stay under the 4096 limit", () => {
    const many = Array.from({ length: 50 }, (_, i) => t(`${"x".repeat(200)} ${i}`));
    const e = buildQueueListEmbed(t("y".repeat(300)), many);
    expect(e.description.length).toBeLessThan(4096);
    expect(e.description).toContain("และอีก 25 เพลง");
  });
});

describe("buildQueueListText (Components V2 popup)", () => {
  test("is the embed's title + description as markdown", () => {
    const text = buildQueueListText(t("Now"), [t("One", 60_000)]);
    expect(text).toStartWith("### ");
    expect(text).toContain("คิวเพลง");
    expect(text).toContain("Now `3:05`");
    expect(text).toContain("`1.` One `1:00`");
  });
});

describe("thumbnailFor", () => {
  test("YouTube tracks only", () => {
    const yt = { ...t("Now"), uri: "https://www.youtube.com/watch?v=abc123", identifier: "abc123" };
    expect(thumbnailFor(yt)).toBe("https://i.ytimg.com/vi/abc123/hqdefault.jpg");

    const other = { ...t("Now"), uri: "https://soundcloud.com/x/y", identifier: "abc123" };
    expect(thumbnailFor(other)).toBeUndefined();
    expect(thumbnailFor(t("Now"))).toBeUndefined();
  });
});

describe("buildPlayerSections (panel text)", () => {
  const text = (...args: Parameters<typeof buildPlayerSections>) => buildPlayerSections(...args).join("\n");

  test("now playing: title as heading, artist under it", () => {
    const c = text({ ...t("Now"), author: "Some Artist" }, []);
    expect(c).toContain(`## ${NOW_PLAYING_EMOJI} Now`);
    expect(c).toContain("Some Artist");
  });

  test("the queue is not listed in the text (the dropdown shows it)", () => {
    const c = text(t("Now"), [t("One", 60_000), t("Two")]);
    expect(c).not.toContain("One");
    expect(c).not.toContain("Two");
  });

  test("requester and voice channel line", () => {
    const c = text({ ...t("Now"), requestedBy: "123456", voiceChannelName: "Lounge" }, []);
    expect(c).toContain("ขอเพลง โดย <@123456>");
    expect(c).toContain("Lounge");
  });

  test("paused status", () => {
    expect(text({ ...t("Now"), requestedBy: "1" }, [], { paused: true })).toContain("หยุดชั่วคราว");
    expect(text({ ...t("Now"), requestedBy: "1" }, [])).not.toContain("หยุดชั่วคราว");
  });

  test("nothing playing → idle panel", () => {
    const c = text(null, []);
    expect(c).toContain("กำลังรอเพลง");
    expect(c).toContain("/earth setup");
  });

  test("idle panel inside the music room tells people to type a song", () => {
    const c = text(null, [], { setupChannel: true });
    expect(c).toContain("พิมพ์ชื่อเพลง");
    expect(c).not.toContain("เสียงก็ได้");
  });

  test("markdown in titles is escaped", () => {
    const c = text(t("a_b*c [x]"), []);
    expect(c).toContain("a\\_b\\*c \\[x\\]");
  });

  test("loop label only when looping", () => {
    expect(text({ ...t("Now"), requestedBy: "1" }, [])).not.toContain("🔁");
    expect(text(t("Now"), [], { loop: "track" })).toContain("🔁 เพลงนี้");
    expect(text(t("Now"), [], { loop: "queue" })).toContain("🔁 ทั้งคิว");
  });
});
