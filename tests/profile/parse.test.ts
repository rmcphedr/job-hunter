import { test, expect } from "vitest";
import { parseResumeFile } from "@/profile/load";

test("a skill with commas inside parentheses stays one skill", () => {
  const p = parseResumeFile();
  expect(p.skills["Machine Learning and Evaluation"][0]).toBe("Python (NumPy, pandas, SciPy, scikit-learn, PyTorch, statsmodels, XGBoost)");
});
