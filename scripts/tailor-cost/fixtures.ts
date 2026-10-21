// Fixture resume and job description for the tailor cost measurement.
//
// Written to look like the incoming Per Scholas NY cohort: an entry-level
// candidate from the AI-Enabled Healthcare IT Technician track applying to a
// hospital help desk role in New York City. Lengths are typical of what the
// route sees (a one-page resume, a full ATS job posting), because token
// counts, not prose quality, are what this fixture is for. Every figure in
// the resume is deliberate so output-guard's invented-figure check has real
// numbers to match against.

export const RESUME = `
JORDAN ALVAREZ
Bronx, NY | (347) 555-0142 | jordan.alvarez@example.com | linkedin.com/in/jordanalvarez-it

SUMMARY
Help desk and desktop support technician, CompTIA A+ certified, graduate of
the Per Scholas AI-Enabled Healthcare IT Technician program (New York, 2026).
Four years of customer-facing experience before moving into IT, which shows
in how I handle a frustrated nurse at 6 am. Comfortable with Windows 10/11,
Active Directory, Microsoft 365, ticketing systems, and the HIPAA rules that
govern touching a clinical workstation.

CERTIFICATIONS
CompTIA A+ (2026)
Google IT Support Professional Certificate (2025)
HIPAA Awareness for Healthcare IT, Per Scholas (2026)

TECHNICAL TRAINING
Per Scholas, AI-Enabled Healthcare IT Technician, New York, NY (Feb 2026 to Jun 2026)
- 15 week, 600 hour program covering hardware, networking, Windows and Linux
  administration, Active Directory, Microsoft 365, healthcare IT workflows,
  and AI-assisted troubleshooting tools.
- Resolved 140 simulated help desk tickets in the program's ServiceNow lab,
  closing 92% within the first contact.
- Built a 6 machine Active Directory lab: domain join, group policy, password
  resets, and account lockout troubleshooting.
- Capstone: documented a device refresh runbook for a 40 workstation clinic
  floor, covering imaging, Epic client install, and asset tagging.
- Worked a 2 week rotation on the help desk of a Bronx federally qualified
  health center, shadowing a desktop support team of 3.

EXPERIENCE
Shift Lead, Walgreens, Bronx, NY (Mar 2022 to Jan 2026)
- Ran front of store and photo kiosk operations for a location serving about
  1,200 customers a day, and was the first call when a register, label
  printer, or kiosk went down.
- Trained 11 new hires on point of sale and inventory scanner workflows.
- Cut shrink in the photo department by 18% over one year by tightening the
  claim and pickup process.

Customer Service Representative, Spectrum (call center), New York, NY (Jun 2021 to Feb 2022)
- Handled 60 to 80 inbound calls a day for internet and TV customers,
  walking people through modem resets, Wi-Fi setup, and billing questions.
- Held a 4.7 out of 5 customer satisfaction score across 9 months.

SKILLS
Windows 10/11, macOS basics, Active Directory, Microsoft 365 admin center,
Outlook and Teams support, ServiceNow, Jira Service Management, TCP/IP, DNS,
DHCP, VPN troubleshooting, printer and peripheral support, hardware repair,
imaging (SCCM basics), remote support (TeamViewer, Quick Assist), HIPAA,
Epic client installation (training lab), Spanish (fluent).

EDUCATION
Bronx Community College, coursework toward A.A.S. in Computer Information
Systems, 2020 to 2021.
`.trim();

export const JOB_DESCRIPTION = `
IT Help Desk Technician I
Harborview Health System, New York, NY (on site, Manhattan and Bronx campuses)
Full time, non-exempt. $52,000 to $60,000 a year plus shift differential.

About the team
Harborview Health System runs two hospitals and 14 outpatient clinics across
Manhattan and the Bronx. The IT Service Desk is the single point of contact
for about 9,000 clinical and administrative staff. We take roughly 1,100
tickets a week across phone, chat, and a ServiceNow portal, and we are
growing the desk from 12 to 16 technicians this quarter.

What you will do
- Provide first level technical support to physicians, nurses, and staff by
  phone, chat, email, and in person, with a focus on clear communication with
  people who are busy and sometimes stressed.
- Log, prioritize, and route incidents and requests in ServiceNow, meeting
  documentation standards so the next technician can pick up where you left
  off.
- Resolve common issues on the first contact: password resets and account
  unlocks in Active Directory, Microsoft 365 and Outlook problems, printer
  and scanner issues, VPN and Wi-Fi connectivity, and basic Epic client
  errors.
- Image, deploy, and swap Windows 11 workstations, laptops, and workstations
  on wheels using SCCM and our asset management system.
- Follow HIPAA and information security policies when handling devices and
  accounts that touch patient data, and escalate anything that looks like a
  security incident the same hour.
- Take part in a rotating on call schedule, including some weekend and
  overnight shifts.

What we are looking for
- CompTIA A+ or equivalent, or completion of a recognized IT support training
  program such as Per Scholas, Year Up, or NPower.
- Hands on experience with Windows 10/11, Active Directory, and Microsoft 365
  in a work, lab, or training setting.
- Experience with a ticketing system (ServiceNow preferred).
- Customer service experience. We care more about how you treat a frustrated
  caller than about how many certifications you hold.
- Ability to lift 40 pounds and move equipment between floors.

Nice to have
- Exposure to Epic or another electronic health record system.
- Spanish or another second language.
- CompTIA Network+ or Security+, or interest in earning one (we pay for
  exams after 6 months).

Why Harborview
Union position (1199SEIU) with health coverage from day one, pension
contributions, tuition assistance after one year, and a defined path from
Technician I to II to Desktop Support Engineer. Many of our Tier 2 engineers
and two of our service desk managers started in this role.

Harborview Health System is an equal opportunity employer.
`.trim();

export const ROLE = "IT Help Desk Technician I";
export const COMPANY = "Harborview Health System";
