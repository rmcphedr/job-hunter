export type BaseProfile = {
  name: string;
  headline: string;
  links: string[];
  roles: { title: string; org: string; dates: string; bullets: string[] }[];
  quote?: string;
  projects: { name: string; text: string }[];
  skills: Record<string, string[]>;
  /** Skills you have really used that don't fit on the one-page resume. Tailoring may add up to 4 when a job asks. */
  extraSkills?: string[];
  education: { degree: string; school: string; dates: string; coursework: string[] }[];
  awards: { name: string; text: string }[];
  /** Personal facts the resume doesn't carry. Set in parseLatex.ts. */
  facts: { citizenship: string; location: string; yearsExperience: number };
};
