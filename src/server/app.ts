import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { analyzeCatalog, generateProject, planProject } from '../core/pipeline.js';
import type { AnalysisBundle } from '../core/pipeline.js';
import { listDatabases, loadCatalog, testConnection } from '../core/db/catalog.js';
import type { ConnectionOptions } from '../core/db/catalog.js';
import { inspectOutputDirectory } from '../core/emit/writer.js';
import { createSecretStore } from '../profiles/secrets.js';
import type { SecretStore } from '../profiles/secrets.js';
import {
  loadProfiles,
  removeProfile,
  saveProfiles,
  toConnectionOptions,
  updateSettings,
  upsertProfile,
} from '../profiles/store.js';
import type { ConnectionProfile } from '../profiles/store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const profileSchema = z.object({
  name: z.string().min(1).max(80),
  server: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  instanceName: z.string().nullable().optional(),
  database: z.string().min(1),
  user: z.string().min(1),
  encrypt: z.boolean(),
  trustServerCertificate: z.boolean(),
  outputDir: z.string().min(1),
  projectName: z.string().min(1),
  password: z.string().nullable().optional(),
});

const connectionSchema = z.object({
  server: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  instanceName: z.string().nullable().optional(),
  database: z.string().default('master'),
  user: z.string().min(1),
  password: z.string(),
  encrypt: z.boolean().default(true),
  trustServerCertificate: z.boolean().default(false),
});

const generateSchema = z.object({
  profileId: z.string().min(1),
  selectedKeys: z.array(z.string()).optional(),
  outputDir: z.string().min(1),
  projectName: z.string().min(1),
  overwrite: z.enum(['safe', 'force', 'dry-run']).default('safe'),
  include: z.array(z.string()).optional(),
  exclude: z.array(z.string()).optional(),
});

type JobState = 'running' | 'done' | 'error';

interface Job {
  id: string;
  state: JobState;
  logs: string[];
  error: string | null;
  result: {
    database: string;
    generated: number;
    skipped: number;
    counts: Record<string, number>;
    conflicts: string[];
    files: Array<{ path: string; status: string }>;
    outputDir: string;
  } | null;
  events: EventEmitter;
  startedAt: string;
  finishedAt: string | null;
}

export interface ServerOptions {
  port: number;
  host?: string;
  token?: string;
  open?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  url: string;
  token: string;
}

const TOKEN_COOKIE = 'convert_sp_token';

function publicProfile(profile: ConnectionProfile): ConnectionProfile {
  return profile;
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const host = options.host ?? '127.0.0.1';
  const token = options.token ?? randomBytes(24).toString('hex');
  const secrets: SecretStore = await createSecretStore();
  const jobs = new Map<string, Job>();
  const analysisCache = new Map<string, { bundle: AnalysisBundle; at: number }>();

  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cookie);
  await app.register(fastifyStatic, { root: await resolveWebRoot(), prefix: '/' });

  app.addHook('onRequest', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.url.startsWith('/api')) {
      return;
    }
    const header = request.headers['x-convert-sp-token'];
    const cookieToken = request.cookies?.[TOKEN_COOKIE];
    if (header === token || cookieToken === token) {
      return;
    }
    await reply.code(401).send({ message: 'Unauthorized. Open the URL printed by convert-sp ui.' });
  });

  app.setErrorHandler((error, _request, reply) => {
    const status = (error as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : String(error);
    reply.code(status).send({ message });
  });

  app.get('/', async (request, reply) => {
    const query = request.query as { token?: string };
    if (query.token === token) {
      reply.setCookie(TOKEN_COOKIE, token, {
        httpOnly: true,
        sameSite: 'strict',
        path: '/',
      });
    }
    return reply.sendFile('index.html');
  });

  app.get('/api/info', async () => {
    const profiles = await loadProfiles();
    return {
      name: 'convert-sp',
      version: '0.1.0',
      secretMode: secrets.mode,
      profiles: profiles.profiles.length,
      token,
    };
  });

  app.get('/api/profiles', async () => {
    const file = await loadProfiles();
    return {
      profiles: file.profiles.map(publicProfile),
      settings: file.settings,
    };
  });

  app.post('/api/profiles', async (request, reply) => {
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const profile = await upsertProfile(parsed.data, secrets);
    return profile;
  });

  app.put('/api/profiles/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const profile = await upsertProfile(parsed.data, secrets, id);
    return profile;
  });

  app.delete('/api/profiles/:id', async (request) => {
    const { id } = request.params as { id: string };
    await removeProfile(id, secrets);
    return { ok: true };
  });

  app.post('/api/connections/test', async (request, reply) => {
    const parsed = connectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const connection = toOptions(parsed.data);
    const result = await testConnection(connection);
    return { ok: true, version: result.version.split('\n')[0] };
  });

  app.post('/api/connections/databases', async (request, reply) => {
    const parsed = connectionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const databases = await listDatabases(toOptions({ ...parsed.data, database: 'master' }));
    return { databases };
  });

  app.post('/api/profiles/:id/test', async (request, reply) => {
    const { id } = request.params as { id: string };
    const profile = await findProfile(id);
    const password = await secrets.get(profile.id);
    if (password === null) {
      return reply.code(400).send({ message: 'No stored password for this profile.' });
    }
    const result = await testConnection(toConnectionOptions(profile, password));
    return { ok: true, version: result.version.split('\n')[0] };
  });

  app.get('/api/profiles/:id/databases', async (request) => {
    const { id } = request.params as { id: string };
    const profile = await findProfile(id);
    const password = await secrets.get(profile.id);
    if (password === null) {
      throw Object.assign(new Error('No stored password for this profile.'), { statusCode: 400 });
    }
    const databases = await listDatabases(toConnectionOptions(profile, password));
    return { databases };
  });

  app.get('/api/profiles/:id/procedures', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { refresh?: string };
    const profile = await findProfile(id);
    const bundle = await getBundle(profile, query.refresh === '1');
    return {
      database: bundle.database,
      procedures: bundle.analyses.map((analysis) => ({
        key: analysis.key,
        schema: analysis.procedure.schema,
        name: analysis.procedure.name,
        verb: analysis.verb,
        tables: analysis.tables.map((table) => `${table.schema}.${table.name}`),
        destination: analysis.destination,
        methodName: analysis.methodName,
        paramsObject: analysis.paramsObject,
        paramsClass: analysis.paramsClass,
        rowType: analysis.rowType,
        parameterCount: analysis.procedure.parameters.filter((parameter) => !parameter.isOutput).length,
        issues: analysis.issues,
        resultError: analysis.procedure.resultError,
      })),
    };
  });

  app.post('/api/output/inspect', async (request, reply) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: 'path is required' });
    }
    return inspectOutputDirectory(parsed.data.path);
  });

  app.get('/api/fs/list', async (request) => {
    const query = request.query as { path?: string };
    const target = query.path ? path.resolve(query.path) : os.homedir();
    const entries = await readdir(target, { withFileTypes: true }).catch(() => []);
    const directories = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('$'))
      .map((entry) => ({ name: entry.name, path: path.join(target, entry.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = path.dirname(target) === target ? null : path.dirname(target);
    return { path: target, parent, directories, roots: await listRoots() };
  });

  app.post('/api/generate', async (request, reply) => {
    const parsed = generateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ message: parsed.error.issues.map((issue) => issue.message).join('; ') });
    }
    const job: Job = {
      id: randomUUID(),
      state: 'running',
      logs: [],
      error: null,
      result: null,
      events: new EventEmitter(),
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };
    jobs.set(job.id, job);
    void runJob(job, parsed.data).catch((error: unknown) => {
      job.state = 'error';
      job.error = error instanceof Error ? error.message : String(error);
      log(job, `error: ${job.error}`);
      job.finishedAt = new Date().toISOString();
      job.events.emit('update');
    });
    return { jobId: job.id };
  });

  app.get('/api/jobs/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job) {
      return reply.code(404).send({ message: 'Unknown job' });
    }
    return {
      id: job.id,
      state: job.state,
      logs: job.logs,
      error: job.error,
      result: job.result,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    };
  });

  app.get('/api/jobs/:id/events', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job) {
      return reply.code(404).send({ message: 'Unknown job' });
    }

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const send = (): void => {
      reply.raw.write(
        `data: ${JSON.stringify({ state: job.state, logs: job.logs, error: job.error, result: job.result })}\n\n`,
      );
    };
    send();
    const timer = setInterval(send, 2000);
    job.events.on('update', send);
    request.raw.on('close', () => {
      clearInterval(timer);
      job.events.off('update', send);
      reply.raw.end();
    });
    return reply;
  });

  app.get('/api/jobs/:id/report', async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = jobs.get(id);
    if (!job?.result) {
      return reply.code(404).send({ message: 'Unknown job' });
    }
    const reportPath = path.join(job.result.outputDir, 'report.md');
    try {
      const { readFile } = await import('node:fs/promises');
      return reply.type('text/markdown').send(await readFile(reportPath, 'utf8'));
    } catch {
      return reply.code(404).send({ message: 'report.md not found' });
    }
  });

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api')) {
      return reply.code(404).send({ message: 'Not found' });
    }
    return reply.sendFile('index.html');
  });

  async function listRoots(): Promise<string[]> {
    if (process.platform !== 'win32') {
      return ['/'];
    }
    const roots: string[] = [];
    for (let code = 65; code <= 90; code += 1) {
      const drive = `${String.fromCharCode(code)}:\\`;
      try {
        await stat(drive);
        roots.push(drive);
      } catch {
        // ignore missing drives
      }
    }
    return roots;
  }

  async function findProfile(id: string): Promise<ConnectionProfile> {
    const file = await loadProfiles();
    const profile = file.profiles.find((item) => item.id === id || item.name === id);
    if (!profile) {
      throw Object.assign(new Error('Profile not found'), { statusCode: 404 });
    }
    return profile;
  }

  async function requirePassword(profile: ConnectionProfile): Promise<string> {
    const password = await secrets.get(profile.id);
    if (password === null) {
      throw Object.assign(new Error(`Profile "${profile.name}" has no stored password.`), {
        statusCode: 400,
      });
    }
    return password;
  }

  async function getBundle(profile: ConnectionProfile, refresh: boolean): Promise<AnalysisBundle> {
    const cached = analysisCache.get(profile.id);
    if (cached && !refresh && Date.now() - cached.at < 5 * 60 * 1000) {
      return cached.bundle;
    }
    const password = await requirePassword(profile);
    const catalog = await loadCatalog(toConnectionOptions(profile, password));
    const bundle = analyzeCatalog(catalog);
    analysisCache.set(profile.id, { bundle, at: Date.now() });
    return bundle;
  }

  function log(job: Job, message: string): void {
    job.logs.push(`${new Date().toISOString().slice(11, 19)}  ${message}`);
    job.events.emit('update');
  }

  async function runJob(job: Job, request: z.infer<typeof generateSchema>): Promise<void> {
    const profile = await findProfile(request.profileId);
    log(job, `profile: ${profile.name} (${profile.server}/${profile.database})`);

    const bundle = await getBundle(profile, true);
    log(job, `catalog: ${bundle.analyses.length} procedures`);

    const selected = request.selectedKeys?.length
      ? request.selectedKeys.length
      : bundle.analyses.length;
    log(job, `selection: ${selected} procedures`);

    const planned = planProject({
      bundle,
      selectedKeys: request.selectedKeys,
      include: request.include,
      exclude: request.exclude,
      projectName: request.projectName,
      outputDir: request.outputDir,
      overwrite: request.overwrite,
    });
    log(
      job,
      `classification: ${planned.generated.length} generated, ${planned.skipped.length} skipped`,
    );

    const result = await generateProject({
      bundle,
      selectedKeys: request.selectedKeys,
      include: request.include,
      exclude: request.exclude,
      projectName: request.projectName,
      outputDir: request.outputDir,
      overwrite: request.overwrite,
    });

    for (const [status, count] of Object.entries(result.write.counts)) {
      if (count > 0) {
        log(job, `${status}: ${count}`);
      }
    }
    for (const file of result.write.files.filter((item) => item.status === 'conflict')) {
      log(job, `conflict: ${file.path}`);
    }
    if (request.overwrite === 'dry-run') {
      log(job, 'dry run - nothing was written');
    }

    job.result = {
      database: bundle.database,
      generated: result.generated.length,
      skipped: result.skipped.length,
      counts: result.write.counts,
      conflicts: result.write.files
        .filter((item) => item.status === 'conflict')
        .map((item) => item.path),
      files: result.write.files,
      outputDir: path.resolve(request.outputDir),
    };
    job.state = 'done';
    job.finishedAt = new Date().toISOString();
    await updateSettings({ lastProfileId: profile.id, lastOutputDir: request.outputDir });
    log(job, `done in ${result.write.files.length} files`);
  }

  await app.listen({ port: options.port, host });
  const url = `http://${host}:${options.port}/?token=${token}`;
  return { app, url, token };
}

function toOptions(input: z.infer<typeof connectionSchema>): ConnectionOptions {
  return {
    server: input.server,
    port: input.port,
    instanceName: input.instanceName ?? undefined,
    database: input.database || 'master',
    user: input.user,
    password: input.password,
    encrypt: input.encrypt,
    trustServerCertificate: input.trustServerCertificate,
  };
}

async function resolveWebRoot(): Promise<string> {
  const candidates = [
    path.join(here, '../../web/dist/browser'),
    path.join(here, '../../web/dist/web/browser'),
    path.join(process.cwd(), 'web/dist/browser'),
    path.join(process.cwd(), 'web/dist/web/browser'),
    path.join(process.cwd(), 'src/server/public'),
    path.join(here, '../../src/server/public'),
    path.join(here, 'public'),
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isDirectory()) {
        return candidate;
      }
    } catch {
      // try next
    }
  }
  return path.join(here, 'public');
}
