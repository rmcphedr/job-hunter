import { test, expect } from "vitest";
import { trimOnce } from "@/tailor/latex";
import { baseResume } from "@/tailor/truth";
import { parseResumeFile } from "@/profile/load";

test("to fit one page, added extra skills go before any of his own content", () => {
  const p = { ...parseResumeFile(), extraSkills: ["Kubernetes"] };
  const r = baseResume(p);
  r.skills[0].items.push("Kubernetes");
  const t = trimOnce(r, p)!;
  expect(t.skills.flatMap((c) => c.items)).not.toContain("Kubernetes");
  expect(t.projects).toHaveLength(r.projects.length);
});
