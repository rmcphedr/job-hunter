// Targets from job-search-agent/config/target_roles.yml and job_keywords.yaml: data / ML / applied AI scientist and engineer roles,
// research scientist and engineer, bioinformatics / computational biology / neuroscience, AI automation and scientific consulting.
const INCLUDE = /\b(data scien\w*|scientist|machine learning|ml|mlops|ai|artificial intelligence|deep learning|llm|nlp|computer vision|research engineer|applied research\w*|researcher|bioinformatic\w*|computational|neuro\w*|biostatistic\w*|statistician|ai engineer|automation engineer|forward[- ]deployed|(?:scientific|data|ai|behavioral[- ]data|research) consultant)\b/i;
const EXCLUDE = /\b(intern|internship|co-?op|new grad|staff|principal|director|vp|vice president|head of|manager|sales|account executive|recruit\w*|designer|qa|tester|support|technician|mechanical|electrical|civil|hardware|manufacturing|antenna|rf|chemical|structural|optical|mechatronics|process engineer|field service|finance|accounting|accountant|human resources|legal counsel|business development)\b/i;
// PhD and postdoc years count (profile.yml), so only 10+ year requirements are dropped.
const TOO_SENIOR = /\b(1\d)\+?\s*(years|yrs)\s+(of\s+)?(professional\s+|relevant\s+|industry\s+|hands-on\s+|post-?graduate\s+)?(software\s+|engineering\s+|development\s+|data science\s+|machine learning\s+|ml\s+|research\s+)?(experience|exp)\b/i;
// "Member of Technical Staff" is the standard engineer title at AI labs, not a staff-level role.
const TECH_STAFF = /\btechnical staff\b/i;

/** Free, code-only filter that drops obvious non-matches before any paid scoring call. */
export function prefilter(j: { title: string; descriptionText: string }): { pass: true } | { pass: false; reason: string } {
  const techStaff = TECH_STAFF.test(j.title);
  if (!INCLUDE.test(j.title) && !techStaff) return { pass: false, reason: "not a target role" };
  const ex = j.title.replace(TECH_STAFF, " ").match(EXCLUDE);
  if (ex) return { pass: false, reason: `excluded title: ${ex[1].toLowerCase()}` };
  if (TOO_SENIOR.test(j.descriptionText)) return { pass: false, reason: "requires 10+ years" };
  return { pass: true };
}
