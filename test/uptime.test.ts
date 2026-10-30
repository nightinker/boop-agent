import { describe, expect, it } from "vitest";
import { formatUptime } from "../server/uptime.js";

describe("formatUptime", () => {
  it("shows <1m for under a minute", () => {
    expect(formatUptime(0)).toBe("Up <1m");
    expect(formatUptime(59.9)).toBe("Up <1m");
  });

  it("shows only minutes when under an hour", () => {
    expect(formatUptime(60)).toBe("Up 1m");
    expect(formatUptime(45 * 60 + 30)).toBe("Up 45m");
  });

  it("shows hours and minutes, omitting seconds", () => {
    expect(formatUptime(3 * 3600 + 12 * 60 + 59)).toBe("Up 3h 12m");
    expect(formatUptime(3600)).toBe("Up 1h 0m");
  });

  it("shows days, hours and minutes", () => {
    expect(formatUptime(2 * 86400 + 4 * 3600 + 5 * 60)).toBe("Up 2d 4h 5m");
    expect(formatUptime(86400)).toBe("Up 1d 0h 0m");
  });

  it("treats negative or non-finite input as zero", () => {
    expect(formatUptime(-5)).toBe("Up <1m");
    expect(formatUptime(Number.NaN)).toBe("Up <1m");
  });
});
