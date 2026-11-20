import { TypeSafeClient, score, choice } from "@typesafe-ai/sdk";
import { canSpend, recordSpend } from "../budget/budget";
import { BudgetExceededError } from "../llm/openrouter";
import { buildScoringState } from "./state";
import type { DimensionScores, Feasibility, Scorer } from "./types";

const questions = {
  scope: score(
    "How much of this job (`job`) is the kind of work the candidate wants: applied ML / data science, AI or research scientist or engineer roles, computational biology or neuroscience, LLM/NLP/vision product work, MLOps, or AI automation and scientific consulting?",
    [
      "No ML, data science, research, or AI engineering work (or that work is incidental)",
      "Adjacent quantitative or software work with little ML/AI or scientific research content (e.g. pure backend, general analytics without modeling)",
      "Some ML, data, or research content mixed with a lot of unrelated work",
      "Clear applied ML, data science, research engineer/scientist, or AI product role with meaningful modeling or scientific work",
      "Core applied ML / research scientist / AI engineer role aligned with his targets (LLMs, multimodal, computational biology/neuroscience, evaluation, or AI automation)",
    ],
  ),
  company: score(
    "Based only on what the listing (`job`) reveals, how strong does the hiring company look as an employer?",
    [
      "No information, or warning signs (vague company, agency reselling candidates, unclear product)",
      "Small or unknown company with little evidence of traction",
      "Real company with a clear product and some traction or funding",
      "Well-funded or clearly growing company with a strong product (e.g. notable investors, known customers)",
      "Top-tier or category-leading company, or a startup backed by top investors with strong momentum",
    ],
  ),
  pay: score(
    "How good is the posted pay (`job.salary`) compared with typical pay for this role in the job's own local market (the job's country, or the hiring company's market for remote roles)? If the salary is not posted, answer level 1.",
    [
      "Well below the local market for this role",
      "Below market, or salary not posted",
      "Around the local market rate",
      "Above the local market rate",
      "Top of the local market for this role",
    ],
  ),
  level: score(
    "How well does the seniority this job asks for match the candidate (`candidate`: about 8 years of relevant experience including a PhD in neuroscience, a Mila/McGill postdoc, and independent AI consulting — not a junior founding engineer)?",
    [
      "Far off: staff/principal/director with 12+ years required, or an internship / new-grad role far below him",
      "Somewhat too senior (asks for ~10–12 years or a staff bar he is unlikely to clear) or clearly junior-only",
      "Stretch but plausible (asks for ~8–10 years, or a slightly junior applied role he would still do well in)",
      "Good match: mid-to-senior applied scientist / ML engineer / research engineer open to PhD + postdoc backgrounds",
      "Exact match: research or applied ML scientist / AI engineer pitched at PhD or postdoc level, or explicitly open to strong researcher–engineer hybrids with ~5–10 years",
    ],
  ),
  fit: score(
    "How well does the candidate's real experience (`candidate.roles`, `candidate.projects`, `candidate.skills` — ML pipelines, fMRI/time-series, NLP/BERT, evaluation, agentic AI tooling, scientific collaboration) match what this job (`job.description`) requires?",
    [
      "Requires core skills he does not have at all",
      "Matches a few requirements but misses several core ones",
      "Matches about half of the core requirements",
      "Matches most core requirements with directly relevant shipped or research work",
      "His work maps directly onto nearly every requirement",
    ],
  ),
  canTake: choice(
    // Choice keys keep their original names because they are stored in the database enum:
    // in_egypt = in the candidate's home country (Canada), remote_from_egypt = remote and open to someone working from Canada.
    "Can the candidate (`candidate.citizenship`: lives in Montreal, Canada and is authorized to work in Canada only, willing to relocate per `candidate.relocation`) actually take this job (`job`)?",
    {
      in_egypt: "The job is located in Canada (on-site or hybrid anywhere in Canada), so no visa is needed",
      remote_from_egypt: "The job is remote and open to people working from Canada (Canada, North America, Americas, worldwide, or no location restriction; US-based remote only if it says it hires in Canada or via contractor/EOR)",
      sponsors: "The job is outside Canada and he can get there: on-site or hybrid elsewhere and the listing explicitly says they sponsor visas or relocate people",
      unclear: "Not enough information to tell whether someone in Canada can take it",
      not_possible: "Restricted to a region excluding Canada (e.g. US-only remote, on-site in the US, UK or EU without explicit sponsorship, must already have work authorization there, or explicitly no sponsorship)",
    },
  ),
} as const;

const norm = (s: number) => Math.round((s / 4) * 1000) / 10;

export function makeJevScorer(): Scorer {
  const client = new TypeSafeClient();
  const pin = Number(process.env.JEV_USD_PER_MTOK_INPUT ?? "0.042");
  const pout = Number(process.env.JEV_USD_PER_MTOK_OUTPUT ?? "0");
  const estimate = 0.0003;
  return {
    engine: "jev",
    estimateUsd: () => estimate,
    async score(job, profile): Promise<DimensionScores> {
      if (!(await canSpend("scoring", estimate))) throw new BudgetExceededError("scoring");
      const res = await client.systemOne({ state: buildScoringState(job, profile), questions });
      const inTok = res.usage?.input_tokens, outTok = res.usage?.output_tokens;
      // If usage isn't reported, charge the estimate so the budget cap still holds.
      const usd = inTok == null ? estimate : Math.max((inTok * pin + (outTok ?? 0) * pout) / 1e6, 0);
      await recordSpend({
        category: "scoring", provider: "typesafe", model: res.model,
        usd, inputTokens: inTok ?? 0, outputTokens: outTok ?? 0,
      });
      const a = res.answers;
      return {
        scope: norm(a.scope.score), company: norm(a.company.score), pay: norm(a.pay.score),
        level: norm(a.level.score), fit: norm(a.fit.score),
        canTake: a.canTake.choice as Feasibility, canTakeConfidence: a.canTake.confidence,
        raw: a,
      };
    },
  };
}
