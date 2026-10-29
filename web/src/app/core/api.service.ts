import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ConnectionProfile,
  DirectoryListing,
  JobResult,
  JobStatus,
  OutputInspection,
  ProcedureSummary,
  ProfileInput,
} from './models';

export const TOKEN_KEY = 'convert-sp-token';

export function sessionToken(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('token');
  if (fromUrl) {
    sessionStorage.setItem(TOKEN_KEY, fromUrl);
    return fromUrl;
  }
  return sessionStorage.getItem(TOKEN_KEY) ?? '';
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);

  info(): Observable<{ name: string; version: string; secretMode: string }> {
    return this.http.get<{ name: string; version: string; secretMode: string }>('/api/info');
  }

  profiles(): Observable<{ profiles: ConnectionProfile[]; settings: { lastProfileId: string | null } }> {
    return this.http.get<{ profiles: ConnectionProfile[]; settings: { lastProfileId: string | null } }>(
      '/api/profiles',
    );
  }

  saveProfile(input: ProfileInput, id?: string): Observable<ConnectionProfile> {
    if (id) {
      return this.http.put<ConnectionProfile>(`/api/profiles/${id}`, input);
    }
    return this.http.post<ConnectionProfile>('/api/profiles', input);
  }

  deleteProfile(id: string): Observable<{ ok: boolean }> {
    return this.http.delete<{ ok: boolean }>(`/api/profiles/${id}`);
  }

  testConnection(input: {
    server: string;
    port: number;
    instanceName: string | null;
    database: string;
    user: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  }): Observable<{ ok: boolean; version: string }> {
    return this.http.post<{ ok: boolean; version: string }>('/api/connections/test', input);
  }

  testProfile(id: string): Observable<{ ok: boolean; version: string }> {
    return this.http.post<{ ok: boolean; version: string }>(`/api/profiles/${id}/test`, {});
  }

  databases(input: {
    server: string;
    port: number;
    instanceName: string | null;
    user: string;
    password: string;
    encrypt: boolean;
    trustServerCertificate: boolean;
  }): Observable<{ databases: string[] }> {
    return this.http.post<{ databases: string[] }>('/api/connections/databases', {
      ...input,
      database: 'master',
    });
  }

  procedures(profileId: string, refresh = false): Observable<{
    database: string;
    procedures: ProcedureSummary[];
  }> {
    return this.http.get<{ database: string; procedures: ProcedureSummary[] }>(
      `/api/profiles/${profileId}/procedures${refresh ? '?refresh=1' : ''}`,
    );
  }

  inspectOutput(path: string): Observable<OutputInspection> {
    return this.http.post<OutputInspection>('/api/output/inspect', { path });
  }

  listDirectories(path?: string): Observable<DirectoryListing> {
    const query = path ? `?path=${encodeURIComponent(path)}` : '';
    return this.http.get<DirectoryListing>(`/api/fs/list${query}`);
  }

  generate(input: {
    profileId: string;
    selectedKeys: string[];
    outputDir: string;
    projectName: string;
    overwrite: 'safe' | 'force' | 'dry-run';
  }): Observable<{ jobId: string }> {
    return this.http.post<{ jobId: string }>('/api/generate', input);
  }

  job(id: string): Observable<JobStatus> {
    return this.http.get<JobStatus>(`/api/jobs/${id}`);
  }

  reportUrl(id: string): string {
    return `/api/jobs/${id}/report?token=${encodeURIComponent(sessionToken())}`;
  }
}

export type { JobResult };
