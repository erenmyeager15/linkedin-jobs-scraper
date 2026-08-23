export interface ActorInput {
  keywords?: string[];
  locations?: string[];
  searchUrls?: string[];
  jobUrls?: string[];
  workplaceType?: ('remote' | 'hybrid' | 'onsite')[];
  jobType?: ('full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | 'volunteer')[];
  experienceLevel?: ('internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive')[];
  datePosted?: 'anytime' | 'past-24h' | 'past-week' | 'past-month';
  easyApplyOnly?: boolean;
  sortBy?: 'relevance' | 'recent';
  minimumSalary?: '40000' | '60000' | '80000' | '100000' | '120000';
  maxResults?: number;
  maxJobsPerSearch?: number;
  proxyConfiguration?: {
    useApifyProxy?: boolean;
    apifyProxyGroups?: string[];
  };
}

export interface JobRecord {
  jobTitle: string | null;
  companyName: string | null;
  companyLinkedInUrl: string | null;
  companyLogoUrl: string | null;
  jobLocation: string | null;
  country: string | null;
  workplaceType: string | null;
  jobType: string | null;
  experienceLevel: string | null;
  postedDate: string | null;
  postedAt: string | null;
  expiresAt: string | null;
  numberOfApplicants: number | null;
  jobDescription: string | null;
  jobDescriptionHtml: string | null;
  responsibilities: string | null;
  qualifications: string | null;
  benefits: string[];
  requiredSkills: string[];
  salaryRange: string | null;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  jobFunctions: string[];
  industries: string[];
  jobUrl: string;
  applyUrl: string | null;
  jobId: string;
  companySize: string | null;
  companyIndustry: string | null;
  easyApply: boolean;
  keywordUsed: string;
  locationUsed: string;
  sourceSearchUrl: string | null;
  resultPosition: number | null;
  scrapedAt: string;
}
