import { readFile } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, tailorings } from "@/db/schema";
import { resumeLlmConfig } from "@/llm/resumeConfig";
import { safeJoin } from "@/llm/codex";

export async function GET(req: Request, { params }: { params: Promise<{ jobId: string }> }) {
  const { jobId } = await params;
  const id = Number(jobId);
  if (!Number.isInteger(id) || id <= 0) return new Response("Bad job id", { status: 400 });
  const [t] = await db.select({ docxPath: tailorings.docxPath, runStatus: tailorings.runStatus })
    .from(tailorings).where(eq(tailorings.jobId, id));
  if (!t?.docxPath || t.runStatus === "failed") {
    return new Response("No tailored DOCX for this job yet", { status: 404 });
  }
  let docx: Buffer;
  try {
    const root = resumeLlmConfig().outputDirectory;
    docx = await readFile(safeJoin(root, path.join(String(id), "resume.docx")));
  } catch {
    return new Response("No tailored DOCX for this job yet", { status: 404 });
  }
  const [job] = await db.select({ company: jobs.companyName }).from(jobs).where(eq(jobs.id, id));
  const company = (job?.company ?? "job").replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const download = new URL(req.url).searchParams.has("download");
  return new Response(new Uint8Array(docx), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="Resume-${company}.docx"`,
    },
  });
}
