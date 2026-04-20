-- Pre-generated resume summary used by the tailoring pipeline when the
-- raw resume_text exceeds 6000 characters. Generated once at upload time
-- so prompts get a curated highlight reel instead of a hard slice that
-- might cut a relevant role in half.

alter table public.profiles
  add column if not exists resume_summary text;
