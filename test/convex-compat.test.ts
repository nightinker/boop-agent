import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOWNGRADE_TTL_MS,
  UnknownArgError,
  isUnknownArgError,
  resetCompatState,
  withOptionalArgs,
} from "../server/convex-compat.js";

const extraRunner = () =>
  new Error("ArgumentValidationError: Object contains extra field `runner` that is not in the validator.");

beforeEach(() => resetCompatState());

describe("withOptionalArgs", () => {
  it("tries the full call again once the remembered rejection expires", async () => {
    let t = 0;
    const now = () => t;
    const call = vi.fn(async (args: { id: string; runner?: string }) => {
      if (args.runner && call.mock.calls.length <= 1) throw extraRunner();
      return args;
    });
    const send = () => withOptionalArgs("f", call, { id: "a", runner: "server" }, ["runner"], { now });

    expect(await send()).toEqual({ id: "a" }); // rejected, then sent without runner
    expect(await send()).toEqual({ id: "a" }); // remembered: one call, no runner
    expect(call).toHaveBeenCalledTimes(3);

    t += DOWNGRADE_TTL_MS + 1; // the Mac has pushed newer functions meanwhile
    expect(await send()).toEqual({ id: "a", runner: "server" });
    expect(call).toHaveBeenCalledTimes(4);
  });

  it("keeps refusing in strict mode only while the rejection is remembered", async () => {
    let t = 0;
    let old = true;
    const call = vi.fn(async (args: { runner?: string }) => {
      if (old && args.runner) throw extraRunner();
      return "ok";
    });
    const send = () => withOptionalArgs("g", call, { runner: "server" }, ["runner"], { fallback: false, now: () => t });
    await expect(send()).rejects.toBeInstanceOf(UnknownArgError);
    await expect(send()).rejects.toBeInstanceOf(UnknownArgError);
    old = false;
    t += DOWNGRADE_TTL_MS + 1;
    expect(await send()).toBe("ok");
  });

  it("surfaces other validation errors as they are, without downgrading", async () => {
    const wrongType = new Error("ArgumentValidationError: Value does not match validator. Path: .request");
    const missing = new Error("ArgumentValidationError: Object is missing the required field `request`.");
    const other = new Error("ArgumentValidationError: Object contains extra field `colour` that is not in the validator.");
    for (const err of [wrongType, missing, other]) {
      const call = vi.fn(async () => {
        throw err;
      });
      await expect(withOptionalArgs("h", call, { runner: "server" }, ["runner"])).rejects.toBe(err);
      expect(call).toHaveBeenCalledTimes(1);
    }
    expect(isUnknownArgError(wrongType)).toBe(false);
    expect(isUnknownArgError(missing)).toBe(false);
    expect(isUnknownArgError(extraRunner())).toBe(true);
    expect(isUnknownArgError(new UnknownArgError("h", ["runner"]))).toBe(true);
  });
});
