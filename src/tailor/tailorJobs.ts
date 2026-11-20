import { and, eq, gte, isNull, lt, ne, or, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "../db/client";
import { jobs, jobScores, spend, tailorings } from "../db/schema";
import { loadSettings } from "../config";
import { loadProfile } from "../profile/load";
import { canSpend, spendSummary } from "../budget/budget";
import { composite } from "../scoring/composite";
import { BudgetExceededError } from "../llm/openrouter";
import { CodexCliError } from "../llm/codex";
import { resumeLlmConfig } from "../llm/resumeConfig";
import { assignTiers, pickTreatment, estimateUsd } from "./tiers";
import { consumeResumeMeta, generateResume, generateExtras, wantsCoverLetter } from "./generate";
import { truthCheck } from "./truth";
import { fitPages } from "./latex";
import { asResumeFormat, readBaseTex, resumeBase } from "../profile/format";
import { writeDocx } from "./docx";
import { diffAgainstBase } from "./diff";
import { jobOutDir } from "./artifacts";
import type { SourceRef, Tier } from "./types";
import { tailorOneJob } from "./run";

export const OUT_DIR = resumeLlmConfig().outputDirectory;
const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

/**
 * Tailors every eligible job (scored, open, takeable, composite ≥ cutoff, not yet tailored), best first.
 * With jobIds, tailors only those jobs and skips the score cutoff.
 * Checks the budget before each OpenRouter job; stops cleanly when it's reached, or after 3 errors in a row.
 * Default resume provider is Codex CLI (see RESUME_LLM_PROVIDER); OpenRouter remains for other LLM tasks.
 */
export async function tailorPending(opts: {
  limit?: number;
  /** Only these jobs, whatever their score: Ryan picked them himself. */
  jobIds?: number[];
  generator?: { resume: typeof generateResume; extras: typeof generateExtras };
} = {}) {
  const gen = opts.generator ?? { resume: generateResume, extras: generateExtras };
  const cfg = await loadSettings();
  const llm = resumeLlmConfig();
  const rows = await db.select().from(jobs)
    .innerJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .leftJoin(tailorings, eq(tailorings.jobId, jobs.id))
    // Not tailored yet, or a failed attempt without a PDF that hasn't failed 3 times.
    .where(and(eq(jobs.status, "scored"), isNull(jobs.closedAt), ne(jobScores.canTake, "not_possible"),
      or(
        isNull(tailorings.jobId),
        and(isNull(tailorings.pdfPath), lt(tailorings.attempts, 3), ne(tailorings.runStatus, "running")),
        // Also pick up explicitly queued pending runs.
        eq(tailorings.runStatus, "pending"),
      )));
  const eligible = rows
    .map((r) => ({ job: r.jobs, composite: composite(r.job_scores, cfg.weights).score, attempts: r.tailorings?.attempts ?? 0 }))
    .filter((r) => (opts.jobIds ? opts.jobIds.includes(r.job.id) : r.composite >= cfg.cutoff))
    .sort((a, b) => b.composite - a.composite)
    .slice(0, opts.limit ?? 10_000);

  const [{ n: topToday }] = await db.select({ n: sql<number>`count(*)::int` }).from(tailorings)
    .where(and(eq(tailorings.tier, "top"), gte(tailorings.createdAt, startOfToday()), sql`${tailorings.pdfPath} is not null`));
  const tiers = assignTiers(eligible.map((e) => ({ id: e.job.id, composite: e.composite })), cfg, topToday);

  const result = { tailored: 0, failed: 0, stoppedForBudget: false, stoppedForErrors: false, missingTectonic: false, byTier: { top: 0, middle: 0, bottom: 0 } as Record<Tier, number> };
  if (!eligible.length) return result;
  // Without a LaTeX engine every job would pay for model calls and then fail; check once, before spending anything.
  if (!opts.generator) {
    try { await promisify(execFile)("tectonic", ["--version"]); } catch { result.missingTectonic = true; return result; }
  }

  // Production path with status/versioning: one job at a time through tailorOneJob.
  if (!opts.generator && (llm.provider === "codex_cli" || opts.jobIds?.length === 1)) {
    let consecutiveErrors = 0;
    for (const { job } of eligible) {
      const r = await tailorOneJob(job.id);
      if (r.ok) {
        result.tailored++;
        result.byTier[tiers.get(job.id) ?? "middle"]++;
        consecutiveErrors = 0;
      } else if (r.code === "budget") {
        result.stoppedForBudget = true;
        break;
      } else if (r.code === "already_running") {
        continue;
      } else {
        result.failed++;
        consecutiveErrors++;
        if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
      }
    }
    return result;
  }

  const fmt = resumeBase(asResumeFormat(cfg.resumeFormat));
  const profile = { ...(await loadProfile(fmt.format)), extraSkills: cfg.extraSkills, targetPages: fmt.maxPages };
  const baseTex = readBaseTex(fmt.format);
  let consecutiveErrors = 0;

  for (const { job, attempts } of eligible) {
    const tier = tiers.get(job.id)!;
    const { monthUsd, capUsd } = await spendSummary();
    const t = pickTreatment(tier, monthUsd / capUsd);
    const provider = llm.provider;
    if (provider === "openrouter" || opts.generator) {
      if (!(await canSpend("tailoring", estimateUsd(t)))) { result.stoppedForBudget = true; break; }
    }
    const started = new Date();
    const usdSince = async () => {
      const [r] = await db.select({ s: sql<number>`coalesce(sum(${spend.usd}), 0)` }).from(spend).where(gte(spend.at, started));
      return Number(r.s);
    };
    const save = async (v: Partial<typeof tailorings.$inferInsert>) => {
      const row = {
        jobId: job.id, tier, model: t.resumeModel ?? "base", attempts: attempts + 1, usd: await usdSince(),
        provider: opts.generator ? "openrouter" : provider,
        runStatus: "completed" as const,
        ...v,
      };
      await db.insert(tailorings).values(row).onConflictDoUpdate({ target: tailorings.jobId, set: { ...row, createdAt: new Date() } });
    };
    try {
      await db.insert(tailorings).values({
        jobId: job.id, tier, model: t.resumeModel ?? "base", provider, runStatus: "running",
        attempts: attempts + 1, startedAt: started, error: null,
      }).onConflictDoUpdate({
        target: tailorings.jobId,
        set: { runStatus: "running", startedAt: started, error: null, attempts: attempts + 1 },
      });

      const draft = await gen.resume(job, profile, t);
      const meta = consumeResumeMeta();
      const skipClaims = async () => [] as SourceRef[];
      const checked = await truthCheck(
        draft, profile, t.extrasModel,
        meta?.provider === "codex_cli" ? skipClaims : undefined,
        job.descriptionText,
      );
      // Build the PDF before paying for the cover letter, so a LaTeX failure doesn't cost that call.
      let fit: { resume: typeof checked.resume; pdfPath: string };
      try {
        const outDir = jobOutDir(job.id);
        fit = await fitPages(checked.resume, profile, baseTex, outDir, fmt.maxPages);
      } catch (e) {
        await save({
          resume: checked.resume, issues: checked.issues, error: (e as Error).message, pdfPath: null,
          runStatus: "failed", finishedAt: new Date(),
        });
        result.failed++; consecutiveErrors++;
        if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
        continue;
      }
      let docxPath: string | null = null;
      try { docxPath = await writeDocx(fit.resume, profile, jobOutDir(job.id)); } catch { /* optional */ }
      const extras = await gen.extras(job, profile, t, { coverLetter: wantsCoverLetter(job), insights: false });
      await save({
        resume: fit.resume, issues: checked.issues, diff: diffAgainstBase(fit.resume, profile),
        coverLetter: extras.coverLetter, pdfPath: fit.pdfPath, docxPath, error: null,
        changelog: meta?.changelog ?? null,
        gapReport: meta?.gaps?.length ? meta.gaps : null,
        provider: meta?.provider ?? provider,
        model: meta?.model ?? (t.resumeModel ?? "base"),
        runStatus: "completed", finishedAt: new Date(),
        meta: { requirements: meta?.requirements ?? [], fitSummary: meta?.fitSummary ?? "" },
      });
      result.tailored++; result.byTier[tier]++; consecutiveErrors = 0;
    } catch (e) {
      if (e instanceof BudgetExceededError) { result.stoppedForBudget = true; break; }
      result.failed++; consecutiveErrors++;
      const msg = e instanceof CodexCliError ? e.message : (e as Error).message;
      await save({ error: msg.slice(0, 300), pdfPath: null, runStatus: "failed", finishedAt: new Date() });
    }
    if (consecutiveErrors >= 3) { result.stoppedForErrors = true; break; }
  }
  return result;
}
