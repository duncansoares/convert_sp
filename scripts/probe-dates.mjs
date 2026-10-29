import mssql from 'mssql';

const pool = await new mssql.ConnectionPool({
  server: 'localhost',
  port: 1433,
  options: { instanceName: 'SQLEXPRESS', encrypt: false, trustServerCertificate: true },
  user: 'convert_sp_demo',
  password: process.env.DEMO_PASSWORD ?? 'Demo!Passw0rd#2026',
  database: 'convert_sp_demo',
}).connect();

async function attempt(label, type, value) {
  try {
    const request = pool.request();
    request.input('CreatedAfter', type, value);
    const result = await request.execute('dbo.usp_Customer_Search');
    console.log(`ok   ${label}: ${result.recordset.length} rows`);
  } catch (error) {
    console.log(`fail ${label}: ${error.message}`);
  }
}

await attempt('DateTime2(7) + ISO string', mssql.DateTime2(7), '2026-01-01T00:00:00Z');
await attempt('DateTime2(0) + ISO string', mssql.DateTime2(0), '2026-01-01T00:00:00Z');
await attempt('DateTime2(0) + Date', mssql.DateTime2(0), new Date('2026-01-01T00:00:00Z'));

// Also confirm that omitting optional inputs lets the procedure defaults apply.
try {
  const request = pool.request();
  request.input('Page', mssql.Int, 1);
  const result = await request.execute('dbo.usp_Customer_Search');
  console.log(`ok   only Page supplied: ${result.recordset.length} rows (defaults applied)`);
} catch (error) {
  console.log(`fail only Page supplied: ${error.message}`);
}

await pool.close();
