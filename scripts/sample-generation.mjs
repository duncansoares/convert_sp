import { analyzeCatalog, generateProject } from '../dist/core/pipeline.js';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const database = 'Acme';
const out = path.resolve('generated/sample');

const col = (name, sqlType, extra = {}) => ({
  name,
  propertyName: name,
  sqlType,
  maxLength: extra.maxLength ?? 4,
  precision: extra.precision ?? 10,
  scale: extra.scale ?? 0,
  isNullable: extra.isNullable ?? false,
  isIdentity: extra.isIdentity ?? false,
  isComputed: extra.isComputed ?? false,
  hasDefault: extra.hasDefault ?? false,
});

const tables = [
  {
    schema: 'dbo',
    name: 'Customer',
    primaryKey: ['Id'],
    columns: [
      col('Id', 'int', { isIdentity: true }),
      col('Name', 'nvarchar', { maxLength: 200 }),
      col('Email', 'nvarchar', { maxLength: 510, isNullable: true }),
      col('Balance', 'decimal', { precision: 18, scale: 2 }),
      col('IsActive', 'bit'),
      col('CreatedAt', 'datetime2', { isNullable: true }),
      col('Notes', 'nvarchar', { maxLength: -1, isNullable: true }),
    ],
  },
  {
    schema: 'dbo',
    name: 'OrderHeader',
    primaryKey: ['Id'],
    columns: [
      col('Id', 'int', { isIdentity: true }),
      col('CustomerId', 'int'),
      col('Total', 'money'),
    ],
  },
  {
    schema: 'sales',
    name: 'AuditLog',
    primaryKey: ['AuditId'],
    columns: [
      col('AuditId', 'bigint', { isIdentity: true }),
      col('Message', 'varchar', { maxLength: 500, isNullable: true }),
    ],
  },
  {
    schema: 'dbo',
    name: 'NoKeyTable',
    primaryKey: [],
    columns: [col('Value', 'int')],
  },
];

const param = (name, sqlType, extra = {}) => ({
  name,
  sqlType,
  maxLength: extra.maxLength ?? 4,
  precision: 0,
  scale: 0,
  isOutput: extra.isOutput ?? false,
  hasDefault: extra.hasDefault ?? false,
  defaultValue: null,
});

const result = (columns) =>
  columns.map(([name, sqlType, extra = {}]) => ({
    name,
    sqlType,
    maxLength: extra.maxLength ?? 4,
    precision: extra.precision ?? 10,
    scale: extra.scale ?? 0,
    isNullable: extra.isNullable ?? false,
  }));

const procedures = [
  {
    objectId: 1,
    schema: 'dbo',
    name: 'usp_Customer_GetById',
    definition: 'SELECT Id, Name, Email, Balance FROM dbo.Customer WHERE Id = @CustomerId',
    parameters: [param('CustomerId', 'int')],
    resultColumns: result([['Id', 'int'], ['Name', 'nvarchar', { maxLength: 200 }], ['Email', 'nvarchar', { maxLength: 510, isNullable: true }], ['Balance', 'decimal', { precision: 18, scale: 2 }]]),
    resultError: null,
  },
  {
    objectId: 2,
    schema: 'dbo',
    name: 'usp_Customer_Search',
    definition: 'SELECT * FROM dbo.Customer WHERE Name LIKE @Term',
    parameters: [
      param('Term', 'nvarchar', { maxLength: 200, hasDefault: true }),
      param('Page', 'int', { hasDefault: true }),
      param('Size', 'int', { hasDefault: true }),
      param('Sort', 'nvarchar', { maxLength: 100, hasDefault: true }),
      param('Active', 'bit', { hasDefault: true }),
      param('CreatedAfter', 'datetime2', { hasDefault: true }),
      param('Email', 'nvarchar', { maxLength: 510, hasDefault: true }),
    ],
    resultColumns: result([['Id', 'int'], ['Name', 'nvarchar', { maxLength: 200 }]]),
    resultError: null,
  },
  {
    objectId: 3,
    schema: 'dbo',
    name: 'usp_Customer_Create',
    definition: 'INSERT INTO dbo.Customer (Name, Email) VALUES (@Name, @Email); SELECT SCOPE_IDENTITY() AS Id',
    parameters: [param('Name', 'nvarchar', { maxLength: 200 }), param('Email', 'nvarchar', { maxLength: 510 })],
    resultColumns: result([['Id', 'int']]),
    resultError: null,
  },
  {
    objectId: 4,
    schema: 'dbo',
    name: 'usp_Customer_Deactivate',
    definition: 'UPDATE dbo.Customer SET IsActive = 0 WHERE Id = @CustomerId',
    parameters: [param('CustomerId', 'int')],
    resultColumns: null,
    resultError: null,
  },
  {
    objectId: 5,
    schema: 'dbo',
    name: 'usp_Customer_Delete',
    definition: 'DELETE FROM dbo.Customer WHERE Id = @CustomerId',
    parameters: [param('CustomerId', 'int')],
    resultColumns: null,
    resultError: null,
  },
  {
    objectId: 6,
    schema: 'dbo',
    name: 'usp_Customer_Purge',
    definition: 'DELETE FROM dbo.Customer WHERE Id = @Id',
    parameters: [
      param('Id', 'int'), param('Reason', 'nvarchar', { maxLength: 200 }),
      param('A', 'int'), param('B', 'int'), param('C', 'int'),
      param('D', 'int'), param('E', 'int'),
    ],
    resultColumns: null,
    resultError: null,
  },
  {
    objectId: 7,
    schema: 'dbo',
    name: 'usp_Order_Place',
    definition:
      'INSERT INTO dbo.OrderHeader (CustomerId, Total) VALUES (@CustomerId, 0); UPDATE dbo.Customer SET Balance = Balance WHERE Id = @CustomerId;',
    parameters: [param('CustomerId', 'int'), param('Total', 'money')],
    resultColumns: result([['Id', 'int']]),
    resultError: null,
  },
  {
    objectId: 8,
    schema: 'sales',
    name: 'usp_Audit_List',
    definition: 'SELECT AuditId, Message FROM sales.AuditLog WHERE AuditId > @From',
    parameters: [param('From', 'bigint')],
    resultColumns: result([['AuditId', 'bigint'], ['Message', 'varchar', { maxLength: 500, isNullable: true }]]),
    resultError: null,
  },
  {
    objectId: 9,
    schema: 'dbo',
    name: 'usp_NoKey_Read',
    definition: 'SELECT Value FROM dbo.NoKeyTable',
    parameters: [],
    resultColumns: result([['Value', 'int']]),
    resultError: null,
  },
  {
    objectId: 10,
    schema: 'dbo',
    name: 'usp_Dynamic_Report',
    definition: "DECLARE @sql nvarchar(max) = N'SELECT 1'; EXEC(@sql);",
    parameters: [],
    resultColumns: null,
    resultError: null,
  },
  {
    objectId: 11,
    schema: 'dbo',
    name: 'usp_Ping',
    definition: 'SELECT 1 AS ok',
    parameters: [],
    resultColumns: result([['ok', 'int']]),
    resultError: null,
  },
  {
    objectId: 12,
    schema: 'dbo',
    name: 'usp_Customer_Out',
    definition: 'SELECT * FROM dbo.Customer WHERE Id = @CustomerId',
    parameters: [param('CustomerId', 'int'), param('Total', 'int', { isOutput: true })],
    resultColumns: result([['Id', 'int']]),
    resultError: null,
  },
  {
    objectId: 13,
    schema: 'dbo',
    name: 'usp_Customer_Cte',
    definition:
      'WITH recent AS (SELECT Id FROM dbo.Customer) SELECT Id FROM recent OPTION (RECOMPILE);',
    parameters: [],
    resultColumns: result([['Id', 'int']]),
    resultError: null,
  },
];

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const bundle = analyzeCatalog({ database, procedures, tables });
const generated = await generateProject({
  bundle,
  projectName: 'acme-api',
  outputDir: out,
  overwrite: 'safe',
});

console.log('generated:', generated.generated.length, 'skipped:', generated.skipped.length);
console.log('counts:', generated.write.counts);
console.log('\nskipped:');
for (const analysis of generated.skipped) {
  console.log(' ', analysis.procedure.schema + '.' + analysis.procedure.name, '->', analysis.destination.reason);
}
console.log('\nfiles:');
for (const file of generated.write.files) {
  console.log(' ', file.status.padEnd(9), file.path);
}
