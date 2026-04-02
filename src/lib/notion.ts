import { Client } from "@notionhq/client";

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const DATA_SOURCE_ID = process.env.NOTION_DATA_SOURCE_ID!;

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

function getPlainText(prop: unknown): string {
  const p = prop as { type: string; rich_text?: Array<{ plain_text: string }>; title?: Array<{ plain_text: string }> };
  if (p.type === "title" && p.title?.length) return p.title[0].plain_text;
  if (p.type === "rich_text" && p.rich_text?.length) return p.rich_text[0].plain_text;
  return "";
}

function getSelect(prop: unknown): string {
  const p = prop as { select?: { name: string } | null };
  return p.select?.name ?? "";
}

function getNumber(prop: unknown): number | null {
  const p = prop as { number?: number | null };
  return p.number ?? null;
}

function getCheckbox(prop: unknown): boolean {
  const p = prop as { checkbox?: boolean };
  return p.checkbox ?? false;
}

function getDate(prop: unknown): string | null {
  const p = prop as { date?: { start?: string } | null };
  return p.date?.start ?? null;
}

function getUrl(prop: unknown): string {
  const p = prop as { url?: string | null };
  return p.url ?? "";
}

function getFormula(prop: unknown): number | null {
  const p = prop as { formula?: { type: string; number?: number | null } };
  if (p.formula?.type === "number") return p.formula.number ?? null;
  return null;
}

export async function fetchJobs(): Promise<Job[]> {
  const pages: Job[] = [];
  let startCursor: string | undefined = undefined;
  let hasMore = true;

  while (hasMore) {
    const response = await notion.dataSources.query({
      data_source_id: DATA_SOURCE_ID,
      page_size: 100,
      ...(startCursor ? { start_cursor: startCursor } : {}),
    });

    for (const page of response.results) {
      if (!("properties" in page)) continue;
      const props = page.properties;

      pages.push({
        id: page.id,
        name: getPlainText(props["Name"]),
        company: getPlainText(props["Company"]),
        role: getPlainText(props["Role"]),
        location: getPlainText(props["Location"]),
        industry: getPlainText(props["Industry"]),
        companySize: getSelect(props["Company Size"]),
        source: getSelect(props["Source"]),
        status: getSelect(props["Status"]),
        outcome: getSelect(props["Outcome"]),
        priority: getSelect(props["Priority"]),
        matchScore: getNumber(props["Match Score"]),
        salaryRange: getPlainText(props["Salary Range"]),
        salaryFloorMet: getCheckbox(props["Salary Floor Met"]),
        foundingRole: getCheckbox(props["Founding Role"]),
        resumeVariant: getSelect(props["Resume Variant"]),
        coverLetterRating: getSelect(props["Cover Letter Rating"]),
        dateFound: getDate(props["Date Found"]),
        dateApplied: getDate(props["Date Applied"]),
        responseDate: getDate(props["Response Date"]),
        applyLink: getUrl(props["Apply Link"]),
        daysSinceApplied: getFormula(props["Days Since Applied"]),
      });
    }

    hasMore = response.has_more;
    startCursor = response.next_cursor ?? undefined;
  }

  return pages;
}

export type DismissReason = "expired" | "scam" | "not_interested" | "applied_elsewhere";

const DISMISS_MAP: Record<DismissReason, { status: string; outcome: string; note: string }> = {
  expired: { status: "Rejected", outcome: "No Response", note: "Dismissed: Expired" },
  scam: { status: "Rejected", outcome: "Rejected", note: "Dismissed: Scam" },
  not_interested: { status: "Rejected", outcome: "Declined", note: "Dismissed: Not Interested" },
  applied_elsewhere: { status: "Applied", outcome: "", note: "Applied through different channel" },
};

export async function dismissJob(pageId: string, reason: DismissReason): Promise<void> {
  const mapping = DISMISS_MAP[reason];

  await notion.pages.update({
    page_id: pageId,
    properties: {
      Status: { select: { name: mapping.status } },
      Notes: { rich_text: [{ text: { content: mapping.note } }] },
      ...(mapping.outcome ? { Outcome: { select: { name: mapping.outcome } } } : {}),
    },
  });
}
