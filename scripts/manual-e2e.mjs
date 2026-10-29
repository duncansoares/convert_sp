/**
 * Manual end-to-end run against a live SQL Server, through the running UI server.
 *
 *   $env:TOKEN='<token from the ui url>'; node scripts/manual-e2e.mjs
 *
 * Optional: BASE_URL, OUTPUT_DIR, PROJECT_NAME.
 */
const baseUrl = process.env.BASE_URL ?? 'http://127.0.0.1:4319';
const token = process.env.TOKEN;
if (!token) {
  console.error('TOKEN is required (copy it from the UI url).');
  process.exit(1);
}

const connection = {
  server: process.env.DEMO_SERVER ?? 'localhost',
  port: 1433,
  instanceName: process.env.DEMO_INSTANCE ?? 'SQLEXPRESS',
  database: 'convert_sp_demo',
  user: 'convert_sp_demo',
  password: process.env.DEMO_PASSWORD ?? 'Demo!Passw0rd#2026',
  encrypt: false,
  trustServerCertificate: true,
};

const outputDir = process.env.OUTPUT_DIR ?? 'C:\\Users\\dunca\\source\\convert_sp\\generated\\manual-api';
const projectName = process.env.PROJECT_NAME ?? 'manual-api';

async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'x-convert-sp-token': token,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${options.method ?? 'GET'} ${path} -> ${response.status}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

const started = Date.now();
const test = await call('/api/connections/test', { method: 'POST', body: JSON.stringify(connection) });
console.log(`connection ok: ${test.version}`);

const profile = await call('/api/profiles', {
  method: 'POST',
  body: JSON.stringify({
    name: 'Demo (convert_sp_demo)',
    server: connection.server,
    port: connection.port,
    instanceName: connection.instanceName,
    database: connection.database,
    user: connection.user,
    encrypt: connection.encrypt,
    trustServerCertificate: connection.trustServerCertificate,
    outputDir,
    projectName,
    password: connection.password,
  }),
});
console.log(`profile saved: ${profile.id} (password returned: ${Object.hasOwn(profile, 'password')})`);

const { procedures } = await call(`/api/profiles/${profile.id}/procedures`);
console.log(`procedures listed: ${procedures.length}`);
for (const entry of procedures) {
  const notes = entry.issues?.length ? ` [${entry.issues.map((issue) => issue.code).join(', ')}]` : '';
  const destination =
    entry.destination?.kind === 'skipped'
      ? 'skipped'
      : (entry.destination?.className ?? entry.destination?.kind ?? '?');
  console.log(`  ${entry.key.padEnd(38)} ${String(entry.verb).padEnd(6)} ${String(destination).padEnd(34)}${notes}`);
}

const { jobId } = await call('/api/generate', {
  method: 'POST',
  body: JSON.stringify({ profileId: profile.id, outputDir, projectName, overwrite: 'force' }),
});
console.log(`\njob ${jobId} started`);

let job;
for (;;) {
  job = await call(`/api/jobs/${jobId}`);
  if (job.state !== 'running') {
    break;
  }
  await new Promise((resolve) => setTimeout(resolve, 400));
}

console.log(`job ${job.state} in ${Date.now() - started} ms`);
for (const line of job.logs) {
  console.log(`  log: ${line}`);
}
if (job.state === 'error') {
  console.error(`error: ${job.error}`);
  process.exit(1);
}

console.log(`\noutput: ${job.result.outputDir}`);
console.log(`generated: ${job.result.generated}, skipped: ${job.result.skipped}`);
console.log(`counts: ${JSON.stringify(job.result.counts)}`);
console.log(`conflicts: ${job.result.conflicts.length ? job.result.conflicts.join(', ') : 'none'}`);
console.log(`files: ${job.result.files.length}`);
for (const file of job.result.files) {
  console.log(`  ${file.status.padEnd(8)} ${file.path}`);
}
