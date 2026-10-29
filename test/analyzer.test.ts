import { describe, expect, it } from 'vitest';
import { analyzeProcedure } from '../src/core/analyze/analyzer.js';
import type { RawProcedure, SqlParameter } from '../src/core/types.js';

const DATABASE = 'Acme';

function procedure(
  name: string,
  definition: string,
  options: { params?: number; result?: boolean } = {},
): RawProcedure {
  const params: SqlParameter[] = [];
  const count = options.params ?? 0;
  for (let index = 1; index <= count; index += 1) {
    params.push({
      name: `Param${index}`,
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isOutput: false,
      hasDefault: false,
      defaultValue: null,
    });
  }
  return {
    objectId: 1,
    schema: 'dbo',
    name,
    definition,
    parameters: params,
    resultColumns: options.result === false ? null : [
      { name: 'Id', sqlType: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false },
    ],
    resultError: null,
  };
}

describe('verb detection', () => {
  it('ignores INSERT inside comments', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_Get', '-- insert into dbo.Customer\nSELECT * FROM dbo.Customer'),
      DATABASE,
    );
    expect(analysis.verb).toBe('get');
    expect(analysis.tables.map((table) => table.name)).toEqual(['Customer']);
  });

  it('ignores INSERT inside string literals', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_Get', "SELECT 'update dbo.Customer set x = 1' AS note FROM dbo.Customer"),
      DATABASE,
    );
    expect(analysis.verb).toBe('get');
  });

  it('does not treat UPDATE STATISTICS as a write', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Stats', 'UPDATE STATISTICS dbo.Customer; SELECT * FROM dbo.Customer'),
      DATABASE,
    );
    expect(analysis.verb).toBe('get');
  });

  it('treats INSERT as post', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_Create', 'INSERT INTO dbo.Customer (Name) VALUES (@Name)'),
      DATABASE,
    );
    expect(analysis.verb).toBe('post');
    expect(analysis.methodName).toBe('postCustomerCreate');
  });

  it('treats UPDATE with an alias as post on the aliased table', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Rename',
        'UPDATE c SET c.Name = @Name FROM dbo.Customer AS c WHERE c.Id = @Id',
      ),
      DATABASE,
    );
    expect(analysis.verb).toBe('post');
    expect(analysis.tables.map((table) => table.name)).toContain('Customer');
  });

  it('treats MERGE as post', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Merge',
        'MERGE dbo.Customer AS target USING dbo.Staging AS source ON target.Id = source.Id WHEN MATCHED THEN UPDATE SET Name = source.Name;',
      ),
      DATABASE,
    );
    expect(analysis.verb).toBe('post');
  });

  it('treats delete-and-select as delete', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Archive',
        'DELETE FROM dbo.Customer OUTPUT deleted.* WHERE Id = @Id',
      ),
      DATABASE,
    );
    expect(analysis.verb).toBe('delete');
    expect(analysis.methodName).toBe('deleteCustomerArchive');
  });

  it('prefers post when a procedure inserts and deletes', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Move',
        'INSERT INTO dbo.Archive (Id) SELECT Id FROM dbo.Customer; DELETE FROM dbo.Customer WHERE Id = @Id',
      ),
      DATABASE,
    );
    expect(analysis.verb).toBe('post');
  });

  it('ignores writes to temp tables when choosing the verb', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Temp',
        'SELECT Id INTO #ids FROM dbo.Customer; INSERT INTO #ids VALUES (1); SELECT * FROM dbo.Customer;',
      ),
      DATABASE,
    );
    expect(analysis.verb).toBe('get');
  });
});

describe('table footprint', () => {
  it('classifies a single-table procedure as a repository method', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_GetById', 'SELECT * FROM dbo.Customer WHERE Id = @Id'),
      DATABASE,
    );
    expect(analysis.destination.kind).toBe('repository');
    if (analysis.destination.kind === 'repository') {
      expect(analysis.destination.className).toBe('CustomerRepository');
    }
    expect(analysis.routePath).toBe('get-by-id');
    expect(analysis.controllerRoute).toBe('customer');
  });

  it('classifies a two-table procedure as a multitable service', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Order_Create',
        'INSERT INTO dbo.OrderHeader (Id) VALUES (@Id); INSERT INTO dbo.OrderLine (Id) VALUES (@Id);',
      ),
      DATABASE,
    );
    expect(analysis.destination.kind).toBe('multitable');
    expect(analysis.methodName).toBe('postOrderCreate');
  });

  it('resolves CTE names as not tables', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Customer_Cte',
        'WITH recent AS (SELECT Id FROM dbo.Customer) SELECT * FROM recent',
      ),
      DATABASE,
    );
    expect(analysis.tables.map((table) => table.name)).toEqual(['Customer']);
  });

  it('ignores parameters and ORDER BY that look like table references', () => {
    const analysis = analyzeProcedure(
      procedure(
        'usp_Audit_List',
        `@From bigint = 0
AS
BEGIN
    SET NOCOUNT ON;
    SELECT a.AuditId, a.Event
    FROM sales.AuditLog AS a
    WHERE a.AuditId > @From
    ORDER BY a.AuditId;
END`,
      ),
      DATABASE,
    );
    expect(analysis.tables.map((table) => table.name)).toEqual(['AuditLog']);
    expect(analysis.destination.kind).toBe('repository');
    if (analysis.destination.kind === 'repository') {
      expect(analysis.destination.className).toBe('AuditLogRepository');
    }
  });

  it('handles bracketed identifiers and spaces', () => {
    const analysis = analyzeProcedure(
      procedure('usp_OrderLines', 'SELECT * FROM [dbo].[Order Details]'),
      DATABASE,
    );
    expect(analysis.tables[0]?.name).toBe('Order Details');
  });

  it('skips dynamic SQL', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Dynamic', "EXEC sp_executesql N'SELECT 1'"),
      DATABASE,
    );
    expect(analysis.destination.kind).toBe('skipped');
    expect(analysis.issues.some((issue) => issue.code === 'dynamic-sql')).toBe(true);
  });

  it('skips cross-database references', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Other', 'SELECT * FROM OtherDb.dbo.Customer'),
      DATABASE,
    );
    expect(analysis.destination.kind).toBe('skipped');
  });

  it('skips procedures with no tables', () => {
    const analysis = analyzeProcedure(procedure('usp_Ping', 'SELECT 1 AS ok'), DATABASE);
    expect(analysis.destination.kind).toBe('skipped');
  });
});

describe('parameter handling', () => {
  it('keeps positional arguments up to six parameters', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_Search', 'SELECT * FROM dbo.Customer', { params: 6 }),
      DATABASE,
    );
    expect(analysis.paramsObject).toBe(false);
    expect(analysis.paramsClass).toBeNull();
  });

  it('groups seven parameters into one object', () => {
    const analysis = analyzeProcedure(
      procedure('usp_Customer_Search', 'SELECT * FROM dbo.Customer', { params: 7 }),
      DATABASE,
    );
    expect(analysis.paramsObject).toBe(true);
    expect(analysis.paramsClass).toBe('CustomerSearchParams');
  });

  it('excludes OUTPUT parameters from the input count', () => {
    const raw = procedure('usp_Customer_Out', 'SELECT * FROM dbo.Customer', { params: 7 });
    const output = raw.parameters[0] as SqlParameter;
    output.isOutput = true;
    const analysis = analyzeProcedure(raw, DATABASE);
    expect(analysis.paramsObject).toBe(false);
    expect(analysis.outputParams).toHaveLength(1);
    const issue = analysis.issues.find((entry) => entry.code === 'output-params');
    expect(issue?.severity).toBe('info');
  });

  it('skips procedures with table-valued parameters', () => {
    const raw = procedure('usp_Customer_Bulk', 'INSERT INTO dbo.Customer (Id) VALUES (1)');
    const parameter: SqlParameter = {
      name: 'Rows',
      sqlType: 'CustomerType',
      maxLength: 0,
      precision: 0,
      scale: 0,
      isOutput: false,
      isTableType: true,
      hasDefault: false,
      defaultValue: null,
    };
    raw.parameters = [parameter];
    const analysis = analyzeProcedure(raw, DATABASE);
    expect(analysis.destination.kind).toBe('skipped');
    expect(analysis.issues.some((entry) => entry.code === 'unsupported-parameter')).toBe(true);
  });
});
