-- Role family (design / engineering / product / data / marketing / ops / other).
-- Captured at onboarding; used to tune scraper queries and tailor copy.

alter table public.profiles
  add column if not exists role_family text;
