import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { resumeLlmConfig } from "../llm/resumeConfig";
import { safeJoin } from "../llm/codex";

/** Absolute output directory for a job's current resume artifacts. */
export function jobOutDir(jobId: number): string {
  return safeJoin(resumeLlmConfig().outputDirectory, String(jobId));
}

/**
 * Archive the current generation into versions/v{N}/ before regenerating.
 * Does not modify the master resume.tex.
 */
export async function archiveCurrentVersion(jobId: number, version: number): Promise<string | null> {
  const current = jobOutDir(jobId);
  const dest = safeJoin(current, path.join("versions", `v${version}`));
  try {
    await mkdir(path.dirname(dest), { recursive: true });
    await cp(current, dest, {
      recursive: true,
      filter: (src) => !src.includes(`${path.sep}versions${path.sep}`),
    });
    return dest;
  } catch {
    return null;
  }
}

/** Clear current artifact files (not versions/) before a new generation. */
export async function clearCurrentArtifacts(jobId: number): Promise<void> {
  const dir = jobOutDir(jobId);
  for (const name of ["resume.pdf", "resume.tex", "resume.docx", "meta.json"]) {
    await rm(safeJoin(dir, name), { force: true }).catch(() => {});
  }
}
