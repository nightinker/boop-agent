import { describe, expect, it } from "vitest";
import {
  createComposioAccountTools,
  displayToolkitName,
  parseConnectionSlugs,
  truncateOutput,
} from "../server/integrations/composio-account-loader.js";

describe("personal Composio account integration", () => {
  it("keeps only toolkits with an active connection", () => {
    const stdout = JSON.stringify({
      custom_vueschool_staging: [{ status: "ACTIVE" }],
      github: [{ status: "EXPIRED" }, { status: "ACTIVE" }],
      custom_vueschool_metabase: [{ status: "INITIATED" }],
      gmail: [],
    });
    expect(parseConnectionSlugs(stdout)).toEqual(["custom_vueschool_staging", "github"]);
  });

  it("turns slugs into readable names", () => {
    expect(displayToolkitName("custom_certificates_dev_production")).toBe(
      "Certificates Dev Production",
    );
    expect(displayToolkitName("digital_ocean")).toBe("Digital Ocean");
  });

  it("truncates long CLI output", () => {
    expect(truncateOutput("abcdef", 3)).toBe("abc\n…[truncated 3 characters]");
    expect(truncateOutput("abc", 3)).toBe("abc");
  });

  it("exposes search, schema, execute and list tools", () => {
    const tools = createComposioAccountTools(["custom_vueschool_staging"]);
    expect(tools.map((tool) => tool.name)).toEqual([
      "composio_search_tools",
      "composio_get_tool_schema",
      "composio_execute_tool",
      "composio_list_connections",
    ]);
    expect(tools[0]!.description).toContain("custom_vueschool_staging");
  });
});

describe("dispatcher integration list", () => {
  it("adds the description only for the personal Composio integration", async () => {
    const { describeIntegrationsForPrompt } = await import("../server/interaction-agent.js");
    expect(
      describeIntegrationsForPrompt([
        { name: "gmail", description: "Gmail" },
        { name: "composio-account", description: "Vueschool Staging, Banner Studio" },
      ]),
    ).toBe("gmail, composio-account (Vueschool Staging, Banner Studio)");
  });
});
