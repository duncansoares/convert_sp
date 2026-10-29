import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ConnectionOptions } from '../core/db/catalog.js';
import { appDataDir } from './secrets.js';

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

export interface Settings {
  lastProfileId: string | null;
  lastOutputDir: string | null;
}

interface ProfileFile {
  version: 1;
  profiles: ConnectionProfile[];
  settings: Settings;
}

const EMPTY: ProfileFile = {
  version: 1,
  profiles: [],
  settings: { lastProfileId: null, lastOutputDir: null },
};

export function profilesPath(): string {
  return path.join(appDataDir(), 'profiles.json');
}

export async function loadProfiles(): Promise<ProfileFile> {
  try {
    const raw = await readFile(profilesPath(), 'utf8');
    const parsed = JSON.parse(raw) as ProfileFile;
    if (parsed?.version === 1 && Array.isArray(parsed.profiles)) {
      return {
        version: 1,
        profiles: parsed.profiles,
        settings: parsed.settings ?? EMPTY.settings,
      };
    }
  } catch {
    // fall through
  }
  return { ...EMPTY, profiles: [], settings: { ...EMPTY.settings } };
}

export async function saveProfiles(file: ProfileFile): Promise<void> {
  await mkdir(path.dirname(profilesPath()), { recursive: true });
  await writeFile(profilesPath(), `${JSON.stringify(file, null, 2)}\n`, { mode: 0o600 });
}

export interface ProfileInput {
  name: string;
  server: string;
  port: number;
  instanceName?: string | null;
  database: string;
  user: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  outputDir: string;
  projectName: string;
  password?: string | null;
}

export async function upsertProfile(
  input: ProfileInput,
  secretStore: { set: (id: string, value: string) => Promise<void>; remove: (id: string) => Promise<void> },
  existingId?: string,
): Promise<ConnectionProfile> {
  const file = await loadProfiles();
  const now = new Date().toISOString();
  const id = existingId ?? randomUUID();

  const profile: ConnectionProfile = {
    id,
    name: input.name,
    server: input.server,
    port: input.port,
    instanceName: input.instanceName ?? null,
    database: input.database,
    user: input.user,
    encrypt: input.encrypt,
    trustServerCertificate: input.trustServerCertificate,
    outputDir: input.outputDir,
    projectName: input.projectName,
    hasSecret: Boolean(input.password),
    updatedAt: now,
  };

  const index = file.profiles.findIndex((item) => item.id === id);
  if (index >= 0) {
    const previous = file.profiles[index] as ConnectionProfile;
    profile.hasSecret = Boolean(input.password) || previous.hasSecret;
    file.profiles[index] = profile;
  } else {
    file.profiles.push(profile);
  }

  if (input.password) {
    await secretStore.set(id, input.password);
  }
  if (input.password === null) {
    await secretStore.remove(id);
    profile.hasSecret = false;
  }

  file.settings.lastProfileId = id;
  await saveProfiles(file);
  return profile;
}

export async function removeProfile(
  id: string,
  secretStore: { remove: (id: string) => Promise<void> },
): Promise<void> {
  const file = await loadProfiles();
  file.profiles = file.profiles.filter((profile) => profile.id !== id);
  if (file.settings.lastProfileId === id) {
    file.settings.lastProfileId = file.profiles[0]?.id ?? null;
  }
  await secretStore.remove(id);
  await saveProfiles(file);
}

export async function updateSettings(settings: Partial<Settings>): Promise<void> {
  const file = await loadProfiles();
  file.settings = { ...file.settings, ...settings };
  await saveProfiles(file);
}

export function toConnectionOptions(
  profile: ConnectionProfile,
  password: string,
): ConnectionOptions {
  return {
    server: profile.server,
    port: profile.port,
    instanceName: profile.instanceName ?? undefined,
    database: profile.database,
    user: profile.user,
    password,
    encrypt: profile.encrypt,
    trustServerCertificate: profile.trustServerCertificate,
  };
}
