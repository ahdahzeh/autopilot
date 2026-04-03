import type { Job } from "@/lib/types";

// Map Supabase row to Job type used by analytics and components
export function mapRow(row: Record<string, unknown>): Job {
  return {
    id: row.id as string,
    name: (row.company as string) || "",
    company: (row.company as string) || "",
    role: (row.role as string) || "",
    location: (row.location as string) || "",
    industry: (row.industry as string) || "",
    companySize: (row.company_size as string) || "",
    source: (row.source as string) || "",
    status: (row.status as string) || "",
    outcome: (row.outcome as string) || "",
    priority: (row.priority as string) || "",
    matchScore: (row.match_score as number) ?? null,
    salaryRange: (row.salary_range as string) || "",
    salaryFloorMet: true,
    foundingRole: (row.founding_role as boolean) || false,
    resumeVariant: "",
    coverLetterRating: "",
    dateFound: (row.date_found as string) ?? null,
    dateApplied: (row.date_applied as string) ?? null,
    responseDate: (row.response_date as string) ?? null,
    applyLink: (row.apply_link as string) || "",
    daysSinceApplied: null,
  };
}
