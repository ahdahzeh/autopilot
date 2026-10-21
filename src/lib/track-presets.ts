// Per Scholas NY cohort presets.
//
// A cohort member signs up with one of these codes and the whole targeting
// half of onboarding is answered for them: redeem_invite_code() copies the
// `profile` object below onto their profile row, and onboarding skips every
// step those fields cover (see STEP_PREREQS in src/app/onboarding/page.tsx).
// Settings also offers these presets when an admin mints a new code.
//
// KEEP IN SYNC with supabase/migrations/020_multi_use_invites.sql. The
// migration seeds the three codes with these same objects as
// invite_codes.prefilled_profile, key for key and value for value. Change a
// title here and change it there in the same commit.

// The subset of profile columns an invite may prefill. Must stay within the
// whitelist in invite_prefilled_fields() (migration 020); anything outside
// it is ignored by redeem_invite_code().
export type InvitePrefill = {
  role_family: string;
  target_titles: string[];
  target_locations: string[];
  salary_floor: number;
  daily_job_limit: number;
  sources: string[];
  priority_industries: string[];
  excluded_titles: string[];
};

export type TrackPreset = {
  // The shared invite code, also the key in TRACK_PRESETS.
  code: string;
  // Shown at signup ("Invite accepted") and on the onboarding review step.
  label: string;
  profile: InvitePrefill;
};

// Per Scholas NY places graduates in New York City or US-remote roles.
const COHORT_LOCATIONS = ["New York, NY", "Remote"];

// Every source with a scraper module, LinkedIn last because it is the
// slowest and most often throttled (same convention as onboarding).
const COHORT_SOURCES = ["hiringcafe", "builtin", "greenhouse", "lever", "ashby", "workday", "linkedin"];

// The scraper drops a job when its title contains any of these as a
// case-insensitive substring, with no word boundaries
// (JobListing.is_excluded_title in scraper/models.py). Entry-level graduates
// should not see the senior tier of their own track, but every entry has to
// be long enough not to swallow an entry-level title by accident: "vp" would
// also match "VPN Support Technician", so it is spelled out.
const ENTRY_LEVEL_EXCLUDED_TITLES = [
  "senior", "sr.", "lead", "principal", "staff", "manager",
  "director", "head of", "chief", "vice president", "architect",
];

// salary_floor stays 0 so entry-level roles are not hidden, and the daily
// limit is 20 (the cap everyone in the cohort gets).
const COHORT_PIPELINE = { salary_floor: 0, daily_job_limit: 20 };

export const TRACK_PRESETS: Record<string, TrackPreset> = {
  "PSNY-IT": {
    code: "PSNY-IT",
    label: "AI-Enabled Healthcare IT Technician",
    profile: {
      // Help desk and desktop support are not one of the onboarding
      // families (design, engineering, product, data, marketing, ops), and
      // the value only drives placeholder copy, so "other" is the honest fit.
      role_family: "other",
      target_titles: [
        "IT Support Specialist", "Help Desk Technician", "Service Desk Analyst",
        "Desktop Support Technician", "Healthcare IT Support Specialist",
        "EHR Support Analyst", "Technical Support Specialist", "IT Technician",
      ],
      target_locations: COHORT_LOCATIONS,
      ...COHORT_PIPELINE,
      sources: COHORT_SOURCES,
      priority_industries: ["Healthcare", "Hospitals and health systems", "Health IT", "Managed IT services"],
      excluded_titles: ENTRY_LEVEL_EXCLUDED_TITLES,
    },
  },
  "PSNY-CYBER": {
    code: "PSNY-CYBER",
    label: "Cybersecurity with AI Tools",
    profile: {
      role_family: "other",
      target_titles: [
        "SOC Analyst", "Junior Cybersecurity Analyst", "Information Security Analyst",
        "Cybersecurity Analyst", "Security Operations Analyst", "IT Security Specialist",
        "GRC Analyst", "Vulnerability Management Analyst",
      ],
      target_locations: COHORT_LOCATIONS,
      ...COHORT_PIPELINE,
      sources: COHORT_SOURCES,
      priority_industries: ["Cybersecurity", "Financial services", "Healthcare", "Managed security services", "Government and public sector"],
      excluded_titles: ENTRY_LEVEL_EXCLUDED_TITLES,
    },
  },
  "PSNY-DATA": {
    code: "PSNY-DATA",
    label: "AI-Native Business Intelligence",
    profile: {
      role_family: "data",
      target_titles: [
        "Business Intelligence Analyst", "Data Analyst", "Junior Data Analyst",
        "Reporting Analyst", "BI Developer", "Power BI Developer",
        "Data Analytics Associate", "SQL Analyst",
      ],
      target_locations: COHORT_LOCATIONS,
      ...COHORT_PIPELINE,
      sources: COHORT_SOURCES,
      priority_industries: ["Financial services", "Healthcare", "Retail and e-commerce", "Media", "Technology"],
      excluded_titles: ENTRY_LEVEL_EXCLUDED_TITLES,
    },
  },
};

export const TRACK_PRESET_LIST: TrackPreset[] = Object.values(TRACK_PRESETS);

export function getTrackPreset(code: string | null | undefined): TrackPreset | null {
  if (!code) return null;
  return TRACK_PRESETS[code.trim().toUpperCase()] ?? null;
}
