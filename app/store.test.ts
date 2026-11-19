import { describe, expect, test } from "bun:test";
import type { Item } from "../protocol.ts";
import { age, duration, groupSessions } from "./format.ts";
import { mergeItems, partsOf } from "./store.ts";

const text = (id: string, value: string): Item => ({ k: "text", id, turn: "t", at: 0, text: value });

describe("mergeItems", () => {
  test("changed items replace by id and unchanged ones keep their objects", () => {
    const a = text("a", "one");
    const b = text("b", "two");
    const merged = mergeItems([a, b], [text("b", "two more"), text("c", "three")], ["a", "b", "c"]);
    expect(merged.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(merged[0]).toBe(a);
    expect((merged[1] as { text: string }).text).toBe("two more");
    expect(mergeItems([a, b], [text("b", "two")], ["a", "b"])[1]).toBe(b);
  });
  test("order drops what is gone", () => {
    expect(mergeItems([text("a", "1"), text("b", "2")], [], ["b"]).map((item) => item.id)).toEqual(["b"]);
  });
  test("a page replaces the list", () => {
    expect(mergeItems([text("z", "old")], [text("a", "1")], undefined).map((item) => item.id)).toEqual(["a"]);
  });
});

test("partsOf cuts by UTF-8 bytes and never inside a pair", () => {
  const parts = partsOf("修复测试".repeat(100), 600);
  expect(parts.join("")).toBe("修复测试".repeat(100));
  for (const part of parts) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(600);
  expect(partsOf("😀😀😀", 5)).toEqual(["😀", "😀", "😀"]);
  expect(partsOf("")).toEqual([""]);
});

test("ages and durations", () => {
  const now = 1_000_000_000;
  expect([10, 300, 7200, 172800, 86400 * 21].map((s) => age(now - s * 1000, now))).toEqual(["now", "5m", "2h", "2d", "3w"]);
  expect([42_000, 185_000, 4_320_000].map(duration)).toEqual(["42s", "3m 05s", "1h 12m"]);
});

test("groupSessions orders by what needs a person", () => {
  const row = (id: string, state: string, unread = false, at = 0) => ({ id, title: id, state, unread, createdAt: at, updatedAt: at }) as never;
  const groups = groupSessions([row("idle", "idle", false, 1), row("run", "running", false, 2), row("ask", "waiting", false, 3), row("new", "idle", true, 4), row("bad", "failed", false, 5)], "");
  expect(groups.map((g) => [g.id, g.rows.map((r) => r.id)])).toEqual([["waiting", ["bad", "ask"]], ["running", ["run"]], ["unread", ["new"]], ["recent", ["idle"]]]);
  expect(groupSessions([row("alpha", "idle"), row("beta", "idle")], "bet")[0]!.rows.map((r) => r.id)).toEqual(["beta"]);
});
