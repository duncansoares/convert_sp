import mssql from 'mssql';

const config = {
  server: 'localhost',
  port: 1433,
  options: { instanceName: 'SQLEXPRESS', encrypt: false, trustServerCertificate: true },
  user: 'convert_sp_demo',
  password: process.env.DEMO_PASSWORD ?? 'Demo!Passw0rd#2026',
  database: 'convert_sp_demo',
  connectionTimeout: 15000,
  requestTimeout: 15000,
};

const versions = {
  'less-than only': 'SELECT 1 < 2 AS a',
  'greater-than only': 'SELECT 1 > 0 AS b',
  'le': 'SELECT 1 <= 2 AS a',
  'ge': 'SELECT 2 >= 1 AS b',
  'bang-equals': 'SELECT 1 != 0 AS x',
  'string with <>': "SELECT 'a<>b' AS s",
  'case <>': "SELECT CASE WHEN 1 <> 0 THEN 'y' ELSE 'n' END AS x",
  'not equals keyword': 'SELECT 1 AS x WHERE NOT 1 = 0',
  'concat of chars': "SELECT NCHAR(60) + NCHAR(62) AS s",
};

const pool = await new mssql.ConnectionPool(config).connect();
for (const [label, text] of Object.entries(versions)) {
  try {
    const result = await pool.request().query(text);
    console.log(`ok   ${label}: ${JSON.stringify(result.recordset[0] ?? null)}`);
  } catch (error) {
    console.log(`fail ${label}: ${error.message} (line ${error.lineNumber})`);
  }
}

const info = await pool.request().query('SELECT @@VERSION AS v, (SELECT compatibility_level FROM sys.databases WHERE name = DB_NAME()) AS compat, SUSER_SNAME() AS who, LANGUAGE AS lang');
console.log(info.recordset[0]);
await pool.close();
