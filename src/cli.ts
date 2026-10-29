#!/usr/bin/env node
import { Command } from 'commander';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { analyzeCatalog, generateProject } from './core/pipeline.js';
import { loadCatalog } from './core/db/catalog.js';
import type { ConnectionOptions } from './core/db/catalog.js';
import { createSecretStore } from './profiles/secrets.js';
import { loadProfiles, toConnectionOptions } from './profiles/store.js';
import type { ConnectionProfile } from './profiles/store.js';
import type { Analysis } from './core/types.js';

const program = new Command();

program
  .name('convert-sp')
  .description('Generate a repository-based NestJS application from SQL Server stored procedures')
  .version('0.1.0');

interface ConnectionFlags {
  profile?: string;
  connectionFile?: string;
}

async function resolveConnection(flags: ConnectionFlags): Promise<{
  options: ConnectionOptions;
  profile: ConnectionProfile | null;
}> {
  if (flags.connectionFile) {
    const raw = JSON.parse(await readFile(path.resolve(flags.connectionFile), 'utf8')) as Record<
      string,
      unknown
    >;
    const options: ConnectionOptions = {
      server: String(raw.server ?? raw.host ?? 'localhost'),
      port: Number(raw.port ?? 1433),
      database: String(raw.database ?? ''),
      user: String(raw.user ?? raw.username ?? ''),
      password: String(raw.password ?? process.env.CONVERT_SP_PASSWORD ?? ''),
      encrypt: raw.encrypt !== false,
      trustServerCertificate: raw.trustServerCertificate === true,
      instanceName: raw.instanceName ? String(raw.instanceName) : undefined,
    };
    if (!options.database || !options.user) {
      throw new Error('--connection-file must contain database and user (or username)');
    }
    return { options, profile: null };
  }

  const store = await createSecretStore();
  const file = await loadProfiles();
  const requested = flags.profile;
  const profile =
    (requested
      ? file.profiles.find(
          (item) => item.id === requested || item.name.toLowerCase() === requested.toLowerCase(),
        )
      : undefined) ??
    file.profiles.find((item) => item.id === file.settings.lastProfileId) ??
    (requested ? undefined : file.profiles[0]);

  if (!profile) {
    throw new Error(
      requested
        ? `No saved profile matches "${requested}". Run "convert-sp ui" to create one.`
        : 'No saved profiles. Run "convert-sp ui" to create a connection, or pass --connection-file.',
    );
  }

  const password = await store.get(profile.id);
  if (password === null) {
    throw new Error(
      `Profile "${profile.name}" has no stored password. Set CONVERT_SP_PASSWORD or recreate the profile.`,
    );
  }

  return { options: toConnectionOptions(profile, password), profile };
}

function summarize(analysis: Analysis): string {
  const tables = analysis.tables.map((table) => `${table.schema}.${table.name}`).join(', ');
  const destination =
    analysis.destination.kind === 'skipped'
      ? `skipped (${analysis.destination.reason})`
      : analysis.destination.kind === 'repository'
        ? analysis.destination.className
        : analysis.destination.className;
  return `${analysis.procedure.schema}.${analysis.procedure.name} | ${analysis.verb} | ${
    tables || '-'
  } | ${destination} | ${analysis.destination.kind === 'skipped' ? '-' : analysis.methodName}`;
}

program
  .command('analyze')
  .description('Read the catalog and print how each procedure would be classified')
  .option('-p, --profile <name>', 'saved profile name or id')
  .option('--connection-file <path>', 'JSON file with connection settings (for CI)')
  .option('--include <pattern...>', 'only procedures matching these patterns')
  .option('--exclude <pattern...>', 'skip procedures matching these patterns')
  .option('--json', 'print machine-readable JSON')
  .action(async (options) => {
    const { options: connection } = await resolveConnection(options);
    const catalog = await loadCatalog(connection);
    const bundle = analyzeCatalog(catalog);

    if (options.json) {
      const payload = bundle.analyses.map((analysis) => ({
        schema: analysis.procedure.schema,
        name: analysis.procedure.name,
        verb: analysis.verb,
        tables: analysis.tables.map((table) => `${table.schema}.${table.name}`),
        destination: analysis.destination,
        method: analysis.methodName,
        issues: analysis.issues,
      }));
      console.log(JSON.stringify(payload, null, 2));
      return;
    }

    console.log(`Database ${bundle.database}: ${bundle.analyses.length} procedures`);
    for (const analysis of bundle.analyses) {
      console.log(summarize(analysis));
      for (const issue of analysis.issues) {
        if (issue.severity !== 'info') {
          console.log(`    ! ${issue.code}: ${issue.message}`);
        }
      }
    }
  });

program
  .command('generate')
  .description('Generate the NestJS project')
  .option('-p, --profile <name>', 'saved profile name or id')
  .option('--connection-file <path>', 'JSON file with connection settings (for CI)')
  .requiredOption('-o, --out <dir>', 'output directory')
  .option('--project <name>', 'generated project name')
  .option('--include <pattern...>', 'only procedures matching these patterns')
  .option('--exclude <pattern...>', 'skip procedures matching these patterns')
  .option('--dry-run', 'report what would change without writing')
  .option('--force', 'overwrite files that were modified by hand')
  .action(async (options) => {
    const { options: connection, profile } = await resolveConnection(options);
    const outDir = path.resolve(options.out);
    const catalog = await loadCatalog(connection);
    const bundle = analyzeCatalog(catalog);

    const result = await generateProject({
      bundle,
      selectedKeys: undefined,
      include: options.include,
      exclude: options.exclude,
      projectName: options.project ?? profile?.projectName ?? `${bundle.database.toLowerCase()}-api`,
      outputDir: outDir,
      overwrite: options.dryRun ? 'dry-run' : options.force ? 'force' : 'safe',
    });

    console.log(`Database ${bundle.database}: ${bundle.analyses.length} procedures`);
    console.log(`Generated ${result.generated.length}, skipped ${result.skipped.length}`);
    console.log(
      `Files: ${result.write.counts.created} created, ${result.write.counts.updated} updated, ` +
        `${result.write.counts.unchanged} unchanged, ${result.write.counts.conflict} conflicting, ` +
        `${result.write.counts.deleted} deleted`,
    );
    for (const file of result.write.files.filter((item) => item.status === 'conflict')) {
      console.log(`  conflict: ${file.path}`);
    }
    if (!options.dryRun) {
      console.log(`Report: ${path.join(outDir, 'report.md')}`);
    } else {
      console.log('Dry run: nothing was written.');
    }
  });

program
  .command('ui')
  .description('Start the local web interface')
  .option('--port <port>', 'port to listen on', '4319')
  .option('--no-open', 'do not open the browser')
  .action(async (options) => {
    const { startServer } = await import('./server/app.js');
    const { app, url } = await startServer({ port: Number(options.port) });
    console.log(`convert-sp UI listening on ${url}`);
    if (options.open !== false) {
      const { spawn } = await import('node:child_process');
      if (process.platform === 'win32') {
        spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
      } else if (process.platform === 'darwin') {
        spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      } else {
        spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
      }
    }
    process.on('SIGINT', async () => {
      await app.close();
      process.exit(0);
    });
  });

program
  .command('profiles')
  .description('List saved connection profiles')
  .action(async () => {
    const file = await loadProfiles();
    if (file.profiles.length === 0) {
      console.log('No saved profiles. Run "convert-sp ui" to create one.');
      return;
    }
    for (const profile of file.profiles) {
      const marker = profile.id === file.settings.lastProfileId ? '*' : ' ';
      console.log(
        `${marker} ${profile.name} — ${profile.server}:${profile.port}/${profile.database} ` +
          `(${profile.user}) secret=${profile.hasSecret ? 'yes' : 'no'}`,
      );
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
