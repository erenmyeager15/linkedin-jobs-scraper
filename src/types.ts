export interface ActorInput {
  keywords: string[];
  locations: string[];
  workplaceType?: ('remote' | 'hybrid' | 'onsite')[];
  jobType?: ('full-time' | 'part-time' | 'contract' | 'internship' | 'temporary' | 'volunteer')[];
  experienceLevel?: ('internship' | 'entry' | 'associate' | 'mid-senior' | 'director' | 'executive')[];
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
  jobLocation: string | null;
  workplaceType: string | null;
  jobType: string | null;
  experienceLevel: string | null;
  postedDate: string | null;
  numberOfApplicants: number | null;
  jobDescription: string | null;
  requiredSkills: string[];
  salaryRange: string | null;
  applyUrl: string | null;
  jobId: string;
  companySize: string | null;
  companyIndustry: string | null;
  easyApply: boolean;
  keywordUsed: string;
  locationUsed: string;
  scrapedAt: string;
}
