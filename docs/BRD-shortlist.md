# Business Requirements Document
## Shortlist — Automated Job Vacancy Funnel

**Version:** 1.0
**Date:** August 12, 2026
**Author:** Victor Dickson
**Status:** Draft
**Working name:** Shortlist (provisional — see PRD §11)

---

## 1. Executive Summary

Shortlist is a personal, automated funnel that continuously collects software engineering vacancies from public job sources, scores each one against a structured profile of my actual experience, and delivers a small ranked shortlist with a written rationale for every match.

The problem it solves is not *finding* jobs. Job listings are abundant and free. The problem is that the roles I am strongest for — payments infrastructure, webhook and money-path correctness, LLM agents in production — are poorly served by keyword search, because the listings that fit are titled "Backend Engineer" or "Product Engineer" and only reveal the fit in the body text. Manual searching therefore costs hours per week and still misses the best matches.

Shortlist replaces that search time with a daily digest of five to fifteen roles worth reading, each with a score and a one-line reason.

**v1.0 does not apply to jobs.** It finds, ranks and reports. I remain the only thing that submits an application.

---

## 2. Business Problem

### 2.1 Context

I am seeking a full-time engineering role, primarily to fund continued development of Myshoplet, whose infrastructure gap is roughly $60/month. The search is therefore time-bounded and cost-sensitive: it must not itself become a project that consumes the time the job is meant to buy back.

### 2.2 Current pain points

| Pain | Detail |
|---|---|
| Search time | Manually checking eight to ten boards is 45–60 minutes per day, and most of it is re-reading listings already seen yesterday. |
| Low signal | Board search ranks by recency and keyword, not by fit. A "Backend Engineer" post that wants Paystack and webhook experience is indistinguishable from one that wants Java and Kafka until the body is read. |
| Missed matches | My strongest differentiators — idempotent money paths, KYC/KYB tiers, LLM agents on WhatsApp — almost never appear in job titles, so title-based search cannot surface them. |
| Staleness | The best remote roles close fast. A listing found five days late is often already closed. |
| No memory | Nothing tracks which roles I have already seen, dismissed, or applied to, so the same listing is re-evaluated repeatedly across boards. |
| Scattered pipeline | Applications live in email, browser tabs and memory. There is no single view of what is in flight. |

### 2.3 Business impact of the gap

- Search time is taken directly from Myshoplet development time, which delays the revenue that would remove the need for the job.
- Late applications to fast-moving remote roles reduce the interview rate for exactly the roles that pay best.
- Without a tracked pipeline, follow-ups are missed and the funnel leaks at the cheapest possible stage.

---

## 3. Business Objectives

| # | Objective | Measurable target |
|---|---|---|
| 1 | Cut daily search time | From 45–60 min/day → under 10 min/day reviewing a digest |
| 2 | Surface roles while they are still open | 90% of shortlisted roles are under 7 days old at time of digest |
| 3 | Raise the relevance of what I read | ≥ 60% of shortlisted roles judged "worth applying to" on review |
| 4 | Increase application throughput | From ad-hoc → 5–10 considered applications per week |
| 5 | Keep a single source of truth for the pipeline | 100% of applications tracked with a status |
| 6 | Cost nothing meaningful to run | ≤ $1/month in the steady state |

**Objective 3 is the one that matters.** A funnel that surfaces thirty roles a day of which four are relevant has failed, because I will stop reading it. Precision beats recall here.

---

## 4. Stakeholders

| Role | Who | Interest |
|---|---|---|
| Operator and sole user | Victor Dickson | A short, accurate, current list of roles worth applying to |
| Downstream beneficiary | Myshoplet | Funded infrastructure and reclaimed development time |
| Indirect audience | Hiring managers | Receive considered applications rather than volume spam |
| Possible future users | Other Nigerian engineers job-hunting remotely | Out of scope for v1.0, but the profile model should not hard-code one person |

There is no external stakeholder to satisfy and no approval gate. This document exists to keep scope honest, not to seek sign-off.

---

## 5. Source Landscape

### 5.1 Access model by source

The distinction that matters is not "free vs. paid" but "permitted vs. adversarial". Anything requiring me to defeat blocking is excluded, because maintaining a scraper under active countermeasures while job hunting is a bad trade.

| Source | Access | Coverage for my profile | Status |
|---|---|---|---|
| Greenhouse | Public job board API per company | High — most funded startups | In scope |
| Lever | Public postings API per company | High | In scope |
| Ashby | Public API per company | Medium, growing | In scope |
| Workable | Public API per company | Medium | In scope |
| RemoteOK | Public JSON feed | Medium — remote-first | In scope |
| Remotive | Public JSON feed | Medium | In scope |
| Arbeitnow | Public JSON feed | Medium — EU-heavy | In scope |
| Himalayas | Public JSON feed | Medium — remote | In scope |
| Jobberman (NG) | HTML, permissive robots | High for Lagos roles | In scope, low priority |
| MyJobMag (NG) | HTML, permissive robots | Medium for Lagos roles | In scope, low priority |
| LinkedIn | Prohibited by terms; actively blocked | High | **Out of scope** |
| Indeed | Prohibited by terms; actively blocked | High | **Out of scope** |

### 5.2 The company list is the real asset

Greenhouse, Lever, Ashby and Workable are per-company APIs, not global search. Coverage therefore depends on a curated list of companies worth watching. For my profile that list starts with African fintech and commerce (Paystack, Moniepoint, Mono, Anchor, Grey, Raenest, Bumpa, Sabi, Flutterwave, Kuda) and extends to remote-friendly international companies that hire in Nigeria.

This list is a maintained input, not a one-off. Growing it is the highest-leverage recurring task in the project.

---

## 6. Scope

### 6.1 In scope (v1.0)

- Scheduled ingestion from the permitted sources in §5.1
- Normalisation of every source into one job schema
- Deduplication across sources and across runs
- Two-stage scoring: cheap deterministic filters, then LLM rubric scoring for survivors only
- A daily email digest of the ranked shortlist with per-role rationale
- A web dashboard showing full history with a status per role (new / interested / applied / rejected / closed)
- A feedback signal — marking a role interested or not — recorded for later scoring adjustment
- A structured, version-controlled profile describing my experience, preferences and dealbreakers

### 6.2 Out of scope (v1.0)

- **Automatic application submission.** See §11 R1.
- LinkedIn and Indeed ingestion
- Cover letter and CV generation (planned v1.1)
- Multi-user accounts, authentication beyond a single shared secret
- Recruiter or agency outreach
- Salary negotiation tooling
- A mobile app
- Any public listing of the collected data — this is a private tool, and republishing aggregated job data raises licensing questions I have no reason to take on

---

## 7. Business Rules

| Rule | Detail |
|---|---|
| Freshness | Only postings first seen within the last 21 days are eligible for a digest. Older ones remain queryable in the dashboard. |
| Digest size | Between 5 and 15 roles. Never zero-padded to hit a minimum; an empty day sends an empty-state email saying so. |
| Score threshold | Only roles scoring ≥ 70/100 enter the digest, even if that yields fewer than 5. |
| One digest per day | A role appears in exactly one digest. Re-surfacing requires an explicit score change of ≥ 10 points. |
| Deduplication | Same role from multiple sources collapses to one record, preferring the source closest to the employer (ATS over aggregator). |
| Dealbreakers | Any role matching a dealbreaker rule is rejected before scoring and never reaches the digest. |
| Honesty | Every scored role carries a stated reason and, where relevant, the strongest reason I might *not* be a fit. A funnel that flatters me is useless. |
| Data retention | Job records retained 12 months, then purged. Application status records retained indefinitely. |
| Attribution | Every stored role keeps its canonical source URL. Applications are made on the employer's own site, never through a mirrored form. |

---

## 8. Success Metrics

| Metric | Baseline | Target (8 weeks after launch) |
|---|---|---|
| Daily review time | 45–60 min | ≤ 10 min |
| Shortlist precision (judged worth applying to) | n/a | ≥ 60% |
| Median posting age at digest | ~5 days | ≤ 3 days |
| Considered applications per week | ad-hoc, ~2 | 5–10 |
| Roles tracked with a status | 0% | 100% |
| Monthly running cost | n/a | ≤ $1 |
| Digest delivery reliability | n/a | ≥ 98% of scheduled days |

**Deliberately not a metric:** total jobs ingested. Ingesting more is trivially easy and tells me nothing about whether the tool works.

---

## 9. Constraints

These are specific to my actual infrastructure, and several have already caused production incidents on Myshoplet.

| Constraint | Detail | Consequence for design |
|---|---|---|
| GitHub Actions unavailable | Broken account-wide on a billing issue since at least 2026-07-31; 40 of 40 runs fail at `startup_failure` | Scheduling cannot use Actions. Use an external scheduler hitting a secret-gated endpoint. |
| Vercel Hobby cron limits | Hobby plan cron is coarse and unsuitable as the only trigger | External scheduler (cron-job.org) is the primary trigger; Vercel cron is a fallback at most |
| Atlas M0 is near its cap | The Myshoplet cluster is on the free 512MB tier and cannot absorb another dataset | Shortlist gets its **own** free M0 cluster, separate credentials, separate connection string |
| No database backups on M0 | Backups are impossible on the free tier at any price | Treat all Shortlist data as reproducible. Job data can be re-ingested; only application status is precious, so it must be exportable to a file. |
| Budget | Target $0, ceiling ~$1/month | LLM scoring must be tightly rationed; only top candidates get a model call |
| Solo operator | One developer, part-time, while job hunting | Every phase must be independently useful. No phase may be a prerequisite for value. |
| Email deliverability | Resend is already configured on my domain | Reuse it rather than adding a provider |
| Undocumented external consumers | Rotating `CRON_SECRET` on Myshoplet once silently killed an external scheduler and stopped ~94% of payment nudges | Any shared credential must be recorded in `docs/EXTERNAL-CONSUMERS.md` at the moment it is created |

---

## 10. Assumptions

1. The public ATS APIs (Greenhouse, Lever, Ashby, Workable) remain open and unauthenticated for public job boards. If any closes, that adapter degrades and the others continue.
2. A curated company watchlist of 50–150 employers gives better precision than untargeted global search, and is cheap to maintain.
3. My profile can be expressed well enough as structured data for an LLM to score fit accurately with a fixed rubric.
4. A daily cadence is sufficient. Roles do not close within hours.
5. Free-tier M0 storage is adequate: roughly 30k job records at ~4KB each is well inside 512MB, and the 12-month purge holds it steady.
6. I will actually read the digest. If I stop reading it, the project has failed regardless of technical quality, and should be turned off rather than expanded.

---

## 11. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Auto-applying would damage my reputation** | — | High | Explicitly out of scope. v1.0 has no submission path, and there is no code that could be flag-flipped into one. |
| R2 | Low precision makes the digest ignorable | Medium | High | Threshold at 70, cap at 15, require a written rationale per role, and tune weights from my own interested/not-interested feedback |
| R3 | The project becomes a substitute for applying | **High** | High | Timebox to 3 weeks for v1.0. Phase 1 must send a real digest by end of week 1, even if the ranking is crude. |
| R4 | An ATS API closes or changes shape | Medium | Medium | One adapter per source behind a shared interface; a failing adapter logs and is skipped, never breaks the run |
| R5 | LLM scoring cost creeps | Low | Medium | Hard daily cap on model calls; deterministic pre-filter does the elimination; cheap model by default |
| R6 | Duplicate or repeated digest emails | Medium | Medium | Ingestion and digest send must both be idempotent, keyed on a stable job hash and the digest date — the same class of bug as the retried-webhook double payment on Myshoplet |
| R7 | Scheduler silently stops | Medium | High | Digest email is itself the heartbeat; a missing digest is visible. Record the external scheduler in `docs/EXTERNAL-CONSUMERS.md` on day one. |
| R8 | Scope creep into a product for other users | Medium | Medium | Multi-user is out of scope. The profile is data, not a schema migration, so the option stays open without being built. |
| R9 | Job-board terms change to prohibit collection | Low | Medium | Only permitted sources are used; a source that changes its terms is dropped rather than worked around |

---

## 12. Secondary Benefit

This project is itself a portfolio artifact. It is a scheduled ingestion pipeline with external API adapters, deduplication, idempotent writes, LLM scoring under a cost budget, and an email delivery path — which is a recognisable shape of backend work, and demonstrable in an interview for exactly the roles it is designed to find.

That is a genuine benefit, but it is a **secondary** one. If a design choice trades shortlist quality for demonstrability, shortlist quality wins.

---

*End of BRD*
