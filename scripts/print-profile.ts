import { parseResumeFile } from "../src/profile/load";

const p = parseResumeFile();
console.log(JSON.stringify(p, null, 2));
const checks: [string, boolean][] = [
  ["name", p.name === "Ryan McPhedrain"],
  ["headline", p.headline === "Machine Learning Scientist and Applied AI Developer"],
  ["links", JSON.stringify(p.links) === JSON.stringify(["rmcphedr@gmail.com", "https://linkedin.com/in/ryanmcphedrain", "https://github.com/rmcphedr"])],
  ["orgs", JSON.stringify(p.roles.map((r) => r.org)) === JSON.stringify(["Montreal, QC", "Mila / McGill University, Montreal, QC", "The Decision Lab, Montreal, QC", "McGill University, Montreal, QC"])],
  ["bullets per role", JSON.stringify(p.roles.map((r) => r.bullets.length)) === JSON.stringify([2, 5, 3, 4])],
  ["dates", p.roles[1].dates === "2024 – 2026"],
  ["project", p.projects[0]?.name === "Agentic AI Workflow Systems (2026)"],
  ["skills", Object.keys(p.skills).length === 3 && p.skills["Machine Learning and Evaluation"]?.[0] === "Python (NumPy, pandas, SciPy, scikit-learn, PyTorch, statsmodels, XGBoost)"],
  ["education", p.education.length === 2 && p.education[0].school === "McGill University, Montreal, QC"],
  ["awards", p.awards.length === 2],
];
for (const [n, ok] of checks) console.log(ok ? "OK  " : "FAIL", n);
process.exit(checks.every(([, ok]) => ok) ? 0 : 1);
