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
  salaryRange: string;
  salaryFloorMet: boolean;
  foundingRole: boolean;
  resumeVariant: string;
  coverLetterRating: string;
  dateFound: string | null;
  dateApplied: string | null;
  responseDate: string | null;
  applyLink: string;
  daysSinceApplied: number | null;
};

export type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";
