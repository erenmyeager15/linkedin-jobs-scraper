# LinkedIn Jobs Scraper — Extract Job Listings at Scale

## Description

Scrape LinkedIn job listings at scale and turn them into a clean, deduplicated dataset — job titles, companies, salaries, required skills, workplace type, experience level, applicant counts, and more. This LinkedIn Jobs scraper runs from simple keywords and locations with no login and no API key. Export to JSON, CSV, Excel, or HTML, or pull via the Apify API.

Scrape LinkedIn Jobs at scale with this production-ready Apify Actor. Supply job keywords and locations, and the Actor extracts comprehensive job listing data including titles, companies, descriptions, salaries, required skills, workplace type, job type, experience level, applicant counts, and more.

Built on Crawlee's PlaywrightCrawler with residential proxy rotation, session pool management, and intelligent anti-bot countermeasures, this Actor reliably scrapes LinkedIn without getting blocked. Each search supports pagination up to 500 job listings, and multiple keyword + location combinations can be run in a single execution.

Deduplication by LinkedIn job ID ensures clean, unique results. A pay-per-event model charges $0.0015 per successfully scraped job, making it affordable at any scale.

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
  "jobLocation": "London, England",
  "workplaceType": "Hybrid",
  "jobType": "Full-time",
  "experienceLevel": "Mid-Senior level",
  "postedDate": "Posted 2 weeks ago",
  "numberOfApplicants": 47,
  "jobDescription": "Google's software engineers develop the next-generation technologies...",
  "requiredSkills": ["JavaScript", "Python", "Go", "Distributed Systems"],
  "salaryRange": "$120,000 - $180,000",
  "applyUrl": "https://www.linkedin.com/jobs/view/123456789/",
  "jobId": "123456789",
  "companySize": "10,001+ employees",
  "companyIndustry": "Technology, Information and Internet",
  "easyApply": true,
  "keywordUsed": "software engineer",
  "locationUsed": "London, UK",
  "scrapedAt": "2026-06-08T13:30:00.000Z"
}
```

## Pricing

| Unit        | Price    |
|-------------|----------|
| Per job     | $0.0015  |

Charges are incurred only when a job record is successfully scraped and pushed to the dataset. There are no upfront fees, no monthly minimums, and no hidden costs.

## Input Parameters

| Parameter          | Type       | Required | Default        | Description                                      |
|--------------------|------------|----------|----------------|--------------------------------------------------|
| keywords           | string[]   | Yes      | —              | Job titles, skills, or search terms              |
| locations          | string[]   | Yes      | —              | City, region, or country                         |
| workplaceType      | string[]   | No       | []             | Filter: remote, hybrid, onsite                   |
| jobType            | string[]   | No       | []             | Filter: full-time, part-time, contract, etc.     |
| experienceLevel    | string[]   | No       | []             | Filter: entry, mid-senior, director, etc.        |
| maxResults         | number     | No       | 50             | Maximum total jobs across all searches            |
| maxJobsPerSearch   | number     | No       | 25             | Max jobs per keyword + location combination       |
| proxyConfiguration | object     | No       | RESIDENTIAL    | Apify proxy settings                             |

## How to Scrape LinkedIn Jobs (Step by Step)

1. Click **Try for free** / **Run**.
2. Enter your job **keywords** (titles or skills) and **locations** (city, region, or country).
3. Optionally filter by workplace type, job type, and experience level.
4. Set **Max Results** and **Max Jobs Per Search** — start small to test.
5. Run, then export results as JSON, CSV, Excel, or HTML, or pull them via the Apify API.

## Technical Details

- **Runtime:** Node.js 20 + Playwright (Chrome)
- **SDK:** Apify SDK v3 + Crawlee v3
- **Proxy:** Residential proxy rotation (required for LinkedIn)
- **Anti-bot:** Session pool (max 20 uses), random delays (1500-4000ms), 3 retries with retryOnBlocked, cookie acceptance
- **Pagination:** Infinite scroll with automatic load-more detection
- **Deduplication:** By LinkedIn job ID across all searches
