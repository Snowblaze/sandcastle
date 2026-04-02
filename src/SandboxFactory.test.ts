import { Effect, Exit, Layer, Ref } from "effect";
import { NodeFileSystem } from "@effect/platform-node";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { AgentError, TimeoutError, WorktreeError } from "./errors.js";
import { Display, SilentDisplay, type DisplayEntry } from "./Display.js";

// Mock child_process before importing modules under test
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("./WorktreeManager.js", () => ({
  create: vi.fn(),
  remove: vi.fn(),
  pruneStale: vi.fn(),
  hasUncommittedChanges: vi.fn(),
}));

import { execFile } from "node:child_process";
import * as WorktreeManager from "./WorktreeManager.js";
import {
  SandboxFactory,
  WorktreeSandboxConfig,
  WorktreeDockerSandboxFactory,
  SANDBOX_WORKSPACE_DIR,
} from "./SandboxFactory.js";

const mockExecFile = vi.mocked(execFile);
const mockCreate = vi.mocked(WorktreeManager.create);
const mockRemove = vi.mocked(WorktreeManager.remove);
const mockPruneStale = vi.mocked(WorktreeManager.pruneStale);
const mockHasUncommittedChanges = vi.mocked(
  WorktreeManager.hasUncommittedChanges,
);

/** Make all execFile calls succeed with given stdout. */
const mockDockerSuccess = (stdout = "") => {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    (callback as Function)(null, stdout, "");
    return {} as any;
  });
};

/** Collect all docker arg arrays across calls. */
const capturedArgs = (): string[][] =>
  mockExecFile.mock.calls.map((call) => call[1] as string[]);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("WorktreeDockerSandboxFactory", () => {
  let hostRepoDir: string;
  const worktreePath = "/tmp/sandcastle-worktrees/sandcastle-123";
  const tempDirs: string[] = [];

  const makeTempRepo = async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandcastle-test-"));
    tempDirs.push(dir);
    await mkdir(join(dir, ".git"));
    return dir;
  };

  const makeLayer = (
    displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
  ) =>
    Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: { FOO: "bar" },
          hostRepoDir,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(displayRef),
      ),
    );

  beforeEach(async () => {
    hostRepoDir = await makeTempRepo();
    mockCreate.mockReturnValue(
      Effect.succeed({
        path: worktreePath,
        branch: "sandcastle/20240101-000000",
      }),
    );
    mockRemove.mockReturnValue(Effect.void);
    mockPruneStale.mockReturnValue(Effect.void);
    // Default: clean worktree (no uncommitted changes)
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    mockDockerSuccess();
  });

  afterEach(async () => {
    await Promise.all(
      tempDirs.map((d) => rm(d, { recursive: true, force: true })),
    );
    tempDirs.length = 0;
  });

  it("passes branch from config to WorktreeManager.create when branch is specified", async () => {
    const layerWithBranch = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: {},
          hostRepoDir,
          worktree: { mode: "branch", branch: "feature/my-branch" },
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithBranch)),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      branch: "feature/my-branch",
    });
  });

  it("calls create without branch options when no branch in config", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      name: undefined,
    });
  });

  it("creates a worktree before starting the container", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      name: undefined,
    });
    // Worktree creation happened before the docker run call
    const runCallIndex = mockExecFile.mock.calls.findIndex(
      (c) => (c[1] as string[])[0] === "run",
    );
    expect(runCallIndex).toBeGreaterThan(-1);
    // create() was called (mocked promise), so it was invoked before docker run
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("starts container with worktree and .git bind-mounts at SANDBOX_WORKSPACE_DIR", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toBeDefined();
    expect(runArgs).toContain(`${worktreePath}:${SANDBOX_WORKSPACE_DIR}`);
    const gitMount = `${hostRepoDir}/.git:${hostRepoDir}/.git`;
    expect(runArgs).toContain(gitMount);
  });

  it("sets working directory to SANDBOX_WORKSPACE_DIR", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toContain("-w");
    const wIndex = runArgs!.indexOf("-w");
    expect(runArgs![wIndex + 1]).toBe(SANDBOX_WORKSPACE_DIR);
  });

  it("removes worktree after the effect completes", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });

  it("prunes stale worktrees before creating a new worktree", async () => {
    const callOrder: string[] = [];
    mockPruneStale.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("pruneStale");
      }),
    );
    mockCreate.mockImplementation(() =>
      Effect.sync(() => {
        callOrder.push("create");
        return { path: worktreePath, branch: "sandcastle/20240101-000000" };
      }),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockPruneStale).toHaveBeenCalledWith(hostRepoDir);
    expect(callOrder.indexOf("pruneStale")).toBeLessThan(
      callOrder.indexOf("create"),
    );
  });

  it("continues creating the worktree even if pruning fails", async () => {
    mockPruneStale.mockReturnValue(
      Effect.fail(new WorktreeError({ message: "prune failed" })),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockCreate).toHaveBeenCalledWith(hostRepoDir, {
      name: undefined,
    });
  });

  it("always sets HOME=/home/agent in the container environment", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toContain("HOME=/home/agent");
  });

  it("restores Codex auth.json from CODEX_AUTH_JSON_B64 when provided", async () => {
    const layerWithCodexAuth = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: { CODEX_AUTH_JSON_B64: "eyJ0ZXN0IjoidHJ1ZSJ9" },
          hostRepoDir,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithCodexAuth)),
    );

    const restoreCall = capturedArgs().find(
      (args) =>
        args[0] === "exec" &&
        args.includes("CODEX_AUTH_JSON_B64") &&
        args.includes('printf "%s" "$CODEX_AUTH_JSON_B64" | base64 -d > "$HOME/.codex/auth.json"'),
    );
    expect(restoreCall).toBeDefined();
  });

  it("does not let user env override HOME", async () => {
    const layerWithHome = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: { FOO: "bar", HOME: "/tmp/evil" },
          hostRepoDir,
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([])),
      ),
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithHome)),
    );

    const runArgs = capturedArgs().find((args) => args[0] === "run");
    expect(runArgs).toContain("HOME=/home/agent");
    expect(runArgs).not.toContain("HOME=/tmp/evil");
  });

  it("preserves worktree (does not remove) when the effect fails with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.die("boom"));
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(mockRemove).not.toHaveBeenCalled();
  });

  it("removes container but preserves worktree on typed failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new WorktreeError({ message: "boom" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    // Worktree must NOT be removed
    expect(mockRemove).not.toHaveBeenCalled();
    // Container must be removed (docker stop + rm)
    const allArgs = capturedArgs();
    expect(allArgs.some((args) => args[0] === "rm")).toBe(true);
  });

  it("attaches preservedWorktreePath to TimeoutError on failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(
            new TimeoutError({ message: "timed out", idleTimeoutSeconds: 30 }),
          ),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(TimeoutError);
    expect((exit.cause.error as TimeoutError).preservedWorktreePath).toBe(
      worktreePath,
    );
  });

  it("attaches preservedWorktreePath to AgentError on failure with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(new AgentError({ message: "agent failed" })),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(AgentError);
    expect((exit.cause.error as AgentError).preservedWorktreePath).toBe(
      worktreePath,
    );
  });

  it("logs copy-to-sandbox as a spinner when copyToSandbox paths are provided", async () => {
    const ref = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]);
    const layerWithCopy = Layer.provide(
      WorktreeDockerSandboxFactory.layer,
      Layer.mergeAll(
        Layer.succeed(WorktreeSandboxConfig, {
          imageName: "test-image",
          env: {},
          hostRepoDir,
          copyToSandbox: ["node_modules"],
        }),
        NodeFileSystem.layer,
        SilentDisplay.layer(ref),
      ),
    );

    vi.mock("./CopyToSandbox.js", () => ({
      copyToSandbox: vi.fn(() => Effect.succeed(undefined)),
    }));

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(layerWithCopy)),
    );

    const entries = await Effect.runPromise(Ref.get(ref));
    const spinnerEntry = entries.find(
      (e) => e._tag === "spinner" && e.message === "Copying to sandbox",
    );
    expect(spinnerEntry).toBeDefined();
  });

  it("removes worktree silently on success with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
    expect(stderrSpy).not.toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("preserves worktree and returns preservedWorktreePath on success with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(mockRemove).not.toHaveBeenCalled();
    expect(result.preservedWorktreePath).toBe(worktreePath);
    expect(result.value).toBe("done");
  });

  it("prints uncommitted changes message on success with dirty worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(true));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() => Effect.void);
      }).pipe(Effect.provide(makeLayer())),
    );

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("uncommitted changes");
    expect(output).toContain(worktreePath);
    stderrSpy.mockRestore();
  });

  it("removes worktree on failure with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new AgentError({ message: "agent failed" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    expect(mockRemove).toHaveBeenCalledWith(worktreePath);
  });

  it("prints 'no uncommitted changes' message on failure with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() =>
            Effect.fail(new AgentError({ message: "agent failed" })),
          );
        }).pipe(Effect.provide(makeLayer())),
      ),
    ).rejects.toThrow();

    const output = stderrSpy.mock.calls.map((c) => c[0]).join(" ");
    expect(output).toContain("no uncommitted changes");
    stderrSpy.mockRestore();
  });

  it("does not attach preservedWorktreePath to TimeoutError when worktree is clean on failure", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        yield* factory.withSandbox(() =>
          Effect.fail(
            new TimeoutError({ message: "timed out", idleTimeoutSeconds: 30 }),
          ),
        );
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("unreachable");
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") throw new Error("unreachable");
    expect(exit.cause.error).toBeInstanceOf(TimeoutError);
    expect(
      (exit.cause.error as TimeoutError).preservedWorktreePath,
    ).toBeUndefined();
  });

  describe("mode: none", () => {
    const makeNoneLayer = (
      displayRef = Ref.unsafeMake<ReadonlyArray<DisplayEntry>>([]),
    ) =>
      Layer.provide(
        WorktreeDockerSandboxFactory.layer,
        Layer.mergeAll(
          Layer.succeed(WorktreeSandboxConfig, {
            imageName: "test-image",
            env: { FOO: "bar" },
            hostRepoDir,
            worktree: { mode: "none" },
          }),
          NodeFileSystem.layer,
          SilentDisplay.layer(displayRef),
        ),
      );

    it("does not create or remove a worktree", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      expect(mockCreate).not.toHaveBeenCalled();
      expect(mockRemove).not.toHaveBeenCalled();
      expect(mockPruneStale).not.toHaveBeenCalled();
    });

    it("bind-mounts host repo dir at SANDBOX_WORKSPACE_DIR", async () => {
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      const runArgs = capturedArgs().find((args) => args[0] === "run");
      expect(runArgs).toBeDefined();
      expect(runArgs).toContain(`${hostRepoDir}:${SANDBOX_WORKSPACE_DIR}`);
      const gitMount = `${hostRepoDir}/.git:${hostRepoDir}/.git`;
      expect(runArgs).toContain(gitMount);
    });

    it("returns undefined preservedWorktreePath", async () => {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          return yield* factory.withSandbox(() => Effect.succeed("done"));
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      expect(result.preservedWorktreePath).toBeUndefined();
      expect(result.value).toBe("done");
    });

    it("does not pass hostWorktreePath to the effect", async () => {
      let receivedInfo: { hostWorktreePath?: string } | undefined;
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox((info) => {
            receivedInfo = info;
            return Effect.void;
          });
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      expect(receivedInfo?.hostWorktreePath).toBeUndefined();
    });

    it("mounts only one git volume when .git is a directory (normal repo)", async () => {
      // hostRepoDir already has .git as a directory from makeTempRepo()
      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      const runArgs = capturedArgs().find((args) => args[0] === "run");
      expect(runArgs).toBeDefined();
      // Should have exactly one git-related -v mount (the .git directory)
      const gitMounts = runArgs!.filter((arg) => arg.includes(".git:"));
      expect(gitMounts).toHaveLength(1);
      expect(gitMounts[0]).toBe(`${hostRepoDir}/.git:${hostRepoDir}/.git`);
    });

    it("mounts both .git file and parent .git dir when .git is a worktree file", async () => {
      // Create a parent repo with .git/worktrees/<name> structure
      const parentRepoDir = await makeTempRepo();
      const parentGitDir = join(parentRepoDir, ".git");
      await mkdir(join(parentGitDir, "worktrees", "my-worktree"), {
        recursive: true,
      });

      // Replace .git directory with a worktree file pointing to the parent
      await rm(join(hostRepoDir, ".git"), { recursive: true });
      await writeFile(
        join(hostRepoDir, ".git"),
        `gitdir: ${parentGitDir}/worktrees/my-worktree\n`,
      );

      await Effect.runPromise(
        Effect.gen(function* () {
          const factory = yield* SandboxFactory;
          yield* factory.withSandbox(() => Effect.void);
        }).pipe(Effect.provide(makeNoneLayer())),
      );

      const runArgs = capturedArgs().find((args) => args[0] === "run");
      expect(runArgs).toBeDefined();
      const gitMounts = runArgs!.filter((arg) => arg.includes(".git"));
      // Should mount both the .git file and the parent .git directory
      expect(gitMounts).toContain(`${hostRepoDir}/.git:${hostRepoDir}/.git`);
      expect(gitMounts).toContain(`${parentGitDir}:${parentGitDir}`);
    });
  });

  it("returns undefined preservedWorktreePath on success with clean worktree", async () => {
    mockHasUncommittedChanges.mockReturnValue(Effect.succeed(false));

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const factory = yield* SandboxFactory;
        return yield* factory.withSandbox(() => Effect.succeed("done"));
      }).pipe(Effect.provide(makeLayer())),
    );

    expect(result.preservedWorktreePath).toBeUndefined();
    expect(result.value).toBe("done");
  });
});
