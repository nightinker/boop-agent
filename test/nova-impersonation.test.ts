import { describe, expect, it, vi } from "vitest";
import {
  checkTargets,
  describeActionResult,
  extractImpersonationLink,
  findUserIdsByEmail,
  looksSignedOut,
  parseAccount,
  parseNovaActions,
  removeLink,
  safeDisplayUrl,
  type McpCallResult,
} from "../server/impersonation/links.js";
import {
  allowedInReadOnlySession,
  runImpersonationCapture,
  type NovaCaller,
} from "../server/impersonation/runner.js";
import { createImpersonationTools } from "../server/impersonation/tools.js";

const BASE = "https://certificates.dev";
const LINK = "https://certificates.dev/impersonate/42?expires=1999999999&signature=abcdef0123456789abcdef0123456789abcdef01";
const TARGETS = [
  "https://certificates.dev/trainings/typescript-level-1",
  "https://certificates.dev/trainings/typescript-level-2",
  "https://certificates.dev/trainings/typescript-level-3",
];

const text = (t: string): McpCallResult => ({ content: [{ type: "text", text: t }] });

function fakeNova(responses: Record<string, McpCallResult>) {
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  const close = vi.fn(async () => undefined);
  const nova: NovaCaller = {
    server: "nova",
    call: async (tool, args) => {
      calls.push({ tool, args });
      const r = responses[tool];
      if (!r) throw new Error(`unexpected tool ${tool}`);
      return r;
    },
    close,
  };
  return { nova, calls, close };
}

const actionsList = text(
  JSON.stringify({
    actions: [
      { name: "Send Reset Email", uriKey: "send-reset-email", allowlisted: false },
      { name: "Impersonate User", uriKey: "impersonate-user", allowlisted: true },
    ],
  }),
);

function okBrowser() {
  const fn = vi.fn(async (_link: string, targets: string[]) => ({
    landedUrl: "https://certificates.dev/dashboard",
    blockedWrites: 1,
    pages: targets.map((t, i) => ({ target: t, finalUrl: t, path: `/tmp/boop-browser-screenshots/shot-${i}.png` })),
  }));
  return fn;
}

describe("impersonation link extraction", () => {
  it("reads Nova's openInNewTab / redirect / visit responses", () => {
    expect(extractImpersonationLink(text(JSON.stringify({ openInNewTab: LINK })), BASE)).toBe(new URL(LINK).toString());
    expect(extractImpersonationLink({ structuredContent: { result: { redirect: LINK } } }, BASE)).toBe(new URL(LINK).toString());
    expect(extractImpersonationLink(text(JSON.stringify({ visit: { path: "/nova-impersonate/42" } })), BASE)).toBe(
      "https://certificates.dev/nova-impersonate/42",
    );
  });

  it("falls back to a URL in plain text, preferring an impersonation one", () => {
    const r = text(`Docs: https://certificates.dev/help. Sign in as the user: ${LINK}.`);
    expect(extractImpersonationLink(r, BASE)).toBe(new URL(LINK).toString());
  });

  it("returns null when there's no usable link or the call errored", () => {
    expect(extractImpersonationLink(text(JSON.stringify({ message: "Impersonation started." })), BASE)).toBeNull();
    expect(extractImpersonationLink({ ...text(LINK), isError: true }, BASE)).toBeNull();
    expect(extractImpersonationLink(text(JSON.stringify({ url: "javascript:alert(1)" })), BASE)).toBeNull();
  });

  it("describes a result without any link or token in it", () => {
    const out = describeActionResult(text(JSON.stringify({ message: "done", openInNewTab: LINK })));
    expect(out).toContain("done");
    expect(out).not.toContain("signature");
    expect(out).not.toContain("certificates.dev/impersonate");
  });

  it("removes a link and its encodings from text", () => {
    const t = `a ${LINK} b ${encodeURIComponent(LINK)} c`;
    const out = removeLink(t, LINK);
    expect(out).not.toContain("signature=");
    expect(out).not.toContain(encodeURIComponent(LINK));
  });

  it("shows only origin and path of a URL", () => {
    expect(safeDisplayUrl(LINK)).toBe("https://certificates.dev/impersonate/42");
  });
});

describe("impersonation safety checks", () => {
  it("accepts only numeric ids and emails as accounts", () => {
    expect(parseAccount("42")).toEqual({ kind: "id", id: "42" });
    expect(parseAccount(" Test@Example.com ")).toEqual({ kind: "email", email: "test@example.com" });
    expect(parseAccount("any customer")).toBeNull();
  });

  it("finds a user id only on an exact email match", () => {
    const r = text(
      JSON.stringify({
        records: [
          { id: 7, email: "test@example.com" },
          { id: 8, email: "test@example.com.au" },
        ],
      }),
    );
    expect(findUserIdsByEmail(r, "TEST@example.com")).toEqual(["7"]);
  });

  it("parses Nova action lists", () => {
    expect(parseNovaActions(actionsList).map((a) => a.uriKey)).toEqual(["send-reset-email", "impersonate-user"]);
  });

  it("keeps targets on the same site as the session", () => {
    const check = checkTargets(
      ["/trainings/typescript-level-1", "https://www.certificates.dev/x", "https://evil.example/x", "ftp://certificates.dev/x"],
      BASE,
    );
    expect(check.allowed).toEqual(["https://certificates.dev/trainings/typescript-level-1", "https://www.certificates.dev/x"]);
    expect(check.rejected.map((r) => r.url)).toEqual(["https://evil.example/x", "ftp://certificates.dev/x"]);
  });

  it("detects sign-in pages and allows only read-only methods", () => {
    expect(looksSignedOut("https://certificates.dev/login?next=/x")).toBe(true);
    expect(looksSignedOut("https://certificates.dev/trainings/typescript")).toBe(false);
    expect(allowedInReadOnlySession("get")).toBe(true);
    expect(allowedInReadOnlySession("POST")).toBe(false);
    expect(allowedInReadOnlySession("DELETE")).toBe(false);
  });
});

describe("runImpersonationCapture", () => {
  it("runs the allowlisted action, opens the link and returns screenshots without leaking the link", async () => {
    const { nova, calls, close } = fakeNova({
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ openInNewTab: LINK })),
    });
    const browser = okBrowser();
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: TARGETS },
      { connectNova: async () => nova, browser },
    );
    expect(out.ok).toBe(true);
    expect(out.screenshots).toHaveLength(3);
    expect(calls.find((c) => c.tool === "nova_run_action")?.args).toEqual({
      resource: "users",
      action: "impersonate-user",
      ids: ["42"],
      fields: {},
    });
    expect(browser).toHaveBeenCalledWith(new URL(LINK).toString(), TARGETS, { fullPage: false });
    expect(out.text).not.toContain("signature");
    expect(out.text).not.toContain("/impersonate/42");
    expect(out.text).toContain("Blocked 1 non-GET");
    expect(close).toHaveBeenCalled();
  });

  it("resolves an email to a user id first", async () => {
    const { nova, calls } = fakeNova({
      nova_list_records: text(JSON.stringify({ records: [{ id: 99, email: "qa@example.com" }] })),
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ redirect: LINK })),
    });
    const out = await runImpersonationCapture(
      { account: "qa@example.com", namedByUser: true, targets: TARGETS.slice(0, 1) },
      { connectNova: async () => nova, browser: okBrowser() },
    );
    expect(out.ok).toBe(true);
    expect(calls.find((c) => c.tool === "nova_run_action")?.args.ids).toEqual(["99"]);
  });

  it("refuses an account the user did not name, before touching Nova", async () => {
    const connectNova = vi.fn();
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: false, targets: TARGETS },
      { connectNova, browser: okBrowser() },
    );
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/explicitly/);
    expect(connectNova).not.toHaveBeenCalled();
  });

  it("refuses when the action is not allowlisted", async () => {
    const { nova, calls } = fakeNova({
      nova_list_actions: text(JSON.stringify([{ name: "Impersonate", uriKey: "impersonate", allowlisted: false }])),
    });
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: TARGETS },
      { connectNova: async () => nova, browser: okBrowser() },
    );
    expect(out.ok).toBe(false);
    expect(out.text).toMatch(/not allowlisted/);
    expect(calls.some((c) => c.tool === "nova_run_action")).toBe(false);
  });

  it("reports what the action returned when there is no usable link, and opens no browser", async () => {
    const { nova } = fakeNova({
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ message: "Impersonation is disabled for this user." })),
    });
    const browser = okBrowser();
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: TARGETS },
      { connectNova: async () => nova, browser },
    );
    expect(out.ok).toBe(false);
    expect(out.text).toContain("returned no usable impersonation link");
    expect(out.text).toContain("Impersonation is disabled for this user.");
    expect(out.text).toContain("Fallback");
    expect(browser).not.toHaveBeenCalled();
  });

  it("keeps the link out of a browser failure message", async () => {
    const { nova } = fakeNova({
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ openInNewTab: LINK })),
    });
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: TARGETS },
      {
        connectNova: async () => nova,
        browser: async () => {
          throw new Error(`page.goto: net::ERR_FAILED at ${LINK}`);
        },
      },
    );
    expect(out.ok).toBe(false);
    expect(out.text).not.toContain("signature");
  });

  it("refuses targets on another site", async () => {
    const connectNova = vi.fn();
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: ["https://evil.example/steal"] },
      { connectNova, browser: okBrowser() },
    );
    expect(out.ok).toBe(false);
    expect(connectNova).not.toHaveBeenCalled();
  });

  it("warns when the session landed on a sign-in page", async () => {
    const { nova } = fakeNova({
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ openInNewTab: LINK })),
    });
    const out = await runImpersonationCapture(
      { account: "42", namedByUser: true, targets: TARGETS.slice(0, 1) },
      {
        connectNova: async () => nova,
        browser: async (_l, targets) => ({
          landedUrl: "https://certificates.dev/login",
          blockedWrites: 0,
          pages: targets.map((t) => ({ target: t, finalUrl: "https://certificates.dev/login", path: "/tmp/x.png" })),
        }),
      },
    );
    expect(out.text).toMatch(/sign-in page/);
  });
});

describe("impersonate_and_screenshot tool", () => {
  it("passes the arguments through and never returns the link", async () => {
    const { nova } = fakeNova({
      nova_list_actions: actionsList,
      nova_run_action: text(JSON.stringify({ openInNewTab: LINK })),
    });
    const deps = vi.fn(() => ({ connectNova: async () => nova, browser: okBrowser() }));
    const [tool] = createImpersonationTools(deps, "test_ns");
    expect(tool.name).toBe("impersonate_and_screenshot");
    const result = await tool.handle({ account: "42", named_by_user: true, targets: TARGETS, nova_server: "certs" });
    expect(deps).toHaveBeenCalledWith("certs");
    expect(JSON.stringify(result)).not.toContain("signature");
    expect(JSON.stringify(result)).toContain("shot-0.png");
  });
});
