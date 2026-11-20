import { deflateRawSync } from "node:zlib";
import { mkdir, writeFile } from "node:fs/promises";
import type { BaseProfile } from "../profile/types";
import type { TailoredResume } from "./types";
import { safeJoin } from "../llm/codex";

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function para(text: string, opts: { bold?: boolean; size?: number } = {}): string {
  const size = opts.size ?? 22; // half-points
  const bold = opts.bold ? "<w:b/>" : "";
  return `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>${bold}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p>`;
}

function bullet(text: string): string {
  return `<w:p><w:pPr><w:ind w:left="360"/><w:spacing w:after="60"/></w:pPr><w:r><w:t xml:space="preserve">• ${xmlEscape(text)}</w:t></w:r></w:p>`;
}

/** Deterministic ATS-friendly DOCX from structured resume data (not LLM-formatted). */
export function renderDocxXml(r: TailoredResume, p: BaseProfile): string {
  const parts: string[] = [];
  parts.push(para(p.name, { bold: true, size: 32 }));
  parts.push(para(r.headline, { size: 24 }));
  parts.push(para(p.links.join(" | "), { size: 18 }));
  parts.push(para("Experience", { bold: true, size: 26 }));
  for (const role of r.roles) {
    const b = p.roles[role.roleIdx];
    if (!b) continue;
    parts.push(para(`${b.title} — ${b.org} (${b.dates})`, { bold: true }));
    for (const x of role.bullets) parts.push(bullet(x.text));
  }
  if (r.projects.length) {
    parts.push(para("Projects", { bold: true, size: 26 }));
    for (const x of r.projects) {
      const name = p.projects[Number(String(x.source).slice(1))]?.name ?? "";
      parts.push(bullet(name ? `${name}: ${x.text}` : x.text));
    }
  }
  parts.push(para("Skills", { bold: true, size: 26 }));
  for (const c of r.skills) parts.push(para(`${c.category}: ${c.items.join(", ")}`));
  if (p.education.length) {
    parts.push(para("Education", { bold: true, size: 26 }));
    for (const e of p.education) {
      parts.push(para(`${e.degree} — ${e.school} (${e.dates})`, { bold: true }));
      if (e.coursework.length) parts.push(para(`Coursework: ${e.coursework.join(", ")}`));
    }
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${parts.join("\n")}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr>
  </w:body>
</w:document>`;
}

/** Minimal ZIP (stored + deflated) writer for a DOCX package. */
function zip(files: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const nameBuf = Buffer.from(f.name, "utf8");
    const raw = f.data;
    const compressed = f.store ? raw : deflateRawSync(raw);
    const method = f.store ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc >>> 0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    const localFull = Buffer.concat([local, compressed]);
    locals.push(localFull);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc >>> 0, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);
    offset += localFull.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

/** Write resume.docx under outDir (path-traversal safe). */
export async function writeDocx(r: TailoredResume, p: BaseProfile, outDir: string): Promise<string> {
  await mkdir(outDir, { recursive: true });
  const docxPath = safeJoin(outDir, "resume.docx");
  const document = renderDocxXml(r, p);
  const buf = zip([
    { name: "[Content_Types].xml", data: Buffer.from(CONTENT_TYPES, "utf8") },
    { name: "_rels/.rels", data: Buffer.from(RELS, "utf8") },
    { name: "word/document.xml", data: Buffer.from(document, "utf8") },
    { name: "word/_rels/document.xml.rels", data: Buffer.from(DOC_RELS, "utf8") },
  ]);
  await writeFile(docxPath, buf);
  return docxPath;
}
