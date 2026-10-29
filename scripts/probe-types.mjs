import mssql from 'mssql';

const pool = await new mssql.ConnectionPool({
  server: 'localhost',
  port: 1433,
  options: { instanceName: 'SQLEXPRESS', encrypt: false, trustServerCertificate: true },
  user: 'convert_sp_demo',
  password: process.env.DEMO_PASSWORD ?? 'Demo!Passw0rd#2026',
  database: 'convert_sp_demo',
}).connect();

async function place(label, value, type) {
  try {
    const request = pool.request();
    request.input('CustomerId', mssql.Int, 1);
    request.input('Total', type, value);
    const result = await request.execute('dbo.usp_Order_Place');
    console.log(`ok   ${label}: ${JSON.stringify(result.recordset[0])}`);
  } catch (error) {
    console.log(`fail ${label}: ${error.message}`);
  }
}

async function delta(label, value, type) {
  try {
    const request = pool.request();
    request.input('CustomerId', mssql.Int, 1);
    request.input('Delta', type, value);
    const result = await request.execute('dbo.usp_Customer_UpdateBalance');
    console.log(`ok   ${label}: ${JSON.stringify(result.recordset[0])}`);
  } catch (error) {
    console.log(`fail ${label}: ${error.message}`);
  }
}

await place('Money + string', '60.00', mssql.Money);
await place('Money + number', 60, mssql.Money);
await delta('Decimal(18,2) + string', '1.25', mssql.Decimal(18, 2));
await delta('Decimal(18,2) + number', 1.25, mssql.Decimal(18, 2));

await pool.close();
