export interface ConnectionProfile {
  id: string;
  name: string;
  server: string;
  port: number;
  instanceName: string | null;
  database: string;
  user: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  outputDir: string;
  projectName: string;
  hasSecret: boolean;
  updatedAt: string;
}

export interface ProfileInput {
  name: string;
  server: string;
  port: number;
  instanceName: string | null;
  database: string;
  user: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  outputDir: string;
  projectName: string;
  password?: string | null;
}

export interface Issue {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
}

export type Destination =
  | { kind: 'repository'; table: { schema: string; name: string }; className: string }
  | { kind: 'multitable'; className: string }
  | { kind: 'skipped'; reason: string };

export interface ProcedureSummary {
  key: string;
  schema: string;
  name: string;
  verb: 'get' | 'post' | 'delete';
  tables: string[];
  destination: Destination;
  methodName: string;
  paramsObject: boolean;
  paramsClass: string | null;
  rowType: string | null;
  parameterCount: number;
  issues: Issue[];
  resultError: string | null;
}

export interface JobResult {
  database: string;
  generated: number;
  skipped: number;
  counts: Record<string, number>;
  conflicts: string[];
  files: Array<{ path: string; status: string }>;
  outputDir: string;
}

export interface JobStatus {
  id: string;
  state: 'running' | 'done' | 'error';
  logs: string[];
  error: string | null;
  result: JobResult | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  directories: Array<{ name: string; path: string }>;
  roots: string[];
}

export interface OutputInspection {
  exists: boolean;
  empty: boolean;
  writable: boolean;
  hasManifest: boolean;
  generatedFiles: number;
  conflicts: string[];
}
