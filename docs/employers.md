# Employers for the Per Scholas New York tracks

Research record for migration `019_track_employers.sql`. Checked on 2026-10-21 with one live HTTP
request per board: Workday `POST /wday/cxs/<tenant>/<site>/jobs`, Greenhouse
`boards-api.greenhouse.io/v1/boards/<slug>/jobs`, Lever `api.lever.co/v0/postings/<slug>`,
Ashby `api.ashbyhq.com/posting-api/job-board/<slug>`. "Jobs" is the board's total active postings
at check time, not the number of track-relevant openings; the notes column names the relevant
titles that were open that day.

Tracks: **HIT** = AI-Enabled Healthcare IT Technician (help desk, desktop support, service desk,
EHR support), **CYB** = Cybersecurity with AI Tools (SOC, junior security analyst, GRC),
**BI** = AI-Native Business Intelligence (BI, data, reporting analyst).

## 1. Verified employers added to the shared pool

### Workday (new source, `ats_type = 'workday'`, slug `<tenant>/<wdN>/<site>`)

| Employer | Tracks | Slug | Jobs | Notes |
|---|---|---|---|---|
| Adobe | HIT, CYB, BI | `adobe/wd5/external_experienced` | 306 | NYC office. Search hits: help desk 23, security analyst 24, data analyst 90 |
| AIG | CYB, BI | `aig/wd1/aig` | 440 | NYC HQ. Search hits: help desk 12, security analyst 99, data analyst 61 |
| AIG Early Careers | CYB, BI | `aig/wd1/early_careers` | 41 | AIG's entry-level site; 39 security analyst search hits. Search hits: help desk 0, security analyst 39, data analyst 29 |
| Ally | CYB, BI | `ally/wd1/Ally` | 77 | NYC, Charlotte and Detroit; remote-friendly. Search hits: help desk 0, security analyst 10, data analyst 40 |
| Ankura | CYB, BI | `ankura/wd5/Ankura` | 91 | NYC and Washington DC. Search hits: help desk 1, security analyst 3, data analyst 64 |
| Arch Capital | CYB, BI | `archgroup/wd1/Careers` | 203 | NJ and NYC. Search hits: help desk 5, security analyst 6, data analyst 45 |
| Arctic Wolf | CYB | `arcticwolf/wd1/External` | 118 | SOC-as-a-service; US remote. Search hits: help desk 1, security analyst 13, data analyst 12 |
| Ares Management | BI | `aresmgmt/wd1/External` | 245 | NYC and Los Angeles. Search hits: help desk 2, security analyst 4, data analyst 40 |
| Assurant | CYB, BI | `assurant/wd1/Assurant_Careers` | 119 | NYC HQ. Search hits: help desk 8, security analyst 7, data analyst 15 |
| AT&T | HIT, BI | `att/wd1/ATTGeneral` | 1178 | NYC and NJ. Search hits: help desk 21, security analyst 158, data analyst 179 |
| athenahealth | HIT | `athenahealth/wd1/External` | 86 | EHR vendor; EHR support roles, US remote. Search hits: help desk 2, security analyst 0, data analyst 12 |
| Avanade (Accenture) | HIT, CYB, BI | `accenture/wd103/AvanadeCareers` | 668 | Accenture's Microsoft-services subsidiary; the main AccentureCareers site answers 429 to API calls. Search hits: help desk 11, security analyst 38, data analyst 58 |
| Baker Tilly | CYB, BI | `bakertilly/wd5/BTCareers` | 441 | NYC office. Search hits: help desk 0, security analyst 4, data analyst 18 |
| Barclays | HIT, CYB, BI | `barclays/wd3/External_Career_Site_Barclays` | 690 | Per Scholas partner; US offices in NYC and Whippany NJ. Search hits: help desk 41, security analyst 39, data analyst 189 |
| Barnard College | HIT, BI | `barnard/wd1/Staff` | 39 | NYC. Search hits: help desk 0, security analyst 1, data analyst 6 |
| BlackRock | HIT, CYB, BI | `blackrock/wd1/BlackRock_Professional` | 286 | NYC HQ. Search hits: help desk 8, security analyst 9, data analyst 36 |
| Blackstone | BI | `blackstone/wd1/Blackstone_Careers` | 146 | NYC HQ; the probe's track searches on this tenant did not return (board total verified). Search hits: help desk 1, security analyst 3, data analyst 16 |
| BMO | HIT, CYB, BI | `bmo/wd3/External` | 984 | NYC office. Search hits: help desk 21, security analyst 16, data analyst 75 |
| Booz Allen Hamilton | CYB, BI | `bah/wd1/BAH_Jobs` | 2000 | NYC office; 1,111 security analyst search hits, many need a clearance. Search hits: help desk 37, security analyst 1109, data analyst 1167 |
| Bristol Myers Squibb | CYB, BI | `bristolmyerssquibb/wd5/BMS` | 663 | Lawrenceville and Princeton NJ. Search hits: help desk 47, security analyst 287, data analyst 287 |
| Broadridge | CYB, BI | `broadridge/wd5/Careers` | 313 | Lake Success NY and NYC. Search hits: help desk 6, security analyst 16, data analyst 73 |
| Brookfield | CYB, BI | `brookfield/wd5/brookfield` | 136 | NYC. Search hits: help desk 2, security analyst 20, data analyst 61 |
| Brown Brothers Harriman | CYB, BI | `bbh/wd5/BBH` | 185 | NYC HQ. Search hits: help desk 9, security analyst 45, data analyst 91 |
| Capital One | HIT, CYB, BI | `capitalone/wd12/Capital_One` | 1991 | NYC office; large cyber and data organizations. Search hits: help desk 33, security analyst 63, data analyst 267 |
| Carlyle | BI | `carlyle/wd1/Carlyle` | 77 | NYC and Washington DC. Search hits: help desk 3, security analyst 5, data analyst 15 |
| CDW | HIT, CYB, BI | `cdw/wd5/Careers` | 174 | NJ and NYC. Search hits: help desk 20, security analyst 10, data analyst 18 |
| Centene (Fidelis Care) | HIT, CYB, BI | `centene/wd5/Centene_External` | 340 | Fidelis Care is Centene's New York plan (Queens, Rego Park). Search hits: help desk 0, security analyst 14, data analyst 43 |
| CIBC | CYB, BI | `cibc/wd3/search` | 534 | NYC office. Search hits: help desk 421, security analyst 34, data analyst 122 |
| Cigna | CYB, BI | `cigna/wd5/cignacareers` | 527 | NYC and Bloomfield CT; remote-friendly. Search hits: help desk 9, security analyst 51, data analyst 190 |
| Circle | CYB, BI | `circle/wd1/Circle` | 59 | NYC, Boston and remote. Search hits: help desk 0, security analyst 4, data analyst 21 |
| Cisco | HIT, CYB, BI | `cisco/wd5/Cisco_Careers` | 1459 | NYC office. Search hits: help desk 39, security analyst 49, data analyst 51 |
| CrowdStrike | CYB, HIT | `crowdstrike/wd5/crowdstrikecareers` | 362 | US remote; moved here from Greenhouse. Search hits: help desk 13, security analyst 67, data analyst 45 |
| Crowe | CYB, BI | `crowe/wd12/External_Careers` | 170 | NYC office. Search hits: help desk 3, security analyst 4, data analyst 10 |
| CVS Health | HIT, CYB, BI | `cvshealth/wd1/CVS_Health_Careers` | 19643 | Aetna in NYC; IT, security and data teams, many remote. Search hits: help desk 75, security analyst 19, data analyst 77 |
| Dataminr | CYB, BI | `dataminr/wd12/Dataminr` | 25 | NYC HQ. Search hits: help desk 1, security analyst 4, data analyst 5 |
| Deutsche Bank | HIT, BI | `db/wd3/DBWebsite` | 1168 | NYC. Search hits: help desk 107, security analyst 158, data analyst 512 |
| Disney | HIT, CYB, BI | `disney/wd5/disneycareer` | 391 | NYC (ABC, ESPN, Disney Entertainment). Search hits: help desk 7, security analyst 4, data analyst 27 |
| DoubleVerify | HIT, BI | `doubleverify/wd5/DV_Careers` | 34 | NYC HQ. Search hits: help desk 6, security analyst 0, data analyst 6 |
| Dow Jones | HIT, CYB, BI | `dowjones/wd1/Dow_Jones_Career` | 257 | NYC HQ. Search hits: help desk 13, security analyst 5, data analyst 47 |
| EisnerAmper | BI | `eisneramper/wd1/EisnerAmper_External` | 153 | NYC HQ. Search hits: help desk 1, security analyst 0, data analyst 4 |
| Elevance Health | CYB, BI | `elevancehealth/wd1/ANT` | 248 | Empire BCBS in NYC; many remote US roles. Search hits: help desk 0, security analyst 3, data analyst 10 |
| Entrust | CYB, HIT | `entrust/wd1/EntrustCareers` | 92 | US remote. Search hits: help desk 6, security analyst 36, data analyst 20 |
| Equiniti | BI | `equiniti/wd3/Opportunities` | 66 | Per Scholas partner; small US footprint, mostly UK and India postings. Search hits: help desk 2, security analyst 0, data analyst 4 |
| Etsy | HIT, CYB, BI | `etsy/wd5/Etsy_Careers` | 71 | Brooklyn HQ. Search hits: help desk 4, security analyst 1, data analyst 11 |
| Everest | BI | `everestre/wd5/careers` | 47 | Warren NJ. Search hits: help desk 1, security analyst 2, data analyst 27 |
| FactSet | BI | `factset/wd108/FactSetCareers` | 91 | NYC and Norwalk CT. Search hits: help desk 3, security analyst 0, data analyst 18 |
| Federal Reserve System | CYB, BI | `rb/wd5/FRS` | 171 | Federal Reserve Bank of New York roles are on this site. Search hits: help desk 1, security analyst 20, data analyst 53 |
| FIS | CYB, BI | `fis/wd5/SearchJobs` | 525 | NYC and NJ. Search hits: help desk 8, security analyst 84, data analyst 59 |
| Fiserv | CYB, BI | `fiserv/wd5/EXT` | 351 | NJ offices. Search hits: help desk 0, security analyst 9, data analyst 21 |
| Fox Corporation | HIT, CYB, BI | `fox/wd1/Domestic` | 320 | NYC HQ. Search hits: help desk 9, security analyst 3, data analyst 30 |
| FTI Consulting | CYB, BI | `fticonsulting/wd108/FTIConsultingCareers` | 251 | NYC and Washington DC. Search hits: help desk 4, security analyst 4, data analyst 25 |
| GDIT | HIT, CYB, BI | `gdit/wd5/External_Career_Site` | 1260 | US-wide; help desk and SOC roles. Search hits: help desk 171, security analyst 484, data analyst 484 |
| Guardian Life | CYB, BI | `guardianlife/wd5/Guardian-Life-Careers` | 118 | NYC HQ. Search hits: help desk 3, security analyst 31, data analyst 88 |
| Guidehouse | HIT, CYB, BI | `guidehouse/wd1/External` | 793 | NYC office. Search hits: help desk 15, security analyst 325, data analyst 345 |
| Healthfirst | BI | `healthfirst/wd1/healthfirst` | 74 | NYC health plan; reporting and data analyst roles. Search hits: help desk 0, security analyst 1, data analyst 7 |
| Henry Schein | BI | `henryschein/wd1/External_Careers` | 245 | Melville, Long Island. Search hits: help desk 2, security analyst 0, data analyst 9 |
| Hewlett Packard Enterprise | HIT, CYB, BI | `hpe/wd5/Jobsathpe` | 1622 | US remote friendly. Search hits: help desk 67, security analyst 793, data analyst 803 |
| HP | HIT, CYB, BI | `hp/wd5/ExternalCareerSite` | 846 | US remote friendly. Search hits: help desk 19, security analyst 13, data analyst 103 |
| Humana | CYB, BI | `humana/wd5/Humana_External_Career_Site` | 268 | US remote friendly. Search hits: help desk 2, security analyst 13, data analyst 41 |
| Huron | CYB, BI | `huron/wd1/huroncareers` | 271 | NYC and Chicago. Search hits: help desk 8, security analyst 16, data analyst 84 |
| ICF | HIT, CYB, BI | `icf/wd5/ICFExternal_Career_Site` | 424 | NYC office; remote-friendly. Search hits: help desk 16, security analyst 75, data analyst 188 |
| iHeartMedia | HIT, BI | `iheartmedia/wd5/External_iHM` | 303 | NYC. Search hits: help desk 16, security analyst 0, data analyst 27 |
| Intel | CYB, BI | `intel/wd1/External` | 746 | US remote friendly. Search hits: help desk 10, security analyst 59, data analyst 246 |
| Invesco | CYB, BI | `invesco/wd1/IVZ` | 229 | NYC and Atlanta. Search hits: help desk 13, security analyst 13, data analyst 52 |
| JLL | HIT, BI | `jll/wd1/jllcareers` | 2000 | NYC; 314 help desk search hits. Search hits: help desk 315, security analyst 275, data analyst 275 |
| KeyBank | CYB, BI | `keybank/wd5/External_Career_Site` | 565 | Ohio and New York; remote-friendly. Search hits: help desk 0, security analyst 6, data analyst 65 |
| Kyndryl | HIT, CYB, BI | `kyndryl/wd5/KyndrylProfessionalCareers` | 872 | NYC HQ; 791 help desk search hits. Search hits: help desk 788, security analyst 415, data analyst 492 |
| Kyndryl Early Careers | HIT, CYB, BI | `kyndryl/wd5/KyndrylEarlyCareers` | 39 | Kyndryl's entry-level site. Search hits: help desk 39, security analyst 16, data analyst 24 |
| Leidos | HIT, CYB, BI | `leidos/wd5/External` | 2000 | US-wide, remote-friendly. Search hits: help desk 81, security analyst 649, data analyst 811 |
| M&T Bank | HIT, CYB, BI | `mtb/wd5/MTB` | 768 | Buffalo and NYC; many remote US roles. Search hits: help desk 6, security analyst 50, data analyst 143 |
| Mastercard | CYB, BI | `mastercard/wd1/CorporateCareers` | 1124 | Purchase NY; real run on 2026-10-20 returned NY analyst roles. Search hits: help desk 30, security analyst 134, data analyst 102 |
| McKesson | HIT, CYB, BI | `mckesson/wd3/External_Careers` | 683 | US remote friendly; service desk and security roles. Search hits: help desk 247, security analyst 71, data analyst 201 |
| Memorial Sloan Kettering | HIT, BI | `msk/wd108/MSKCC_Careers_Primary` | 137 | NYC; data and clinical systems roles. Search hits: help desk 2, security analyst 0, data analyst 18 |
| Merck | CYB, BI | `msd/wd5/SearchJobs` | 950 | Rahway NJ. Search hits: help desk 2, security analyst 11, data analyst 40 |
| Mimecast | CYB | `mimecast/wd5/Mimecast-Careers` | 70 | US remote. Search hits: help desk 3, security analyst 16, data analyst 25 |
| Mizuho Americas | HIT, CYB, BI | `mizuho/wd1/mizuhoamericas` | 120 | NYC HQ for the Americas. Search hits: help desk 3, security analyst 15, data analyst 50 |
| Montefiore Medical Center | HIT, BI | `montefiore/wd12/MMC` | 488 | Bronx; Montefiore's main Workday site (WP, Nyack, SLCH sites are regional hospitals). Search hits: help desk 1, security analyst 7, data analyst 37 |
| Morgan Stanley | HIT, CYB, BI | `ms/wd5/External` | 1249 | NYC HQ. Search hits: help desk 94, security analyst 21, data analyst 188 |
| MUFG | HIT, CYB, BI | `mufgub/wd3/MUFG-Careers` | 691 | NYC and Jersey City. Search hits: help desk 35, security analyst 117, data analyst 353 |
| Nasdaq | CYB, BI | `nasdaq/wd1/Global_External_Site` | 165 | NYC. Search hits: help desk 2, security analyst 23, data analyst 114 |
| Neuberger Berman | BI | `nb/wd1/NBCareers` | 93 | NYC HQ. Search hits: help desk 0, security analyst 3, data analyst 41 |
| NewYork-Presbyterian | HIT, BI | `nyp/wd1/nypcareers` | 346 | NYC hospital system; clinical systems and IT roles. Search hits: help desk 1, security analyst 0, data analyst 9 |
| NextGen Healthcare | HIT, BI | `nextgen/wd5/NextGen_Careers` | 33 | EHR vendor; US remote. Search hits: help desk 2, security analyst 5, data analyst 8 |
| NVIDIA | HIT, CYB, BI | `nvidia/wd5/NVIDIAExternalCareerSite` | 2000 | US remote friendly. Search hits: help desk 29, security analyst 63, data analyst 377 |
| Optiv | CYB | `optiv/wd5/Optiv_Careers` | 52 | MSSP; SOC analyst roles. Search hits: help desk 3, security analyst 10, data analyst 7 |
| PayPal | CYB, BI | `paypal/wd1/jobs` | 344 | NYC office; 235 security analyst search hits. Search hits: help desk 6, security analyst 234, data analyst 208 |
| Pfizer | CYB, BI | `pfizer/wd1/PfizerCareers` | 545 | NYC HQ. Search hits: help desk 1, security analyst 18, data analyst 126 |
| Proofpoint | CYB | `proofpoint/wd5/ProofpointCareers` | 120 | US remote; moved here from Greenhouse. Search hits: help desk 3, security analyst 9, data analyst 20 |
| Protiviti | CYB, BI | `roberthalf/wd1/ProtivitiNA` | 178 | Robert Half's consulting arm; NYC office. Search hits: help desk 0, security analyst 35, data analyst 51 |
| Prudential | CYB, BI | `pru/wd5/Careers` | 154 | Newark NJ. Search hits: help desk 4, security analyst 14, data analyst 26 |
| PVH | HIT, BI | `pvh/wd1/PVH_Careers` | 1568 | NYC HQ (Calvin Klein, Tommy Hilfiger). Search hits: help desk 13, security analyst 8, data analyst 49 |
| PwC | HIT, CYB, BI | `pwc/wd3/Global_Experienced_Careers` | 3859 | NYC HQ. Search hits: help desk 23, security analyst 80, data analyst 222 |
| PwC US Entry Level | CYB, BI | `pwc/wd3/US_Entry_Level_Careers` | 56 | PwC's US entry-level site. Search hits: help desk 0, security analyst 0, data analyst 0 |
| Rackspace | HIT, CYB | `rackspace/wd1/External` | 66 | US remote. Search hits: help desk 0, security analyst 24, data analyst 24 |
| Regeneron | BI | `regeneron/wd1/Careers` | 593 | Tarrytown NY. Search hits: help desk 2, security analyst 3, data analyst 29 |
| RSM | CYB, BI | `rsm/wd1/RSMCareers` | 672 | NYC office. Search hits: help desk 4, security analyst 14, data analyst 23 |
| S&P Global | CYB, BI | `spgi/wd5/SPGI_Careers` | 312 | NYC HQ. Search hits: help desk 6, security analyst 37, data analyst 184 |
| SailPoint | CYB, HIT | `sailpoint/wd1/SailPoint` | 102 | identity security; US remote. Search hits: help desk 29, security analyst 45, data analyst 41 |
| Salesforce | HIT, CYB, BI | `salesforce/wd12/External_Career_Site` | 1577 | NYC tower. Search hits: help desk 43, security analyst 24, data analyst 134 |
| Salesforce Futureforce | BI | `salesforce/wd12/Futureforce_NewGradRoles` | 30 | Salesforce new-grad roles. Search hits: help desk 0, security analyst 0, data analyst 0 |
| Santander | CYB | `santander/wd3/SantanderCareers` | 1042 | Santander US in Boston and NYC. Search hits: help desk 7, security analyst 22, data analyst 90 |
| Scholastic | HIT, BI | `scholastic/wd5/External` | 86 | NYC HQ. Search hits: help desk 3, security analyst 1, data analyst 3 |
| SHI | HIT, CYB, BI | `shi/wd12/shicareers` | 261 | Somerset NJ. Search hits: help desk 10, security analyst 26, data analyst 73 |
| Sprinklr | CYB, BI | `sprinklr/wd1/careers` | 69 | NYC HQ. Search hits: help desk 5, security analyst 5, data analyst 19 |
| SS&C Technologies | HIT, CYB, BI | `ssctech/wd1/SSCTechnologies` | 322 | NYC offices. Search hits: help desk 3, security analyst 19, data analyst 92 |
| State Street | CYB, BI | `statestreet/wd1/Global` | 1299 | Boston and NYC. Search hits: help desk 53, security analyst 222, data analyst 693 |
| Tapestry | HIT, CYB, BI | `tapestry/wd108/Tapestry_Careers` | 2000 | NYC HQ (Coach, Kate Spade). Search hits: help desk 4, security analyst 3, data analyst 10 |
| TD Bank | HIT, CYB, BI | `td/wd3/TD_Bank_Careers` | 1676 | NYC and NJ; 1,006 help desk search hits. Search hits: help desk 978, security analyst 119, data analyst 308 |
| The Hartford | HIT, CYB, BI | `thehartford/wd5/Careers_External` | 249 | NYC and Hartford. Search hits: help desk 29, security analyst 20, data analyst 97 |
| The New School | HIT | `newschool/wd1/External` | 187 | NYC; service desk roles. Search hits: help desk 5, security analyst 0, data analyst 0 |
| Thomson Reuters | BI | `thomsonreuters/wd5/External_Career_Site` | 483 | NYC office. Search hits: help desk 15, security analyst 16, data analyst 38 |
| TIAA | HIT, CYB, BI | `tiaa/wd1/Search` | 219 | NYC HQ. Search hits: help desk 5, security analyst 12, data analyst 34 |
| Travelers | HIT, CYB, BI | `travelers/wd5/External` | 391 | NYC and Hartford. Search hits: help desk 16, security analyst 22, data analyst 81 |
| Trellix | CYB | `trellix/wd1/EnterpriseCareers` | 62 | US remote. Search hits: help desk 1, security analyst 8, data analyst 7 |
| Trend Micro | CYB | `trendmicro/wd3/External` | 175 | US remote. Search hits: help desk 1, security analyst 20, data analyst 13 |
| Unisys | HIT, CYB, BI | `unisys/wd5/External` | 427 | US-wide service desk and security roles. Search hits: help desk 45, security analyst 43, data analyst 47 |
| Veradigm | HIT, BI | `veradigm/wd12/VR` | 127 | EHR vendor (formerly Allscripts); US remote. Search hits: help desk 1, security analyst 5, data analyst 26 |
| Visa | HIT, BI | `visa/wd5/Visa` | 844 | NYC office. Search hits: help desk 128, security analyst 30, data analyst 110 |
| Warner Bros. Discovery | CYB, BI | `warnerbros/wd5/global` | 283 | NYC offices. Search hits: help desk 20, security analyst 11, data analyst 59 |
| Warner Music Group | BI | `wmg/wd1/WMGUS` | 40 | NYC HQ. Search hits: help desk 0, security analyst 0, data analyst 12 |
| Wells Fargo | HIT, CYB, BI | `wf/wd1/WellsFargoJobs` | 1470 | NYC offices. Search hits: help desk 7, security analyst 37, data analyst 177 |
| WeWork | HIT | `wework/wd1/WeWork` | 71 | NYC HQ; 52 help desk search hits. Search hits: help desk 52, security analyst 0, data analyst 0 |
| Wiley | CYB, BI | `wiley/wd1/wiley_careers` | 75 | Hoboken NJ. Search hits: help desk 7, security analyst 6, data analyst 29 |
| Withum | BI | `withum/wd108/Withum_Careers_Page` | 92 | NJ and NYC. Search hits: help desk 0, security analyst 0, data analyst 1 |
| Workday | HIT, CYB, BI | `workday/wd5/Workday` | 374 | NYC office. Search hits: help desk 20, security analyst 76, data analyst 83 |

### Greenhouse, Lever and Ashby

| Employer | Tracks | ATS | Slug | Jobs | Notes |
|---|---|---|---|---|---|
| 1Password | CYB, BI | ashby | `1password` | 76 | Security Incident Response; Staff Data Analyst (remote, North America) |
| AQR Capital Management | HIT, CYB, BI | greenhouse | `aqr` | 56 | Desktop Support Engineer; Security Engineer, Associate; reporting roles (Greenwich CT, NYC) |
| Axonius | HIT, CYB, BI | greenhouse | `axonius` | 20 | Technical Support Engineer (SkillBridge); Cyber Data Analyst (NYC HQ) |
| Clover Health | BI | greenhouse | `cloverhealth` | 57 | Data Analyst, Clinical Data Effectiveness (remote) |
| Cohere | HIT | ashby | `cohere` | 116 | IT Support Specialist (NYC, Toronto, SF) |
| Cohere Health | BI | greenhouse | `coherehealth` | 76 | Business Intelligence Engineer; Lead Data Analyst (Boston, remote) |
| Compass | CYB | greenhouse | `urbancompass` | 210 | 16 security titles on the check date; EPM Systems Administrator (NYC) |
| Dashlane | CYB | greenhouse | `dashlane` | 15 | security engineering (NYC, Paris) |
| DoorDash | BI | greenhouse | `doordashusa` | 457 | Data Analyst, In-Store; Enterprise Support Specialist (NYC office) |
| Expel | CYB, HIT | greenhouse | `expel` | 8 | IT Support Specialist; managed detection and response SOC (US remote) |
| Flatiron Health | HIT, BI | greenhouse | `flatironhealth` | 21 | oncology data company, NYC; no analyst opening on the check date |
| Harvey | BI, HIT | ashby | `harvey` | 344 | CX Data Analyst; GTM Systems Administrator (NYC) |
| Huntress | CYB | greenhouse | `huntress` | 33 | Security Operations Analyst; SOC manager (US remote) |
| Komodo Health | HIT, BI | greenhouse | `komodohealth` | 23 | IT Analyst; healthcare data platform (NYC, SF) |
| Lucid Software | CYB, HIT | greenhouse | `lucidsoftware` | 32 | Security Analyst; Product Support Specialist (remote) |
| Lyft | CYB, BI | greenhouse | `lyft` | 179 | Security Analyst; Data Analyst (NYC office) |
| Newsela | BI | greenhouse | `newsela` | 12 | Educational Data Analyst (remote) |
| Oscar Health | CYB, BI | greenhouse | `oscar` | 248 | Staff Security Engineer, GRC; Credentialing Quality and Data Operations; People Analytics reporting (NYC) |
| Palantir | CYB | lever | `palantir` | 306 | Defensive Security Analyst (NYC, DC) |
| Paxos | HIT, CYB | ashby | `paxos` | 22 | Technical Support Engineer; Security Engineer, Detection and Response (NYC) |
| Payoneer | CYB, BI | greenhouse | `payoneer` | 102 | GRC Security Specialist; Finance reporting analyst (NYC) |
| Per Scholas | pool | greenhouse | `perscholashires` | 37 | pool only: Per Scholas' own roles, including instructional assistants for the IT Support and Cyber tracks |
| Point72 | HIT, CYB, BI | greenhouse | `point72` | 215 | AV Support Specialist; Identity and Access Management Business Analyst; Fund Reporting Analyst (NYC, Stamford) |
| Recorded Future | CYB | greenhouse | `recordedfuture` | 48 | Threat Intelligence Response Analyst (remote) |
| SeatGeek | HIT, BI | greenhouse | `seatgeek` | 38 | Helpdesk Automation Engineer; Data Analyst (NYC) |
| SecurityScorecard | CYB | greenhouse | `securityscorecard` | 12 | NYC-headquartered security ratings company |
| Sierra | HIT | ashby | `sierra` | 189 | IT Support Specialist (SF, NYC) |
| Sigma Computing | HIT | greenhouse | `sigmacomputing` | 77 | Technical Support Engineer (NYC, SF) |
| Squarespace | CYB | greenhouse | `squarespace` | 26 | GRC Analyst; Security Engineer, Incident Response (NYC) |
| Taboola | HIT, BI | greenhouse | `taboola` | 86 | Technical Support Engineer; Senior Data Analyst (NYC) |
| Talkspace | BI | greenhouse | `talkspace` | 24 | Data Analyst (NYC) |
| Vanta | HIT, CYB | ashby | `vanta` | 85 | Technical Support Engineer; GRC engineering (NYC, SF) |
| Veeva Systems | BI | lever | `veeva` | 933 | Data Analyst, Pioneer (new-grad program, US remote) |
| Wiz | CYB | greenhouse | `wizinc` | 123 | cloud security; NYC HQ (replaces the dead greenhouse 'wiz' in the cyber pack) |
| Zeta Global | CYB, BI | greenhouse | `zetaglobal` | 128 | Sr. Systems Administrator; Application Security; Senior Data Analyst (NYC) |
| Zocdoc | HIT, BI | greenhouse | `zocdoc` | 59 | Specialist, Technical Support; Provider Data Operations (NYC) |

Already in the pool before this migration and now listed in the packs: Datadog (greenhouse `datadog`,
434 jobs), Cloudflare (`cloudflare`, 439), Okta (`okta`, 395),
MongoDB (`mongodb`, 394), Betterment (`betterment`, 24).

Total verified employers across the three tracks: 162
(125 Workday career sites on 121 tenants, 36 Greenhouse/Lever/Ashby boards, 5 already in the pool).

## 2. Per Scholas partners and advisory board that are not on a supported ATS

| Employer | What was found | Status |
|---|---|---|
| TEKsystems / Allegis Group | careers-*.icims.com (iCIMS) | unsupported ATS |
| Columbia University | TalentLink (careers.columbia.edu); CUIMC also on TalentLink | unsupported ATS |
| Nomura | careers.nomura.com, in-house portal | no public JSON board |
| Nagarro | nagarro.com job portal, in-house | no public JSON board |
| Bloomberg | bloomberg.avature.net (Avature); the `bloomberg` Workday tenant is only Bloomberg Industry Group (the Arlington VA legal and tax news unit), not Bloomberg LP's NYC hiring | unsupported ATS |
| Wayfair | wayfair.com/careers; `wayfair`, `wayfaircareers`, `wayfairllc` 404 on Greenhouse, Lever and Ashby | not verified |
| People Shores, TOGA Technology | no careers portal found | not verified |
| NYU Langone Health | jobs.nyulangone.org (in-house); no Workday tenant answered | no public JSON board |
| Mount Sinai Health System | careers.mountsinai.org (in-house); the `msmc` Workday tenant is Mount Sinai Medical Center in Miami Beach FL, a different hospital | no public JSON board |
| Northwell Health | jobs.northwell.edu (in-house ATS) | no public JSON board |
| NYC Health + Hospitals | no Workday tenant found; the `hhc` Workday tenant is Houston Healthcare (Warner Robins GA), a different system | not verified |
| Mercy University | no Workday tenant found; the `mercy` Workday tenant is the Mercy health system (St. Louis, Arkansas, Oklahoma) | not verified |

Barclays, Equiniti, Avanade (Accenture), NewYork-Presbyterian, Montefiore and Memorial Sloan
Kettering do run Workday and are in section 1. Accenture's own AccentureCareers site
answers HTTP 429 to API calls from a non-browser client, so only Avanade is included.

## 3. Re-verification of every active `target_companies` row

241 distinct active (ats_type, slug) pairs were read from prod (read-only) and probed.
Live with jobs: 170. Live but empty on the check date (left active):
ashby `confluent`, ashby `deel`, ashby `paragon`, ashby `rutter`, ashby `vercel`, ashby `wiz`, greenhouse `apollo`, greenhouse `iterable`, greenhouse `merge`, greenhouse `webflow`, lever `kraken`, lever `mistral`.
Dead (HTTP 404), deactivated by the migration: 59.

| ATS | Slug | Name | Result | Disposition |
|---|---|---|---|---|
| ashby | `Anthropic` | Anthropic | 404 | duplicate: live greenhouse `anthropic` already in pool |
| ashby | `beehiiv` | beehiiv | 404 | no board found on Greenhouse, Lever or Ashby |
| ashby | `framer` | Framer | 404 | no board found on Greenhouse, Lever or Ashby |
| ashby | `laceworks` | Laceworks | 404 | misspelled duplicate of lacework; acquired by Fortinet |
| ashby | `loop` | Loop Returns | 404 | moved: inserted lever `loopreturns` (4 jobs) |
| ashby | `lottiefiles` | LottieFiles | 404 | moved: inserted ashby `lottie` (5 jobs) |
| ashby | `newfront` | Newfront | 404 | no board found on Greenhouse, Lever or Ashby |
| ashby | `ona` | Gitpod | 404 | Gitpod rebranded to Ona; no board found on a supported ATS |
| ashby | `puzzle.io` | Puzzle | 404 | no board found on Greenhouse, Lever or Ashby |
| ashby | `readai` | Read AI | 404 | moved: inserted ashby `read-ai` (17 jobs) |
| ashby | `replicate` | Replicate | 404 | no board found on Greenhouse, Lever or Ashby |
| ashby | `whatnot` | Whatnot | 404 | no board found on Greenhouse, Lever or Ashby |
| greenhouse | `amplitude` | Amplitude | 404 | moved: inserted ashby `amplitude` (42 jobs) |
| greenhouse | `check` | Check | 404 | moved: inserted ashby `check-technologies` (18 jobs) |
| greenhouse | `clickhouse` | ClickHouse | 404 | moved: inserted ashby `clickhouse` (202 jobs) |
| greenhouse | `crowdstrike` | CrowdStrike | 404 | moved: inserted workday `crowdstrike/wd5/crowdstrikecareers` (362 jobs) |
| greenhouse | `dbtlabsinc` | Dbt Labs | 404 | no board found on Greenhouse, Lever or Ashby |
| greenhouse | `devoted` | Devoted Health | 404 | no board found on Greenhouse, Lever or Ashby |
| greenhouse | `doordash` | DoorDash | 404 | moved: inserted greenhouse `doordashusa` (457 jobs) |
| greenhouse | `fireworksai` | Fireworks AI | 404 | moved: inserted ashby `fireworks` (90 jobs) |
| greenhouse | `fullstory` | FullStory | 404 | moved: inserted ashby `fullstory` (10 jobs) |
| greenhouse | `gorgias` | Gorgias | 404 | moved: inserted ashby `gorgias` (16 jobs) |
| greenhouse | `hackerone` | HackerOne | 404 | moved: inserted ashby `hackerone` (7 jobs) |
| greenhouse | `headway` | Headway | 404 | moved: inserted ashby `headway` (89 jobs) |
| greenhouse | `hightouch` | Hightouch | 404 | moved: inserted ashby `hightouch` (1 jobs) |
| greenhouse | `hingehealth` | Hinge Health | 404 | moved: inserted ashby `hinge-health` (73 jobs) |
| greenhouse | `hotjar` | Hotjar | 404 | merged into Contentsquare; no public board on a supported ATS |
| greenhouse | `hubspot` | HubSpot | 404 | moved: inserted greenhouse `hubspotjobs` (19 jobs) |
| greenhouse | `invision` | InVision | 404 | InVision shut down its product (2024) |
| greenhouse | `lacework` | Lacework | 404 | acquired by Fortinet (2024); careers folded into Fortinet |
| greenhouse | `linear` | Linear | 404 | duplicate: live ashby `linear` already in pool |
| greenhouse | `loom` | Loom | 404 | acquired by Atlassian (2023); Ashby board exists but is empty |
| greenhouse | `lucidchart` | Lucidchart | 404 | moved: inserted greenhouse `lucidsoftware` (32 jobs) |
| greenhouse | `maze` | Maze | 404 | no board found on Greenhouse, Lever or Ashby |
| greenhouse | `miro` | Miro | 404 | moved: inserted ashby `miro` (22 jobs) |
| greenhouse | `mutiny` | Mutiny | 404 | moved: inserted ashby `mutiny` (8 jobs) |
| greenhouse | `notion` | Notion | 404 | duplicate: live ashby `notion` already in pool |
| greenhouse | `oscarhealth` | Oscar Health | 404 | moved: inserted greenhouse `oscar` (248 jobs) |
| greenhouse | `plaid` | Plaid | 404 | moved: inserted ashby `plaid` (129 jobs) |
| greenhouse | `privy` | Privy | 404 | acquired by Attentive; Attentive hires on Greenhouse (attentive) |
| greenhouse | `proofpoint` | Proofpoint | 404 | no Workday tenant or Greenhouse/Lever/Ashby board found |
| greenhouse | `ramp` | Ramp | 404 | duplicate: live ashby `ramp` already in pool |
| greenhouse | `retool` | Retool | 404 | no board found on Greenhouse, Lever or Ashby |
| greenhouse | `scale` | Scale AI | 404 | duplicate: live greenhouse `scaleai` already in pool |
| greenhouse | `sentinelone` | SentinelOne | 404 | no Workday tenant or Greenhouse/Lever/Ashby board found |
| greenhouse | `snyk` | Snyk | 404 | moved: inserted ashby `snyk` (28 jobs) |
| greenhouse | `sumo` | Sumo Logic | 404 | moved: inserted greenhouse `sumologic` (12 jobs) |
| greenhouse | `temporaltechnologies` | Temporal | 404 | moved: inserted ashby `temporal` (73 jobs) |
| greenhouse | `wayve` | Wayve | 404 | moved: inserted ashby `wayve` (173 jobs) |
| greenhouse | `wix` | Wix | 404 | Wix runs its own careers site |
| lever | `clearbit` | Clearbit | 404 | acquired by HubSpot (2023) |
| lever | `huggingface` | Hugging Face | 404 | moved to Workable (unsupported) |
| lever | `mercury` | Mercury | 404 | duplicate: live greenhouse `mercury` already in pool |
| lever | `netflix` | Netflix | 404 | moved to its own Eightfold-based site (unsupported) |
| lever | `plaid` | Plaid | 404 | moved: inserted ashby `plaid` (129 jobs) |
| lever | `substack` | Substack | 404 | duplicate: live ashby `substack` already in pool |
| lever | `threatlocker` | ThreatLocker | 404 | no board found on a supported ATS |
| lever | `vercel` | Vercel | 404 | duplicate: live greenhouse `vercel` already in pool |
| lever | `wise` | Wise | 404 | Wise moved to its own careers site; the Greenhouse board named 'wise' is an unrelated insurance sales company |

## 4. Workday notes

- Tenant discovery: `https://<tenant>.<wdN>.myworkdayjobs.com/robots.txt` answers 200 with one
  `Allow: /<site>/` line per public career site when the tenant exists on that data center, and
  HTTP 422 otherwise. Send `Accept: */*`: with `Accept: application/json` the same URL answers 406
  for every tenant, which made a first probe report zero tenants. The probe tried wd1, wd3, wd5,
  wd12, wd101 to wd105 and wd108 for each guessed tenant name.
- The jobs API caps `limit` at 20 and ANDs every word of `searchText` across title and description,
  so the scraper searches per user title and reads the first page only.
- Some tenants sit behind a WAF that answers 429 to non-browser user agents (Accenture); the
  scraper presents a browser UA, retries one 429 and then skips the tenant for the run.
- Identity check: on 2026-10-21 the first 40 postings of every site (blank search and "new york")
  were tallied by location to confirm each tenant is the employer we think it is. That removed
  four sites the name guess got wrong: `hhc/wd5/HHC` (Houston Healthcare, Georgia),
  `mercy/wd1/mercycareers` (Mercy health system, Missouri), `bdo/wd3/BDO` (BDO Canada) and
  `njit/wd108/NJIT_Careers` (building names only, no city).
- Location strings are free text per tenant. NYC employers write "NYC - 1211 Ave of the Americas",
  "NYC Global HQ", "New York, 745 7th Avenue", NYP campus names or bare Bronx street addresses, so
  `tag_nyc()` in `workday.py` appends "(New York, NY)" to those before the location filter runs.
- Employers whose guessed tenant names did not answer on any data center (not on Workday, or a tenant name we did not guess): ADP, AMD, Adecco, Adelphi University, Aetna, Akamai, Akkodis, AlixPartners, AllianceBernstein, Allianz, Altice USA, AmTrust, American Express, Aon, Apex Systems, Apollo Global, Armis, Atlantic Health System, Atlassian, BCG, BNP Paribas, BNY, Bain, Bank of America, Bard, BeyondTrust, Boston Scientific, BronxCare, CACI, CBIZ, CBRE, Capgemini, Catholic Health LI, Charter, Check Point, Chubb, Citi, Citizens, CityMD / Summit Health, Claroty, Cognizant, Colgate-Palmolive, Collabera, Columbia (CUIMC), Columbia University, Comcast, Compass, Computershare, Con Edison, Conde Nast, ConnectWise, Cooper Union, Coty, Credit Agricole, Crown Castle, Cushman & Wakefield, CyberArk, Cybereason, DTCC, DXC, Darktrace, Datadog, Delinea, Dell, Deloitte, Delta, Digital Realty, Discover, Donnelley Financial, Dragos, Dynatrace, EPAM, EY, EmblemHealth, Endava, Equitable, Estee Lauder, Evercore, Exabeam, F5, Fireblocks, Fitch, Fordham University, Forescout, Fortinet, GE HealthCare, Gemini, General Atlantic, Globant, Goldman Sachs, Grant Thornton, Grubhub, HCLTech, HSBC, Hackensack Meridian Health, Hays, Hearst, Hofstra University, Hospital for Special Surgery, Hunter / CUNY, IAC / Dotdash Meredith, IBM, ICE / NYSE, Imperva / Thales, Infor, Insight, Insight Global, Intuit, Iona, Ivanti, JPMorgan Chase, Jefferies, JetBlue, Johnson & Johnson, Judge Group, Juilliard, KKR, KPMG, Kaplan, Kaseya, Kean, Kearney, Kelly, Kforce, Kroll, L'Oreal, LIU, LTIMindtree, Lazard, Lincoln Financial, Lumen, MJHS, MSCI, MTA, Macquarie, Macy's, Maimonides, ManTech, Manhattan University, ManpowerGroup, Marist, Markel, Marsh McLennan, Mastech, Maximus, McGraw Hill, McKinsey, Medidata, MetLife, MetroPlus, Michael Page, Molina Healthcare, Molloy, MongoDB, Moody's, Motion Recruitment, Mount Sinai Health System, Mphasis, Munich Re, N-able, NBCUniversal, NTT DATA, NYU Langone Health, Nagarro, NatWest, National Grid, Netskope, New York Blood Center, New York Life, NinjaOne, Nomura, Northwell Health, Nuvance Health, Nuveen, Oliver Wyman, One Brooklyn Health, One Medical, Optum / UnitedHealth, Oracle, Oscar Health, Outbrain, PGIM, PIMCO, PSEG, Palo Alto Networks, Paramount, Paxos, Paychex, Payoneer, Pearson, Peloton, Penguin Random House, People Shores, PepsiCo, Per Scholas, Peraton, Perficient, Ping Identity, Pratt, Presidio, Princeton, Protiviti, Publicis Sapient, Quest Diagnostics, RPI, RWJBarnabas Health, Ralph Lauren, Randstad, Rapid7, Related, Rockefeller University, Rowan, Rutgers, SAIC, SBH Health System, SMBC, SUNY, SVA, Scotiabank, Secureworks, Securonix, SentinelOne, ServiceNow, Seton Hall, Siemens Healthineers, SiriusXM, Slalom, Societe Generale, SolarWinds, Sompo, Sony, Sophos, Splunk, Spotify, Squarespace, Stamford Health, Standard Chartered, Stefanini, Stifel, Stony Brook Medicine, Sumo Logic, Swiss Re, Synchrony, Syracuse, T-Mobile, TCS, TEKsystems / Allegis, TOGA Technology, TPG, Taboola, Tanium, Tech Mahindra, Teladoc, Tenable, Thermo Fisher, Thoughtworks, Tiffany, Tishman Speyer, Touro, Trace3, Trustwave, UBS, UiPath, United Airlines, Varonis, Vectra, Verizon, Virtusa, Voya, W. R. Berkley, WTW, WWT, Wagner, Walgreens, Warburg Pincus, Wayfair, Webster Bank, Weill Cornell Medicine, West Monroe, White Plains Hospital, Wipro, Yale, Yale New Haven Health, Yeshiva University, Yext, Zeta Global, Zscaler, Zurich NA.

## 5. How to re-check

```
# Workday: total postings for a site
curl -s -X POST 'https://<tenant>.<wdN>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs' \
  -H 'Content-Type: application/json' -H 'User-Agent: Mozilla/5.0' \
  -d '{"appliedFacets":{},"limit":20,"offset":0,"searchText":""}' | jq .total
# Greenhouse / Lever / Ashby
curl -s https://boards-api.greenhouse.io/v1/boards/<slug>/jobs | jq '.jobs | length'
curl -s 'https://api.lever.co/v0/postings/<slug>?mode=json' | jq length
curl -s https://api.ashbyhq.com/posting-api/job-board/<slug> | jq '.jobs | length'
```
