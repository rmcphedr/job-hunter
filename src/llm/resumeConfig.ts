import "dotenv/config";
import path from "node:path";

export type ResumeLlmProvider = "codex_cli" | "openrouter";

function boolEnv(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v == null || v === "") return fallback;
  return !/^(0|false|no|off)$/i.test(v);
}

function intEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resume-tailoring provider settings. Other LLM tasks keep using OpenRouter. */
export function resumeLlmConfig() {
  const raw = (process.env.RESUME_LLM_PROVIDER ?? "codex_cli").trim().toLowerCase();
  const provider: ResumeLlmProvider = raw === "openrouter" ? "openrouter" : "codex_cli";
  const outDir = process.env.RESUME_OUTPUT_DIRECTORY?.trim() || path.join("data", "out");
  const template = process.env.RESUME_TEMPLATE_PATH?.trim() || "resume.tex";
  return {
    provider,
    /** Explicit opt-in only. Never auto-fallback to OpenRouter on Codex failure. */
    openRouterFallback: boolEnv("RESUME_OPENROUTER_FALLBACK", false),
    codexPath: process.env.CODEX_CLI_PATH?.trim() || "codex",
    /** Milliseconds. */
    timeoutMs: intEnv("CODEX_TASK_TIMEOUT", 300_000),
    outputDirectory: path.isAbsolute(outDir) ? outDir : path.join(process.cwd(), outDir),
    templatePath: path.isAbsolute(template) ? template : path.join(process.cwd(), template),
    agentDir: path.join(process.cwd(), "agents", "resume-tailor"),
    workspaceRoot: path.join(process.cwd(), "data", "codex-workspaces"),
  };
}
