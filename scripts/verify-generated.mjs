/**
 * Typechecks a generated project without installing NestJS.
 *
 * The generated app is CommonJS, so this spawns the tool's TypeScript compiler against
 * `generated/verify` with ambient stubs for the runtime packages. That catches broken
 * imports and mismatched member names in generated output. It does not validate that the
 * stubs match the real packages; run `npm install && npm run build` inside a generated
 * project for that.
 */
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeCatalog, generateProject } from '../dist/core/pipeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '..');
const target = path.join(projectRoot, 'generated', 'verify');
const stubs = path.join(here, 'verify-generated', 'stubs.d.ts');
const tsc = path.join(projectRoot, 'node_modules', 'typescript', 'bin', 'tsc');

const catalog = buildCatalog();

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });

const bundle = analyzeCatalog(catalog);
const result = await generateProject({
  bundle,
  projectName: 'verify-api',
  outputDir: target,
  overwrite: 'safe',
});

console.log(
  `generated ${result.generated.length} procedures, skipped ${result.skipped.length} in ${target}`,
);

await mkdir(path.join(target, 'types'), { recursive: true });
await cp(stubs, path.join(target, 'types', 'stubs.d.ts'));

await writeFile(
  path.join(target, 'tsconfig.verify.json'),
  `${JSON.stringify(
    {
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        incremental: false,
        declaration: false,
        types: [],
      },
      include: ['src/**/*.ts', 'types/**/*.d.ts'],
    },
    null,
    2,
  )}\n`,
  'utf8',
);

const exitCode = await new Promise((resolve) => {
  const child = spawn(process.execPath, [tsc, '-p', path.join(target, 'tsconfig.verify.json')], {
    stdio: 'inherit',
    cwd: target,
  });
  child.on('exit', (code) => resolve(code ?? 1));
});

if (exitCode !== 0) {
  console.error('Generated project does not typecheck.');
  process.exit(1);
}
console.log('Generated project typechecks.');

function buildCatalog() {
  const column = (name, sqlType, extra = {}) => ({
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

  const parameter = (name, sqlType, extra = {}) => ({
    name,
    sqlType,
    maxLength: extra.maxLength ?? 4,
    precision: extra.precision ?? 18,
    scale: extra.scale ?? 0,
    isOutput: extra.isOutput ?? false,
    hasDefault: extra.hasDefault ?? false,
    defaultValue: null,
  });

  const resultColumns = (columns) =>
    columns.map(([name, sqlType, extra = {}]) => ({
      name,
      sqlType,
      maxLength: extra.maxLength ?? 4,
      precision: extra.precision ?? 10,
      scale: extra.scale ?? 0,
      isNullable: extra.isNullable ?? false,
    }));

  return {
    database: 'Acme',
    tables: [
      {
        schema: 'dbo',
        name: 'Customer',
        primaryKey: ['Id'],
        columns: [
          column('Id', 'int', { isIdentity: true }),
          column('Name', 'nvarchar', { maxLength: 200 }),
          column('Email', 'nvarchar', { maxLength: 510, isNullable: true }),
          column('Balance', 'decimal', { precision: 18, scale: 2 }),
          column('IsActive', 'bit'),
          column('CreatedAt', 'datetime2', { isNullable: true }),
          column('Notes', 'nvarchar', { maxLength: -1, isNullable: true }),
        ],
      },
      {
        schema: 'dbo',
        name: 'OrderHeader',
        primaryKey: ['Id'],
        columns: [
          column('Id', 'int', { isIdentity: true }),
          column('CustomerId', 'int'),
          column('Total', 'money'),
        ],
      },
      {
        schema: 'sales',
        name: 'Order Detail',
        primaryKey: ['OrderId', 'LineNo'],
        columns: [
          column('OrderId', 'int'),
          column('LineNo', 'int'),
          column('Qty', 'smallint'),
        ],
      },
      {
        schema: 'dbo',
        name: 'Lookup',
        primaryKey: [],
        columns: [column('Value', 'int')],
      },
    ],
    procedures: [
      {
        objectId: 1,
        schema: 'dbo',
        name: 'usp_Customer_GetById',
        definition: 'SELECT Id, Name FROM dbo.Customer WHERE Id = @CustomerId',
        parameters: [parameter('CustomerId', 'int')],
        resultColumns: resultColumns([
          ['Id', 'int'],
          ['Email', 'nvarchar', { maxLength: 510, isNullable: true }],
          ['Balance', 'decimal', { precision: 18, scale: 2 }],
        ]),
        resultError: null,
      },
      {
        objectId: 2,
        schema: 'dbo',
        name: 'usp_Customer_Search',
        definition: 'SELECT * FROM dbo.Customer WHERE Name LIKE @Term',
        parameters: [
          parameter('Term', 'nvarchar', { maxLength: 200, hasDefault: true }),
          parameter('Page', 'int', { hasDefault: true }),
          parameter('Size', 'int', { hasDefault: true }),
          parameter('Sort', 'nvarchar', { maxLength: 100, hasDefault: true }),
          parameter('Active', 'bit', { hasDefault: true }),
          parameter('CreatedAfter', 'datetime2', { hasDefault: true }),
          parameter('Email', 'nvarchar', { maxLength: 510, hasDefault: true }),
        ],
        resultColumns: resultColumns([['Id', 'int'], ['Name', 'nvarchar', { maxLength: 200 }]]),
        resultError: null,
      },
      {
        objectId: 3,
        schema: 'dbo',
        name: 'usp_Customer_Create',
        definition:
          'INSERT INTO dbo.Customer (Name, Email) VALUES (@Name, @Email); SELECT SCOPE_IDENTITY() AS Id',
        parameters: [
          parameter('Name', 'nvarchar', { maxLength: 200 }),
          parameter('Email', 'nvarchar', { maxLength: 510 }),
        ],
        resultColumns: resultColumns([['Id', 'int']]),
        resultError: null,
      },
      {
        objectId: 4,
        schema: 'dbo',
        name: 'usp_Customer_Deactivate',
        definition: 'UPDATE dbo.Customer SET IsActive = 0 WHERE Id = @CustomerId',
        parameters: [parameter('CustomerId', 'int')],
        resultColumns: null,
        resultError: null,
      },
      {
        objectId: 5,
        schema: 'dbo',
        name: 'usp_Customer_Delete',
        definition: 'DELETE FROM dbo.Customer WHERE Id = @CustomerId',
        parameters: [parameter('CustomerId', 'int')],
        resultColumns: null,
        resultError: null,
      },
      {
        objectId: 6,
        schema: 'dbo',
        name: 'usp_Customer_Purge',
        definition: 'DELETE FROM dbo.Customer WHERE Id = @Id',
        parameters: [
          parameter('Id', 'int'),
          parameter('Reason', 'nvarchar', { maxLength: 200 }),
          parameter('A', 'int'),
          parameter('B', 'int'),
          parameter('C', 'int'),
          parameter('D', 'int'),
          parameter('E', 'int'),
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
        parameters: [parameter('CustomerId', 'int'), parameter('Total', 'money')],
        resultColumns: resultColumns([['Id', 'int']]),
        resultError: null,
      },
      {
        objectId: 8,
        schema: 'sales',
        name: 'usp_OrderDetail_Add',
        definition:
          'INSERT INTO [sales].[Order Detail] (OrderId, LineNo) VALUES (@OrderId, @LineNo); UPDATE dbo.OrderHeader SET Total = Total WHERE Id = @OrderId;',
        parameters: [
          parameter('OrderId', 'int'),
          parameter('LineNo', 'int'),
          parameter('Qty', 'smallint'),
        ],
        resultColumns: null,
        resultError: null,
      },
      {
        objectId: 9,
        schema: 'dbo',
        name: 'usp_NoKey_Read',
        definition: 'SELECT Value FROM dbo.Lookup',
        parameters: [],
        resultColumns: resultColumns([['Value', 'int']]),
        resultError: null,
      },
      {
        objectId: 10,
        schema: 'dbo',
        name: 'usp_Customer_Out',
        definition: 'SELECT * FROM dbo.Customer WHERE Id = @CustomerId',
        parameters: [parameter('CustomerId', 'int'), parameter('Total', 'int', { isOutput: true })],
        resultColumns: resultColumns([['Id', 'int']]),
        resultError: null,
      },
      {
        objectId: 11,
        schema: 'dbo',
        name: 'usp_Customer_Cte',
        definition: 'WITH recent AS (SELECT Id FROM dbo.Customer) SELECT Id FROM recent',
        parameters: [],
        resultColumns: resultColumns([['Id', 'int']]),
        resultError: null,
      },
      {
        objectId: 12,
        schema: 'dbo',
        name: 'usp_Dynamic_Report',
        definition: "DECLARE @sql nvarchar(max) = N'SELECT 1'; EXEC(@sql);",
        parameters: [],
        resultColumns: null,
        resultError: null,
      },
      {
        objectId: 13,
        schema: 'dbo',
        name: 'usp_Ping',
        definition: 'SELECT 1 AS ok',
        parameters: [],
        resultColumns: resultColumns([['ok', 'int']]),
        resultError: null,
      },
    ],
  };
}
