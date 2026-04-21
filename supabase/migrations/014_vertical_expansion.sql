-- Vertical expansion: cybersecurity/GRC, product design, marketing/growth.
-- Slugs verified against live ATS endpoints. Stale rows are safely skipped
-- by the scraper with a warning log.

insert into public.target_companies (user_id, ats_type, slug, name, active) values

  -- ── Cybersecurity / GRC ──────────────────────────────────────────────────
  -- Strong ATS presence; good match for Darrink-type users
  (null, 'greenhouse', 'crowdstrike',    'CrowdStrike',      true),
  (null, 'greenhouse', 'sentinelone',    'SentinelOne',      true),
  (null, 'greenhouse', 'snyk',           'Snyk',             true),
  (null, 'greenhouse', 'hackerone',      'HackerOne',        true),
  (null, 'greenhouse', 'lacework',       'Lacework',         true),
  (null, 'greenhouse', 'sumo',           'Sumo Logic',       true),
  (null, 'greenhouse', 'obsidiansecurity','Obsidian Security',true),
  (null, 'greenhouse', 'abnormalsecurity','Abnormal Security',true),
  (null, 'greenhouse', 'proofpoint',     'Proofpoint',       true),
  (null, 'greenhouse', 'tanium',         'Tanium',           true),
  (null, 'ashby',      'wiz',            'Wiz',              true),
  (null, 'ashby',      'orca',           'Orca Security',    true),
  (null, 'ashby',      'laceworks',      'Laceworks',        true),
  (null, 'lever',      'threatlocker',   'ThreatLocker',     true),

  -- ── Product Design ───────────────────────────────────────────────────────
  -- Tools & PLG companies that hire PMs + Designers heavily
  (null, 'greenhouse', 'miro',           'Miro',             true),
  (null, 'greenhouse', 'loom',           'Loom',             true),
  (null, 'greenhouse', 'maze',           'Maze',             true),
  (null, 'greenhouse', 'hotjar',         'Hotjar',           true),
  (null, 'greenhouse', 'fullstory',      'FullStory',        true),
  (null, 'greenhouse', 'pendo',          'Pendo',            true),
  (null, 'greenhouse', 'lucidchart',     'Lucidchart',       true),
  (null, 'greenhouse', 'invision',       'InVision',         true),
  (null, 'greenhouse', 'wix',            'Wix',              true),
  (null, 'ashby',      'framer',         'Framer',           true),
  (null, 'ashby',      'lottiefiles',    'LottieFiles',      true),
  (null, 'ashby',      'readai',         'Read AI',          true),
  (null, 'lever',      'coda',           'Coda',             true),
  (null, 'lever',      'warp',           'Warp',             true),

  -- ── Marketing / Growth ───────────────────────────────────────────────────
  (null, 'greenhouse', 'hubspot',        'HubSpot',          true),
  (null, 'greenhouse', 'sproutsocial',   'Sprout Social',    true),
  (null, 'greenhouse', 'contentful',     'Contentful',       true),
  (null, 'greenhouse', 'yotpo',          'Yotpo',            true),
  (null, 'greenhouse', 'gorgias',        'Gorgias',          true),
  (null, 'greenhouse', 'privy',          'Privy',            true),
  (null, 'ashby',      'beehiiv',        'beehiiv',          true),
  (null, 'ashby',      'kit',            'Kit (ConvertKit)', true),
  (null, 'ashby',      'loop',           'Loop Returns',     true),
  (null, 'lever',      'clearbit',       'Clearbit',         true)

on conflict (user_id, ats_type, slug) do nothing;
