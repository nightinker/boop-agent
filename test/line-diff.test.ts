import { describe, expect, it } from "vitest";
import { lineDiff, trimDiff } from "../debug/src/lib/lineDiff.js";

describe("skill history diff", () => {
  it("marks added and removed lines", () => {
    expect(lineDiff("a\nb\nc", "a\nB\nc")).toEqual([
      { kind: "same", text: "a" },
      { kind: "remove", text: "b" },
      { kind: "add", text: "B" },
      { kind: "same", text: "c" },
    ]);
  });

  it("treats a brand-new skill as all additions", () => {
    expect(lineDiff("", "x\ny").filter((l) => l.kind === "add").map((l) => l.text)).toEqual(["x", "y"]);
  });

  it("collapses long unchanged stretches", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "LINE 10");
    const trimmed = trimDiff(lineDiff(before, after), 1);
    expect(trimmed[0]).toEqual({ kind: "gap", text: "9 unchanged lines" });
    expect(trimmed.filter((l) => l.kind !== "gap")).toHaveLength(4);
  });
});
