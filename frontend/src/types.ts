export interface DomainRecord {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** A site as the listings show it — the record plus what hangs off it. */
export interface DomainSummary extends DomainRecord {
  scriptCount: number;
  pageCount: number;
  locatorCount: number;
  verifiedCount: number;
}

export interface ScriptRecord {
  id: string;
  name: string;
  sourceUrl: string;
  prompt: string;
  filePath: string;
  createdAt: string;
  updatedAt: string;
  domainId: string;
  origin: 'record' | 'ai';
  pageUrls: string[];
}

/** One line of the plain-English view of a script. */
export interface ScriptStep {
  index: number;
  action: 'navigate' | 'fill' | 'click' | 'select' | 'check' | 'press' | 'assert' | 'accessibility' | 'other';
  text: string;
  title: string;
  test: string;
  target: string;
  value: string | null;
}

export interface LocatorEntry {
  key: string;
  locator: string;
  alternates: string[];
  role: string;
  name: string;
  tag: string;
  type: string | null;
  placeholder: string | null;
  options: string[] | null;
  verified: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  /** When this expression first went from observed to verified. */
  verifiedSince: string | null;
  /** The most recent passing run to confirm it. */
  lastVerifiedAt: string | null;
}

export interface PageLocators {
  url: string;
  title: string;
  headings: string[];
  locators: LocatorEntry[];
  updatedAt: string;
}

/** What the write endpoints answer with: the library alone, no site attached. */
export interface LibraryDocument {
  domainId: string;
  pages: PageLocators[];
  updatedAt: string;
  pageCount: number;
  locatorCount: number;
  verifiedCount: number;
}

export interface DomainLibrary extends LibraryDocument {
  domain: DomainRecord;
}

/** An element whose locator expression changed since the page was last recorded. */
export interface LocatorConflict {
  pageUrl: string;
  key: string;
  role: string;
  name: string;
  existingLocator: string;
  newLocator: string;
  existingAlternates: string[];
  existingVerified: boolean;
}

export type ConflictChoice = 'original' | 'new' | 'both';

export interface ConflictResolution {
  pageUrl: string;
  key: string;
  choice: ConflictChoice;
}

export interface RunStep {
  title: string;
  durationMs: number;
  error?: string;
}

export type RunStatus = 'queued' | 'running' | 'passed' | 'failed' | 'error';

export interface CapturedPage {
  url: string;
  title: string;
  elementCount: number;
  axeCount: number;
}

export interface RecordedActionSummary {
  type: string;
  locator: string | null;
  value: string | null;
  url: string;
}

export interface RecordingSession {
  id: string;
  domainId: string;
  startUrl: string;
  status: 'recording' | 'finished' | 'error';
  error: string | null;
  startedAt: string;
  pages: CapturedPage[];
  actionCount: number;
  actions: RecordedActionSummary[];
}

export interface RunTest {
  title: string;
  status: 'passed' | 'failed';
  durationMs: number;
  steps: RunStep[];
  error: string | null;
}

export interface RunRecord {
  id: string;
  scriptId: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  videoPath: string | null;
  reportPath: string;
  tests: RunTest[];
  steps: RunStep[];
  error: string | null;
}
