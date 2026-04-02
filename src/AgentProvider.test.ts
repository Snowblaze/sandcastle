import { describe, expect, it } from "vitest";
import { codex, pi } from "./AgentProvider.js";

describe("codex factory", () => {
  it("returns a provider with name 'codex'", () => {
    const provider = codex("gpt-5.3-codex");
    expect(provider.name).toBe("codex");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = codex("gpt-5.3-codex");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and codex exec flags", () => {
    const provider = codex("gpt-5.4");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("gpt-5.4");
    expect(command).toContain("codex exec");
    expect(command).toContain("--json");
    expect(command).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = codex("gpt-5.3-codex");
    const command = provider.buildPrintCommand("it's a test");
    // Single-quoted shell escaping: ' -> '\''
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = codex("gpt-5.3-codex");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--model 'gpt-5.3-codex'");
  });

  it("buildInteractiveArgs includes the binary and model", () => {
    const provider = codex("gpt-5.4");
    const args = provider.buildInteractiveArgs("");
    expect(args[0]).toBe("codex");
    expect(args).toContain("gpt-5.4");
    expect(args).toContain("--model");
  });

  it("parseStreamLine extracts text from agent_message", () => {
    const provider = codex("gpt-5.3-codex");
    const line = JSON.stringify({
      type: "agent_message",
      message: "Hello world",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts result from task_complete", () => {
    const provider = codex("gpt-5.3-codex");
    const line = JSON.stringify({
      type: "task_complete",
      last_agent_message: "Final answer <promise>COMPLETE</promise>",
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
    const provider = codex("gpt-5.3-codex");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine extracts exec_command_begin as a Bash tool call", () => {
    const provider = codex("gpt-5.3-codex");
    const line = JSON.stringify({
      type: "exec_command_begin",
      command: "npm test",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine extracts agent_message_delta", () => {
    const provider = codex("gpt-5.3-codex");
    const line = JSON.stringify({
      type: "agent_message_delta",
      delta: "Thinking...",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Thinking..." },
    ]);
  });

  it("parseStreamLine extracts usage from task_complete", () => {
    const provider = codex("gpt-5.3-codex");
    const line = JSON.stringify({
      type: "task_complete",
      last_agent_message: "Done",
      num_turns: 3,
      duration_ms: 12000,
      last_token_usage: {
        input_tokens: 52340,
        output_tokens: 3201,
        cached_input_tokens: 10000,
      },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Done",
        usage: {
          input_tokens: 52340,
          output_tokens: 3201,
          cache_read_input_tokens: 10000,
          cache_creation_input_tokens: 0,
          total_cost_usd: 0,
          num_turns: 3,
          duration_ms: 12000,
        },
      },
    ]);
  });

  it("parseStreamLine bakes model into each provider instance independently", () => {
    const provider1 = codex("model-a");
    const provider2 = codex("model-b");
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
  });
});

// ---------------------------------------------------------------------------
// pi factory
// ---------------------------------------------------------------------------

describe("pi factory", () => {
  it("returns a provider with name 'pi'", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.name).toBe("pi");
  });

  it("does not expose envManifest or dockerfileTemplate", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider).not.toHaveProperty("envManifest");
    expect(provider).not.toHaveProperty("dockerfileTemplate");
  });

  it("buildPrintCommand includes the model and pi flags", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("claude-sonnet-4-6");
    expect(command).toContain("--mode json");
    expect(command).toContain("--no-session");
    expect(command).toContain("-p");
  });

  it("buildPrintCommand shell-escapes the prompt", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("it's a test");
    expect(command).toContain("'it'\\''s a test'");
  });

  it("buildPrintCommand shell-escapes the model", () => {
    const provider = pi("claude-sonnet-4-6");
    const command = provider.buildPrintCommand("do something");
    expect(command).toContain("--model 'claude-sonnet-4-6'");
  });

  it("buildInteractiveArgs includes the binary and model", () => {
    const provider = pi("claude-sonnet-4-6");
    const args = provider.buildInteractiveArgs("");
    expect(args[0]).toBe("pi");
    expect(args).toContain("claude-sonnet-4-6");
    expect(args).toContain("--model");
  });

  it("parseStreamLine extracts text from message_update event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "message_update",
      content: [{ type: "text_delta", text: "Hello world" }],
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "text", text: "Hello world" },
    ]);
  });

  it("parseStreamLine extracts tool call from tool_execution_start event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      tool_name: "Bash",
      input: { command: "npm test" },
    });
    expect(provider.parseStreamLine(line)).toEqual([
      { type: "tool_call", name: "Bash", args: "npm test" },
    ]);
  });

  it("parseStreamLine skips non-allowlisted tools", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      tool_name: "UnknownTool",
      input: { foo: "bar" },
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine extracts result from agent_end event", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_end",
      last_assistant_message: "Final answer <promise>COMPLETE</promise>",
    });
    expect(provider.parseStreamLine(line)).toEqual([
      {
        type: "result",
        result: "Final answer <promise>COMPLETE</promise>",
        usage: null,
      },
    ]);
  });

  it("parseStreamLine extracts usage from agent_end event when present", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "agent_end",
      last_assistant_message: "Done",
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
      total_cost_usd: 0.01,
      num_turns: 3,
      duration_ms: 5000,
    });
    const events = provider.parseStreamLine(line);
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("result");
    const result = events[0] as { type: "result"; usage: unknown };
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 5,
      total_cost_usd: 0.01,
      num_turns: 3,
      duration_ms: 5000,
    });
  });

  it("parseStreamLine returns empty array for non-JSON lines", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("not json")).toEqual([]);
    expect(provider.parseStreamLine("")).toEqual([]);
  });

  it("parseStreamLine returns empty array for unrecognized event types", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "unknown_event", data: "foo" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine returns empty array for malformed JSON", () => {
    const provider = pi("claude-sonnet-4-6");
    expect(provider.parseStreamLine("{bad json")).toEqual([]);
  });

  it("parseStreamLine handles message_update with missing content", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({ type: "message_update" });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("parseStreamLine handles tool_execution_start with missing fields", () => {
    const provider = pi("claude-sonnet-4-6");
    const line = JSON.stringify({
      type: "tool_execution_start",
      tool_name: "Bash",
      // no input field
    });
    expect(provider.parseStreamLine(line)).toEqual([]);
  });

  it("bakes model into each provider instance independently", () => {
    const provider1 = pi("model-a");
    const provider2 = pi("model-b");
    expect(provider1.buildPrintCommand("test")).toContain("model-a");
    expect(provider2.buildPrintCommand("test")).toContain("model-b");
    expect(provider1.buildPrintCommand("test")).not.toContain("model-b");
  });
});
