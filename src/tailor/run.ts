import { eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, jobScores, spend, tailorings } from "../db/schema";
import { loadSettings } from "../config";
import { loadProfile } from "../profile/load";
import { canSpend, spendSummary } from "../budget/budget";
import { BudgetExceededError } from "../llm/openrouter";
import { CodexCliError } from "../llm/codex";
import { resumeLlmConfig } from "../llm/resumeConfig";
import { pickTreatment, estimateUsd } from "./tiers";
import { consumeResumeMeta, generateExtras, generateResume, wantsCoverLetter } from "./generate";
import { truthCheck } from "./truth";
import { fitPages } from "./latex";
import { asResumeFormat, readBaseTex, resumeBase } from "../profile/format";
import { writeDocx } from "./docx";
import { diffAgainstBase } from "./diff";
import { archiveCurrentVersion, clearCurrentArtifacts, jobOutDir } from "./artifacts";
import type { SourceRef, TailoredResume } from "./types";

const controllers = new Map<number, AbortController>();

export type TailorOneResult =
  | { ok: true; jobId: number; version: number; provider: string; pdfPath: string; docxPath: string | null }
  | { ok: false; jobId: number; error: string; code?: string };

/** True when another tailor run is already in flight for this job. */
export async function isTailorRunning(jobId: number): Promise<boolean> {
  if (controllers.has(jobId)) return true;
  const [row] = await db.select({ s: tailorings.runStatus }).from(tailorings).where(eq(tailorings.jobId, jobId));
  return row?.s === "running" || row?.s === "pending";
}

/** Cancel an in-flight Codex/OpenRouter tailor run for this job. */
export async function cancelTailor(jobId: number): Promise<boolean> {
  const c = controllers.get(jobId);
  if (c) {
    c.abort();
    controllers.delete(jobId);
  }
  const [row] = await db.select().from(tailorings).where(eq(tailorings.jobId, jobId));
  if (row && (row.runStatus === "pending" || row.runStatus === "running")) {
    await db.update(tailorings).set({
      runStatus: "cancelled",
      error: "Cancelled",
      finishedAt: new Date(),
    }).where(eq(tailorings.jobId, jobId));
    return true;
  }
  return !!c;
}

/**
 * Tailor a single job with status tracking, versioning, and provider selection.
 * Prevents concurrent runs for the same job. Does not submit an application.
 */
export async function tailorOneJob(jobId: number, opts: {
  regenerate?: boolean;
  forceProvider?: "codex_cli" | "openrouter";
  /** Worker claiming a pending row; skips the pending duplicate check. */
  claimPending?: boolean;
} = {}): Promise<TailorOneResult> {
  if (controllers.has(jobId)) {
    return { ok: false, jobId, error: "A resume is already being tailored for this job.", code: "already_running" };
  }

  const [row] = await db.select({ job: jobs, score: jobScores, t: tailorings }).from(jobs)
    .leftJoin(jobScores, eq(jobScores.jobId, jobs.id))
    .leftJoin(tailorings, eq(tailorings.jobId, jobs.id))
    .where(eq(jobs.id, jobId));
  if (!row?.job) return { ok: false, jobId, error: "This job no longer exists." };
  if (!row.score || row.job.status !== "scored") {
    return { ok: false, jobId, error: "This job hasn't been scored yet." };
  }
  if (row.t?.runStatus === "running") {
    return { ok: false, jobId, error: "A resume is already being tailored for this job.", code: "already_running" };
  }
  if (row.t?.runStatus === "pending" && !opts.claimPending) {
    return { ok: false, jobId, error: "A resume is already being tailored for this job.", code: "already_running" };
  }

  const cfg = await loadSettings();
  const llm = resumeLlmConfig();
  const provider = opts.forceProvider ?? llm.provider;
  const { monthUsd, capUsd } = await spendSummary();
  const treatment = pickTreatment("middle", monthUsd / capUsd);
  if (provider === "codex_cli") {
    treatment.resumeModel = "codex_cli";
  }

  // OpenRouter budget only applies when that provider will be used for the rewrite.
  if (provider === "openrouter") {
    if (!(await canSpend("tailoring", estimateUsd(treatment)))) {
      return { ok: false, jobId, error: "The monthly OpenRouter budget is used up.", code: "budget" };
    }
  }

  const priorVersion = row.t?.version ?? 0;
  const nextVersion = row.t?.pdfPath ? priorVersion + 1 : Math.max(1, priorVersion || 1);
  if (row.t?.pdfPath) {
    await archiveCurrentVersion(jobId, priorVersion || 1);
  }

  const controller = new AbortController();
  controllers.set(jobId, controller);
  const started = new Date();
  const attempts = (row.t?.attempts ?? 0) + 1;

  await db.insert(tailorings).values({
    jobId,
    tier: treatment.tier,
    model: provider === "codex_cli" ? "codex_cli" : (treatment.resumeModel ?? "base"),
    provider,
    runStatus: "running",
    version: nextVersion,
    attempts,
    startedAt: started,
    finishedAt: null,
    error: null,
    pdfPath: null,
    docxPath: null,
  }).onConflictDoUpdate({
    target: tailorings.jobId,
    set: {
      tier: treatment.tier,
      model: provider === "codex_cli" ? "codex_cli" : (treatment.resumeModel ?? "base"),
      provider,
      runStatus: "running",
      version: nextVersion,
      attempts,
      startedAt: started,
      finishedAt: null,
      error: null,
      // Keep prior resume visible until the new one succeeds.
    },
  });

  const usdSince = async () => {
    const [r] = await db.select({ s: sql<number>`coalesce(sum(${spend.usd}), 0)` }).from(spend).where(gte(spend.at, started));
    return Number(r.s);
  };

  try {
    await clearCurrentArtifacts(jobId);
    const fmt = resumeBase(asResumeFormat(cfg.resumeFormat));
    const profile = { ...(await loadProfile(fmt.format)), extraSkills: cfg.extraSkills, targetPages: fmt.maxPages };
    const baseTex = readBaseTex(fmt.format);

    const draft = await generateResume(row.job, profile, treatment, {
      signal: controller.signal,
      forceProvider: provider,
    });
    const meta = consumeResumeMeta();

    // Skip paid claim-check when Codex produced the rewrite (deterministic checks still run).
    const skipClaims = async () => [] as SourceRef[];
    const checked = await truthCheck(
      draft,
      profile,
      treatment.extrasModel,
      meta?.provider === "codex_cli" ? skipClaims : undefined,
      row.job.descriptionText,
    );

    const outDir = jobOutDir(jobId);
    const fit = await fitPages(checked.resume, profile, baseTex, outDir, fmt.maxPages);
    let docxPath: string | null = null;
    try {
      docxPath = await writeDocx(fit.resume, profile, outDir);
    } catch {
      docxPath = null;
    }

    // Cover letter still uses OpenRouter when the listing asks; failures don't fail the whole run.
    let coverLetter: string | null = null;
    if (wantsCoverLetter(row.job) && provider === "openrouter") {
      try {
        const extras = await generateExtras(row.job, profile, treatment, { coverLetter: true, insights: false });
        coverLetter = extras.coverLetter;
      } catch { /* keep resume even if cover letter fails */ }
    } else if (wantsCoverLetter(row.job) && llm.openRouterFallback) {
      try {
        const extras = await generateExtras(row.job, profile, treatment, { coverLetter: true, insights: false });
        coverLetter = extras.coverLetter;
      } catch { /* optional */ }
    }

    const gapReport = meta?.gaps?.length ? meta.gaps : (row.t?.gapReport ?? null);
    await db.update(tailorings).set({
      runStatus: "completed",
      resume: fit.resume,
      issues: checked.issues,
      diff: diffAgainstBase(fit.resume, profile),
      changelog: meta?.changelog ?? null,
      gapReport,
      coverLetter,
      pdfPath: fit.pdfPath,
      docxPath,
      provider: meta?.provider ?? provider,
      model: meta?.model ?? (provider === "codex_cli" ? "codex_cli" : treatment.resumeModel ?? "base"),
      usd: await usdSince(),
      error: null,
      finishedAt: new Date(),
      meta: {
        requirements: meta?.requirements ?? [],
        fitSummary: meta?.fitSummary ?? "",
        version: nextVersion,
      },
    }).where(eq(tailorings.jobId, jobId));

    return { ok: true, jobId, version: nextVersion, provider: meta?.provider ?? provider, pdfPath: fit.pdfPath, docxPath };
  } catch (e) {
    if (controller.signal.aborted) {
      await db.update(tailorings).set({
        runStatus: "cancelled",
        error: "Cancelled",
        finishedAt: new Date(),
        usd: await usdSince(),
      }).where(eq(tailorings.jobId, jobId));
      return { ok: false, jobId, error: "Cancelled", code: "cancelled" };
    }
    if (e instanceof BudgetExceededError) {
      await db.update(tailorings).set({
        runStatus: "failed",
        error: e.message.slice(0, 300),
        finishedAt: new Date(),
        usd: await usdSince(),
      }).where(eq(tailorings.jobId, jobId));
      return { ok: false, jobId, error: e.message, code: "budget" };
    }
    const msg = e instanceof CodexCliError ? e.message : (e as Error).message;
    const code = e instanceof CodexCliError ? e.code : "failed";
    await db.update(tailorings).set({
      runStatus: "failed",
      error: msg.slice(0, 500),
      finishedAt: new Date(),
      pdfPath: null,
      usd: await usdSince(),
      meta: e instanceof CodexCliError ? { detail: e.detail?.slice(0, 1000), code: e.code } : null,
    }).where(eq(tailorings.jobId, jobId));
    return { ok: false, jobId, error: msg, code };
  } finally {
    controllers.delete(jobId);
  }
}

/** Process jobs with run_status=pending (worker hook). */
export async function processPendingTailors(limit = 5): Promise<{ ran: number; ok: number; failed: number }> {
  const rows = await db.select({ jobId: tailorings.jobId }).from(tailorings)
    .where(inArray(tailorings.runStatus, ["pending"]))
    .limit(limit);
  let ok = 0, failed = 0;
  for (const r of rows) {
    const res = await tailorOneJob(r.jobId, { claimPending: true });
    if (res.ok) ok++; else failed++;
  }
  return { ran: rows.length, ok, failed };
}

export type { TailoredResume };
