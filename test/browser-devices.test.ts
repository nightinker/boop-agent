import { describe, expect, it } from "vitest";
import {
  DEVICE_PRESETS,
  readPngSize,
  resolveDeviceEmulation,
  resolveDevicePreset,
  wantsEmulation,
} from "../server/browser/devices.js";
import { formatScreenshotResult } from "../server/browser/launcher.js";

describe("browser device presets", () => {
  it("maps natural device names to presets", () => {
    expect(resolveDevicePreset("mobile view")).toBe("iphone");
    expect(resolveDevicePreset("iPhone 15")).toBe("iphone");
    expect(resolveDevicePreset("iPhone-14 Pro")).toBe("iphone");
    expect(resolveDevicePreset("Tablet")).toBe("ipad");
    expect(resolveDevicePreset("Pixel 7")).toBe("pixel");
    expect(resolveDevicePreset("desktop")).toBe("desktop");
    expect(resolveDevicePreset("laptop")).toBe("laptop");
    expect(resolveDevicePreset("toaster")).toBeNull();
  });

  it("emulates a real phone for mobile presets so viewport meta is honored", () => {
    expect(resolveDeviceEmulation({ device: "mobile" })).toMatchObject({
      width: 390,
      height: 844,
      deviceScaleFactor: 3,
      isMobile: true,
      hasTouch: true,
      userAgent: expect.stringContaining("iPhone"),
    });
    expect(resolveDeviceEmulation({ device: "tablet" })).toMatchObject({
      width: 820,
      height: 1180,
      isMobile: true,
    });
  });

  it("keeps desktop presets non-mobile with no UA override", () => {
    const desktop = resolveDeviceEmulation({ device: "desktop" });
    expect(desktop).toEqual({ ...DEVICE_PRESETS.desktop });
    expect(desktop.userAgent).toBeUndefined();
  });

  it("treats a phone-sized custom width as mobile and lets overrides win", () => {
    expect(resolveDeviceEmulation({ width: 390 })).toMatchObject({
      width: 390,
      isMobile: true,
      deviceScaleFactor: 3,
    });
    expect(resolveDeviceEmulation({ width: 1024, height: 768 })).toMatchObject({
      width: 1024,
      height: 768,
      isMobile: false,
    });
    expect(
      resolveDeviceEmulation({ device: "iphone", deviceScaleFactor: 2, isMobile: false }),
    ).toMatchObject({ deviceScaleFactor: 2, isMobile: false, hasTouch: false });
  });

  it("rejects unknown devices and out-of-range sizes", () => {
    expect(() => resolveDeviceEmulation({ device: "toaster" })).toThrow(/Unknown device/);
    expect(() => resolveDeviceEmulation({ width: 10 })).toThrow(/width/);
    expect(() => resolveDeviceEmulation({ device: "iphone", deviceScaleFactor: 9 })).toThrow(
      /deviceScaleFactor/,
    );
  });

  it("only emulates when an emulation option is passed", () => {
    expect(wantsEmulation({})).toBe(false);
    expect(wantsEmulation({ device: "iphone" })).toBe(true);
    expect(wantsEmulation({ width: 800 })).toBe(true);
  });

  it("reads PNG dimensions from the IHDR chunk", () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const view = new DataView(png.buffer);
    view.setUint32(16, 1170);
    view.setUint32(20, 2532);
    expect(readPngSize(png)).toEqual({ width: 1170, height: 2532 });
    expect(readPngSize(new Uint8Array([0xff, 0xd8, 0xff]))).toBeNull();
  });
});

describe("browser screenshot width check", () => {
  const emulation = resolveDeviceEmulation({ device: "iphone" });
  const base = {
    path: "/tmp/shot.png",
    url: "https://example.com/",
    bytes: 2048,
    imageHeight: 2532,
    emulation,
    expectedImageWidth: 1170,
    downscaled: false,
  };

  it("reports OK when the image matches the requested width", () => {
    const text = formatScreenshotResult({
      ...base,
      imageWidth: 1170,
      innerWidth: 390,
      scrollWidth: 390,
    });
    expect(text).toContain("Screenshot saved: /tmp/shot.png");
    expect(text).toContain("Width check: OK");
    expect(text).toContain("isMobile=true");
  });

  it("flags pages that render wider than the device", () => {
    const text = formatScreenshotResult({
      ...base,
      imageWidth: 1170,
      innerWidth: 390,
      scrollWidth: 520,
    });
    expect(text).toContain("Width check: MISMATCH");
  });

  it("flags image width mismatches", () => {
    const text = formatScreenshotResult({
      ...base,
      imageWidth: 1440,
      innerWidth: 390,
      scrollWidth: 390,
    });
    expect(text).toContain("Width check: MISMATCH");
  });
});
