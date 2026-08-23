# LinkedIn Jobs Scraper - $1/1k, Search URLs, Salaries & Skills

> **Unofficial Actor.** This tool is independent and is **not affiliated with, endorsed by, or sponsored by LinkedIn**. It collects only publicly available job listings and never uses LinkedIn credentials, cookies, or private APIs.

## Description

Scrape LinkedIn job listings from keywords and locations, complete LinkedIn Jobs search URLs, or individual public job URLs. Preserve filters selected on LinkedIn, paginate automatically, and export clean records with company data, descriptions, normalized dates and salaries, skills, benefits, LinkedIn listing URLs, and external application links. No login, cookies, or API key required.

Use simple keyword/location fields for repeatable searches, paste full search-result URLs to keep LinkedIn filters, or pass job URLs when you already know the listings. All modes can be combined in one run.

Built on Crawlee's PlaywrightCrawler with residential proxy rotation, session pool management, and explicit authwall/challenge detection. Each search supports bounded pagination up to 500 listings, and multiple keyword/location combinations, search URLs, and direct job URLs can run together.

Deduplication by LinkedIn job ID ensures clean, unique results. A pay-per-event model charges $1.00 per 1,000 successfully scraped jobs, making it affordable at any scale.

### Use Cases

1. **HR & Recruitment Research** — Benchmark job titles, salaries, required skills, and workplace trends across markets and industries to inform hiring strategy.
2. **Job Aggregators** — Feed LinkedIn job data into your own job board, comparison site, or analytics dashboard with structured, deduplicated records.
3. **Salary Benchmarking** — Collect salary ranges from job listings to analyse compensation trends by role, location, experience level, and company size.
4. **Talent Mapping** — Identify which companies are hiring for specific roles in specific regions, and map competitor hiring activity over time.
5. **Competitor Hiring Analysis** — Monitor what skills, seniority levels, and locations your competitors are hiring for, and detect strategic shifts.

## Sample Output

```json
{
  "jobTitle": "Software Engineer",
  "companyName": "Google",
  "companyLinkedInUrl": "https://www.linkedin.com/company/google/",
  "companyLogoUrl": "https://media.licdn.com/dms/image/example",
  "jobLocation": "London, England",
  "country": "GB",
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
  "salaryCurrency": "$",
  "salaryPeriod": "YEAR",
  "jobUrl": "https://www.linkedin.com/jobs/view/123456789",
  "applyUrl": "https://careers.google.com/jobs/123456789",
  "jobId": "123456789",
  "companySize": null,
  "companyIndustry": null,
  "easyApply": true,
  "keywordUsed": "software engineer",
  "locationUsed": "London, UK",
  "resultPosition": 1,
  "scrapedAt": "2026-08-23T13:30:00.000Z"
}
```

## Pricing

| Unit                | Price     |
|---------------------|-----------|
| Per 1,000 jobs      | $1.00     |
| Actor start         | $0.00005 per GB of memory |

The dataset write and `job-scraped` charge happen atomically. Empty, blocked, rejected, or spending-limit records are not billed as jobs.

A job is saved and charged only when it carries a real job title plus a company or a description. Blocked pages and empty results are never saved and never charged, and the run stops as soon as your `maxResults` or your spending limit is reached.

### Field Availability

LinkedIn does not publish every field on every listing. Missing values remain `null` rather than being guessed. `jobUrl` always points to the LinkedIn listing; `applyUrl` is only populated when LinkedIn publishes a separate employer application link. When no explicit skills list is present, `requiredSkills` uses whole-word inference from the public description.

## Input Parameters

| Parameter          | Type       | Required | Default        | Description                                      |
|--------------------|------------|----------|----------------|--------------------------------------------------|
| searchUrls         | string[]   | No       | []             | Full LinkedIn Jobs search URLs; preserves selected filters |
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
| proxyConfiguration | object     | No       | RESIDENTIAL    | Apify proxy settings                             |

## How to Scrape LinkedIn Jobs (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter **keywords + locations**, paste full **search URLs**, paste individual **job URLs**, or combine them.
3. Optionally filter by workplace, employment type, experience, date, Easy Apply, salary, and sort order.
4. Start with 1-5 results, inspect the output, then scale.
5. Run, then export results as JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Technical Details

- **Runtime:** Node.js 20 + Playwright (Chrome)
- **SDK:** Apify SDK v3 + Crawlee v3
- **Proxy:** Residential proxy rotation (required for LinkedIn)
- **Anti-bot:** Session pool (max 20 uses), randomised delays, 3 retries with retryOnBlocked, authwall detection with session rotation
- **Input modes:** Keyword/location searches, full search URLs, and direct job URLs
- **Extraction:** Server-rendered markup plus public JobPosting JSON-LD when published
- **Pagination:** Offset paging over LinkedIn's public guest endpoints, bounded by limits
- **Deduplication:** By LinkedIn job ID across every input mode
- **Billing:** Atomic dataset write plus `job-scraped` event
- **Efficiency:** Only the HTML document is fetched. Scripts, stylesheets, images, media, and fonts are all blocked, because every field comes from server-rendered markup

## Responsible Use

This Actor is intended for lawful collection of publicly available information only. Users are responsible for ensuring their use complies with the source website's terms, robots.txt, applicable privacy laws, including India's DPDP Act, and all local regulations.

Do not use this Actor to collect, store, sell, or misuse personal data without a lawful basis. The Actor author is not responsible for misuse by end users.
