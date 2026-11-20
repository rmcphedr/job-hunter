import { describe, expect, test } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderDocxXml, writeDocx } from "@/tailor/docx";
import { baseResume } from "@/tailor/truth";
import { parseResumeFile } from "@/profile/load";

describe("docx", () => {
  test("renders ATS-friendly XML with name and roles", () => {
    const p = parseResumeFile();
    const xml = renderDocxXml(baseResume(p), p);
    expect(xml).toContain(p.name);
    expect(xml).toContain(p.roles[0].title);
    expect(xml).toContain("<w:document");
  });

  test("writes a zip-based .docx file", async () => {
    const p = parseResumeFile();
    const dir = await mkdtemp(join(tmpdir(), "docx-"));
    const path = await writeDocx(baseResume(p), p, dir);
    const buf = await readFile(path);
    expect(buf[0]).toBe(0x50); // P
    expect(buf[1]).toBe(0x4b); // K — ZIP magic
    expect(path.endsWith("resume.docx")).toBe(true);
  });
});
