/**
 * Device/viewport emulation presets for local browser screenshots.
 *
 * Emulation is applied by creating a fresh browser context with these options,
 * because Chromium only honors isMobile (layout viewport + <meta name=viewport>)
 * when it is set at context creation. Resizing an existing desktop window to a
 * phone width is NOT the same: pages lay out wider than the viewport and the
 * screenshot gets cut off on the right.
 */

export interface DeviceEmulation {
  width: number;
  height: number;
  deviceScaleFactor: number;
  isMobile: boolean;
  hasTouch: boolean;
  userAgent?: string;
}

export interface DeviceEmulationInput {
  device?: string;
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  isMobile?: boolean;
  hasTouch?: boolean;
  userAgent?: string;
}

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const PIXEL_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

export const DEVICE_PRESETS = {
  iphone: {
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
  },
  pixel: {
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
    userAgent: PIXEL_UA,
  },
  ipad: {
    width: 820,
    height: 1180,
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent: IPAD_UA,
  },
  laptop: { width: 1280, height: 800, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, isMobile: false, hasTouch: false },
} satisfies Record<string, DeviceEmulation>;

export type DevicePresetName = keyof typeof DEVICE_PRESETS;

const DEVICE_ALIASES: Record<string, DevicePresetName> = {
  mobile: "iphone",
  phone: "iphone",
  ios: "iphone",
  iphone14: "iphone",
  iphone15: "iphone",
  android: "pixel",
  pixel7: "pixel",
  tablet: "ipad",
  ipadair: "ipad",
  macbook: "laptop",
  notebook: "laptop",
  pc: "desktop",
  monitor: "desktop",
};

export const DEVICE_PRESET_NAMES = Object.keys(DEVICE_PRESETS) as DevicePresetName[];

export const DEVICE_PRESET_SUMMARY = DEVICE_PRESET_NAMES.map((name) => {
  const p: DeviceEmulation = DEVICE_PRESETS[name];
  return `${name} ${p.width}x${p.height}@${p.deviceScaleFactor}x${p.isMobile ? " mobile+touch" : ""}`;
}).join(", ");

const LIMITS = {
  width: [200, 3840],
  height: [200, 4320],
  deviceScaleFactor: [1, 4],
} as const;

/** Map a free-form device name ("iPhone 15", "mobile view", "Tablet") to a preset. */
export function resolveDevicePreset(name: string): DevicePresetName | null {
  const key = name
    .toLowerCase()
    .replace(/\b(view|mode|size|screen|layout)\b/g, "")
    .replace(/[^a-z0-9]/g, "");
  if (!key) return null;
  if (key in DEVICE_PRESETS) return key as DevicePresetName;
  if (key in DEVICE_ALIASES) return DEVICE_ALIASES[key];
  if (key.startsWith("iphone")) return "iphone";
  if (key.startsWith("ipad")) return "ipad";
  if (key.startsWith("pixel")) return "pixel";
  return null;
}

/** True when the caller asked for any device/viewport emulation at all. */
export function wantsEmulation(input: DeviceEmulationInput): boolean {
  return (
    input.device !== undefined ||
    input.width !== undefined ||
    input.height !== undefined ||
    input.deviceScaleFactor !== undefined ||
    input.isMobile !== undefined ||
    input.hasTouch !== undefined ||
    input.userAgent !== undefined
  );
}

function checkRange(field: keyof typeof LIMITS, value: number): number {
  const [min, max] = LIMITS[field];
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${field} must be between ${min} and ${max} (got ${value}).`);
  }
  return field === "deviceScaleFactor" ? value : Math.round(value);
}

/**
 * Resolve a preset plus explicit overrides into concrete emulation options.
 * A custom size with no preset defaults to desktop-like behavior unless the
 * width is phone-sized (< 600 CSS px), in which case it emulates a phone so the
 * page's mobile layout is used rather than a squeezed desktop layout.
 */
export function resolveDeviceEmulation(input: DeviceEmulationInput): DeviceEmulation {
  let base: DeviceEmulation;
  if (input.device !== undefined && input.device.trim()) {
    const preset = resolveDevicePreset(input.device);
    if (!preset) {
      throw new Error(
        `Unknown device "${input.device}". Use one of: ${DEVICE_PRESET_NAMES.join(", ")} (aliases: mobile, phone, tablet), or pass width/height.`,
      );
    }
    base = DEVICE_PRESETS[preset];
  } else if (input.width !== undefined && input.width < 600) {
    base = DEVICE_PRESETS.iphone;
  } else {
    base = DEVICE_PRESETS.desktop;
  }

  const width = checkRange("width", input.width ?? base.width);
  const height = checkRange("height", input.height ?? base.height);
  const deviceScaleFactor = checkRange(
    "deviceScaleFactor",
    input.deviceScaleFactor ?? base.deviceScaleFactor,
  );
  const isMobile = input.isMobile ?? base.isMobile;
  const hasTouch = input.hasTouch ?? (input.isMobile ?? base.hasTouch);
  const userAgent =
    input.userAgent?.trim() || (isMobile ? (base.userAgent ?? IPHONE_UA) : undefined);
  return {
    width,
    height,
    deviceScaleFactor,
    isMobile,
    hasTouch,
    ...(userAgent ? { userAgent } : {}),
  };
}

export function describeEmulation(e: DeviceEmulation): string {
  return `${e.width}x${e.height} CSS px @${e.deviceScaleFactor}x${e.isMobile ? ", mobile" : ""}${e.hasTouch ? ", touch" : ""}`;
}

/** Read width/height from a PNG's IHDR chunk. Returns null if not a PNG. */
export function readPngSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47
  ) {
    return null;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}
