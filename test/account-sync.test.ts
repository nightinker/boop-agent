import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  accountSyncMode,
  followSharedAccount,
  publishCurrentAccount,
  resetAccountSyncState,
  type AccountSyncDeps,
} from "../server/account-sync.js";

const quiet = { log: () => undefined, warn: () => undefined };

function deps(over: Partial<AccountSyncDeps> = {}) {
  const switched: string[] = [];
  const d: AccountSyncDeps = {
    readShared: async () => "carol@example.com",
    currentEmail: async () => "bob@example.com",
    cswapAccounts: async () => [
      { number: 1, email: "bob@example.com", active: true, needsRelogin: false },
      { number: 2, email: "Carol@Example.com", active: false, needsRelogin: false },
    ],
    switchCswap: async (n) => void switched.push(`cswap:${n}`),
    profiles: async () => [{ label: "work", email: "carol@example.com" }],
    useProfile: async (label) => void switched.push(`profile:${label}`),
    log: quiet,
    ...over,
  };
  return { d, switched };
}

beforeEach(() => resetAccountSyncState());

describe("which copy leads", () => {
  it("the Mac publishes, a server follows, and the env can override", () => {
    expect(accountSyncMode({}, "darwin")).toBe("publish");
    expect(accountSyncMode({}, "linux")).toBe("follow");
    expect(accountSyncMode({ BOOP_ACCOUNT_SYNC: "off" }, "linux")).toBe("off");
  });
});

describe("following the Mac's account", () => {
  it("switches with cswap to the account with that email", async () => {
    const { d, switched } = deps();
    expect(await followSharedAccount(d)).toEqual({ status: "switched", email: "carol@example.com", via: "cswap" });
    expect(switched).toEqual(["cswap:2"]);
  });

  it("uses a config-dir login when cswap doesn't have it or it needs a fresh login", async () => {
    const { d, switched } = deps({
      cswapAccounts: async () => [{ number: 2, email: "carol@example.com", active: false, needsRelogin: true }],
    });
    expect(await followSharedAccount(d)).toMatchObject({ status: "switched", via: "profile" });
    expect(switched).toEqual(["profile:work"]);
  });

  it("does nothing when already on it, or when nothing is shared", async () => {
    expect(await followSharedAccount(deps({ currentEmail: async () => "CAROL@example.com" }).d)).toEqual({ status: "same" });
    expect(await followSharedAccount(deps({ readShared: async () => null }).d)).toEqual({ status: "none" });
  });

  it("keeps the current account, warning once, when this machine can't use that one", async () => {
    const warn = vi.fn();
    const { d, switched } = deps({ cswapAccounts: async () => [], profiles: async () => [], log: { log: () => undefined, warn } });
    expect(await followSharedAccount(d)).toEqual({ status: "unavailable", email: "carol@example.com" });
    await followSharedAccount(d);
    expect(switched).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps going if cswap isn't installed", async () => {
    const { d } = deps({ cswapAccounts: async () => Promise.reject(new Error("cswap not found")) });
    expect(await followSharedAccount(d)).toMatchObject({ status: "switched", via: "profile" });
  });
});

describe("publishing from the Mac", () => {
  it("shares a switch made outside Boop, and stays quiet when nothing changed", async () => {
    const record = vi.fn(async () => undefined);
    expect(await publishCurrentAccount({ readShared: async () => "bob@example.com", currentEmail: async () => "carol@example.com", record })).toBe(true);
    expect(record).toHaveBeenCalledWith("carol@example.com");
    expect(await publishCurrentAccount({ readShared: async () => "carol@example.com", currentEmail: async () => "carol@example.com", record })).toBe(false);
    expect(record).toHaveBeenCalledTimes(1);
  });
});
