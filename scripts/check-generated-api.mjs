/**
 * Exercises the generated NestJS app over HTTP against the demo database.
 *
 *   node scripts/check-generated-api.mjs
 *
 * Expects the generated app on http://127.0.0.1:3000 with DB_* env vars set.
 */
const baseUrl = process.env.API_URL ?? 'http://127.0.0.1:3000';

let failures = 0;

async function call(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

function check(label, condition, detail) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failures += 1;
    console.log(`FAIL ${label} :: ${JSON.stringify(detail).slice(0, 300)}`);
  }
}

const list = await call('GET', '/customer/list');
check('GET /customer/list', list.status === 200 && Array.isArray(list.body) && list.body.length >= 3, list);
check('decimal arrives as number', typeof list.body?.[0]?.Balance === 'number', list.body?.[0]);

const byId = await call('GET', '/customer/get-by-id?customerId=1');
check('GET /customer/get-by-id', byId.status === 200 && byId.body?.[0]?.Id === 1, byId);

const defaults = await call('GET', '/customer/search');
check('GET /customer/search without params (SQL defaults)', defaults.status === 200 && Array.isArray(defaults.body), defaults);

const searched = await call('GET', '/customer/search?term=Ada&page=1&size=5&active=true');
check('GET /customer/search with query', searched.status === 200 && Array.isArray(searched.body), searched);

const created = await call('POST', '/customer/create', { name: 'Manual Test' });
check('POST /customer/create without optional email', created.status < 300, created);
const createdId = created.body?.[0]?.Id;

if (typeof createdId === 'number') {
  const balance = await call('POST', '/customer/update-balance', { customerId: createdId, delta: '10.00' });
  check('POST /customer/update-balance (decimal input)', balance.status < 300, balance);

  const removed = await call('DELETE', `/customer/delete?customerId=${createdId}`);
  check('DELETE /customer/delete', removed.status < 300, removed);

  const gone = await call('GET', `/customer/get-by-id?customerId=${createdId}`);
  check('deleted row is gone', Array.isArray(gone.body) && gone.body.length === 0, gone);
} else {
  console.log('FAIL could not capture the created row id', created);
  failures += 1;
}

const hostile = await call('POST', '/customer/delete-purge', {
  id: 999999,
  reason: 'manual test',
  a: 1,
  b: 2,
  c: 3,
  d: 4,
  e: 5,
});
check('POST /customer/delete-purge (7-parameter delete)', hostile.status < 300, hostile);

const stats = await call('GET', '/customer-stats?customerId=1');
check('GET /customer-stats (multi-table service)', stats.status === 200, stats);
check(
  'GET /customer-stats returns rows plus a named output envelope',
  Array.isArray(stats.body?.rows) && typeof stats.body?.output?.orderCount === 'number',
  stats,
);

const placed = await call('POST', '/order-place', { customerId: 1, total: '12.34' });
check('POST /order-place (money input)', placed.status < 300, placed);

const audit = await call('GET', '/audit-log/audit-list');
check('GET /audit-log/audit-list without optional param', audit.status === 200, audit);

const invalidQuery = await call('GET', '/customer/get-by-id?customerId=abc');
check('invalid query is rejected with 400', invalidQuery.status === 400, invalidQuery);

const missingBody = await call('POST', '/customer/create', {});
check('missing required body field is rejected with 400', missingBody.status === 400, missingBody);

console.log(failures === 0 ? '\nall generated API checks passed' : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
