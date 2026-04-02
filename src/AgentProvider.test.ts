import { describe, expect, it } from "vitest";
import { claudeCode } from "./AgentProvider.js";

describe("claudeCode factory", () => {
  it("returns a provider with name 'claude-code'", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.name).toBe("claude-code");
  });

  it("envManifest contains ANTHROPIC_API_KEY and GH_TOKEN but NOT CLAUDE_CODE_OAUTH_TOKEN", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.envManifest).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(provider.envManifest).toHaveProperty("ANTHROPIC_API_KEY");
    expect(provider.envManifest).toHaveProperty("GH_TOKEN");
  });

  it("has a non-empty dockerfileTemplate", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.dockerfileTemplate).toContain("FROM");
    expect(provider.dockerfileTemplate).toContain("claude");
  });

  it("buildPrintCommand includes the model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--output-format stream-json");
    expect(command).toContain("--print");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand("it's a test");
    // Single-quoted shell escaping: ' -> '\''
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = claudeCode("claude-opus-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--model 'claude-opus-4-6'");
  });

  it("buildInteractiveArgs includes the model", () => {
    const provider = claudeCode("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs("");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--model");
  });

  it("parseStreamLine extracts text from assistant message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from result message", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "result",
      result: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
        usage: null,
      },
    ]);
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = claudeCode("claude-opus-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts tool_use block (Bash → command arg)", () => {
    const provider = claudeCode("claude-opus-4-6");
    const line = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", name: "Bash", input: { command: "npm test" } },
        ],
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine bakes model into each provider instance independently", () => {
    const provider1 = claudeCode("model-a");
    const provider2 = claudeCode("model-b");
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
  });
});
