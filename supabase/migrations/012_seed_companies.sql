-- Global seed list of well-known companies with public ATS boards.
-- Rows with user_id IS NULL are applied to every user's daily scrape.
-- If any slug 404s (company migrated ATS), the scraper logs a warning and
-- skips it — safe to let stale rows sit until someone cleans them up.
--
-- Curate by editing this file: add with an insert-on-conflict block below,
-- deactivate by setting active=false (keeps history) or delete the row.

insert into public.target_companies (user_id, ats_type, slug, name, active) values
  -- Greenhouse
  (null, 'greenhouse', 'stripe',     'Stripe',      true),
  (null, 'greenhouse', 'airbnb',     'Airbnb',      true),
  (null, 'greenhouse', 'figma',      'Figma',       true),
  (null, 'greenhouse', 'plaid',      'Plaid',       true),
  (null, 'greenhouse', 'doordash',   'DoorDash',    true),
  (null, 'greenhouse', 'reddit',     'Reddit',      true),
  (null, 'greenhouse', 'robinhood',  'Robinhood',   true),
  (null, 'greenhouse', 'affirm',     'Affirm',      true),
  (null, 'greenhouse', 'databricks', 'Databricks',  true),
  (null, 'greenhouse', 'coinbase',   'Coinbase',    true),
  (null, 'greenhouse', 'discord',    'Discord',     true),
  (null, 'greenhouse', 'instacart',  'Instacart',   true),
  (null, 'greenhouse', 'gitlab',     'GitLab',      true),
  (null, 'greenhouse', 'duolingo',   'Duolingo',    true),
  (null, 'greenhouse', 'scale',      'Scale AI',    true),
  -- Lever
  (null, 'lever',      'netflix',    'Netflix',     true),
  (null, 'lever',      'mercury',    'Mercury',     true),
  (null, 'lever',      'huggingface','Hugging Face',true),
  (null, 'lever',      'kraken',     'Kraken',      true),
  (null, 'lever',      'palantir',   'Palantir',    true),
  -- Ashby
  (null, 'ashby',      'Anthropic',  'Anthropic',   true),
  (null, 'ashby',      'openai',     'OpenAI',      true),
  (null, 'ashby',      'ramp',       'Ramp',        true),
  (null, 'ashby',      'linear',     'Linear',      true),
  (null, 'ashby',      'vercel',     'Vercel',      true),
  (null, 'ashby',      'posthog',    'PostHog',     true),
  (null, 'ashby',      'perplexity', 'Perplexity',  true),
  (null, 'ashby',      'replicate',  'Replicate',   true)
on conflict (user_id, ats_type, slug) do nothing;
