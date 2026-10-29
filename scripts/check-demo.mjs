/**
 * Probes the demo instance the way the tool does and reports which connection form works.
 *
 *   node scripts/check-demo.mjs
 */
import { listDatabases, loadCatalog, testConnection } from '../dist/core/db/catalog.js';
import { analyzeCatalog } from '../dist/core/pipeline.js';

const password = process.env.DEMO_PASSWORD ?? 'Demo!Passw0rd#2026';
const database = 'convert_sp_demo';

const candidates = [
  { label: 'localhost + instance SQLEXPRESS', server: 'localhost', port: 1433, instanceName: 'SQLEXPRESS' },
  { label: '. + instance SQLEXPRESS', server: '.', port: 1433, instanceName: 'SQLEXPRESS' },
  { label: 'localhost:1433', server: 'localhost', port: 1433 },
  { label: '127.0.0.1:1433', server: '127.0.0.1', port: 1433 },
  { label: 'axum\\SQLEXPRESS', server: 'axum', port: 1433, instanceName: 'SQLEXPRESS' },
];

const base = {
  user: 'convert_sp_demo',
  password,
  database,
  encrypt: false,
  trustServerCertificate: true,
  connectTimeoutMs: 8000,
};

let working = null;
for (const candidate of candidates) {
  const started = Date.now();
  try {
    const result = await testConnection({ ...base, ...candidate });
    console.log(`ok   ${candidate.label} (${Date.now() - started} ms)`);
    working = candidate;
    break;
  } catch (error) {
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    console.log(`fail ${candidate.label}: ${message}`);
  }
}

if (!working) {
  console.error('\nNo connection form worked.');
  process.exit(1);
}

const options = { ...base, ...working };
delete options.label;

const databases = await listDatabases(options);
console.log(`\ndatabases visible: ${databases.length} (includes ${databases.includes(database) ? database : 'NOT ' + database})`);

const catalog = await loadCatalog(options);
console.log(
  `catalog: ${catalog.procedures.length} procedures, ${catalog.tables.length} tables, ${catalog.tables.reduce(
    (sum, table) => sum + table.columns.length,
    0,
  )} columns`,
);

const bundle = analyzeCatalog(catalog);
const generated = bundle.analyses.filter((analysis) => analysis.destination.kind !== 'skipped');
const skipped = bundle.analyses.filter((analysis) => analysis.destination.kind === 'skipped');

console.log(`\nclassified: ${generated.length} generated, ${skipped.length} skipped`);
for (const analysis of bundle.analyses) {
  const tables = analysis.tables.map((table) => `${table.schema}.${table.name}`).join(', ') || '-';
  const destination =
    analysis.destination.kind === 'skipped'
      ? `skipped (${analysis.destination.reason})`
      : analysis.destination.className;
  const details = [
    analysis.paramsObject ? `${analysis.paramsClass} object` : null,
    analysis.procedure.resultError ? 'no result metadata' : null,
    ...analysis.issues.filter((issue) => issue.severity !== 'info').map((issue) => issue.code),
  ].filter(Boolean);
  console.log(
    `  ${`${analysis.procedure.schema}.${analysis.procedure.name}`.padEnd(34)} ${analysis.verb.padEnd(6)} ` +
      `${destination.padEnd(34)} ${analysis.methodName}${details.length ? `  [${details.join(', ')}]` : ''}`,
  );
  console.log(`    tables: ${tables}`);
}

const tablesWithoutEntity = bundle.tables.filter((table) => table.primaryKey.length === 0);
console.log(
  `\ntables without a primary key: ${tablesWithoutEntity.map((table) => table.name).join(', ') || 'none'}`,
);
