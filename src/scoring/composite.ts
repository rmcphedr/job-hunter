import type { Weights } from "../config";
import type { Feasibility } from "./types";

type Dims = { scope: number; company: number; pay: number; level: number; fit: number; canTake: Feasibility };

/** Below this level score the seniority match is poor (for Ryan: far-off staff/12+ year bars or junior-only roles). */
export const TOO_SENIOR_LEVEL = 40;

/**
 * Weighted sum (0–100), −5 when feasibility is unclear, −25 when level is a clear mismatch
 * (a 10% weight alone let badly mismatched seniority still rank first). not_possible always sorts after everything else.
 */
export function composite(s: Dims, w: Weights): { score: number; sortGroup: 0 | 1 } {
  const total = w.scope + w.company + w.pay + w.level + w.fit || 1;
  let v = (w.scope * s.scope + w.company * s.company + w.pay * s.pay + w.level * s.level + w.fit * s.fit) / total;
  if (s.canTake === "unclear") v -= 5;
  if (s.level < TOO_SENIOR_LEVEL) v -= 25;
  return { score: Math.round(Math.max(0, Math.min(100, v))), sortGroup: s.canTake === "not_possible" ? 1 : 0 };
}
