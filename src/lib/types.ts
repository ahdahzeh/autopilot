export type Job = {
  id: string;
  name: string;
  company: string;
  role: string;
  location: string;
  industry: string;
  companySize: string;
  source: string;
  status: string;
  outcome: string;
  priority: string;
  matchScore: number | null;
  tailorScore: number | null;
  tailorReasoning: string;
  salaryRange: string;
  dateFound: string | null;
  dateApplied: string | null;
  responseDate: string | null;
  applyLink: string;
  daysSinceApplied: number | null;
  description: string;
};

export type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";
