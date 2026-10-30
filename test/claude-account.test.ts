import { describe, expect, it } from "vitest";
import { parseClaudeAuthStatus, parseCswapList } from "../server/claude-account.js";

describe("Claude account status", () => {
  it("reads the signed-in account", () => {
    const account = parseClaudeAuthStatus(
      JSON.stringify({
        loggedIn: true,
        authMethod: "claude.ai",
        email: "me@example.test",
        orgName: "Example",
        subscriptionType: "team",
      }),
    );
    expect(account).toEqual({
      loggedIn: true,
      email: "me@example.test",
      orgName: "Example",
      subscriptionType: "team",
      authMethod: "claude.ai",
    });
  });

  it("reports a signed-out CLI without an email", () => {
    expect(parseClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toMatchObject({
      loggedIn: false,
      email: null,
    });
  });
});

describe("cswap account list", () => {
  it("parses accounts after an upgrade notice", () => {
    const stdout = [
      "A newer version of claude-swap is available.",
      JSON.stringify({
        schemaVersion: 1,
        activeAccountNumber: 2,
        accounts: [
          { number: 1, email: "a@example.test", organizationName: "A", active: false, usageStatus: "ok" },
          { number: 2, email: "b@example.test", organizationName: null, active: true, usageStatus: "relogin_required" },
        ],
      }),
    ].join("\n");

    expect(parseCswapList(stdout)).toEqual({
      available: true,
      activeAccountNumber: 2,
      accounts: [
        { number: 1, email: "a@example.test", organizationName: "A", active: false, needsRelogin: false },
        { number: 2, email: "b@example.test", organizationName: null, active: true, needsRelogin: true },
      ],
    });
  });

  it("drops entries without an email or number", () => {
    const state = parseCswapList(
      JSON.stringify({ accounts: [{ number: "x", email: "a@example.test" }, { number: 3 }] }),
    );
    expect(state.accounts).toEqual([]);
    expect(state.activeAccountNumber).toBeNull();
  });

  it("rejects output with no JSON", () => {
    expect(() => parseCswapList("nothing here")).toThrow("no JSON");
  });
});
