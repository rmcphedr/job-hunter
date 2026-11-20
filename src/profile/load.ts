import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { profile } from "../db/schema";
import { parseResumeTex } from "./parseLatex";
import { readBaseTex, resumeBase, type ResumeFormat } from "./format";
import type { BaseProfile } from "./types";

/** Parses the master resume for a format: resume.tex (two_page, default) or resume-1page.tex (one_page). */
export function parseResumeFile(format: ResumeFormat = "two_page"): BaseProfile {
  return parseResumeTex(readBaseTex(format));
}

export async function saveProfile(p: BaseProfile, format: ResumeFormat = "two_page"): Promise<void> {
  const id = resumeBase(format).profileId;
  await db.insert(profile).values({ id, data: p })
    .onConflictDoUpdate({ target: profile.id, set: { data: p, updatedAt: new Date() } });
}

/** Returns the saved profile for a format; on first use parses its resume file and saves it. */
export async function loadProfile(format: ResumeFormat = "two_page"): Promise<BaseProfile> {
  const [row] = await db.select().from(profile).where(eq(profile.id, resumeBase(format).profileId));
  if (row) return row.data as BaseProfile;
  const p = parseResumeFile(format);
  await saveProfile(p, format);
  return p;
}
