import { test, expect } from "vitest";
import { parseResumeFile } from "@/profile/load";
import { resumeBase, readBaseTex, asResumeFormat } from "@/profile/format";
import { truthCheck, baseResume } from "@/tailor/truth";
import { renderTex } from "@/tailor/latex";

const noFlags = async () => [] as string[];

test.each(["two_page", "one_page"] as const)("%s base parses and passes the truth check unchanged", async (format) => {
  const p = parseResumeFile(format);
  expect(p.name).toBe("Ryan McPhedrain");
  expect(p.roles.length).toBeGreaterThanOrEqual(3);
  expect(p.roles.every((r) => r.bullets.length >= 2)).toBe(true);
  expect(Object.keys(p.skills).length).toBe(3);
  expect(p.facts).toEqual({ citizenship: "Canadian citizen", location: "Montreal, QC, Canada", yearsExperience: 9 });
  const { issues } = await truthCheck(baseResume(p), p, "m", noFlags);
  expect(issues).toEqual([]);
});

test("format settings: two pages by default, one page uses resume-1page.tex", () => {
  expect(asResumeFormat(undefined)).toBe("two_page");
  expect(resumeBase("two_page")).toMatchObject({ maxPages: 2, profileId: 1 });
  expect(resumeBase("one_page")).toMatchObject({ maxPages: 1, profileId: 2 });
  expect(resumeBase("one_page").templatePath).toMatch(/resume-1page\.tex$/);
});

test("rendered resumes keep the base's summary, contact line and section order", () => {
  for (const format of ["two_page", "one_page"] as const) {
    const p = parseResumeFile(format);
    const tex = renderTex(baseResume(p), p, readBaseTex(format));
    expect(tex).toContain("\\section{Summary}");
    expect(tex).toContain("236-512-2798");
    const skills = tex.indexOf("\\section{Skills}"), exp = tex.indexOf("\\section{Experience}");
    expect(format === "one_page" ? skills < exp : skills > exp).toBe(true);
  }
});
