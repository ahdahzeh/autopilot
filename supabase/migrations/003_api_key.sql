-- Migration 003: Anthropic API key for AI tailoring

alter table public.profiles
  add column if not exists anthropic_api_key text not null default '';
