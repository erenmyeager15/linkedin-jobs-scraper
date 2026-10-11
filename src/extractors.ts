export interface DomExtractionInput {
  kind: 'search' | 'detail';
  pageUrl: string;
  blockMarkers: string[];
  document?: Document;
  DOMParser?: typeof globalThis.DOMParser;
}

/** Self-contained for Playwright serialization and local server-HTML parsing. */
export function extractLinkedInDom(input: DomExtractionInput) {
  const document = input.document ?? globalThis.document;
  const DOMParser = input.DOMParser ?? globalThis.DOMParser;
  const blockMarkers = input.blockMarkers;
  const absoluteHref = (element: Element | null | undefined): string | null => {
    const raw = element?.getAttribute('href');
    if (!raw) return null;
    try { const url = new URL(raw, input.pageUrl); return /^https?:$/.test(url.protocol) ? url.href : null; }
    catch { return null; }
  };
  // Static DOM text, not CSS rendering. Scripts, templates and hidden boilerplate
  // cannot become a job description or trigger a challenge marker.
  const visibleText = (root: Node): string => {
    const chunks: string[] = [];
    const walk = (node: Node): void => {
      if (node.nodeType === 3) { chunks.push(node.textContent ?? ''); return; }
      if (node.nodeType === 1) {
        const element = node as Element;
        if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(element.tagName) || element.hasAttribute('hidden')
          || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(element.getAttribute('style') ?? '')) return;
        if (element.tagName === 'BR') { chunks.push('\n'); return; }
        const block = /^(BODY|DIV|P|LI|UL|OL|SECTION|ARTICLE|H[1-6]|TR)$/.test(element.tagName);
        if (block) chunks.push('\n');
        Array.from(node.childNodes).forEach(walk);
        if (block) chunks.push('\n');
        return;
      }
      Array.from(node.childNodes).forEach(walk);
    };
    walk(root);
    return chunks.join('').replace(/[^\S\n]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  };
  if (input.kind === 'search') {
    const cards = document.querySelectorAll<HTMLElement>('li');
    let jobCardCount = 0;
    const results: Array<{
      jobId: string;
      jobTitle: string | null;
      companyName: string | null;
      companyLinkedInUrl: string | null;
      companyLogoUrl: string | null;
      jobLocation: string | null;
      postedDate: string | null;
      salaryRange: string | null;
      jobUrl: string | null;
    }> = [];

    for (const card of cards) {
      try {
        const cardRoot = card.querySelector('.base-card, .base-search-card, [data-entity-urn]');
        const base = cardRoot || card;
        const urn = base.getAttribute('data-entity-urn') || '';
        const link = card.querySelector<HTMLAnchorElement>('a.base-card__full-link, a[href*="/jobs/view/"]');
        const href = link?.getAttribute('href') || '';

        // Count only real job cards, so the paging offset cannot jump past listings.
        if (cardRoot || href) jobCardCount += 1;

        let jobId = '';
        const urnM = urn.match(/jobPosting:(\d+)/);
        const hrefM = href.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/) || href.match(/(\d{6,})/);
        if (urnM) jobId = urnM[1];
        else if (hrefM) jobId = hrefM[1];
        if (!jobId) continue;

        const jobTitle = card.querySelector('.base-search-card__title, h3')?.textContent?.trim() || null;
        const companyEl = card.querySelector<HTMLAnchorElement>('.base-search-card__subtitle a, h4 a, .base-search-card__subtitle');
        const companyName = companyEl?.textContent?.trim() || null;
        const companyLinkedInUrl = absoluteHref(companyEl);
        const logoEl = card.querySelector<HTMLImageElement>('img');
        const companyLogoUrl = logoEl?.getAttribute('data-delayed-url')
          || logoEl?.getAttribute('data-ghost-url')
          || logoEl?.getAttribute('src')
          || null;
        const jobLocation = card.querySelector('.job-search-card__location')?.textContent?.trim() || null;

        const timeEl = card.querySelector('time');
        const postedDate = timeEl?.getAttribute('datetime') || timeEl?.textContent?.trim() || null;

        const salaryEl = card.querySelector('.job-search-card__salary-info');
        const salaryRange = salaryEl?.textContent?.replace(/\s+/g, ' ').trim() || null;

        const jobUrl = href ? (href.startsWith('http') ? href.split('?')[0] : `https://www.linkedin.com${href}`) : null;

        results.push({
          jobId,
          jobTitle,
          companyName,
          companyLinkedInUrl,
          companyLogoUrl,
          jobLocation,
          postedDate,
          salaryRange,
          jobUrl,
        });
      } catch {
        /* skip malformed card */
      }
    }

    const pageText = (visibleText(document.body ?? document)).toLowerCase();

    return {
      kind: 'search' as const,
      results,
      cardCount: jobCardCount,
      blocked: blockMarkers.some((marker) => pageText.includes(marker)),
      emptyRecognized: !pageText.trim() || /\bno (?:matching )?(?:jobs?|results?|job postings?) (?:found|available)\b/i.test(pageText),
    };
  }
  const text = (sel: string): string | null => {
    const el = document.querySelector(sel);
    return el?.textContent?.trim() || null;
  };
  const textAny = (sels: string[]): string | null => {
    for (const s of sels) {
      const v = text(s);
      if (v) return v;
    }
    return null;
  };

  const ldObjects: Array<Record<string, unknown>> = [];
  const collectLd = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(collectLd);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const objectValue = value as Record<string, unknown>;
    ldObjects.push(objectValue);
    if (Array.isArray(objectValue['@graph'])) objectValue['@graph'].forEach(collectLd);
  };
  document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]').forEach((script) => {
    try {
      collectLd(JSON.parse(script.textContent || ''));
    } catch {
      /* Ignore malformed structured data and continue with visible markup. */
    }
  });
  const jobPosting = ldObjects.find((item) => {
    const rawType = item['@type'];
    const types = Array.isArray(rawType) ? rawType.map(String) : [String(rawType ?? '')];
    return types.includes('JobPosting');
  }) ?? {};
  const structuredCompany = (
    jobPosting.hiringOrganization && typeof jobPosting.hiringOrganization === 'object'
      ? jobPosting.hiringOrganization
      : {}
  ) as Record<string, unknown>;
  const rawJobLocation = Array.isArray(jobPosting.jobLocation)
    ? jobPosting.jobLocation[0]
    : jobPosting.jobLocation;
  const structuredLocationObject = (
    rawJobLocation && typeof rawJobLocation === 'object' ? rawJobLocation : {}
  ) as Record<string, unknown>;
  const structuredAddress = (
    structuredLocationObject.address && typeof structuredLocationObject.address === 'object'
      ? structuredLocationObject.address
      : {}
  ) as Record<string, unknown>;
  const rawCountry = structuredAddress.addressCountry;
  const structuredCountry = typeof rawCountry === 'string'
    ? rawCountry
    : rawCountry && typeof rawCountry === 'object'
      ? String((rawCountry as Record<string, unknown>).name ?? '') || null
      : null;
  const structuredLocation = [
    structuredAddress.streetAddress,
    structuredAddress.addressLocality,
    structuredAddress.addressRegion,
    structuredAddress.postalCode,
    structuredCountry,
  ].map((value) => String(value ?? '').trim()).filter(Boolean).join(', ') || null;

  const baseSalary = (
    jobPosting.baseSalary && typeof jobPosting.baseSalary === 'object'
      ? jobPosting.baseSalary
      : {}
  ) as Record<string, unknown>;
  const salaryValue = (
    baseSalary.value && typeof baseSalary.value === 'object' ? baseSalary.value : {}
  ) as Record<string, unknown>;
  const numberValue = (value: unknown): number | null => {
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const structuredSalaryMin = numberValue(salaryValue.minValue ?? salaryValue.value);
  const structuredSalaryMax = numberValue(salaryValue.maxValue);
  const structuredSalaryCurrency = String(
    baseSalary.currency ?? salaryValue.currency ?? '',
  ).trim() || null;
  const structuredSalaryPeriod = String(
    salaryValue.unitText ?? baseSalary.unitText ?? '',
  ).trim().toUpperCase() || null;
  const structuredSalaryRange = structuredSalaryMin === null
    ? null
    : [
        structuredSalaryCurrency,
        structuredSalaryMax === null
          ? String(structuredSalaryMin)
          : String(structuredSalaryMin) + ' - ' + String(structuredSalaryMax),
        structuredSalaryPeriod ? '/ ' + structuredSalaryPeriod.toLowerCase() : null,
      ].filter(Boolean).join(' ');

  const toStringArray = (value: unknown): string[] => {
    const values = Array.isArray(value) ? value : value ? [value] : [];
    return values
      .flatMap((entry) => String(entry).split(/\n|;/))
      .map((entry) => entry.replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  };
  const structuredBenefits = toStringArray(jobPosting.jobBenefits);
  const structuredSkills = toStringArray(jobPosting.skills);
  const structuredIndustries = toStringArray(jobPosting.industry);
  const structuredResponsibilities = String(jobPosting.responsibilities ?? '').trim() || null;
  const structuredQualifications = String(jobPosting.qualifications ?? '').trim() || null;
  const structuredDescriptionHtml = String(jobPosting.description ?? '').trim() || null;
  const structuredJobTitle = String(jobPosting.title ?? '').trim() || null;
  const structuredCompanyName = String(structuredCompany.name ?? '').trim() || null;
  const structuredCompanyUrl = String(
    structuredCompany.sameAs ?? structuredCompany.url ?? '',
  ).trim() || null;
  const structuredCompanyLogo = typeof structuredCompany.logo === 'string'
    ? structuredCompany.logo
    : structuredCompany.logo && typeof structuredCompany.logo === 'object'
      ? String((structuredCompany.logo as Record<string, unknown>).url ?? '').trim() || null
      : null;
  const structuredPostedAt = String(jobPosting.datePosted ?? '').trim() || null;
  const structuredExpiresAt = String(jobPosting.validThrough ?? '').trim() || null;
  const structuredJobType = toStringArray(jobPosting.employmentType).join(', ') || null;

  const pageText = visibleText(document.body ?? document);
  const jobTitle = textAny([
    'h1.top-card-layout__title',
    '.top-card-layout__title',
    'h1',
  ]) ?? structuredJobTitle;

  const companyName = textAny([
    '.topcard__org-name-link',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
  ]) ?? structuredCompanyName;
  const companyEl = document.querySelector<HTMLAnchorElement>(
    '.topcard__org-name-link, .job-details-jobs-unified-top-card__company-name a, .jobs-unified-top-card__company-name a'
  );
  const companyLinkedInUrl = absoluteHref(companyEl)?.split('?')[0] || structuredCompanyUrl;
  const companyLogoEl = document.querySelector<HTMLImageElement>(
    '.top-card-layout__entity-image, .artdeco-entity-image, img[data-delayed-url]'
  );
  const companyLogoUrl = companyLogoEl?.getAttribute('data-delayed-url')
    || companyLogoEl?.getAttribute('data-ghost-url')
    || companyLogoEl?.getAttribute('src')
    || structuredCompanyLogo;

  const jobLocation = textAny([
    '.topcard__flavor--bullet',
    '.job-details-jobs-unified-top-card__bullet',
    '.jobs-unified-top-card__bullet',
  ]) ?? structuredLocation;

  let postedDate: string | null = textAny([
    '.topcard__flavor--metadata-posted-date',
    '.job-details-jobs-unified-top-card__posted-date',
    '.jobs-unified-top-card__posted-date',
  ]);
  if (!postedDate) {
    const m = pageText.match(
      /(Posted\s+\d+\s+(hour|day|week|month|year)s?\s+ago)/i
    );
    if (m) postedDate = m[1];
  }
  postedDate ??= structuredPostedAt;

  const applyAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).find((anchor) => {
    const label = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
    if (!/\bapply\b/i.test(label)) return false;
    const href = absoluteHref(anchor);
    if (!href) return false;
    const target = new URL(href, input.pageUrl);
    const hostname = target.hostname.toLowerCase();
    const isLinkedIn = hostname === 'linkedin.com' || hostname.endsWith('.linkedin.com');
    return /\/jobs\/view\/externalApply\//i.test(target.pathname) || !isLinkedIn;
  });
  const applyUrl = absoluteHref(applyAnchor);

  let numberOfApplicants: number | null = null;
  const appText = textAny([
    '.topcard__flavor--metadata-applications',
    '.job-details-jobs-unified-top-card__applicant-count',
    '.jobs-unified-top-card__applicant-count',
  ]);
  if (appText) {
    const m = appText.match(/(\d[\d,]*)/);
    if (m) {
      const parsed = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(parsed)) numberOfApplicants = parsed;
    }
  }
  if (numberOfApplicants === null) {
    const m = pageText.match(/(\d[\d,]*)\s*applicant/i);
    if (m) {
      const parsed = parseInt(m[1].replace(/,/g, ''), 10);
      if (!Number.isNaN(parsed)) numberOfApplicants = parsed;
    }
  }

  const descriptionSelectors = [
    '.description__text .show-more-less-html__markup',
    '.show-more-less-html__markup',
    '.description__text',
    '.jobs-description-content__text',
    '.jobs-box__description-content',
    'article.jobs-description',
    '.job-view-layout',
  ];
  const descriptionElement = descriptionSelectors
    .map((selector) => document.querySelector<HTMLElement>(selector))
    .find((element): element is HTMLElement => Boolean(element));
  // Browser DOMParser wraps fragments; server DOMParser does not. Make the
  // document shape explicit so structured-only descriptions retain their text.
  const structuredDescriptionDocument = structuredDescriptionHtml
    ? new DOMParser().parseFromString(/<html(?:\s|>)/i.test(structuredDescriptionHtml)
      ? structuredDescriptionHtml : `<html><body>${structuredDescriptionHtml}</body></html>`, 'text/html')
    : null;
  const jobDescription = (descriptionElement ? visibleText(descriptionElement) : null)?.replace(/\n{3,}/g, '\n\n').trim()
    || (structuredDescriptionDocument
      ? visibleText(structuredDescriptionDocument.body ?? structuredDescriptionDocument) || null
      : null);
  const jobDescriptionHtml = (descriptionElement?.innerHTML?.trim()
    || structuredDescriptionHtml)?.replace(/&#(?:160|xA0);/gi, '&nbsp;') ?? null;

  let workplaceType: string | null = null;
  let jobType: string | null = null;
  let experienceLevel: string | null = null;
  const jobFunctions: string[] = [];
  const industries: string[] = [];

  const criteriaItems = document.querySelectorAll<HTMLElement>(
    '.description__job-criteria-list li, .jobs-unified-description__job-criteria-list li'
  );
  for (const item of criteriaItems) {
    const label = item
      .querySelector(
        '.description__job-criteria-subheader, .jobs-unified-description__job-criteria-subheader'
      )
      ?.textContent?.trim()
      .toLowerCase();
    const value = item
      .querySelector(
        '.description__job-criteria-text, .jobs-unified-description__job-criteria-text'
      )
      ?.textContent?.trim();
    if (!value) continue;
    if (
      label?.includes('employment type') ||
      label?.includes('job type') ||
      label === 'type'
    ) {
      jobType = value;
    } else if (
      label?.includes('seniority') ||
      label?.includes('experience') ||
      label === 'experience level' ||
      label === 'level'
    ) {
      experienceLevel = value;
    } else if (
      label?.includes('workplace') ||
      label === 'workplace type' ||
      label === 'location type'
    ) {
      workplaceType = value;
    } else if (label?.includes('job function') || label === 'function') {
      jobFunctions.push(...value.split(',').map((entry) => entry.trim()).filter(Boolean));
    } else if (label?.includes('industr')) {
      industries.push(...value
        .split(',')
        .map((entry) => entry.trim().replace(/^and\s+/i, ''))
        .filter(Boolean));
    }
  }

  if (!jobType) {
    const m = pageText.match(
      /\b(Full-time|Part-time|Contract|Internship|Temporary|Volunteer)\b/i
    );
    if (m) jobType = m[1];
  }
  jobType ??= structuredJobType;
  if (!experienceLevel) {
    const m = pageText.match(
      /\b(Entry level|Mid-Senior level|Associate|Director|Executive|Internship)\b/i
    );
    if (m) experienceLevel = m[1];
  }

  let salaryRange: string | null = null;
  const salaryText = textAny([
    '.salary',
    '.salary-range',
    '.job-details-jobs-unified-top-card__salary',
    '.jobs-unified-top-card__salary',
  ]);
  if (salaryText) {
    salaryRange = salaryText;
  } else {
    const explicitRange = pageText.match(
      /salary range(?:\s+for\s+this\s+(?:role|position))?\s+(?:is|of)\s+((?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*[\d,]+(?:\.\d+)?[kKmM]?)\s*(?:-|–|—|to|and)\s*((?:(?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*)?[\d,]+(?:\.\d+)?[kKmM]?)(?:\s*(?:\/|per)\s*(year|yr|hr|hour|month|week|day))?/i,
    );
    if (explicitRange) {
      salaryRange = [explicitRange[1], '-', explicitRange[2], explicitRange[3] ? `/ ${explicitRange[3]}` : null]
        .filter(Boolean)
        .join(' ');
    } else {
      const contextual = pageText.match(
        /\b(?:salary|compensation|base pay|pay range|annual pay|hourly rate)\b[^.\n]{0,160}?((?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*[\d,]+(?:\.\d+)?[kKmM]?(?:\s*(?:-|–|—|to|and)\s*(?:(?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*)?[\d,]+(?:\.\d+)?[kKmM]?)?(?:\s*(?:\/|per)\s*(?:year|yr|hr|hour|month|week|day))?)/i,
      );
      const periodBound = pageText.match(
        /((?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*[\d,]+(?:\.\d+)?[kKmM]?(?:\s*(?:-|–|—|to|and)\s*(?:(?:USD|GBP|EUR|INR|AUD|CAD|SGD|AED|[$£€₹])\s*)?[\d,]+(?:\.\d+)?[kKmM]?)?\s*(?:\/|per)\s*(?:year|yr|hr|hour|month|week|day))/i,
      );
      salaryRange = contextual?.[1] ?? periodBound?.[1] ?? null;
    }
  }
  salaryRange ??= structuredSalaryRange;

  const sectionItems = (headingPattern: RegExp): string[] => {
    if (!descriptionElement) return [];
    const heading = Array.from(
      descriptionElement.querySelectorAll<HTMLElement>('h2, h3, h4, strong'),
    ).find((element) => headingPattern.test(element.textContent?.replace(/\s+/g, ' ').trim() || ''));
    if (!heading) return [];
    let sibling = heading.nextElementSibling;
    while (sibling) {
      if (/^H[2-4]$/.test(sibling.tagName) || sibling.tagName === 'STRONG') break;
      const items = Array.from(sibling.querySelectorAll('li'))
        .map((item) => item.textContent?.replace(/\s+/g, ' ').trim() || '')
        .filter(Boolean);
      if (items.length) return items;
      sibling = sibling.nextElementSibling;
    }
    return [];
  };
  const visibleResponsibilities = sectionItems(/responsibilit|what (?:you(?:'|’)?ll|you will) do/i);
  const visibleQualifications = sectionItems(/qualification|requirements?|what you (?:bring|need)/i);
  const visibleBenefits = sectionItems(/^benefits?\b/i);
  if (visibleBenefits.length === 0 && jobDescription) {
    const benefitsText = jobDescription.match(
      /\bBenefits?:\s*(.+?)(?=\b(?:This role|About (?:the company|[A-Z][A-Za-z.& ]+)|Why Join|Non-Discrimination)\b|$)/is,
    )?.[1]?.replace(/^.*?\binclude\s+/i, '').trim();
    if (benefitsText && benefitsText.length <= 2_000) {
      visibleBenefits.push(...benefitsText
        .split(/,\s*/)
        .map((item) => item.replace(/\s+and more\.?$/i, '').trim())
        .filter(Boolean));
    }
  }

  const requiredSkills: string[] = [];
  const skillHeadings = ['Skills', 'Qualifications', 'Required Skills', 'Technical Skills', 'Must Have'];
  for (const heading of skillHeadings) {
    const headingEl = Array.from(document.querySelectorAll('h2, h3, h4, strong')).find(
      (el) => el.textContent?.trim().toLowerCase() === heading.toLowerCase()
    );
    if (headingEl) {
      let next = headingEl.nextElementSibling;
      while (next) {
        if (next.tagName === 'UL') {
          next.querySelectorAll('li').forEach((li) => {
            const s = li.textContent?.trim();
            if (s) requiredSkills.push(s);
          });
          break;
        }
        if (['H2', 'H3', 'H4', 'HR'].includes(next.tagName)) break;
        next = next.nextElementSibling;
      }
    }
  }
  // When LinkedIn exposes no skills list, inference happens outside the browser
  // using whole-token matching so "Java" is not reported for "JavaScript".

  let companySize: string | null = null;
  let companyIndustry: string | null = null;
  const aboutSection = document.querySelector(
    '[data-anonymize="company-info"], .jobs-company__box, .jobs-company-info'
  );
  if (aboutSection) {
    const t = aboutSection.textContent || '';
    const sizeM = t.match(/(\d[\d,]*\s*(employees?|employee))/i);
    if (sizeM) companySize = sizeM[1];
    const indM = t.match(/Industry\s*:?\s*(.+?)(?:\n|$)/i);
    if (indM) companyIndustry = indM[1].trim();
  }
  companyIndustry ??= industries[0] ?? structuredIndustries[0] ?? null;
  requiredSkills.push(...structuredSkills);

  const lowerPageText = pageText.toLowerCase();
  const easyApply = lowerPageText.includes('easy apply')
    && !lowerPageText.includes('easy apply is not available');

  return {
    kind: 'detail' as const,
    jobTitle,
    companyName,
    companyLinkedInUrl,
    companyLogoUrl,
    jobLocation,
    country: structuredCountry,
    workplaceType,
    structuredLocationTypes: Array.isArray(jobPosting.jobLocationType)
      ? jobPosting.jobLocationType.map(String) : typeof jobPosting.jobLocationType === 'string' ? [jobPosting.jobLocationType] : [],
    jobType,
    experienceLevel,
    postedDate,
    structuredPostedAt,
    structuredExpiresAt,
    numberOfApplicants,
    jobDescription,
    jobDescriptionHtml,
    responsibilities: structuredResponsibilities || visibleResponsibilities.join('\n') || null,
    qualifications: structuredQualifications || visibleQualifications.join('\n') || null,
    benefits: [...new Set([...structuredBenefits, ...visibleBenefits])],
    requiredSkills,
    salaryRange,
    structuredSalaryMin,
    structuredSalaryMax,
    structuredSalaryCurrency,
    structuredSalaryPeriod,
    jobFunctions,
    industries: [...new Set([...industries, ...structuredIndustries])],
    companySize,
    companyIndustry,
    applyUrl,
    easyApply,
    blocked: blockMarkers.some((marker) => pageText.toLowerCase().includes(marker)),
  };
}
