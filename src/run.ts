import { Effect, Layer } from "effect";
import { readConfig } from "./Config.js";
import { FilesystemSandbox } from "./FilesystemSandbox.js";
import { orchestrate } from "./Orchestrator.js";
import { resolvePrompt } from "./PromptResolver.js";
import { Sandbox, SandboxError } from "./Sandbox.js";
import { DockerSandboxFactory, SandboxFactory } from "./SandboxFactory.js";
import { resolveTokens } from "./TokenResolver.js";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunOptions {
  /** Inline prompt string (mutually exclusive with promptFile) */
  readonly prompt?: string;
  /** Path to a prompt file (mutually exclusive with prompt) */
  readonly promptFile?: string;
  /** Maximum iterations to run (default: 5) */
  readonly maxIterations?: number;
  /** Hooks to run during sandbox lifecycle */
  readonly hooks?: {
    readonly onSandboxCreate?: ReadonlyArray<{ command: string }>;
    readonly onSandboxReady?: ReadonlyArray<{ command: string }>;
  };
  /** Target branch name for sandbox work */
  readonly branch?: string;
  /** @internal */
  readonly _imageName?: string;
  /** @internal Test-only options — not part of the public API contract */
  readonly _test?: {
    readonly hostRepoDir?: string;
    readonly mockAgentOutput?: string;
  };
}

export interface RunResult {
  readonly iterationsRun: number;
  readonly complete: boolean;
}

const SANDBOX_REPOS_DIR = "/home/agent/repos";

export const run = async (options: RunOptions): Promise<RunResult> => {
  const {
    prompt,
    promptFile,
    maxIterations = 5,
    hooks,
    branch,
    _imageName = "sandcastle:local",
    _test,
  } = options;

  const hostRepoDir = _test?.hostRepoDir ?? process.cwd();
  const repoName = hostRepoDir.split("/").pop()!;
  const sandboxRepoDir = _test
    ? join(tmpdir(), `run-sandbox-${randomUUID()}`, "repo")
    : `${SANDBOX_REPOS_DIR}/${repoName}`;

  // Resolve prompt
  const resolvedPrompt = await Effect.runPromise(
    resolvePrompt({ prompt, promptFile, cwd: hostRepoDir }),
  );

  // Read config
  const config = await Effect.runPromise(readConfig(hostRepoDir));

  // Merge hooks: explicit hooks override config hooks
  const resolvedConfig = hooks ? { ...config, hooks } : config;

  // Resolve iterations: explicit maxIterations param takes priority
  const iterations = maxIterations;

  // Build factory layer
  let factoryLayer: Layer.Layer<SandboxFactory>;

  if (_test) {
    // Test mode: use filesystem sandbox with mock agent
    factoryLayer = makeTestFactory(sandboxRepoDir, _test.mockAgentOutput);
  } else {
    // Production mode: resolve tokens and use Docker
    const tokens = await resolveTokens(hostRepoDir);
    factoryLayer = DockerSandboxFactory.layer(
      _imageName,
      tokens.oauthToken,
      tokens.ghToken,
    );
  }

  const result = await Effect.runPromise(
    orchestrate({
      hostRepoDir,
      sandboxRepoDir,
      iterations,
      config: resolvedConfig,
      prompt: resolvedPrompt,
      branch,
    }).pipe(Effect.provide(factoryLayer)),
  );

  return { iterationsRun: result.iterationsRun, complete: result.complete };
};

/** Format a mock agent result as stream-json lines */
const toStreamJson = (output: string): string => {
  const lines: string[] = [];
  lines.push(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "text", text: output }] },
    }),
  );
  lines.push(JSON.stringify({ type: "result", result: output }));
  return lines.join("\n");
};

const makeTestFactory = (
  sandboxRepoDir: string,
  mockAgentOutput?: string,
): Layer.Layer<SandboxFactory> => {
  const sandboxBaseDir = join(sandboxRepoDir, "..");

  return Layer.succeed(SandboxFactory, {
    withSandbox: <A, E, R>(
      effect: Effect.Effect<A, E, R | Sandbox>,
    ): Effect.Effect<A, E | SandboxError, Exclude<R, Sandbox>> =>
      Effect.acquireUseRelease(
        Effect.promise(async () => {
          await rm(sandboxBaseDir, { recursive: true, force: true });
          await mkdir(sandboxBaseDir, { recursive: true });
          return sandboxBaseDir;
        }),
        (dir) => {
          const fsLayer = FilesystemSandbox.layer(dir);
          const agentOutput = mockAgentOutput ?? "Done.";

          const mockLayer = Layer.succeed(Sandbox, {
            exec: (command, opts) =>
              Effect.flatMap(Sandbox, (real) => real.exec(command, opts)).pipe(
                Effect.provide(fsLayer),
              ),
            execStreaming: (command, onStdoutLine, opts) => {
              if (command.startsWith("claude ")) {
                const streamOutput = toStreamJson(agentOutput);
                for (const line of streamOutput.split("\n")) {
                  onStdoutLine(line);
                }
                return Effect.succeed({
                  stdout: streamOutput,
                  stderr: "",
                  exitCode: 0,
                });
              }
              return Effect.flatMap(Sandbox, (real) =>
                real.execStreaming(command, onStdoutLine, opts),
              ).pipe(Effect.provide(fsLayer));
            },
            copyIn: (hostPath, sandboxPath) =>
              Effect.flatMap(Sandbox, (real) =>
                real.copyIn(hostPath, sandboxPath),
              ).pipe(Effect.provide(fsLayer)),
            copyOut: (sandboxPath, hostPath) =>
              Effect.flatMap(Sandbox, (real) =>
                real.copyOut(sandboxPath, hostPath),
              ).pipe(Effect.provide(fsLayer)),
          });

          return effect.pipe(Effect.provide(mockLayer)) as Effect.Effect<
            A,
            E | SandboxError,
            Exclude<R, Sandbox>
          >;
        },
        (dir) =>
          Effect.promise(() => rm(dir, { recursive: true, force: true })),
      ),
  });
};
