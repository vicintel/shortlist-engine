# Shortlist

An automated job funnel. It collects engineering vacancies from public job sources, scores each one against a structured profile of what you have actually shipped, and produces a short ranked list with a written reason per role.

It finds and ranks. **It does not apply on your behalf** — see [Why there is no auto-apply](#why-there-is-no-auto-apply).

```bash
npm install
cp .env.example .env                            # add GEMINI_API_KEY (free, no card)
cp config/profile.example.json config/profile.json       # your details; gitignored
cp config/companies.example.json config/companies.json   # your board list; gitignored
npm run run                                     # collect, score, shortlist
npm run run -- --email                          # ...and send the digest
```

`config/profile.json` is deliberately not in the repo. It holds your salary floor,
work authorisation and the evidence the model is allowed to claim on your behalf,
and none of that belongs in a public repository.

## Making it yours

The code is general. The configuration is not: it is tuned to one engineer in Lagos,
and running it unchanged will quietly give you the wrong answers rather than an error.
Three files decide everything.

| File | What to change | What happens if you don't |
|---|---|---|
| `config/profile.json` | Who you are, what you have shipped, what you want | The model scores every role against someone else's CV |
| `config/rules.json` | `locationRules.onsiteAllowed` is `["lagos","nigeria","abuja","port harcourt"]` | **Your local jobs get rejected as ineligible.** In Berlin, every Berlin role is dropped and the digest looks empty |
| `config/companies.json` | 51 boards weighted to devtools, fintech and Africa | You get someone else's target companies |

The location rules are the one that bites. They also carry a 63-entry `lockedCountries`
list used to reject "remote, but only from X" postings, where X is not somewhere you can
work. Rewrite both lists for your own situation before trusting a single run.

`npm run discover -- <slug> [slug...]` tests whether a company has a public Greenhouse,
Lever or Ashby board, so you can grow the list without guessing.

**It runs on a free LLM tier by default.** Google's `gemini-3.5-flash-lite` scores
25 jobs per run at no cost. Nothing that bills is used unless you name it.

## What one run does

```
COLLECT   31 sources          2,110 postings
DEDUPE    collapse mirrors    2,041
FILTER    deterministic cuts  59
PRESCORE  free keyword rank   top 25 survive
SCORE     LLM rubric          25 read in full
STORE     idempotent upsert   status tracked per job
VERIFY    open every link     dead postings closed, not shown
DIGEST    5–15 roles          email + terminal
```

Typical run: **under 5 seconds**, excluding LLM scoring.

### Why VERIFY exists

A digest with dead links stops being read. HTTP status alone does not catch this:
**Ashby serves its board shell with a 200 for a posting it cannot resolve**, and PostHog
runs the posting API while leaving their hosted board dark — so `jobUrl` comes back from
Ashby's own API pointing at a page that renders "not found". Feeds contribute their own
version: rows whose URL is nothing but a company homepage.

So the check opens the page and asks whether it still shows *that* job — the Ashby
bootstrap payload (`organization: null`), the `<title>`, closure phrases, and whether the
role's own words appear. Two rules matter:

- **Fail open.** A timeout, a 429 or a 5xx marks nothing dead. A flaky connection must
  never silently empty the digest.
- **Never match a bare `404`** in HTML — it collides with SVG path data like `13.3404`,
  which once flagged six live postings as dead.

Dead postings are set to `closed`, so they survive the purge and are never offered again.
A status you set by hand is never overwritten. Skip the step with `npm run run -- --no-verify`.

## Sources

**Per-company ATS boards** (`config/companies.json`) — Greenhouse, Lever and Ashby expose public board APIs. These are *not* a global search, so this list **is** the coverage. Growing it is the highest-leverage recurring task in the project.

Coverage is not the bottleneck it looks like. Probing ~70 companies found live boards at 21
of them and **10 usable roles in total** — most well-known engineering employers returned
zero remote roles reachable from outside their own region. Adding more big-name boards adds
noise, not jobs. `config/companies.json` is gitignored: a ranked list of the companies you
are targeting is readable by the companies on it.

**LinkedIn, via your own inbox.** LinkedIn has no public jobs API and blocks crawlers, so
there is no honest way to scrape it. Instead this reads the alert emails LinkedIn already
sends you: create saved searches on LinkedIn, and `src/sources/gmail.js` pulls them back
out over IMAP with the `GMAIL_USER` / `GMAIL_APP_PASSWORD` you already set for sending.
The mailbox is opened **read-only**, and only messages from LinkedIn's job-alert senders
are read.

A real 30-day window: 112 alert emails → 746 postings → 624 unique → 99 past the title
gate. Without credentials the source skips itself and the run continues.

```bash
npm run discover -- paystack kuda mono okra    # test new slugs before adding them
```

**Global feeds** — RemoteOK, Remotive, Arbeitnow, Himalayas. Wider reach, noisier.

**Deliberately excluded:** LinkedIn and Indeed. Both prohibit scraping, both actively block it, and maintaining an adversarial scraper while job hunting is a bad trade.

## Scoring

Three stages, cheapest first. The first two are pure computation; only the third calls a model, so only the third is rationed.

**1 — Hard filters** (free, runs on everything). Freshness, title gate, dealbreaker phrases, location eligibility. The title gate matters more than it looks: without it, company boilerplate floats junk to the top — Vercel's footer mentions payments, ledgers and reconciliation on *every* posting, which ranked a Senior Accountant role at 85.

**2 — Prescore** (free, runs on survivors). Weighted keyword tally across stack, domain and AI terms, plus title match, company tier and freshness. Only its top N reach stage 3.

**3 — LLM rubric** (capped at `SHORTLIST_LLM_BUDGET`). Five components summing to 100: domain fit (25), stack fit (25), seniority fit (15), location fit (20), signal quality (15). Returns a score, a one-line reason, and **the strongest reason you might not get it** — a funnel that flatters you is useless.

Structured outputs guarantee the response shape, so there is no JSON-repair path.

### Providers

The scorer is provider-agnostic — switching is configuration, not code.

| Provider | Cost | Notes |
|---|---|---|
| `gemini` | **free** | Default. `gemini-3.5-flash-lite`, no card. Rate-limited, not spend-limited. |
| `groq` | free | Llama 3.3 70B, generous free tier |
| `openrouter` | free | `:free` model ids |
| `ollama` | free | Local, no network. Slow without a GPU. |
| `anthropic` | ~$1.20/mo | Best quality; `claude-haiku-4-5` at 25 jobs/day |
| `openai` | ~$0.30/mo | `gpt-4o-mini` |

With no `SHORTLIST_PROVIDER` set, the first free provider with a working key wins.
A paid provider is never selected implicitly.

**On a free tier the budget is time, not money.** `SHORTLIST_RPM=12` spaces requests
to stay inside Google's limit, so 25 jobs takes about two minutes. Without it, 2 of
25 calls failed on HTTP 429 — bursting past a rate limit converts calls into retries.

## Degrading gracefully

If the provider key is missing, out of credit, or rate-limited, the run does **not** fail and does **not** silently produce an empty shortlist. It falls back to the prescore, marks those entries `~` as provisional, and prints the actual API error.

That matters because the failure mode it replaces — counting failures without saying why — turns a billing problem into "no good jobs today", which you would believe.

Provisional results are noticeably worse than scored ones. The fallback keeps the tool running; it does not replace the model.

## Daily schedule

```bash
./scripts/daily.sh          # run it by hand any time
crontab -l                  # 0 8 * * *  — installed
crontab -l | grep -v shortlist | crontab -   # remove it
```

Runs at **08:00 daily**. It writes `data/digest-<date>.html`, appends to
`data/cron.log`, and fires a macOS notification with the count. Email is attempted
only when `RESEND_API_KEY` is set, so a missing key degrades to the HTML file
rather than failing the run.

### Email to your own Gmail

```bash
node bin/shortlist.js mail-test    # verifies credentials, then sends one test
```

Sends over Gmail SMTP from your account to your inbox — no third-party service and
no sending domain involved.

1. Turn on 2-Step Verification: <https://myaccount.google.com/security>
2. Create an app password: <https://myaccount.google.com/apppasswords> — name it
   "Shortlist". Google shows 16 characters in four groups; paste it as-is, spaces
   are stripped for you. **Your normal Google password will not work.**
3. Put `GMAIL_USER` and `GMAIL_APP_PASSWORD` in `.env`, then run `mail-test`.

`DIGEST_TO` defaults to `GMAIL_USER`, so with those two values set there is nothing
else to configure. Resend remains available via `MAIL_TRANSPORT=resend`.

**Email is optional and deliberately decoupled.** The run always writes
`data/digest-latest.html` — a stable path you can bookmark — so delivery needs no
account, no sending domain and no third party.

If you want it in your inbox as well, use a **separate account of your own**. Never
point this at a business's sending domain: a personal job hunt should not touch a
company's sender reputation, and its mail should not be associated with that domain.
Resend's free tier sends 100/day, and its default `onboarding@resend.dev` sender can
email your own address without verifying a domain at all.

> macOS may need Terminal (or `cron`) to have Full Disk Access for a cron job to
> write here. If `data/cron.log` stops updating, that is the first thing to check.

## Dashboard

```bash
npm run ui        # http://localhost:4321
```

Browse every scored role, filter by status, mark interested/applied/rejected, and
trigger a run from the page. No framework and no build step — one file, `src/server.js`,
serving from `data/jobs.json`. Status changes write straight through to the store.

The digest file uses the same design. `--email` additionally sends it, if you have configured your own account.

## Tracking (CLI)

```bash
npm run list                              # new jobs by score
node bin/shortlist.js list applied        # filter by status
node bin/shortlist.js mark 3d84e66d applied
npm run stats
```

Statuses: `new`, `interested`, `applied`, `rejected`, `closed`. Set once, never overwritten by a re-scrape.

## Tests

```bash
npm test        # 57 tests, no network, ~0.3s
```

Node's built-in runner — no framework, no dependency. They exist because the
idempotency section below makes falsifiable claims, and writing them down is not
the same as verifying them.

Writing them found two real bugs:

- **`store.js` resolved its path at import time**, so a later `chdir` was ignored.
  The first test run wrote to the live database instead of its temp directory.
- **`jobHash` stripped punctuation rather than replacing it**, so "Full-Stack
  Engineer" hashed as `fullstack` while "Full Stack Engineer" stayed `full stack` —
  the same role listed two ways never collapsed. 40 of 90 stored rows were affected.

Fixing the second changed every id, which would have orphaned every row. `migrateIds`
now re-keys on load and merges duplicates keeping the status furthest along, so the
hash function can be changed again without losing a job you already applied to.

## Idempotency

Re-running the pipeline within the same hour must not duplicate rows, reset a status, move `firstSeenAt`, or re-send a digest.

- Job identity is `sha256(company | title | location)`, deliberately excluding the source, so an ATS posting and its aggregator mirror collapse into one record.
- Upserts preserve `firstSeenAt`, `status` and `digestedAt`; only genuinely changing fields are overwritten.
- A job appears in exactly one digest, and only returns if its score improved by 10+.
- Digests are keyed by date — `--email` twice in one day sends once.
- The store is written to a temp file and renamed, so an interrupted run cannot truncate it.

## Application kits

```bash
npm run apply -- 3d84e66d --open      # or the "Draft application" button in the dashboard
```

Writes `data/applications/<company>-<role>-<id>.md` containing:

- a **requirements audit** — every requirement the posting states, marked
  ✓ met / ~ partial / ✗ missing, each with the specific evidence that satisfies it
  or the nearest genuine substitute. Required and preferred are counted separately.
- a cover letter written against **that** posting, opening with the most relevant
  thing he has actually built
- five CV bullets reordered and reworded for this role, each annotated with the line
  of the posting it answers
- drafts for 5–7 application-form questions, including work authorisation and
  location, ready to paste
- **gaps** — what the posting wants that he cannot claim, as interview prep
- three questions for him to ask them, specific enough to show he read the posting

The system prompt forbids inventing a system, a metric, a company or a technology;
everything must trace to `profile.evidence`. On the first real kit every specific
claim — Celery, Temporal, Dagster, credit pools, 14+ usage-based products — was
verified present in the posting text. **Check anyway before you send.**

It never claims work authorisation he does not have. Where sponsorship is needed it
says so plainly rather than burying it.

## Why there is no auto-apply

Automated submission breaks most ATS terms of service, and it spends your first impression at exactly the companies you care about most. A bad match sent under your name cannot be recalled.

The scarce resource in a job search is not applications sent, it is considered applications to roles worth having. This tool optimises for the second.

## Configuration

| File | What it controls |
|---|---|
| `config/profile.json` | Who you are, what you have shipped, what you want and avoid. The heart of matching — edit this first. |
| `config/companies.json` | The ATS watchlist. Coverage is exactly this list. |
| `config/rules.json` | Freshness, title gate, dealbreakers, location rules, prescore weights, digest thresholds. |

## Known limitations

- **Coverage is the watchlist.** Paystack, Kuda, Mono, Flutterwave and most Nigerian fintechs do not expose a public ATS board. They still hire — this tool just cannot see them. Check their careers pages directly.
- **`first_published` is unreliable** on some Greenhouse boards, so the freshness filter occasionally drops a live role. It is the largest rejection bucket (~1,240 of 2,041) and worth auditing before trusting it.
- **Runs locally.** The scheduler is a local crontab, so it only fires when this Mac is awake. A hosted trigger is Phase 2.
- **The whole posting is read.** Nothing is truncated: the longest posting seen is
  16k characters and the budget is 30k. This was not true at first — a 6k cap cut
  the requirements section off **53%** of postings, because the company blurb comes
  first and the qualifications sit past the cap. It was scoring half the corpus
  without seeing what the job asked for.
- **Free-tier quality is lower than paid.** Gemini flash-lite applies the rubric well — on the first real run it correctly downgraded one role to 45 for being EMEA/UK-locked and another to 42 for being country-locked — but Claude reads long descriptions more carefully. Switch with one line in `.env` if a digest starts feeling wrong.
- **No Batches API** on paid providers, which would halve their cost.
