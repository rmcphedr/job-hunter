import { test, expect, beforeEach, afterAll, vi } from "vitest";
import { db, resetDb, closeDb } from "@/db/client";
import { jobs, spend } from "@/db/schema";
import { chatJSON } from "@/llm/openrouter";
import { makeJevScorer, parseAnswers } from "@/scoring/jev";
import { parseResumeFile } from "@/profile/load";

beforeEach(async () => { await resetDb(); vi.restoreAllMocks(); });
afterAll(async () => { await closeDb(); });

test("openrouter call without a reported cost is charged at its estimate, not $0", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: '{"ok":true}' } }],
    usage: { prompt_tokens: 100, completion_tokens: 10 },
  }), { status: 200 }));
  await chatJSON({ model: "m", system: "s", user: "u", category: "scoring", estimateUsd: 0.002 });
  const rows = await db.select().from(spend);
  expect(rows).toHaveLength(1);
  expect(rows[0].usd).toBeCloseTo(0.002, 6);
});

test("jev (OpenRouter) call without a reported cost is charged at its estimate, not $0", async () => {
  const answers = {
    scope: { score: 3 }, company: { score: 2 }, pay: { score: 1 }, level: { score: 3 }, fit: { score: 4 },
    canTake: { choice: "in_egypt", confidence: 0.9 },
  };
  const f = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
    choices: [{ message: { content: JSON.stringify(answers) } }], usage: { prompt_tokens: 3000, completion_tokens: 40 },
  }), { status: 200 }));
  const [job] = await db.insert(jobs).values({ key: "a|b", title: "Machine Learning Scientist", companyName: "A", applyUrl: "https://x" }).returning();
  const scorer = makeJevScorer();
  const s = await scorer.score(job, parseResumeFile());
  expect(s).toMatchObject({ scope: 75, company: 50, pay: 25, level: 75, fit: 100, canTake: "in_egypt", canTakeConfidence: 0.9 });
  expect(JSON.parse(String(f.mock.calls[0][1]?.body)).model).toBe(process.env.JEV_MODEL || "typesafe/jev-router");
  const rows = await db.select().from(spend);
  expect(rows).toHaveLength(1);
  expect(rows[0].provider).toBe("openrouter");
  expect(rows[0].usd).toBeCloseTo(scorer.estimateUsd(), 6);
});

test("jev answers are validated: out-of-range levels and unknown choices are rejected", () => {
  const ok = { scope: { score: 4 }, company: { score: 0 }, pay: { score: 1 }, level: { score: 2 }, fit: { score: 3 }, canTake: { choice: "unclear", confidence: 7 } };
  expect(parseAnswers(ok).canTake.confidence).toBe(1);
  expect(() => parseAnswers({ ...ok, fit: { score: 5 } })).toThrow();
  expect(() => parseAnswers({ ...ok, canTake: { choice: "anywhere", confidence: 0.5 } })).toThrow();
});
