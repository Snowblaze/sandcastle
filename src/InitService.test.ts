import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scaffold } from "./InitService.js";
import type { AgentProvider } from "./AgentProvider.js";
import { claudeCodeProvider } from "./AgentProvider.js";
import { SANDBOX_WORKSPACE_DIR } from "./SandboxFactory.js";
import { SKELETON_PROMPT } from "./templates.js";

const makeDir = () => mkdtemp(join(tmpdir(), "init-service-"));

const fakeProvider: AgentProvider = {
  name: "fake-agent",
  envManifest: {
    FAKE_TOKEN: "Fake agent token",
    FAKE_SECRET: "Fake agent secret",
  },
  envCheck: () => {},
  dockerfileTemplate: "FROM ubuntu:latest\nRUN echo fake\n",
};

describe("InitService scaffold", () => {
  it("uses provider envManifest for .env.example", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const envExample = await readFile(
      join(dir, ".sandcastle", ".env.example"),
      "utf-8",
    );
    expect(envExample).toContain("FAKE_TOKEN=");
    expect(envExample).toContain("FAKE_SECRET=");
    // Comments from manifest should be present
    expect(envExample).toContain("# Fake agent token");
    expect(envExample).toContain("# Fake agent secret");
    // Should NOT contain hardcoded claude-code keys
    expect(envExample).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  it("uses provider dockerfileTemplate for Dockerfile", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);
  });

  it("writes agent name to config.json", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const configJson = await readFile(
      join(dir, ".sandcastle", "config.json"),
      "utf-8",
    );
    const config = JSON.parse(configJson);
    expect(config).toEqual({ agent: "fake-agent" });
  });

  it("scaffolds claude-code provider correctly", async () => {
    const dir = await makeDir();
    await scaffold(dir, claudeCodeProvider);

    const configDir = join(dir, ".sandcastle");

    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(claudeCodeProvider.dockerfileTemplate);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(envExample).toContain("GH_TOKEN=");

    const configJson = await readFile(join(configDir, "config.json"), "utf-8");
    expect(JSON.parse(configJson)).toEqual({ agent: "claude-code" });
  });

  it("errors if .sandcastle/ already exists", async () => {
    const dir = await makeDir();
    await mkdir(join(dir, ".sandcastle"));

    await expect(scaffold(dir, fakeProvider)).rejects.toThrow(
      ".sandcastle/ directory already exists",
    );
  });

  it("includes patches/, logs/, and worktrees/ in .gitignore", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const gitignore = await readFile(
      join(dir, ".sandcastle", ".gitignore"),
      "utf-8",
    );
    expect(gitignore).toContain("patches/");
    expect(gitignore).toContain("logs/");
    expect(gitignore).toContain("worktrees/");
  });

  it("Dockerfile template contains workspace mount comment", async () => {
    const dir = await makeDir();
    await scaffold(dir, claudeCodeProvider);

    const dockerfile = await readFile(
      join(dir, ".sandcastle", "Dockerfile"),
      "utf-8",
    );
    expect(dockerfile).toContain(SANDBOX_WORKSPACE_DIR);
  });

  it("skeleton prompt contains section headers and hints", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider);

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt).toContain("# ");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("blank template produces skeleton prompt and no main.ts", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider, "blank");

    const configDir = join(dir, ".sandcastle");
    const prompt = await readFile(join(configDir, "prompt.md"), "utf-8");
    expect(prompt).toContain("!`");
    expect(prompt).toContain("<promise>COMPLETE</promise>");

    const { access } = await import("node:fs/promises");
    await expect(access(join(configDir, "main.ts"))).rejects.toThrow();
  });

  it("blank template produces identical output to default (no template arg)", async () => {
    const dir1 = await makeDir();
    const dir2 = await makeDir();
    await scaffold(dir1, fakeProvider);
    await scaffold(dir2, fakeProvider, "blank");

    const prompt1 = await readFile(
      join(dir1, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    const prompt2 = await readFile(
      join(dir2, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    expect(prompt1).toBe(prompt2);
  });

  it("simple-loop template produces main.ts and prompt.md", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider, "simple-loop");

    const configDir = join(dir, ".sandcastle");
    const { access } = await import("node:fs/promises");

    // Both files must exist
    await expect(access(join(configDir, "main.ts"))).resolves.toBeUndefined();
    await expect(access(join(configDir, "prompt.md"))).resolves.toBeUndefined();
  });

  it("simple-loop main.ts contains sandcastle.run() with expected options", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider, "simple-loop");

    const mainTs = await readFile(join(dir, ".sandcastle", "main.ts"), "utf-8");
    expect(mainTs).toContain("run(");
    expect(mainTs).toContain("maxIterations");
    expect(mainTs).toContain("3");
    expect(mainTs).toContain("claude-sonnet-4-6");
    expect(mainTs).toContain("promptFile");
    expect(mainTs).toContain("npm install");
    expect(mainTs).toContain("onSandboxReady");
  });

  it("simple-loop prompt.md contains shell expressions for issues and commit history", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider, "simple-loop");

    const prompt = await readFile(
      join(dir, ".sandcastle", "prompt.md"),
      "utf-8",
    );
    // Shell expressions for dynamic context
    expect(prompt).toContain("!`gh issue");
    expect(prompt).toContain("!`git log");
    // Completion signal
    expect(prompt).toContain("<promise>COMPLETE</promise>");
  });

  it("unknown template name throws a clear error", async () => {
    const dir = await makeDir();
    await expect(scaffold(dir, fakeProvider, "nonexistent")).rejects.toThrow(
      "nonexistent",
    );
  });

  it("common files are generated correctly regardless of template", async () => {
    const dir = await makeDir();
    await scaffold(dir, fakeProvider, "blank");

    const configDir = join(dir, ".sandcastle");
    const dockerfile = await readFile(join(configDir, "Dockerfile"), "utf-8");
    expect(dockerfile).toBe(fakeProvider.dockerfileTemplate);

    const envExample = await readFile(join(configDir, ".env.example"), "utf-8");
    expect(envExample).toContain("FAKE_TOKEN=");

    const configJson = JSON.parse(
      await readFile(join(configDir, "config.json"), "utf-8"),
    );
    expect(configJson).toEqual({ agent: "fake-agent" });
  });
});
