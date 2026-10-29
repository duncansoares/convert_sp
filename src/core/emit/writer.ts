import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { GeneratedFile } from '../generate/project.js';
import type { WrittenFile } from '../types.js';

export interface ManifestEntry {
  hash: string;
}

export interface Manifest {
  version: 1;
  generator: string;
  database: string;
  files: Record<string, ManifestEntry>;
}

export interface WriteOptions {
  outputDir: string;
  database: string;
  overwrite: 'safe' | 'force' | 'dry-run';
}

export interface WriteResult {
  files: WrittenFile[];
  counts: Record<WrittenFile['status'], number>;
  manifestPath: string;
}

const MANIFEST = 'manifest.json';

export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function readFileSafe(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

async function readManifest(outputDir: string): Promise<Manifest | null> {
  const raw = await readFileSafe(path.join(outputDir, MANIFEST));
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw.toString('utf8')) as Manifest;
    if (parsed?.version === 1 && parsed.files) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeAtomic(target: string, content: string): Promise<void> {
  await mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temp, content, 'utf8');
  await rename(temp, target);
}

export async function writeFiles(
  files: GeneratedFile[],
  options: WriteOptions,
): Promise<WriteResult> {
  const outputDir = path.resolve(options.outputDir);
  await mkdir(outputDir, { recursive: true });

  const manifest = await readManifest(outputDir);
  const nextManifest: Manifest = {
    version: 1,
    generator: 'convert-sp',
    database: options.database,
    files: {},
  };

  const results: WrittenFile[] = [];
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));

  for (const file of sorted) {
    const relative = file.path.replace(/\\/g, '/');
    const target = path.join(outputDir, relative);
    const contentHash = hashContent(file.content);
    const existing = await readFileSafe(target);
    const knownHash = manifest?.files[relative]?.hash;

    if (existing === null) {
      if (options.overwrite !== 'dry-run') {
        await writeAtomic(target, file.content);
      }
      nextManifest.files[relative] = { hash: contentHash };
      results.push({ path: relative, status: options.overwrite === 'dry-run' ? 'skipped' : 'created' });
      continue;
    }

    const existingHash = hashContent(existing);
    if (existingHash === contentHash) {
      nextManifest.files[relative] = { hash: contentHash };
      results.push({ path: relative, status: 'unchanged' });
      continue;
    }

    const safeToWrite = knownHash !== undefined && knownHash === existingHash;
    if (safeToWrite || options.overwrite === 'force') {
      if (options.overwrite !== 'dry-run') {
        await writeAtomic(target, file.content);
      }
      nextManifest.files[relative] = { hash: contentHash };
      results.push({ path: relative, status: options.overwrite === 'dry-run' ? 'skipped' : 'updated' });
      continue;
    }

    // User-modified or unknown file: never overwrite silently.
    if (knownHash !== undefined) {
      nextManifest.files[relative] = { hash: knownHash };
    }
    results.push({ path: relative, status: 'conflict' });
  }

  // Remove generated files that no longer exist, but only when unmodified.
  if (manifest) {
    const current = new Set(sorted.map((file) => file.path.replace(/\\/g, '/')));
    for (const [relative, entry] of Object.entries(manifest.files)) {
      if (current.has(relative)) {
        continue;
      }
      const target = path.join(outputDir, relative);
      const existing = await readFileSafe(target);
      if (!existing) {
        continue;
      }
      if (hashContent(existing) === entry.hash || options.overwrite === 'force') {
        if (options.overwrite !== 'dry-run') {
          await rm(target, { force: true });
        }
        results.push({ path: relative, status: options.overwrite === 'dry-run' ? 'skipped' : 'deleted' });
      } else {
        results.push({ path: relative, status: 'conflict' });
      }
    }
  }

  if (options.overwrite !== 'dry-run') {
    await writeAtomic(path.join(outputDir, MANIFEST), `${JSON.stringify(nextManifest, null, 2)}\n`);
  }

  const counts: Record<WrittenFile['status'], number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    deleted: 0,
    skipped: 0,
  };
  for (const result of results) {
    counts[result.status] += 1;
  }

  return { files: results, counts, manifestPath: path.join(outputDir, MANIFEST) };
}

export async function inspectOutputDirectory(
  outputDir: string,
): Promise<{
  exists: boolean;
  empty: boolean;
  writable: boolean;
  hasManifest: boolean;
  generatedFiles: number;
  conflicts: string[];
}> {
  const resolved = path.resolve(outputDir);
  let exists = false;
  let empty = true;
  let writable = false;
  let hasManifest = false;
  let generatedFiles = 0;

  try {
    const info = await stat(resolved);
    exists = info.isDirectory();
  } catch {
    exists = false;
  }

  if (exists) {
    try {
      const entries = await readFileSafe(path.join(resolved, MANIFEST));
      hasManifest = entries !== null;
      if (hasManifest) {
        const manifest = await readManifest(resolved);
        generatedFiles = Object.keys(manifest?.files ?? {}).length;
      }
    } catch {
      hasManifest = false;
    }
    empty = generatedFiles === 0;
    try {
      const probe = path.join(resolved, `.convert-sp-probe-${Date.now()}`);
      await writeFile(probe, '');
      await rm(probe, { force: true });
      writable = true;
    } catch {
      writable = false;
    }
  } else {
    writable = true;
  }

  return { exists, empty, writable, hasManifest, generatedFiles, conflicts: [] };
}
