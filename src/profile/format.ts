import { readFileSync } from "node:fs";
import path from "node:path";

/** Which master resume tailoring starts from. two_page (default) is resume.tex; one_page is resume-1page.tex. */
export type ResumeFormat = "two_page" | "one_page";
export const RESUME_FORMATS: ResumeFormat[] = ["two_page", "one_page"];

export function asResumeFormat(v: unknown): ResumeFormat {
  return v === "one_page" ? "one_page" : "two_page";
}

/** Template file, page limit and profile row for a format. Neither base is ever trimmed below its own length. */
export function resumeBase(format: ResumeFormat) {
  const env = format === "one_page" ? process.env.RESUME_ONE_PAGE_TEMPLATE_PATH : process.env.RESUME_TEMPLATE_PATH;
  const file = env?.trim() || (format === "one_page" ? "resume-1page.tex" : "resume.tex");
  return {
    format,
    templatePath: path.isAbsolute(file) ? file : path.join(process.cwd(), file),
    maxPages: format === "one_page" ? 1 : 2,
    /** profile table row: 1 = two-page base (editable in Settings), 2 = one-page base. */
    profileId: format === "one_page" ? 2 : 1,
    label: format === "one_page" ? "One page" : "Two pages",
  };
}

export function readBaseTex(format: ResumeFormat): string {
  return readFileSync(resumeBase(format).templatePath, "utf8");
}
