-- Track employers for the Per Scholas New York cohort (Healthcare IT, Cybersecurity,
-- Business Intelligence), re-verification of every tracked ATS board, and the
-- Workday source. Every slug below answered a live HTTP request on 2026-10-21; the
-- research table with job counts is in docs/employers.md.
--
-- Safe to run twice: deactivations are no-ops the second time, inserts are
-- on-conflict guarded, pack updates set the same value, the sources update
-- excludes profiles that already carry 'workday', and the trigger is created
-- with create or replace / drop if exists.

-- ── 1. Workday is a fourth ATS type ─────────────────────────────────────────
-- Slug contract for ats_type = 'workday': '<tenant>/<wdN>/<site>', e.g.
-- 'barclays/wd3/External_Career_Site_Barclays' (scraper/scrapers/workday.py).
-- The 011 check constraint was named by Postgres, so drop it by that name.
alter table public.target_companies drop constraint if exists target_companies_ats_type_check;
alter table public.target_companies
  add constraint target_companies_ats_type_check
  check (ats_type in ('greenhouse', 'lever', 'ashby', 'workday'));

-- ── 2. Dead boards: deactivate, never delete ──────────────────────────────────
-- Every one of these returned HTTP 404 from its ATS API on 2026-10-21 (user rows
-- included: a 404 slug is dead for everyone, and the daily ingest log was
-- filling with these). Replacements that were found are inserted in step 3.
update public.target_companies t
   set active = false
  from (values
    ('ashby', 'Anthropic'),                       -- Anthropic: duplicate of live greenhouse anthropic
    ('ashby', 'beehiiv'),                         -- beehiiv: no board found on Greenhouse, Lever or Ashby
    ('ashby', 'framer'),                          -- Framer: no board found on Greenhouse, Lever or Ashby
    ('ashby', 'laceworks'),                       -- Laceworks: misspelled duplicate of lacework; acquired by Fortinet
    ('ashby', 'loop'),                            -- Loop Returns: moved to lever loopreturns
    ('ashby', 'lottiefiles'),                     -- LottieFiles: moved to ashby lottie
    ('ashby', 'newfront'),                        -- Newfront: no board found on Greenhouse, Lever or Ashby
    ('ashby', 'ona'),                             -- Gitpod: Gitpod rebranded to Ona; no board found on a supported ATS
    ('ashby', 'puzzle.io'),                       -- Puzzle: no board found on Greenhouse, Lever or Ashby
    ('ashby', 'readai'),                          -- Read AI: moved to ashby read-ai
    ('ashby', 'replicate'),                       -- Replicate: no board found on Greenhouse, Lever or Ashby
    ('ashby', 'whatnot'),                         -- Whatnot: no board found on Greenhouse, Lever or Ashby
    ('greenhouse', 'amplitude'),                  -- Amplitude: moved to ashby amplitude
    ('greenhouse', 'check'),                      -- Check: moved to ashby check-technologies
    ('greenhouse', 'clickhouse'),                 -- ClickHouse: moved to ashby clickhouse
    ('greenhouse', 'crowdstrike'),                -- CrowdStrike: moved to workday crowdstrike/wd5/crowdstrikecareers
    ('greenhouse', 'dbtlabsinc'),                 -- Dbt Labs: no board found on Greenhouse, Lever or Ashby
    ('greenhouse', 'devoted'),                    -- Devoted Health: no board found on Greenhouse, Lever or Ashby
    ('greenhouse', 'doordash'),                   -- DoorDash: moved to greenhouse doordashusa
    ('greenhouse', 'fireworksai'),                -- Fireworks AI: moved to ashby fireworks
    ('greenhouse', 'fullstory'),                  -- FullStory: moved to ashby fullstory
    ('greenhouse', 'gorgias'),                    -- Gorgias: moved to ashby gorgias
    ('greenhouse', 'hackerone'),                  -- HackerOne: moved to ashby hackerone
    ('greenhouse', 'headway'),                    -- Headway: moved to ashby headway
    ('greenhouse', 'hightouch'),                  -- Hightouch: moved to ashby hightouch
    ('greenhouse', 'hingehealth'),                -- Hinge Health: moved to ashby hinge-health
    ('greenhouse', 'hotjar'),                     -- Hotjar: merged into Contentsquare; no public board on a supported ATS
    ('greenhouse', 'hubspot'),                    -- HubSpot: moved to greenhouse hubspotjobs
    ('greenhouse', 'invision'),                   -- InVision: InVision shut down its product (2024)
    ('greenhouse', 'lacework'),                   -- Lacework: acquired by Fortinet (2024); careers folded into Fortinet
    ('greenhouse', 'linear'),                     -- Linear: duplicate of live ashby linear
    ('greenhouse', 'loom'),                       -- Loom: acquired by Atlassian (2023); Ashby board exists but is empty
    ('greenhouse', 'lucidchart'),                 -- Lucidchart: moved to greenhouse lucidsoftware
    ('greenhouse', 'maze'),                       -- Maze: no board found on Greenhouse, Lever or Ashby
    ('greenhouse', 'miro'),                       -- Miro: moved to ashby miro
    ('greenhouse', 'mutiny'),                     -- Mutiny: moved to ashby mutiny
    ('greenhouse', 'notion'),                     -- Notion: duplicate of live ashby notion
    ('greenhouse', 'oscarhealth'),                -- Oscar Health: moved to greenhouse oscar
    ('greenhouse', 'plaid'),                      -- Plaid: moved to ashby plaid
    ('greenhouse', 'privy'),                      -- Privy: acquired by Attentive; Attentive hires on Greenhouse (attentive)
    ('greenhouse', 'proofpoint'),                 -- Proofpoint: no Workday tenant or Greenhouse/Lever/Ashby board found
    ('greenhouse', 'ramp'),                       -- Ramp: duplicate of live ashby ramp
    ('greenhouse', 'retool'),                     -- Retool: no board found on Greenhouse, Lever or Ashby
    ('greenhouse', 'scale'),                      -- Scale AI: duplicate of live greenhouse scaleai
    ('greenhouse', 'sentinelone'),                -- SentinelOne: no Workday tenant or Greenhouse/Lever/Ashby board found
    ('greenhouse', 'snyk'),                       -- Snyk: moved to ashby snyk
    ('greenhouse', 'sumo'),                       -- Sumo Logic: moved to greenhouse sumologic
    ('greenhouse', 'temporaltechnologies'),       -- Temporal: moved to ashby temporal
    ('greenhouse', 'wayve'),                      -- Wayve: moved to ashby wayve
    ('greenhouse', 'wix'),                        -- Wix: Wix runs its own careers site
    ('lever', 'clearbit'),                        -- Clearbit: acquired by HubSpot (2023)
    ('lever', 'huggingface'),                     -- Hugging Face: moved to Workable (unsupported)
    ('lever', 'mercury'),                         -- Mercury: duplicate of live greenhouse mercury
    ('lever', 'netflix'),                         -- Netflix: moved to its own Eightfold-based site (unsupported)
    ('lever', 'plaid'),                           -- Plaid: moved to ashby plaid
    ('lever', 'substack'),                        -- Substack: duplicate of live ashby substack
    ('lever', 'threatlocker'),                    -- ThreatLocker: no board found on a supported ATS
    ('lever', 'vercel'),                          -- Vercel: duplicate of live greenhouse vercel
    ('lever', 'wise')                             -- Wise: Wise moved to its own careers site; the Greenhouse board named 'wise' is an unrelated insurance sales company
  ) as dead(ats_type, slug)
 where t.ats_type = dead.ats_type
   and t.slug = dead.slug
   and t.active;

-- ── 3. Verified global rows: moved boards and track employers ─────────────────
-- user_id IS NULL rows are scraped for every user (011). Same idiom as 012-014.
insert into public.target_companies (user_id, ats_type, slug, name, active) values
  (null, 'greenhouse', 'aqr', 'AQR Capital Management', true),
  (null, 'greenhouse', 'axonius', 'Axonius', true),
  (null, 'greenhouse', 'cloverhealth', 'Clover Health', true),
  (null, 'greenhouse', 'coherehealth', 'Cohere Health', true),
  (null, 'greenhouse', 'dashlane', 'Dashlane', true),
  (null, 'greenhouse', 'doordashusa', 'DoorDash', true),
  (null, 'greenhouse', 'expel', 'Expel', true),
  (null, 'greenhouse', 'flatironhealth', 'Flatiron Health', true),
  (null, 'greenhouse', 'hubspotjobs', 'HubSpot', true),
  (null, 'greenhouse', 'huntress', 'Huntress', true),
  (null, 'greenhouse', 'komodohealth', 'Komodo Health', true),
  (null, 'greenhouse', 'lucidsoftware', 'Lucid Software', true),
  (null, 'greenhouse', 'lyft', 'Lyft', true),
  (null, 'greenhouse', 'newsela', 'Newsela', true),
  (null, 'greenhouse', 'oscar', 'Oscar Health', true),
  (null, 'greenhouse', 'payoneer', 'Payoneer', true),
  (null, 'greenhouse', 'perscholashires', 'Per Scholas', true),
  (null, 'greenhouse', 'point72', 'Point72', true),
  (null, 'greenhouse', 'recordedfuture', 'Recorded Future', true),
  (null, 'greenhouse', 'seatgeek', 'SeatGeek', true),
  (null, 'greenhouse', 'securityscorecard', 'SecurityScorecard', true),
  (null, 'greenhouse', 'sigmacomputing', 'Sigma Computing', true),
  (null, 'greenhouse', 'squarespace', 'Squarespace', true),
  (null, 'greenhouse', 'sumologic', 'Sumo Logic', true),
  (null, 'greenhouse', 'taboola', 'Taboola', true),
  (null, 'greenhouse', 'talkspace', 'Talkspace', true),
  (null, 'greenhouse', 'urbancompass', 'Compass', true),
  (null, 'greenhouse', 'wizinc', 'Wiz', true),
  (null, 'greenhouse', 'zetaglobal', 'Zeta Global', true),
  (null, 'greenhouse', 'zocdoc', 'Zocdoc', true),
  (null, 'lever', 'loopreturns', 'Loop Returns', true),
  (null, 'lever', 'veeva', 'Veeva Systems', true),
  (null, 'ashby', '1password', '1Password', true),
  (null, 'ashby', 'amplitude', 'Amplitude', true),
  (null, 'ashby', 'check-technologies', 'Check', true),
  (null, 'ashby', 'clickhouse', 'ClickHouse', true),
  (null, 'ashby', 'fireworks', 'Fireworks AI', true),
  (null, 'ashby', 'fullstory', 'FullStory', true),
  (null, 'ashby', 'gorgias', 'Gorgias', true),
  (null, 'ashby', 'hackerone', 'HackerOne', true),
  (null, 'ashby', 'headway', 'Headway', true),
  (null, 'ashby', 'hightouch', 'Hightouch', true),
  (null, 'ashby', 'hinge-health', 'Hinge Health', true),
  (null, 'ashby', 'lottie', 'LottieFiles', true),
  (null, 'ashby', 'miro', 'Miro', true),
  (null, 'ashby', 'mutiny', 'Mutiny', true),
  (null, 'ashby', 'paxos', 'Paxos', true),
  (null, 'ashby', 'plaid', 'Plaid', true),
  (null, 'ashby', 'read-ai', 'Read AI', true),
  (null, 'ashby', 'sierra', 'Sierra', true),
  (null, 'ashby', 'snyk', 'Snyk', true),
  (null, 'ashby', 'temporal', 'Temporal', true),
  (null, 'ashby', 'wayve', 'Wayve', true),
  (null, 'workday', 'accenture/wd103/AvanadeCareers', 'Avanade (Accenture)', true),
  (null, 'workday', 'adobe/wd5/external_experienced', 'Adobe', true),
  (null, 'workday', 'aig/wd1/aig', 'AIG', true),
  (null, 'workday', 'aig/wd1/early_careers', 'AIG Early Careers', true),
  (null, 'workday', 'ally/wd1/Ally', 'Ally', true),
  (null, 'workday', 'ankura/wd5/Ankura', 'Ankura', true),
  (null, 'workday', 'archgroup/wd1/Careers', 'Arch Capital', true),
  (null, 'workday', 'arcticwolf/wd1/External', 'Arctic Wolf', true),
  (null, 'workday', 'aresmgmt/wd1/External', 'Ares Management', true),
  (null, 'workday', 'assurant/wd1/Assurant_Careers', 'Assurant', true),
  (null, 'workday', 'athenahealth/wd1/External', 'athenahealth', true),
  (null, 'workday', 'att/wd1/ATTGeneral', 'AT&T', true),
  (null, 'workday', 'bah/wd1/BAH_Jobs', 'Booz Allen Hamilton', true),
  (null, 'workday', 'bakertilly/wd5/BTCareers', 'Baker Tilly', true),
  (null, 'workday', 'barclays/wd3/External_Career_Site_Barclays', 'Barclays', true),
  (null, 'workday', 'barnard/wd1/Staff', 'Barnard College', true),
  (null, 'workday', 'bbh/wd5/BBH', 'Brown Brothers Harriman', true),
  (null, 'workday', 'blackrock/wd1/BlackRock_Professional', 'BlackRock', true),
  (null, 'workday', 'blackstone/wd1/Blackstone_Careers', 'Blackstone', true),
  (null, 'workday', 'bmo/wd3/External', 'BMO', true),
  (null, 'workday', 'bristolmyerssquibb/wd5/BMS', 'Bristol Myers Squibb', true),
  (null, 'workday', 'broadridge/wd5/Careers', 'Broadridge', true),
  (null, 'workday', 'brookfield/wd5/brookfield', 'Brookfield', true),
  (null, 'workday', 'capitalone/wd12/Capital_One', 'Capital One', true),
  (null, 'workday', 'carlyle/wd1/Carlyle', 'Carlyle', true),
  (null, 'workday', 'cdw/wd5/Careers', 'CDW', true),
  (null, 'workday', 'centene/wd5/Centene_External', 'Centene (Fidelis Care)', true),
  (null, 'workday', 'cibc/wd3/search', 'CIBC', true),
  (null, 'workday', 'cigna/wd5/cignacareers', 'Cigna', true),
  (null, 'workday', 'circle/wd1/Circle', 'Circle', true),
  (null, 'workday', 'cisco/wd5/Cisco_Careers', 'Cisco', true),
  (null, 'workday', 'crowdstrike/wd5/crowdstrikecareers', 'CrowdStrike', true),
  (null, 'workday', 'crowe/wd12/External_Careers', 'Crowe', true),
  (null, 'workday', 'cvshealth/wd1/CVS_Health_Careers', 'CVS Health', true),
  (null, 'workday', 'dataminr/wd12/Dataminr', 'Dataminr', true),
  (null, 'workday', 'db/wd3/DBWebsite', 'Deutsche Bank', true),
  (null, 'workday', 'disney/wd5/disneycareer', 'Disney', true),
  (null, 'workday', 'doubleverify/wd5/DV_Careers', 'DoubleVerify', true),
  (null, 'workday', 'dowjones/wd1/Dow_Jones_Career', 'Dow Jones', true),
  (null, 'workday', 'eisneramper/wd1/EisnerAmper_External', 'EisnerAmper', true),
  (null, 'workday', 'elevancehealth/wd1/ANT', 'Elevance Health', true),
  (null, 'workday', 'entrust/wd1/EntrustCareers', 'Entrust', true),
  (null, 'workday', 'equiniti/wd3/Opportunities', 'Equiniti', true),
  (null, 'workday', 'etsy/wd5/Etsy_Careers', 'Etsy', true),
  (null, 'workday', 'everestre/wd5/careers', 'Everest', true),
  (null, 'workday', 'factset/wd108/FactSetCareers', 'FactSet', true),
  (null, 'workday', 'fis/wd5/SearchJobs', 'FIS', true),
  (null, 'workday', 'fiserv/wd5/EXT', 'Fiserv', true),
  (null, 'workday', 'fox/wd1/Domestic', 'Fox Corporation', true),
  (null, 'workday', 'fticonsulting/wd108/FTIConsultingCareers', 'FTI Consulting', true),
  (null, 'workday', 'gdit/wd5/External_Career_Site', 'GDIT', true),
  (null, 'workday', 'guardianlife/wd5/Guardian-Life-Careers', 'Guardian Life', true),
  (null, 'workday', 'guidehouse/wd1/External', 'Guidehouse', true),
  (null, 'workday', 'healthfirst/wd1/healthfirst', 'Healthfirst', true),
  (null, 'workday', 'henryschein/wd1/External_Careers', 'Henry Schein', true),
  (null, 'workday', 'hp/wd5/ExternalCareerSite', 'HP', true),
  (null, 'workday', 'hpe/wd5/Jobsathpe', 'Hewlett Packard Enterprise', true),
  (null, 'workday', 'humana/wd5/Humana_External_Career_Site', 'Humana', true),
  (null, 'workday', 'huron/wd1/huroncareers', 'Huron', true),
  (null, 'workday', 'icf/wd5/ICFExternal_Career_Site', 'ICF', true),
  (null, 'workday', 'iheartmedia/wd5/External_iHM', 'iHeartMedia', true),
  (null, 'workday', 'intel/wd1/External', 'Intel', true),
  (null, 'workday', 'invesco/wd1/IVZ', 'Invesco', true),
  (null, 'workday', 'jll/wd1/jllcareers', 'JLL', true),
  (null, 'workday', 'keybank/wd5/External_Career_Site', 'KeyBank', true),
  (null, 'workday', 'kyndryl/wd5/KyndrylEarlyCareers', 'Kyndryl Early Careers', true),
  (null, 'workday', 'kyndryl/wd5/KyndrylProfessionalCareers', 'Kyndryl', true),
  (null, 'workday', 'leidos/wd5/External', 'Leidos', true),
  (null, 'workday', 'mastercard/wd1/CorporateCareers', 'Mastercard', true),
  (null, 'workday', 'mckesson/wd3/External_Careers', 'McKesson', true),
  (null, 'workday', 'mimecast/wd5/Mimecast-Careers', 'Mimecast', true),
  (null, 'workday', 'mizuho/wd1/mizuhoamericas', 'Mizuho Americas', true),
  (null, 'workday', 'montefiore/wd12/MMC', 'Montefiore Medical Center', true),
  (null, 'workday', 'ms/wd5/External', 'Morgan Stanley', true),
  (null, 'workday', 'msd/wd5/SearchJobs', 'Merck', true),
  (null, 'workday', 'msk/wd108/MSKCC_Careers_Primary', 'Memorial Sloan Kettering', true),
  (null, 'workday', 'mtb/wd5/MTB', 'M&T Bank', true),
  (null, 'workday', 'mufgub/wd3/MUFG-Careers', 'MUFG', true),
  (null, 'workday', 'nasdaq/wd1/Global_External_Site', 'Nasdaq', true),
  (null, 'workday', 'nb/wd1/NBCareers', 'Neuberger Berman', true),
  (null, 'workday', 'newschool/wd1/External', 'The New School', true),
  (null, 'workday', 'nextgen/wd5/NextGen_Careers', 'NextGen Healthcare', true),
  (null, 'workday', 'nvidia/wd5/NVIDIAExternalCareerSite', 'NVIDIA', true),
  (null, 'workday', 'nyp/wd1/nypcareers', 'NewYork-Presbyterian', true),
  (null, 'workday', 'optiv/wd5/Optiv_Careers', 'Optiv', true),
  (null, 'workday', 'paypal/wd1/jobs', 'PayPal', true),
  (null, 'workday', 'pfizer/wd1/PfizerCareers', 'Pfizer', true),
  (null, 'workday', 'proofpoint/wd5/ProofpointCareers', 'Proofpoint', true),
  (null, 'workday', 'pru/wd5/Careers', 'Prudential', true),
  (null, 'workday', 'pvh/wd1/PVH_Careers', 'PVH', true),
  (null, 'workday', 'pwc/wd3/Global_Experienced_Careers', 'PwC', true),
  (null, 'workday', 'pwc/wd3/US_Entry_Level_Careers', 'PwC US Entry Level', true),
  (null, 'workday', 'rackspace/wd1/External', 'Rackspace', true),
  (null, 'workday', 'rb/wd5/FRS', 'Federal Reserve System', true),
  (null, 'workday', 'regeneron/wd1/Careers', 'Regeneron', true),
  (null, 'workday', 'roberthalf/wd1/ProtivitiNA', 'Protiviti', true),
  (null, 'workday', 'rsm/wd1/RSMCareers', 'RSM', true),
  (null, 'workday', 'sailpoint/wd1/SailPoint', 'SailPoint', true),
  (null, 'workday', 'salesforce/wd12/External_Career_Site', 'Salesforce', true),
  (null, 'workday', 'salesforce/wd12/Futureforce_NewGradRoles', 'Salesforce Futureforce', true),
  (null, 'workday', 'santander/wd3/SantanderCareers', 'Santander', true),
  (null, 'workday', 'scholastic/wd5/External', 'Scholastic', true),
  (null, 'workday', 'shi/wd12/shicareers', 'SHI', true),
  (null, 'workday', 'spgi/wd5/SPGI_Careers', 'S&P Global', true),
  (null, 'workday', 'sprinklr/wd1/careers', 'Sprinklr', true),
  (null, 'workday', 'ssctech/wd1/SSCTechnologies', 'SS&C Technologies', true),
  (null, 'workday', 'statestreet/wd1/Global', 'State Street', true),
  (null, 'workday', 'tapestry/wd108/Tapestry_Careers', 'Tapestry', true),
  (null, 'workday', 'td/wd3/TD_Bank_Careers', 'TD Bank', true),
  (null, 'workday', 'thehartford/wd5/Careers_External', 'The Hartford', true),
  (null, 'workday', 'thomsonreuters/wd5/External_Career_Site', 'Thomson Reuters', true),
  (null, 'workday', 'tiaa/wd1/Search', 'TIAA', true),
  (null, 'workday', 'travelers/wd5/External', 'Travelers', true),
  (null, 'workday', 'trellix/wd1/EnterpriseCareers', 'Trellix', true),
  (null, 'workday', 'trendmicro/wd3/External', 'Trend Micro', true),
  (null, 'workday', 'unisys/wd5/External', 'Unisys', true),
  (null, 'workday', 'veradigm/wd12/VR', 'Veradigm', true),
  (null, 'workday', 'visa/wd5/Visa', 'Visa', true),
  (null, 'workday', 'warnerbros/wd5/global', 'Warner Bros. Discovery', true),
  (null, 'workday', 'wework/wd1/WeWork', 'WeWork', true),
  (null, 'workday', 'wf/wd1/WellsFargoJobs', 'Wells Fargo', true),
  (null, 'workday', 'wiley/wd1/wiley_careers', 'Wiley', true),
  (null, 'workday', 'withum/wd108/Withum_Careers_Page', 'Withum', true),
  (null, 'workday', 'wmg/wd1/WMGUS', 'Warner Music Group', true),
  (null, 'workday', 'workday/wd5/Workday', 'Workday', true)
on conflict (user_id, ats_type, slug) do nothing;

-- ── 4. Vertical packs ────────────────────────────────────────────────────────
-- 017 seeded 'cyber' with CrowdStrike/Wiz/Snyk on Greenhouse and Cloudflare on
-- Lever; all four slugs 404 on 2026-10-21 (CrowdStrike moved to Workday, Snyk to
-- Ashby, Wiz hires on Greenhouse as 'wizinc', and Cloudflare is on Greenhouse).
-- Onboarding copies a pack's ats_slugs into the subscriber's own
-- target_companies rows, so a dead entry here keeps producing dead rows.
-- Rewrite the pack from the verified list.
update public.vertical_packs
   set ats_slugs = '[{"ats_type": "greenhouse", "slug": "datadog", "name": "Datadog"},
     {"ats_type": "greenhouse", "slug": "cloudflare", "name": "Cloudflare"},
     {"ats_type": "greenhouse", "slug": "okta", "name": "Okta"},
     {"ats_type": "greenhouse", "slug": "betterment", "name": "Betterment"},
     {"ats_type": "ashby", "slug": "snyk", "name": "Snyk"},
     {"ats_type": "greenhouse", "slug": "aqr", "name": "AQR Capital Management"},
     {"ats_type": "greenhouse", "slug": "point72", "name": "Point72"},
     {"ats_type": "greenhouse", "slug": "axonius", "name": "Axonius"},
     {"ats_type": "greenhouse", "slug": "oscar", "name": "Oscar Health"},
     {"ats_type": "greenhouse", "slug": "zetaglobal", "name": "Zeta Global"},
     {"ats_type": "greenhouse", "slug": "payoneer", "name": "Payoneer"},
     {"ats_type": "greenhouse", "slug": "squarespace", "name": "Squarespace"},
     {"ats_type": "greenhouse", "slug": "urbancompass", "name": "Compass"},
     {"ats_type": "greenhouse", "slug": "huntress", "name": "Huntress"},
     {"ats_type": "greenhouse", "slug": "lucidsoftware", "name": "Lucid Software"},
     {"ats_type": "greenhouse", "slug": "securityscorecard", "name": "SecurityScorecard"},
     {"ats_type": "greenhouse", "slug": "recordedfuture", "name": "Recorded Future"},
     {"ats_type": "greenhouse", "slug": "expel", "name": "Expel"},
     {"ats_type": "greenhouse", "slug": "dashlane", "name": "Dashlane"},
     {"ats_type": "greenhouse", "slug": "lyft", "name": "Lyft"},
     {"ats_type": "greenhouse", "slug": "wizinc", "name": "Wiz"},
     {"ats_type": "lever", "slug": "palantir", "name": "Palantir"},
     {"ats_type": "ashby", "slug": "vanta", "name": "Vanta"},
     {"ats_type": "ashby", "slug": "paxos", "name": "Paxos"},
     {"ats_type": "ashby", "slug": "1password", "name": "1Password"},
     {"ats_type": "workday", "slug": "hpe/wd5/Jobsathpe", "name": "Hewlett Packard Enterprise"},
     {"ats_type": "workday", "slug": "bah/wd1/BAH_Jobs", "name": "Booz Allen Hamilton"},
     {"ats_type": "workday", "slug": "kyndryl/wd5/KyndrylProfessionalCareers", "name": "Kyndryl"},
     {"ats_type": "workday", "slug": "leidos/wd5/External", "name": "Leidos"},
     {"ats_type": "workday", "slug": "mufgub/wd3/MUFG-Careers", "name": "MUFG"},
     {"ats_type": "workday", "slug": "bristolmyerssquibb/wd5/BMS", "name": "Bristol Myers Squibb"},
     {"ats_type": "workday", "slug": "gdit/wd5/External_Career_Site", "name": "GDIT"},
     {"ats_type": "workday", "slug": "statestreet/wd1/Global", "name": "State Street"},
     {"ats_type": "workday", "slug": "guidehouse/wd1/External", "name": "Guidehouse"},
     {"ats_type": "workday", "slug": "td/wd3/TD_Bank_Careers", "name": "TD Bank"},
     {"ats_type": "workday", "slug": "mckesson/wd3/External_Careers", "name": "McKesson"},
     {"ats_type": "workday", "slug": "paypal/wd1/jobs", "name": "PayPal"},
     {"ats_type": "workday", "slug": "cibc/wd3/search", "name": "CIBC"},
     {"ats_type": "workday", "slug": "nvidia/wd5/NVIDIAExternalCareerSite", "name": "NVIDIA"},
     {"ats_type": "workday", "slug": "aig/wd1/aig", "name": "AIG"},
     {"ats_type": "workday", "slug": "mastercard/wd1/CorporateCareers", "name": "Mastercard"},
     {"ats_type": "workday", "slug": "intel/wd1/External", "name": "Intel"},
     {"ats_type": "workday", "slug": "crowdstrike/wd5/crowdstrikecareers", "name": "CrowdStrike"},
     {"ats_type": "workday", "slug": "pwc/wd3/Global_Experienced_Careers", "name": "PwC"},
     {"ats_type": "workday", "slug": "icf/wd5/ICFExternal_Career_Site", "name": "ICF"}]'::jsonb,
       active = true
 where slug = 'cyber';

-- The other 017 packs carried the same kind of rot. Dead entries are swapped
-- for the board the company moved to, or dropped when no supported board exists
-- (Wise, Devoted Health, Retool). Climate lost Pachama, Rivian and Tesla (all
-- 404) and gains climate employers whose boards answered with jobs.
update public.vertical_packs
   set ats_slugs = '[{"ats_type": "greenhouse", "slug": "stripe", "name": "Stripe"},
     {"ats_type": "ashby", "slug": "plaid", "name": "Plaid"},
     {"ats_type": "ashby", "slug": "ramp", "name": "Ramp"},
     {"ats_type": "greenhouse", "slug": "mercury", "name": "Mercury"},
     {"ats_type": "greenhouse", "slug": "brex", "name": "Brex"},
     {"ats_type": "greenhouse", "slug": "chime", "name": "Chime"},
     {"ats_type": "lever", "slug": "kraken", "name": "Kraken"}]'::jsonb
 where slug = 'fintech';

update public.vertical_packs
   set ats_slugs = '[{"ats_type": "greenhouse", "slug": "oscar", "name": "Oscar Health"},
     {"ats_type": "ashby", "slug": "hinge-health", "name": "Hinge Health"},
     {"ats_type": "lever", "slug": "ro", "name": "Ro"},
     {"ats_type": "ashby", "slug": "headway", "name": "Headway"}]'::jsonb
 where slug = 'health';

update public.vertical_packs
   set ats_slugs = '[{"ats_type": "greenhouse", "slug": "doordashusa", "name": "DoorDash"},
     {"ats_type": "greenhouse", "slug": "instacart", "name": "Instacart"},
     {"ats_type": "greenhouse", "slug": "airbnb", "name": "Airbnb"},
     {"ats_type": "ashby", "slug": "substack", "name": "Substack"}]'::jsonb
 where slug = 'consumer';

update public.vertical_packs
   set ats_slugs = '[{"ats_type": "ashby", "slug": "notion", "name": "Notion"},
     {"ats_type": "greenhouse", "slug": "figma", "name": "Figma"},
     {"ats_type": "ashby", "slug": "linear", "name": "Linear"},
     {"ats_type": "greenhouse", "slug": "vercel", "name": "Vercel"}]'::jsonb
 where slug = 'b2b-saas';

update public.vertical_packs
   set ats_slugs = '[{"ats_type": "greenhouse", "slug": "watershed", "name": "Watershed"},
     {"ats_type": "greenhouse", "slug": "redwoodmaterials", "name": "Redwood Materials"},
     {"ats_type": "ashby", "slug": "formenergy", "name": "Form Energy"},
     {"ats_type": "lever", "slug": "arcadia", "name": "Arcadia"},
     {"ats_type": "lever", "slug": "voltus", "name": "Voltus"},
     {"ats_type": "lever", "slug": "charmindustrial", "name": "Charm Industrial"}]'::jsonb
 where slug = 'climate';

-- Two packs for the Per Scholas tracks. 'cyber' already covers the third.
insert into public.vertical_packs (slug, name, description, icon, ats_slugs) values
  ('healthcare-it', 'Healthcare IT and IT Support',
   'Help desk, desktop support, service desk and clinical systems teams at hospitals, insurers, banks and NYC tech.',
   '🩺',
   '[{"ats_type": "greenhouse", "slug": "aqr", "name": "AQR Capital Management"},
     {"ats_type": "greenhouse", "slug": "point72", "name": "Point72"},
     {"ats_type": "greenhouse", "slug": "axonius", "name": "Axonius"},
     {"ats_type": "greenhouse", "slug": "zocdoc", "name": "Zocdoc"},
     {"ats_type": "greenhouse", "slug": "seatgeek", "name": "SeatGeek"},
     {"ats_type": "greenhouse", "slug": "taboola", "name": "Taboola"},
     {"ats_type": "greenhouse", "slug": "sigmacomputing", "name": "Sigma Computing"},
     {"ats_type": "greenhouse", "slug": "komodohealth", "name": "Komodo Health"},
     {"ats_type": "greenhouse", "slug": "flatironhealth", "name": "Flatiron Health"},
     {"ats_type": "greenhouse", "slug": "lucidsoftware", "name": "Lucid Software"},
     {"ats_type": "greenhouse", "slug": "expel", "name": "Expel"},
     {"ats_type": "ashby", "slug": "vanta", "name": "Vanta"},
     {"ats_type": "ashby", "slug": "paxos", "name": "Paxos"},
     {"ats_type": "ashby", "slug": "harvey", "name": "Harvey"},
     {"ats_type": "ashby", "slug": "sierra", "name": "Sierra"},
     {"ats_type": "ashby", "slug": "cohere", "name": "Cohere"},
     {"ats_type": "workday", "slug": "td/wd3/TD_Bank_Careers", "name": "TD Bank"},
     {"ats_type": "workday", "slug": "kyndryl/wd5/KyndrylProfessionalCareers", "name": "Kyndryl"},
     {"ats_type": "workday", "slug": "jll/wd1/jllcareers", "name": "JLL"},
     {"ats_type": "workday", "slug": "gdit/wd5/External_Career_Site", "name": "GDIT"},
     {"ats_type": "workday", "slug": "mckesson/wd3/External_Careers", "name": "McKesson"},
     {"ats_type": "workday", "slug": "leidos/wd5/External", "name": "Leidos"},
     {"ats_type": "workday", "slug": "visa/wd5/Visa", "name": "Visa"},
     {"ats_type": "workday", "slug": "db/wd3/DBWebsite", "name": "Deutsche Bank"},
     {"ats_type": "workday", "slug": "unisys/wd5/External", "name": "Unisys"},
     {"ats_type": "workday", "slug": "ms/wd5/External", "name": "Morgan Stanley"},
     {"ats_type": "workday", "slug": "cvshealth/wd1/CVS_Health_Careers", "name": "CVS Health"},
     {"ats_type": "workday", "slug": "hpe/wd5/Jobsathpe", "name": "Hewlett Packard Enterprise"},
     {"ats_type": "workday", "slug": "salesforce/wd12/External_Career_Site", "name": "Salesforce"},
     {"ats_type": "workday", "slug": "att/wd1/ATTGeneral", "name": "AT&T"},
     {"ats_type": "workday", "slug": "cisco/wd5/Cisco_Careers", "name": "Cisco"},
     {"ats_type": "workday", "slug": "wework/wd1/WeWork", "name": "WeWork"},
     {"ats_type": "workday", "slug": "mufgub/wd3/MUFG-Careers", "name": "MUFG"},
     {"ats_type": "workday", "slug": "nvidia/wd5/NVIDIAExternalCareerSite", "name": "NVIDIA"},
     {"ats_type": "workday", "slug": "barclays/wd3/External_Career_Site_Barclays", "name": "Barclays"},
     {"ats_type": "workday", "slug": "hp/wd5/ExternalCareerSite", "name": "HP"}]'::jsonb),
  ('data-bi', 'Data and Business Intelligence',
   'Data analyst, BI analyst and reporting analyst teams in finance, health and NYC tech.',
   '📊',
   '[{"ats_type": "greenhouse", "slug": "aqr", "name": "AQR Capital Management"},
     {"ats_type": "greenhouse", "slug": "point72", "name": "Point72"},
     {"ats_type": "greenhouse", "slug": "axonius", "name": "Axonius"},
     {"ats_type": "greenhouse", "slug": "zocdoc", "name": "Zocdoc"},
     {"ats_type": "greenhouse", "slug": "seatgeek", "name": "SeatGeek"},
     {"ats_type": "greenhouse", "slug": "taboola", "name": "Taboola"},
     {"ats_type": "greenhouse", "slug": "komodohealth", "name": "Komodo Health"},
     {"ats_type": "greenhouse", "slug": "flatironhealth", "name": "Flatiron Health"},
     {"ats_type": "greenhouse", "slug": "oscar", "name": "Oscar Health"},
     {"ats_type": "greenhouse", "slug": "cloverhealth", "name": "Clover Health"},
     {"ats_type": "greenhouse", "slug": "coherehealth", "name": "Cohere Health"},
     {"ats_type": "greenhouse", "slug": "talkspace", "name": "Talkspace"},
     {"ats_type": "greenhouse", "slug": "zetaglobal", "name": "Zeta Global"},
     {"ats_type": "greenhouse", "slug": "payoneer", "name": "Payoneer"},
     {"ats_type": "greenhouse", "slug": "lyft", "name": "Lyft"},
     {"ats_type": "greenhouse", "slug": "newsela", "name": "Newsela"},
     {"ats_type": "greenhouse", "slug": "doordashusa", "name": "DoorDash"},
     {"ats_type": "lever", "slug": "veeva", "name": "Veeva Systems"},
     {"ats_type": "ashby", "slug": "harvey", "name": "Harvey"},
     {"ats_type": "ashby", "slug": "1password", "name": "1Password"},
     {"ats_type": "workday", "slug": "jll/wd1/jllcareers", "name": "JLL"},
     {"ats_type": "workday", "slug": "leidos/wd5/External", "name": "Leidos"},
     {"ats_type": "workday", "slug": "bah/wd1/BAH_Jobs", "name": "Booz Allen Hamilton"},
     {"ats_type": "workday", "slug": "gdit/wd5/External_Career_Site", "name": "GDIT"},
     {"ats_type": "workday", "slug": "salesforce/wd12/External_Career_Site", "name": "Salesforce"},
     {"ats_type": "workday", "slug": "kyndryl/wd5/KyndrylProfessionalCareers", "name": "Kyndryl"},
     {"ats_type": "workday", "slug": "statestreet/wd1/Global", "name": "State Street"},
     {"ats_type": "workday", "slug": "hpe/wd5/Jobsathpe", "name": "Hewlett Packard Enterprise"},
     {"ats_type": "workday", "slug": "pwc/wd3/Global_Experienced_Careers", "name": "PwC"},
     {"ats_type": "workday", "slug": "cvshealth/wd1/CVS_Health_Careers", "name": "CVS Health"},
     {"ats_type": "workday", "slug": "db/wd3/DBWebsite", "name": "Deutsche Bank"},
     {"ats_type": "workday", "slug": "nvidia/wd5/NVIDIAExternalCareerSite", "name": "NVIDIA"},
     {"ats_type": "workday", "slug": "cibc/wd3/search", "name": "CIBC"},
     {"ats_type": "workday", "slug": "td/wd3/TD_Bank_Careers", "name": "TD Bank"},
     {"ats_type": "workday", "slug": "spgi/wd5/SPGI_Careers", "name": "S&P Global"},
     {"ats_type": "workday", "slug": "thomsonreuters/wd5/External_Career_Site", "name": "Thomson Reuters"},
     {"ats_type": "workday", "slug": "capitalone/wd12/Capital_One", "name": "Capital One"},
     {"ats_type": "workday", "slug": "guidehouse/wd1/External", "name": "Guidehouse"},
     {"ats_type": "workday", "slug": "icf/wd5/ICFExternal_Career_Site", "name": "ICF"},
     {"ats_type": "workday", "slug": "mufgub/wd3/MUFG-Careers", "name": "MUFG"}]'::jsonb)
on conflict (slug) do update
   set name = excluded.name,
       description = excluded.description,
       icon = excluded.icon,
       ats_slugs = excluded.ats_slugs,
       active = true;

-- ── 5. Turn the Workday source on for users who already run ATS sources ───────
-- The ATS sources draw from the shared company pool, so anyone who opted into
-- Greenhouse/Lever/Ashby gets Workday the same way. Guarded so a re-run does
-- not append a second 'workday'.
update public.profiles
   set sources = array_append(sources, 'workday')
 where onboarded
   and sources && array['greenhouse', 'lever', 'ashby']
   and not ('workday' = any(sources));

-- ── 6. ...and for users who finish onboarding after this migration ──────────
-- The onboarding page writes its own default source list (greenhouse, lever,
-- ashby, no workday) when a profile flips to onboarded, so step 5 alone would
-- miss the Per Scholas cohort that signs up next. Append 'workday' once, on the
-- not-onboarded -> onboarded transition, when the new list already carries an
-- ATS source. Later edits in Settings are left alone, so this is a default and
-- not a lock.
create or replace function public.default_workday_source()
returns trigger
language plpgsql
as $$
begin
  if new.onboarded
     and (tg_op = 'INSERT' or not coalesce(old.onboarded, false))
     and new.sources && array['greenhouse', 'lever', 'ashby']
     and not ('workday' = any(new.sources)) then
    new.sources := array_append(new.sources, 'workday');
  end if;
  return new;
end;
$$;

drop trigger if exists profiles_default_workday_source on public.profiles;
create trigger profiles_default_workday_source
  before insert or update of onboarded on public.profiles
  for each row execute function public.default_workday_source();
