export type WorkplaceType = 'remote' | 'hybrid' | 'onsite';
export type WorkplaceEvidenceSource = 'criteria' | 'structured-data' | 'title' | 'location' | 'role-description';
export interface WorkplaceEvidence {
  type: WorkplaceType;
  source: WorkplaceEvidenceSource;
  text: string;
}
export interface WorkplaceResolution {
  workplaceType: 'Remote' | 'Hybrid' | 'On-site' | null;
  workplaceEvidenceStatus: 'explicit' | 'unknown' | 'conflicting';
  workplaceEvidence: WorkplaceEvidence[];
}

const labels = { remote: 'Remote', hybrid: 'Hybrid', onsite: 'On-site' } as const;
const token = /\b(remote|hybrid|on[ -]?site|work(?:ing)? from home)\b/gi;
const classify = (value: string): WorkplaceType => /hybrid/i.test(value) ? 'hybrid'
  : /on[ -]?site/i.test(value) ? 'onsite' : 'remote';
const clean = (value: string): string => value.replace(/\s+/g, ' ').trim();

/** A source statement, not verification of the employer's actual working arrangement. */
export function resolveWorkplace(input: {
  criteria?: string | null;
  structuredLocationTypes?: string[];
  title?: string | null;
  location?: string | null;
  description?: string | null;
}): WorkplaceResolution {
  const evidence: WorkplaceEvidence[] = [];
  let ambiguous = false;
  const add = (type: WorkplaceType, source: WorkplaceEvidenceSource, text: string): void => {
    const entry = { type, source, text: clean(text).slice(0, 280) };
    if (!evidence.some(e => e.type === type && e.source === source && e.text === entry.text)) evidence.push(entry);
  };
  const inspect = (text: string | null | undefined, source: WorkplaceEvidenceSource): void => {
    if (!text) return;
    const normalized = clean(text);
    for (const match of normalized.matchAll(token)) {
      const before = normalized.slice(Math.max(0, match.index! - 45), match.index);
      const after = normalized.slice(match.index! + match[0].length, match.index! + match[0].length + 65);
      // "Remote sensing", company benefits/policies and technical remote access are not role arrangements.
      if (/\b(?:sensing|access|desktop|procedure|control|systems?|employees?|workers?|teams?|first|friendly|collaboration)\b/i.test(after.trim().split(/[.,;:]/)[0])
        || /\b(?:benefits?|reimbursement|allowance|centers?|centre|health|wellness|facilities)\b/i.test(`${before} ${after}`)) continue;
      if (source === 'role-description') {
        const rolePrefix = /\b(?:(?:this|the|our)\s+)?(?:role|position|job)\s+(?:is|will be|has been)\s+(?:(?:categorized|classified|designated|considered)\s+as\s+)?(?:not\s+(?:eligible for\s+|available for\s+)?|non[- ]?)?(?:an?\s+)?(?:fully\s+|entirely\s+|100%\s+)?$/i.test(before)
          || /\b(?:is|as)\s+(?:not\s+)?(?:an?\s+)?(?:fully\s+|entirely\s+|100%\s+)?$/i.test(before) && /^\s+(?:role|position|job)\b/i.test(after)
          || /\b(?:you(?:'|’)?ll|you will|you)\s+work\b[^.!?;]{0,120}\s(?:on|in|with)\s+(?:an?\s+)?$/i.test(normalized.slice(0, match.index)) && /^\s+(?:work\s+)?(?:schedule|arrangement|model)\b/i.test(after)
          || /\b(?:workplace(?: type)?|work arrangement|work location|location type|work model|working model)\s*:\s*$/i.test(before)
          || /^\s*(?:job )?location\s*:\s*$/i.test(before);
        if (!rolePrefix) continue;
      }
      if (/\b(?:not|no|non|cannot|can't|isn't|is not|isn’t|except)[ -]*(?:eligible for\s+|available for\s+)?(?:a\s+|fully\s+|entirely\s+)?$/i.test(before)
        || /^(?:\s*[-–—]?\s*)(?:is not|isn't|isn’t|not available|not permitted|not allowed)\b/i.test(after)
        || /\b(?:may|might|can|could|optional|options?|preferred|preference|potential|eligible|eligibility)\b/i.test(`${before} ${after}`)) {
        ambiguous = true;
        continue;
      }
      add(classify(match[0]), source, normalized.slice(Math.max(0, match.index! - 100), match.index! + 180));
    }
  };
  inspect(input.criteria, 'criteria');
  for (const value of input.structuredLocationTypes ?? []) {
    if (/^TELECOMMUTE$/i.test(value.trim())) add('remote', 'structured-data', `jobLocationType: ${value}`);
  }
  inspect(input.title, 'title');
  inspect(input.location, 'location');
  // Sentence-sized evidence keeps unrelated benefits and company policy out of the decision.
  for (const sentence of (input.description ?? '').split(/(?<=[.!?;])\s+|[\r\n]+/)) inspect(sentence, 'role-description');
  const types = new Set(evidence.map(e => e.type));
  const status = types.size > 1 || ambiguous && types.size > 0 ? 'conflicting' : types.size ? 'explicit' : 'unknown';
  return { workplaceType: status === 'explicit' ? labels[evidence[0].type] : null,
    workplaceEvidenceStatus: status, workplaceEvidence: evidence.slice(0, 12) };
}

/** Only known source-supported arrangements can meet an explicitly requested filter. */
export function matchesWorkplace(resolution: WorkplaceResolution, requested: WorkplaceType[]): boolean {
  return !requested.length || resolution.workplaceEvidenceStatus === 'explicit'
    && resolution.workplaceType !== null && requested.some(type => labels[type] === resolution.workplaceType);
}

export function workplaceTypesFromUrl(url: string): WorkplaceType[] {
  const codes = new URL(url).searchParams.getAll('f_WT').flatMap(value => value.split(','));
  const map: Record<string, WorkplaceType> = { '1': 'onsite', '2': 'remote', '3': 'hybrid' };
  return [...new Set(codes.map(code => map[code.trim()]).filter((type): type is WorkplaceType => Boolean(type)))];
}
