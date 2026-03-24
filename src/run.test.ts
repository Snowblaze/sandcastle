import { exec } from "node:child_process";
import { mkdtemp, writeFile, readFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { run } from "./run.js";

const execAsync = promisify(exec);

const initRepo = async (dir: string) => {
  await execAsync("git init -b main", { cwd: dir });
  await execAsync('git config user.email "test@test.com"', { cwd: dir });
  await execAsync('git config user.name "Test"', { cwd: dir });
};

const commitFile = async (
  dir: string,
  name: string,
  content: string,
  message: string,
) => {
  await writeFile(join(dir, name), content);
  await execAsync(`git add "${name}"`, { cwd: dir });
  await execAsync(`git commit -m "${message}"`, { cwd: dir });
};

describe("run() public API", () => {
  it("accepts prompt string and returns { iterationsRun, complete }", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "run-api-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    // Create .sandcastle dir with .env
    const configDir = join(hostDir, ".sandcastle");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, ".env"),
      "CLAUDE_CODE_OAUTH_TOKEN=test-token\nGH_TOKEN=test-gh-token\n",
    );

    const result = await run({
      prompt: "Do some work",
      maxIterations: 1,
      _test: {
        hostRepoDir: hostDir,
      },
    });

    expect(result).toHaveProperty("iterationsRun");
    expect(result).toHaveProperty("complete");
    expect(typeof result.iterationsRun).toBe("number");
    expect(typeof result.complete).toBe("boolean");
  });

  it("errors when both prompt and promptFile are provided", async () => {
    await expect(
      run({
        prompt: "inline",
        promptFile: "./some-file.md",
      }),
    ).rejects.toThrow(/Cannot provide both/);
  });

  it("returns complete: true when agent emits completion signal", async () => {
    const hostDir = await mkdtemp(join(tmpdir(), "run-complete-"));
    await initRepo(hostDir);
    await commitFile(hostDir, "hello.txt", "hello", "initial commit");

    const configDir = join(hostDir, ".sandcastle");
    await mkdir(configDir, { recursive: true });
    await writeFile(
      join(configDir, ".env"),
      "CLAUDE_CODE_OAUTH_TOKEN=test-token\nGH_TOKEN=test-gh-token\n",
    );

    // Write a prompt file that the agent will see
    await writeFile(join(configDir, "prompt.md"), "Do some work please.");

    const result = await run({
      maxIterations: 1,
      _test: {
        hostRepoDir: hostDir,
        mockAgentOutput: "All done. <promise>COMPLETE</promise>",
      },
    });

    expect(result.complete).toBe(true);
    expect(result.iterationsRun).toBe(1);
  });
});
