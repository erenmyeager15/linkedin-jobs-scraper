# LinkedIn Jobs Scraper & US Hiring Monitor

> **Unofficial Actor.** This tool is independent and is **not affiliated with, endorsed by, or sponsored by LinkedIn**. It collects only publicly available job listings and never uses LinkedIn credentials, cookies, or private APIs.

## Description

Track US hiring activity with public LinkedIn job listings, disclosed salaries, required skills and workplace evidence. Search across the United States or a specific market such as Austin, New York or San Francisco. Export structured job records and compare saved observations in separate JSON and CSV reports. No login, cookies or API key required.

Use keyword/location fields for repeatable searches, paste full search-result URLs to forward their search parameters, or pass individual public job URLs. All modes can be combined. LinkedIn can ignore requested search filters; this Actor does not promise that every website filter is honored.

For recurring hiring watchlists, an optional saved comparison reports newly observed job IDs and known salary, location, workplace, skills, title, company, employment-type, seniority and application-link changes. The first successful observation batch creates a baseline. JSON and CSV comparison reports stay separate from the ordinary job dataset.

Direct HTTP fetches only public server HTML without starting a browser or using a proxy. Source work is bounded to 180 seconds, one request at a time, with at least 1.5 seconds between source reads. A page gets at most one retry in total for a transient transport/server error or HTTP 429. The run permits at most two rate-limit retries. A valid `Retry-After` delay is honored; without one, a 429 waits 12 seconds. A server-directed wait exceeding 20 seconds, another rate limit on the same page, or a reached spending/time limit stops source work. Redirects and authwalls are not retried. There is no automatic paid fallback or IP rotation. Access can still fail or produce fewer jobs than requested; a cooldown cannot guarantee that a blocked cloud IP becomes usable.

Explicit browser mode remains available for proxy-based workflows at 1024 MB or more; select that memory in Run options before starting browser mode. Inputs with an explicit proxy and no `transport` retain browser selection, not an automatic memory increase. HTTP plus an enabled proxy is rejected before scraping: choose the mode intentionally. Proxy-based small or tightly filtered runs may cost more than their job-event revenue.

Deduplication by LinkedIn job ID ensures unique results within a run. The pay-per-event model charges $1.00 per 1,000 successfully saved jobs. Saved watchlists do not change that billing model or the unit price.

### Workplace evidence and filter limitations

LinkedIn's public guest search does not reliably honor `f_WT`. When a workplace filter is set, this Actor saves and charges only jobs with matching explicit public role evidence: a workplace criterion, `jobLocationType: TELECOMMUTE`, a title/location annotation, or a role-specific description statement. Generic employee benefits, remote-first company policies, technical remote access and home-internet requirements are not evidence of this role's arrangement. Conflicting or missing evidence leaves `workplaceType` null. `workplaceEvidenceStatus` and bounded `workplaceEvidence` excerpts explain the decision; these are source statements, not verification of an employer's actual conditions.

The navigation budget remains bounded by the existing result/per-search limits. A filtered-out candidate still consumes a navigation slot, but is not saved or charged. A filtered run may return fewer than `maxResults`, including zero. The Actor does not silently scan unlimited additional detail pages to fill the batch. `RUN-SUMMARY` reports `detailsFiltered` and `workplaceUnverified`. Unknown/conflicting candidate arrangements make a filtered watchlist scan incomplete and prevent baseline advancement. Removing a workplace filter permits unknown-arrangement rows; it does not verify them. Direct `jobUrls` do not inherit keyword-search workplace filters. Other website filters are forwarded, not independently verified.

### Use Cases

1. **US recruiting teams:** research active role titles, locations and public job requirements.
2. **Employer hiring watchlists:** compare known title, location, skills and workplace fields across successful bounded scans.
3. **Disclosed salary research:** use published ranges with currency and pay-period evidence; missing salaries are not estimated.
4. **Job-board and analytics teams:** export deduplicated listing records with canonical LinkedIn URLs and source traceability.
5. **Competitive hiring research:** identify newly observed job IDs without presenting them as confirmed newly posted jobs or labeling absent listings closed.

## Sample Output

```json
{
  "jobTitle": "Software Engineer",
  "companyName": "Google",
  "companyLinkedInUrl": "https://www.linkedin.com/company/google/",
  "companyLogoUrl": "https://media.licdn.com/dms/image/example",
  "jobLocation": "Austin, Texas, United States",
  "country": "US",
  "workplaceType": "Hybrid",
  "jobType": "Full-time",
  "experienceLevel": "Mid-Senior level",
  "postedDate": "Posted 2 weeks ago",
  "postedAt": "2026-08-09T13:30:00.000Z",
  "numberOfApplicants": 47,
  "jobDescription": "Google's software engineers develop the next-generation technologies...",
  "benefits": ["Health insurance"],
  "requiredSkills": ["JavaScript", "Python", "Kubernetes"],
  "salaryRange": "$120,000 - $180,000 / year",
  "salaryMin": 120000,
  "salaryMax": 180000,
  "salaryCurrency": "USD",
  "salaryPeriod": "YEAR",
  "jobUrl": "https://www.linkedin.com/jobs/view/123456789",
  "applyUrl": "https://careers.google.com/jobs/123456789",
  "jobId": "123456789",
  "companySize": null,
  "companyIndustry": null,
  "easyApply": true,
  "keywordUsed": "software engineer",
  "locationUsed": "United States",
  "resultPosition": 1,
  "scrapedAt": "2026-08-23T13:30:00.000Z"
}
```

## Pricing

| Unit                | Price     |
|---------------------|-----------|
| Per 1,000 jobs      | $1.00     |
| Actor start         | $0.00005 per GB of memory |

The start event has a minimum of one event, including runs below 1 GB. The example above is illustrative, not a current job offer. See the live Store pricing for any discounts or platform-usage terms.

The dataset write and `job-scraped` charge happen atomically. Empty, blocked, rejected, or spending-limit records are not billed as jobs.

A job is saved and charged only when it carries a real job title plus a company or a description. Blocked pages and empty results are never saved and never charged, and the run stops as soon as your `maxResults` or your spending limit is reached.

### Field Availability

LinkedIn does not publish every field on every listing. Missing values remain `null` rather than being guessed. `jobUrl` always points to the LinkedIn listing; `applyUrl` is only populated when LinkedIn publishes a separate employer application link. When no explicit skills list is present, `requiredSkills` uses whole-word inference from the public description.

## Saved job watchlists

Set `watchlistName` on an **Apify platform run**, then schedule the same input with the same name and result limits. This is optional and available regardless of account plan. Leave the name empty for a normal scrape; local watchlist tests use injected storage rather than pretending a local baseline is shared with the platform.

```json
{
  "keywords": ["software engineer"],
  "locations": ["United States"],
  "workplaceType": [],
  "datePosted": "past-week",
  "sortBy": "recent",
  "maxResults": 25,
  "maxJobsPerSearch": 25,
  "watchlistName": "us-software-hiring",
  "watchlistRetentionDays": 30,
  "watchlistMaxJobs": 1000,
  "transport": "http",
  "proxyConfiguration": { "useApifyProxy": false }
}
```

Keep the source inputs, their order, filters and result limits unchanged. A different search scope requires a new name; the Actor rejects a scope mismatch before source navigation. Names are case-insensitive and use 1-64 letters, digits, underscores or hyphens, starting with a letter or digit.

### Comparison semantics

- **`baseline`:** The first successful bounded batch initializes saved state. Its jobs are not advertised as newly published jobs.
- **`newly_observed`:** A job ID was not in this watchlist's retained state. It may be an older listing or a previously evicted observation; this is not a posting-date or repost claim.
- **`updated`:** At least one tracked field has known previous and current values that differ. Changes include both values and their observation timestamps, plus the canonical LinkedIn job URL.
- **`unchanged`:** No tracked known-value change was detected. This does not assert that every field on the listing stayed unchanged.

Missing fields are **unknown**, not removals. Newly available fields are listed separately from changed known values. If a field disappears and later returns, it is compared with its last known value within retention, and `previousObservedAt` exposes that older comparison timestamp.

Salary amounts are compared only when both observations have matching recognized currency codes and pay periods. A bare `$` or unknown pay period is not enough; the raw salary remains in the job dataset but is not used for numeric change alerts. Different currencies/periods are not converted; amount comparisons are marked incomparable. Relative posting ages, inferred `postedAt`, applicant counts, logos and scrape timestamps are not tracked changes. Descriptions and HTML are not saved in watchlist state. Skills use public-text extraction/inference, not a verified recruiter skill taxonomy.

Whitespace, text case, skill ordering and recognized application-link tracking parameters do not create change alerts. Oversized fields (over 1,000 characters) and skills lists exceeding 100 entries or 4,000 combined characters are treated as unavailable for monitoring rather than silently compared using a truncated value.

### Coverage, state and limitations

`RUN-SUMMARY` records per-search pages, seen IDs, queued/saved details, failures and caps. A capped scan can commit its successfully saved **bounded observation batch**, but it is not full search or market coverage. Jobs absent from any batch are never labeled closed, expired, removed or reposted.

Failed requests, unusable details, unparsed cards, ambiguous empty pages, unfinished queued details and a reached spending limit prevent baseline advancement. Existing job output remains available even when the watchlist report is incomplete. An empty initial fragment does not create a new baseline. After a process crash or migration, incomplete in-memory observations cannot advance the baseline; the report does not promise replay of unsaved work.

State lives in a named key-value store in the run owner's Apify account, with an API-owned queue lease serializing state writers. Overlapping runs may report `concurrent_run`; older scans cannot overwrite a newer committed batch. Keep a watchlist schedule far enough apart for one run to finish before the next. Do not mark the writer queue's single pending item as handled.

Retention defaults to 30 days (maximum 90), with 1,000 retained jobs (maximum 5,000) and a 16 MB state-size guard. Pruning happens on successful commits, **not automatically while idle**. Named stores persist until deleted; delete an unused watchlist's named store and writer queue through your Apify Storage page. Time/capacity eviction can make a previously seen job newly observed again. There is no unbounded observation history, closure detection, cross-ID repost matching, webhook/email delivery or only-pay-for-changes mode.

### Reports and billing

The normal dataset is unchanged. The Output tab also links to:

- **Scan summary:** `RUN-SUMMARY`, available for normal and watchlist runs.
- **Transport summary:** `TRANSPORT-SUMMARY`, discloses source mode, explicit proxy use, HTTP time bounds, source attempts, retries, recovered rate limits, cooldown time and terminal failure category. Source attempts count guarded reader invocations; decoded HTML bytes are not a claim about billed network traffic.
- **Watchlist JSON:** `JOB-CHANGES`, with counts, coverage, before/after changes, field availability and commit status.
- **Watchlist CSV:** `JOB-CHANGES-CSV`, one row per changed field or one observation row when no field changed. Spreadsheet formula prefixes are neutralized; use JSON for full coverage and retention metadata.

Only consume comparisons when `baselineCommitted` is `true` and status is `initialized` or `compared`. `prepared`, `incomplete`, `storage_error`, `concurrent_run`, `stale_scan` and `commit_unknown` are not completed comparison reports. A timed-out state write has an explicitly unknown outcome, not a guarantee that the old baseline is untouched. A committed report is retained in state for same-run replay if final output publishing fails.

**Every successfully saved job is still charged on repeat scans, including unchanged jobs.** Watchlists do not reduce source fetching or per-job events, and add storage/API work. There is no separate comparison event in this release. Any applicable platform/storage charges follow the Actor's current Store pricing. See [Apify key-value storage](https://docs.apify.com/storage/key-value-store) for storage retention.

## Input Parameters

| Parameter          | Type       | Required | Default        | Description                                      |
|--------------------|------------|----------|----------------|--------------------------------------------------|
| searchUrls         | string[]   | No       | []             | Full search URLs; forwards filters LinkedIn may ignore |
| jobUrls            | string[]   | No       | []             | Individual public LinkedIn job URLs              |
| keywords           | string[]   | Conditional | []          | Job titles, skills, or terms; use with locations |
| locations          | string[]   | Conditional | []          | City, region, or country; use with keywords      |
| workplaceType      | string[]   | No       | []             | Filter: remote, hybrid, onsite                   |
| jobType            | string[]   | No       | []             | Filter: full-time, part-time, contract, etc.     |
| experienceLevel    | string[]   | No       | []             | Filter: entry, mid-senior, director, etc.        |
| datePosted         | string     | No       | anytime        | Past 24 hours, week, month, or any time          |
| easyApplyOnly      | boolean    | No       | false          | Only LinkedIn Easy Apply jobs                    |
| sortBy             | string     | No       | relevance      | Relevance or most recent                         |
| minimumSalary      | string     | No       | none           | Optional LinkedIn salary threshold               |
| maxResults         | number     | No       | 5              | Maximum total jobs across all inputs             |
| maxJobsPerSearch   | number     | No       | 5              | Maximum jobs per search                          |
| watchlistName      | string     | No       | empty          | Optional persistent comparison name on platform runs |
| watchlistRetentionDays | number | No       | 30             | Last-seen retention, 1-90 days; pruned on successful commits |
| watchlistMaxJobs   | number     | No       | 1000           | Retained job cap, 1-5000                           |
| transport          | string     | No       | http           | Direct HTTP; legacy explicit-proxy API inputs select browser |
| proxyConfiguration | object     | No       | disabled       | Browser mode only; deliberately selected proxy use |

The Console prefilled QA input starts with **one** job and one job per search. Direct API calls that omit both result limits retain the existing five-job runtime defaults; set limits explicitly for repeatable watchlists.

## How to Scrape LinkedIn Jobs (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter **keywords + locations**, paste full **search URLs**, paste individual **job URLs**, or combine them.
3. Optionally filter by workplace, employment type, experience, date, Easy Apply, salary, and sort order.
4. Start with 1-5 results, inspect the output, then scale.
5. Run, then export results as JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Technical Details

- **Runtime:** Node.js 20 + Playwright (Chrome)
- **SDK:** Apify SDK v3 + Crawlee v3
- **HTTP:** No proxy, scripts or browser; HTML responses limited to 2 MiB, one source request at a time, bounded to 180 seconds
- **Browser:** Explicit proxy support, at least 1024 MB, session rotation and bounded legacy retries
- **Failure handling:** No automatic HTTP-to-browser or paid proxy fallback; incomplete scans cannot advance watchlist state
- **Input modes:** Keyword/location searches, full search URLs, and direct job URLs
- **Extraction:** Server-rendered markup plus public JobPosting JSON-LD when published
- **Pagination:** Offset paging over LinkedIn's public guest endpoints, bounded by limits
- **Deduplication:** By LinkedIn job ID across every input mode
- **Billing:** Atomic dataset write plus `job-scraped` event
- **Efficiency:** Only the HTML document is fetched. Scripts, stylesheets, images, media, and fonts are all blocked, because every field comes from server-rendered markup

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.
