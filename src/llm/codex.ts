import { spawn, type SpawnOptions } from "node:child_process";
import { access, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { resumeLlmConfig } from "./resumeConfig";

export class CodexCliError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "missing_cli"
      | "not_authenticated"
      | "api_key_auth"
      | "usage_limit"
      | "timeout"
      | "cancelled"
      | "failed"
      | "invalid_output",
    public readonly detail?: string,
  ) {
    super(message);
    this.name = "CodexCliError";
  }
}

export type CodexAuthStatus = {
  ok: boolean;
  method: "chatgpt" | "api_key" | "unknown" | "none";
  raw: string;
};

export type CodexExecResult = {
  status: "ok" | "failed" | "timeout" | "cancelled";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  outputText: string;
  durationMs: number;
};

export type CodexRunOpts = {
  cwd?: string;
  timeout?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Written to stdin (used for the prompt). */
  input?: string;
};

export type CodexExecOpts = {
  /** Working directory for the Codex sandbox (`--cd`). */
  cwd: string;
  prompt: string;
  /** Absolute path to a JSON Schema file for `--output-schema`. */
  outputSchemaPath?: string;
  /** Absolute path for `--output-last-message` / `-o`. */
  outputPath?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Extra args after `exec` (never interpolated through a shell). */
  extraArgs?: string[];
  /** Injectable runner for tests. */
  run?: typeof runCodexProcess;
};

export type RunResult = { stdout: string; stderr: string; code: number | null };

/** Spawn argv-only (no shell). Supports stdin, timeout, and AbortSignal. */
export async function runCodexProcess(file: string, args: string[], opts: CodexRunOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    } satisfies SpawnOptions);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => { if (!settled) { settled = true; fn(); } };

    const onAbort = () => {
      child.kill("SIGTERM");
      finish(() => reject(new CodexCliError("Codex run was cancelled.", "cancelled", stderr)));
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    if (opts.timeout && opts.timeout > 0) {
      timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new CodexCliError(`Codex timed out after ${opts.timeout}ms.`, "timeout", stderr)));
      }, opts.timeout);
    }

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => { stdout += c; });
    child.stderr?.on("data", (c: string) => { stderr += c; });
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      if (err.code === "ENOENT") {
        finish(() => reject(new CodexCliError(`Codex CLI not found at "${file}". Install it and set CODEX_CLI_PATH if needed.`, "missing_cli")));
      } else {
        finish(() => reject(err));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      finish(() => resolve({ stdout, stderr, code }));
    });

    if (opts.input != null) {
      child.stdin?.end(opts.input, "utf8");
    } else {
      child.stdin?.end();
    }
  });
}

/** Resolve the Codex executable; throws if missing. */
export async function resolveCodexPath(cliPath = resumeLlmConfig().codexPath): Promise<string> {
  if (path.isAbsolute(cliPath) || cliPath.includes("/") || cliPath.includes("\\")) {
    try {
      await access(cliPath, constants.X_OK);
      return cliPath;
    } catch {
      throw new CodexCliError(`Codex CLI not found at "${cliPath}".`, "missing_cli");
    }
  }
  // Let PATH resolution happen at exec time; probe with --version.
  try {
    await runCodexProcess(cliPath, ["--version"], { timeout: 15_000, env: sanitizeEnv(process.env) });
    return cliPath;
  } catch (e) {
    if (e instanceof CodexCliError) throw e;
    throw new CodexCliError(`Codex CLI ("${cliPath}") is not available on PATH.`, "missing_cli", (e as Error).message);
  }
}

/** Strip API-key auth env vars so Codex cannot silently switch to paid API auth. */
export function sanitizeEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out = { ...env };
  delete out.OPENAI_API_KEY;
  delete out.CODEX_API_KEY;
  delete out.OPENAI_API_KEY_NAME;
  return out;
}

function classifyAuth(stdout: string, stderr: string, code: number | null): CodexAuthStatus {
  const raw = `${stdout}\n${stderr}`.trim();
  const lower = raw.toLowerCase();
  if (code !== 0) return { ok: false, method: "none", raw };
  if (/api[_\s-]?key|with-api-key/.test(lower) && !/chatgpt|chat gpt/.test(lower)) {
    return { ok: false, method: "api_key", raw };
  }
  if (/chatgpt|chat gpt|subscription/.test(lower)) return { ok: true, method: "chatgpt", raw };
  // `codex login status` exits 0 when credentials exist; prefer ChatGPT when unclear.
  if (/logged in|authenticated|ok\b/.test(lower) || raw.length > 0) {
    return { ok: true, method: /api/.test(lower) ? "api_key" : "chatgpt", raw };
  }
  return { ok: code === 0, method: code === 0 ? "unknown" : "none", raw };
}

/**
 * Confirm Codex is available and authenticated via ChatGPT (not an API key).
 * Does not read or copy credential files.
 */
export async function checkCodexAuth(opts: { cliPath?: string; run?: typeof runCodexProcess } = {}): Promise<CodexAuthStatus> {
  const cli = opts.cliPath ?? await resolveCodexPath();
  const run = opts.run ?? runCodexProcess;
  let result: RunResult;
  try {
    result = await run(cli, ["login", "status"], { timeout: 20_000, env: sanitizeEnv(process.env) });
  } catch (e) {
    if (e instanceof CodexCliError) throw e;
    throw new CodexCliError("Could not check Codex authentication.", "not_authenticated", (e as Error).message);
  }
  const status = classifyAuth(result.stdout, result.stderr, result.code);
  if (status.method === "api_key") {
    throw new CodexCliError(
      "Codex is signed in with an API key. Sign out and run `codex login` with ChatGPT so resume tailoring uses your subscription.",
      "api_key_auth",
      status.raw,
    );
  }
  if (!status.ok) {
    throw new CodexCliError(
      "Codex is not authenticated. Run `codex login` and sign in with ChatGPT, then `codex login status`.",
      "not_authenticated",
      status.raw,
    );
  }
  return status;
}

function classifyFailure(stdout: string, stderr: string): CodexCliError["code"] {
  const t = `${stdout}\n${stderr}`.toLowerCase();
  if (/usage|rate limit|quota|limit exceeded|too many requests/.test(t)) return "usage_limit";
  if (/not logged|unauthor|auth|login/.test(t)) return "not_authenticated";
  return "failed";
}

/**
 * Run `codex exec` non-interactively with safe argv (no shell interpolation).
 * Requires ChatGPT CLI auth; never passes API keys.
 */
export async function execCodex(opts: CodexExecOpts): Promise<CodexExecResult> {
  const cfg = resumeLlmConfig();
  const run = opts.run ?? runCodexProcess;
  // When a test injects `run`, skip the real filesystem probe.
  const cli = opts.run ? (cfg.codexPath || "codex") : await resolveCodexPath(cfg.codexPath);
  await checkCodexAuth({ cliPath: cli, run });
  await mkdir(opts.cwd, { recursive: true });

  const outPath = opts.outputPath ?? path.join(opts.cwd, "codex-output.json");
  const args = [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--sandbox", "workspace-write",
    "--cd", opts.cwd,
    "--output-last-message", outPath,
  ];
  if (opts.outputSchemaPath) args.push("--output-schema", opts.outputSchemaPath);
  if (opts.extraArgs?.length) args.push(...opts.extraArgs);
  args.push("-"); // prompt from stdin

  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const started = Date.now();
  const result = await run(cli, args, {
    cwd: opts.cwd,
    timeout: timeoutMs,
    signal: opts.signal,
    env: sanitizeEnv(process.env),
    // Prompt via stdin so untrusted job text never lands on argv.
    input: opts.prompt,
  });

  let outputText = "";
  try { outputText = await readFile(outPath, "utf8"); } catch { outputText = result.stdout; }

  if (result.code !== 0) {
    const code = classifyFailure(result.stdout, result.stderr);
    throw new CodexCliError(
      code === "usage_limit"
        ? "Codex hit a ChatGPT usage limit. Try again later, or check your subscription allowance."
        : `Codex exec failed (exit ${result.code}).`,
      code,
      (result.stderr || result.stdout).slice(0, 2000),
    );
  }

  return {
    status: "ok",
    exitCode: result.code,
    stdout: result.stdout,
    stderr: result.stderr,
    outputText,
    durationMs: Date.now() - started,
  };
}

/** Parse JSON from Codex output (raw, fenced, or first object). */
export function parseCodexJson<T>(text: string): T {
  const t = text.trim();
  try { return JSON.parse(t) as T; } catch { /* fall through */ }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) as T; } catch { /* next */ }
  }
  const first = t.indexOf("{"), last = t.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try { return JSON.parse(t.slice(first, last + 1)) as T; } catch { /* next */ }
  }
  throw new CodexCliError("Codex returned unparseable JSON.", "invalid_output", t.slice(0, 400));
}

/** Write a file under a workspace; rejects path traversal. */
export async function writeWorkspaceFile(workspace: string, relative: string, contents: string): Promise<string> {
  const target = safeJoin(workspace, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents, "utf8");
  return target;
}

export function safeJoin(root: string, relative: string): string {
  const resolved = path.resolve(root, relative);
  const rootResolved = path.resolve(root);
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) {
    throw new Error(`Refusing path outside workspace: ${relative}`);
  }
  return resolved;
}
