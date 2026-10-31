import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cswapCandidates, findCswap, type CswapAccount, type LoginCheck } from "../server/claude-account.js";
import {
  ambiguousAccountMessage,
  unknownAccountMessage,
  cswapReloginInstructions,
  formatCswapSection,
  resolveCswapInput,
  switchToCswapAccount,
  type CswapSwitchDeps,
} from "../server/claude-cswap-accounts.js";
import { formatProfileList } from "../server/claude-profiles.js";

function acct(number: number, email: string, extra: Partial<CswapAccount> = {}): CswapAccount {
  return {
    number,
    email,
    organizationName: null,
    active: false,
    needsRelogin: false,
    status: "ok",
    usage: null,
    ...extra,
  };
}

const accounts: CswapAccount[] = [
  acct(1, "me@example.test", { organizationName: "Personal", active: true }),
  acct(2, "me@acme.example", { organizationName: "Acme Corp" }),
  acct(8, "me@globex.example", {
    organizationName: "Globex",
    needsRelogin: true,
    status: "relogin_required",
  }),
];

describe("finding cswap", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "boop-cswap-"));
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it("checks BOOP_CSWAP_PATH, then PATH, then the usual install spots", () => {
    const list = cswapCandidates({ BOOP_CSWAP_PATH: "/x/cswap", PATH: "/a:/b" }, "/h");
    expect(list.slice(0, 3)).toEqual(["/x/cswap", "/a/cswap", "/b/cswap"]);
    expect(list).toContain("/h/.local/bin/cswap");
    expect(list).toContain("/opt/homebrew/bin/cswap");
  });

  it("finds it in ~/.local/bin when PATH doesn't include it", async () => {
    const bin = join(home, ".local", "bin");
    await mkdir(bin, { recursive: true });
    await writeFile(join(bin, "cswap"), "#!/bin/sh\n");
    await chmod(join(bin, "cswap"), 0o755);
    expect(await findCswap({ PATH: join(home, "empty") }, home)).toBe(join(bin, "cswap"));
  });

  it("reports null when it isn't installed", async () => {
    const found = await findCswap({ PATH: join(home, "empty") }, home);
    // Only a system-wide install could be found here; never a guessed path.
    if (found) expect(["/opt/homebrew/bin/cswap", "/usr/local/bin/cswap"]).toContain(found);
  });
});

describe("matching a cswap account", () => {
  it("matches by number, email, org name and partial name", () => {
    const pick = (input: string) => {
      const m = resolveCswapInput(input, accounts);
      return m.kind === "match" ? m.account.number : m.kind;
    };
    expect(pick("8")).toBe(8);
    expect(pick("cswap 8")).toBe(8);
    expect(pick("#2")).toBe(2);
    expect(pick("globex")).toBe(8);
    expect(pick("GloBex")).toBe(8);
    expect(pick("me@acme.example")).toBe(2);
    expect(pick("acme")).toBe(2);
  });

  it("understands plain-English requests without numbers", () => {
    const pick = (input: string) => {
      const m = resolveCswapInput(input, accounts);
      return m.kind === "match" ? m.account.number : m.kind;
    };
    expect(pick("switch to Globex")).toBe(8);
    expect(pick("Please use my Acme Corp account")).toBe(2);
    expect(pick("can you switch over to the globex login")).toBe(8);
    expect(pick("switch to my account")).toBe("none");
  });

  it("never puts slot numbers in chat-facing text", () => {
    const ask = ambiguousAccountMessage("me", accounts);
    const unknown = unknownAccountMessage("nobody", accounts);
    expect(ask).not.toMatch(/cswap|\b[128]\b/);
    expect(unknown).not.toMatch(/cswap|\b[128]\b/);
    expect(ask).toContain("me@acme.example (Acme Corp)");
  });

  it("asks when a name fits several accounts, and rejects unknown ones", () => {
    expect(resolveCswapInput("me", accounts).kind).toBe("ambiguous"); // same email name on all three
    expect(resolveCswapInput("ak", accounts).kind).toBe("none"); // too short for a partial match
    const shared = resolveCswapInput("example", accounts);
    expect(shared.kind).toBe("ambiguous");
    expect(resolveCswapInput("9", accounts).kind).toBe("none");
    expect(resolveCswapInput("nobody", accounts).kind).toBe("none");
  });
});

describe("listing cswap accounts", () => {
  it("marks the active login and flags dead ones", () => {
    const text = formatCswapSection(
      { ok: true, state: { available: true, activeAccountNumber: 1, accounts } },
      true,
    );
    expect(text).toContain("• (active) me@example.test (Personal)");
    expect(text).toContain("me@globex.example (Globex) — needs a fresh login");
  });

  it("says the active cswap login isn't Boop's when a config dir is chosen", () => {
    const text = formatCswapSection(
      { ok: true, state: { available: true, activeAccountNumber: 1, accounts } },
      false,
    );
    expect(text).toContain("• (main login) me@example.test");
  });

  it("says plainly when cswap isn't installed or fails", () => {
    expect(
      formatCswapSection({ ok: true, state: { available: false, activeAccountNumber: null, accounts: [] } }, true),
    ).toContain("cswap isn't installed");
    expect(formatCswapSection({ ok: false, error: "cswap list failed: boom" }, true)).toContain("boom");
  });

  it("drops the 'only account' hint when cswap has others", () => {
    const profile = { label: "default", configDir: "/h/.claude", isDefault: true, email: "me@example.test", orgName: null };
    expect(formatProfileList([profile], null, { otherAccounts: true })).not.toContain("only Claude account");
    expect(formatProfileList([], null, { otherAccounts: true })).toBe("None signed in.");
  });

  it("gives Terminal steps for a fresh login, never asking for secrets in chat", () => {
    const steps = cswapReloginInstructions(accounts[2]);
    expect(steps).toContain("`claude`");
    expect(steps).toContain("/login");
    expect(steps).toContain("cswap add");
    expect(steps).toContain("Never send a password");
  });
});

function deps(overrides: Partial<CswapSwitchDeps> = {}) {
  const check: LoginCheck = { accountNumber: 0, result: "works", detail: null, checkedAt: "now" };
  return {
    checkLogin: vi.fn(async () => check),
    switchAccount: vi.fn(async () => undefined),
    useMainLogin: vi.fn(async () => undefined),
    readMainLogin: vi.fn(async () => ({ loggedIn: true, email: "me@acme.example" })),
    ...overrides,
  };
}

describe("switching to a cswap account", () => {
  it("runs cswap switch and puts Boop on the main login", async () => {
    const d = deps();
    const result = await switchToCswapAccount(accounts[1], true, d);
    expect(result.ok).toBe(true);
    expect(d.switchAccount).toHaveBeenCalledWith(2);
    expect(d.useMainLogin).toHaveBeenCalled();
    expect(d.checkLogin).not.toHaveBeenCalled();
    expect(result.text).toContain("from the next turn");
    expect(result.text).not.toContain("Heads up");
  });

  it("does nothing when Boop is already on that account", async () => {
    const d = deps();
    const result = await switchToCswapAccount(accounts[0], true, d);
    expect(result.text).toContain("already using");
    expect(d.switchAccount).not.toHaveBeenCalled();
  });

  it("only drops the config-dir choice when the cswap account is already the main login", async () => {
    const d = deps({ readMainLogin: vi.fn(async () => ({ loggedIn: true, email: "me@example.test" })) });
    const result = await switchToCswapAccount(accounts[0], false, d);
    expect(result.ok).toBe(true);
    expect(d.switchAccount).not.toHaveBeenCalled();
    expect(d.useMainLogin).toHaveBeenCalled();
  });

  it("refuses a dead login and gives the Terminal steps instead", async () => {
    const d = deps({
      checkLogin: vi.fn(async () => ({
        accountNumber: 8,
        result: "expired" as const,
        detail: "OAuth session expired",
        checkedAt: "now",
      })),
    });
    const result = await switchToCswapAccount(accounts[2], true, d);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("expired");
    expect(result.text).toContain("cswap add");
    expect(d.switchAccount).not.toHaveBeenCalled();
    expect(d.useMainLogin).not.toHaveBeenCalled();
  });

  it("switches anyway when cswap's dead-login flag turns out stale", async () => {
    const d = deps({ readMainLogin: vi.fn(async () => ({ loggedIn: true, email: "me@globex.example" })) });
    const result = await switchToCswapAccount(accounts[2], true, d);
    expect(result.ok).toBe(true);
    expect(d.checkLogin).toHaveBeenCalledWith(8);
    expect(d.switchAccount).toHaveBeenCalledWith(8);
    expect(result.text).toContain("test request worked");
  });

  it("keeps the current account when cswap fails", async () => {
    const d = deps({ switchAccount: vi.fn(async () => Promise.reject(new Error("locked\nmore"))) });
    const result = await switchToCswapAccount(accounts[1], true, d);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("locked");
    expect(result.text).toContain("Nothing was changed");
    expect(d.useMainLogin).not.toHaveBeenCalled();
  });

  it("warns when Claude Code doesn't see the new login", async () => {
    const d = deps({ readMainLogin: vi.fn(async () => ({ loggedIn: false, email: null })) });
    const result = await switchToCswapAccount(accounts[1], true, d);
    expect(result.ok).toBe(true);
    expect(result.text).toContain("Heads up");
    expect(result.text).toContain("/login");
  });
});
