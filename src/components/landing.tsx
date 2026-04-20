import Link from "next/link";
import { ThemeToggle } from "./theme-toggle";

export function Landing() {
  return (
    <>
      <SvgDefs />
      <div className="shell shell--wide">
        <Header />
        <Hero />
        <Blocks />
        <HouseRules />
        <CTA />
        <Footer />
      </div>
    </>
  );
}

function Header() {
  return (
    <header className="flex items-center justify-between mb-12">
      <div className="cb-brand">
        <div className="hdr-mark">
          <svg width={14} height={14} aria-hidden>
            <use href="#ic-mark" />
          </svg>
        </div>
        <div>
          <div className="cb-brand__name">Autopilot</div>
          <div className="cb-brand__sub">Job search, automated</div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <ThemeToggle />
        <Link href="/login" className="cb-btn">
          Sign in
        </Link>
        <Link href="/signup" className="cb-btn cb-btn--solid">
          Get started
        </Link>
      </div>
    </header>
  );
}

function Hero() {
  return (
    <section
      className="relative overflow-hidden mb-9"
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--rl)",
        background: "var(--bg)",
      }}
    >
      <div className="hero-canvas">
        <div className="scan-anim" />
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="100%"
          height="100%"
          aria-hidden
        >
          <defs>
            <pattern id="ap-grid" width="32" height="32" patternUnits="userSpaceOnUse">
              <path
                d="M 32 0 L 0 0 0 32"
                fill="none"
                stroke="currentColor"
                strokeWidth=".5"
                opacity=".12"
              />
            </pattern>
          </defs>
          <rect width="100%" height="100%" fill="url(#ap-grid)" color="var(--tx)" />
          <g transform="translate(58%,50%)">
            <circle className="pr1" cx="0" cy="0" fill="none" stroke="#1F51FF" strokeWidth=".6" />
            <circle className="pr2" cx="0" cy="0" fill="none" stroke="#1F51FF" strokeWidth=".6" />
            <circle className="pr3" cx="0" cy="0" fill="none" stroke="#1F51FF" strokeWidth=".6" />
            <circle className="pr4" cx="0" cy="0" fill="none" stroke="#f5a623" strokeWidth=".5" />
            <circle className="pr5" cx="0" cy="0" fill="none" stroke="#00cc55" strokeWidth=".5" />
            <circle cx="0" cy="0" r="3" fill="#1F51FF" opacity=".75" />
          </g>
          <g className="fn1">
            <circle cx="16%" cy="34%" r="3" fill="none" stroke="#1F51FF" strokeWidth=".9" opacity=".5" />
          </g>
          <g className="fn2">
            <circle cx="22%" cy="68%" r="2" fill="none" stroke="#f5a623" strokeWidth=".9" opacity=".45" />
          </g>
          <g className="fn3">
            <circle cx="40%" cy="22%" r="2.5" fill="none" stroke="#00cc55" strokeWidth=".9" opacity=".4" />
          </g>
          <line x1="16%" y1="34%" x2="22%" y2="68%" stroke="#1F51FF" strokeWidth=".5" opacity=".22" />
          <line x1="22%" y1="68%" x2="40%" y2="22%" stroke="#f5a623" strokeWidth=".5" opacity=".22" />
          <text x="6" y="16" fontFamily="monospace" fontSize="9" fill="#1F51FF" opacity=".4">
            AUTOPILOT / JOBS — INDEX 003
          </text>
          <text x="6" y="194" fontFamily="monospace" fontSize="9" fill="#1F51FF" opacity=".4">
            queue: idle · pipeline: live · key: shared
          </text>
        </svg>
      </div>

      <div className="px-10 py-12 md:px-14 md:py-14 sm:px-6 sm:py-8">
        <div className="pill mb-5">
          <span className="pill-dot" />
          AUTOPILOT · 003 ACTIVE
        </div>
        <h1
          className="font-semibold mb-4"
          style={{
            fontSize: "clamp(36px, 5vw, 56px)",
            letterSpacing: "-0.04em",
            lineHeight: 1.04,
          }}
        >
          Apply to the right jobs,<br />not every job.
        </h1>
        <p
          className="mb-8"
          style={{
            fontSize: "16px",
            color: "var(--tx2)",
            lineHeight: 1.7,
            maxWidth: "640px",
          }}
        >
          A daily scrape across selectable sources, each role scored against your resume.
          Cover letters, bullets, and prep written from your real wins, never invented.
        </p>
        <div className="flex flex-wrap items-center gap-3 mb-8">
          <Link href="/signup" className="cb-btn cb-btn--solid">
            Start free
          </Link>
          <Link href="/login" className="cb-btn">
            I have an account
          </Link>
          <span className="mono text-[10px] uppercase tracking-widest" style={{ color: "var(--tx3)" }}>
            No credit card · BYOK supported
          </span>
        </div>
        <div className="hero-stats">
          <div className="stat">
            <div className="stat-num">05</div>
            <div className="stat-label">Selectable Sources</div>
          </div>
          <div className="stat">
            <div className="stat-num">09</div>
            <div className="stat-label">Outputs Per Role</div>
          </div>
          <div className="stat">
            <div className="stat-num">500w</div>
            <div className="stat-label">Cover Letter</div>
          </div>
        </div>
      </div>
    </section>
  );
}

type BlockSpec = {
  color: "blue" | "green" | "orange" | "accent";
  tag: string;
  meta: string;
  title: string;
  desc: string;
  icon: string;
  status?: { label: string; live?: boolean };
};

const BLOCKS: BlockSpec[] = [
  {
    color: "blue",
    tag: "MATCH 01",
    meta: "Verdict · Strengths · Gaps",
    title: "Match score with honest gaps",
    desc:
      "Each role gets a 0 to 100 score against your resume with a rubric-backed read. Apply, stretch, or skip. No cheerleading.",
    icon: "ic-spark",
    status: { label: "Live · cached by resume + job", live: true },
  },
  {
    color: "blue",
    tag: "WRITE 02",
    meta: "5 paragraphs · Hook → Close",
    title: "500-word cover letter, impact-positioned",
    desc:
      "Hook, proof, pattern, fit, close. Built from the resume, the JD, and the tone you set. No filler, no em-dashes, no invented metrics.",
    icon: "ic-code",
  },
  {
    color: "green",
    tag: "WRITE 03",
    meta: "5 rewrites · originals preserved",
    title: "Resume bullets, reweighted to the role",
    desc:
      "Five of your most relevant bullets rewritten to lead with outcome. Originals shown side by side so nothing gets fabricated behind your back.",
    icon: "ic-grid",
  },
  {
    color: "orange",
    tag: "ATS 04",
    meta: "10 to 15 keywords · truthful insertions",
    title: "ATS keyword gap analysis",
    desc:
      "What an applicant tracker would score you on. Where the resume is quiet, you see it explicitly so you can close the gap or skip the role.",
    icon: "ic-grid",
  },
  {
    color: "blue",
    tag: "PREP 05",
    meta: "8 likely Qs · 4 sharp asks",
    title: "Interview prep with STAR seeds",
    desc:
      "Eight questions you are likely to be asked, each with a STAR answer seeded from your real bullets. Plus four questions sharp enough to read the room.",
    icon: "ic-clock",
  },
  {
    color: "orange",
    tag: "STRAT 06",
    meta: "Lead role · Bridge title · Salary lens",
    title: "Strategy and positioning",
    desc:
      "Which role to lead with, which to downplay, the title-bridging language to use, and a lens on where this role lands against your salary floor.",
    icon: "ic-spark",
  },
  {
    color: "green",
    tag: "REACH 07",
    meta: "DM · Follow-up · Cold email",
    title: "Referral and recruiter outreach",
    desc:
      "A connection note, a follow-up DM after seven days of silence, and a cold email to the hiring manager. Each one scoped to a single ask.",
    icon: "ic-code",
  },
  {
    color: "accent",
    tag: "FILTER 08",
    meta: "Ghost · Repost · Red flag",
    title: "JD hygiene check",
    desc:
      "Catches reposted reqs, ghost listings, and red-flag language before you spend an hour writing toward a job that does not really exist.",
    icon: "ic-grid",
  },
  {
    color: "blue",
    tag: "SHORT 09",
    meta: "110 to 140 words · one ask",
    title: "Short form message",
    desc:
      "A LinkedIn DM or recruiter email tight enough to read on a phone, with one scoped ask. Pairs with the cover letter, never duplicates it.",
    icon: "ic-spark",
  },
];

function Blocks() {
  return (
    <section className="mb-12">
      <div className="section-label">What it generates per role</div>
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
        {BLOCKS.map((b) => (
          <Link
            key={b.tag}
            href="/signup"
            className={`course ${b.color === "accent" ? "" : b.color}`}
          >
            <div className="course-stripe" />
            <div className="course-head">
              <div className="course-icon">
                <svg aria-hidden>
                  <use href={`#${b.icon}`} />
                </svg>
              </div>
              <span className="course-code-tag">{b.tag}</span>
              {b.status && (
                <span className={`course-status ${b.status.live ? "live" : ""}`}>
                  <span className="dot" />
                  {b.status.label}
                </span>
              )}
            </div>
            <div className="course-name">{b.title}</div>
            <div className="course-desc">{b.desc}</div>
            <div className="course-meta-row">{b.meta}</div>
          </Link>
        ))}
      </div>
    </section>
  );
}

function HouseRules() {
  const rules: { num: string; title: string; desc: string }[] = [
    {
      num: "01",
      title: "Truthful by default",
      desc:
        "Every number, every claim, every bullet is traceable to your resume. No invented metrics, ever.",
    },
    {
      num: "02",
      title: "Streamed in parallel",
      desc:
        "Nine outputs per role, generated together over SSE. You see the first block before the last one starts.",
    },
    {
      num: "03",
      title: "Bring your own key",
      desc:
        "Free tier shares an Anthropic pool with a daily cap. Add your key in Settings to remove the cap entirely.",
    },
    {
      num: "04",
      title: "Cached, not recomputed",
      desc:
        "Match scores are keyed by resume hash plus job. Reopen a role and the score loads instantly instead of re-billing.",
    },
  ];
  return (
    <section className="mb-12">
      <div className="section-label">House rules</div>
      <div className="princ-grid">
        {rules.map((r) => (
          <div key={r.num} className="princ-card">
            <div className="princ-num">{r.num}</div>
            <div className="princ-title">{r.title}</div>
            <div className="princ-desc">{r.desc}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CTA() {
  return (
    <section className="mb-12">
      <div
        className="relative overflow-hidden text-center"
        style={{
          border: "1px solid var(--border)",
          borderRadius: "var(--rxl)",
          background: "var(--bg2)",
          padding: "56px 32px",
        }}
      >
        <div className="pill mb-5" style={{ background: "var(--bg)" }}>
          <span className="pill-dot" />
          DAILY · 13:00 UTC (9AM ET / 6AM PT)
        </div>
        <h2
          className="font-semibold mb-3"
          style={{ fontSize: "clamp(28px, 3.5vw, 40px)", letterSpacing: "-0.03em", lineHeight: 1.1 }}
        >
          Set your pipeline in two minutes.<br />First matches land in ninety seconds.
        </h2>
        <p style={{ fontSize: "14px", color: "var(--tx3)", maxWidth: "520px", margin: "12px auto 24px" }}>
          Onboarding takes resume upload, target roles, and locations. Everything after that is automatic.
        </p>
        <div className="inline-flex gap-3">
          <Link href="/signup" className="cb-btn cb-btn--solid">
            Start free
          </Link>
          <Link href="/login" className="cb-btn">
            Sign in
          </Link>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="ftr">
      <div>© 2026 · Autopilot · ahdahzeh.com</div>
      <div className="ftr-links">
        <a href="https://cerebral.ahdahzeh.com">Cerebral</a>
        <a href="https://ahdahzeh.com">Portfolio</a>
        <a href="mailto:hi@ahdahzeh.com">Contact</a>
      </div>
    </footer>
  );
}

function SvgDefs() {
  return (
    <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
      <defs>
        <symbol
          id="ic-mark"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="3" x2="12" y2="8" />
          <line x1="12" y1="16" x2="12" y2="21" />
        </symbol>
        <symbol
          id="ic-arrow"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <line x1="5" y1="12" x2="19" y2="12" />
          <polyline points="12 5 19 12 12 19" />
        </symbol>
        <symbol
          id="ic-clock"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <polyline points="12 6 12 12 16 14" />
        </symbol>
        <symbol
          id="ic-grid"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="7" height="7" />
          <rect x="14" y="3" width="7" height="7" />
          <rect x="14" y="14" width="7" height="7" />
          <rect x="3" y="14" width="7" height="7" />
        </symbol>
        <symbol
          id="ic-code"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="16 18 22 12 16 6" />
          <polyline points="8 6 2 12 8 18" />
        </symbol>
        <symbol
          id="ic-spark"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 2v6M12 16v6M2 12h6M16 12h6" />
          <path d="M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3" />
        </symbol>
        <symbol
          id="ic-login"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" />
          <polyline points="10 17 15 12 10 7" />
          <line x1="15" y1="12" x2="3" y2="12" />
        </symbol>
      </defs>
    </svg>
  );
}
