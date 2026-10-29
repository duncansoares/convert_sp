import { describe, expect, it } from 'vitest';
import { analyzeCatalog } from '../src/core/pipeline.js';
import type { CatalogSnapshot, RawProcedure, TableDefinition } from '../src/core/types.js';

const database = 'Acme';

const customer: TableDefinition = {
  schema: 'dbo',
  name: 'Customer',
  primaryKey: ['Id'],
  columns: [
    {
      name: 'Id',
      propertyName: 'Id',
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isNullable: false,
      isIdentity: true,
      isComputed: false,
      hasDefault: false,
    },
    {
      name: 'Name',
      propertyName: 'Name',
      sqlType: 'nvarchar',
      maxLength: 200,
      precision: 0,
      scale: 0,
      isNullable: false,
      isIdentity: false,
      isComputed: false,
      hasDefault: false,
    },
  ],
};

function proc(
  name: string,
  body: string,
  parameters: RawProcedure['parameters'] = [],
): RawProcedure {
  const declaration = parameters
    .map((parameter) => `  @${parameter.name.replace(/^@/, '')} ${parameter.sqlType}`)
    .join(',\n');
  return {
    objectId: 1,
    schema: 'dbo',
    name,
    definition: `CREATE PROCEDURE dbo.${name}\n${declaration}\nAS\nBEGIN\n${body}\nEND;`,
    parameters,
    resultColumns: [
      { name: 'Id', sqlType: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false },
    ],
    resultError: null,
  };
}

function intParameter(name: string): RawProcedure['parameters'][number] {
  return {
    name,
    sqlType: 'int',
    maxLength: 4,
    precision: 10,
    scale: 0,
    isOutput: false,
    hasDefault: false,
    defaultValue: null,
  };
}

function translate(procedure: RawProcedure) {
  const catalog: CatalogSnapshot = {
    database,
    procedures: [procedure],
    tables: [customer],
  };
  return analyzeCatalog(catalog).analyses[0]!;
}

function text(procedure: RawProcedure): string {
  return translate(procedure).translation?.lines.join('\n') ?? '';
}

describe('procedure translation', () => {
  it('uses the query builder for a simple SELECT', () => {
    const analysis = translate(
      proc('usp_Customer_Get', 'SELECT Id, Name FROM dbo.Customer WHERE Id = @Id', [
        intParameter('@Id'),
      ]),
    );
    expect(analysis.translation?.mode).toBe('orm');
    expect(text(analysis.procedure)).toContain('.createQueryBuilder(');
    expect(text(analysis.procedure)).not.toContain('.query(');
  });

  it('uses the query builder for INSERT, UPDATE and DELETE', () => {
    const insert = text(proc('usp_Customer_Create', "INSERT INTO dbo.Customer (Name) VALUES ('x')"));
    expect(insert).toContain('.insert()');
    expect(insert).toContain('.into(');

    const update = text(proc('usp_Customer_Rename', "UPDATE dbo.Customer SET Name = 'x' WHERE Id = 1"));
    expect(update).toContain('.update(');
    expect(update).toContain('.set(');

    const remove = text(proc('usp_Customer_Delete', 'DELETE FROM dbo.Customer WHERE Id = 1'));
    expect(remove).toContain('.delete()');
    expect(remove).toContain('.from(');
  });

  it('captures SCOPE_IDENTITY with a trailing SELECT', () => {
    const analysis = translate(
      proc(
        'usp_Customer_Create',
        "INSERT INTO dbo.Customer (Name) VALUES ('x'); SELECT SCOPE_IDENTITY() AS Id;",
      ),
    );
    const lines = analysis.translation?.lines.join('\n') ?? '';
    expect(lines).toContain('SELECT SCOPE_IDENTITY() AS [__identity]');
    expect(lines).toContain('rows = [{ Id: Number(insert1[0]?.__identity ?? 0) }]');
  });

  it('falls back to one parameterized batch for a CTE', () => {
    const analysis = translate(
      proc(
        'usp_Customer_Recent',
        'WITH recent AS (SELECT Id FROM dbo.Customer) SELECT Id FROM recent',
      ),
    );
    expect(['hybrid', 'sql']).toContain(analysis.translation?.mode);
    expect(text(analysis.procedure)).toContain("'WITH recent AS");
    expect(text(analysis.procedure)).not.toContain('createQueryBuilder');
  });

  it('falls back to one parameterized batch for flow control', () => {
    const analysis = translate(
      proc(
        'usp_Customer_Ensure',
        "IF NOT EXISTS (SELECT 1 FROM dbo.Customer) INSERT INTO dbo.Customer (Name) VALUES ('x');",
      ),
    );
    expect(analysis.translation?.mode).toBe('sql');
    expect(text(analysis.procedure)).toContain('IF NOT EXISTS');
  });

  it('wraps inline SQL in concatenated string literals', () => {
    const analysis = translate(
      proc(
        'usp_Customer_Recent',
        'WITH recent AS (\n  SELECT Id FROM dbo.Customer\n)\nSELECT Id FROM recent',
      ),
    );
    const lines = analysis.translation?.lines.join('\n') ?? '';
    expect(lines).toContain("' +\n");
    expect(lines).not.toContain('\\n');
    expect(lines).not.toContain('\\r');
  });

  it('drops SQL comments before concatenating inline SQL', () => {
    const analysis = translate(
      proc(
        'usp_Customer_Note',
        '-- internal note\nSELECT Id, Name FROM dbo.Customer WHERE Id = @Id',
        [intParameter('@Id')],
      ),
    );
    const lines = analysis.translation?.lines.join('\n') ?? '';
    expect(lines).not.toContain('internal note');
    expect(lines).not.toContain('\\n');
  });

  it('skips a procedure that calls EXEC', () => {
    const analysis = translate(
      proc('usp_Chain', 'EXEC dbo.usp_Customer_Get @Id = 1'),
    );
    expect(analysis.destination.kind).toBe('skipped');
  });

  it('never calls the stored procedure itself', () => {
    for (const definition of [
      'SELECT Id FROM dbo.Customer WHERE Id = 1',
      "INSERT INTO dbo.Customer (Name) VALUES ('x')",
      "UPDATE dbo.Customer SET Name = 'x'",
      'DELETE FROM dbo.Customer WHERE Id = 1',
      'WITH recent AS (SELECT Id FROM dbo.Customer) SELECT Id FROM recent',
    ]) {
      const lines = text(proc('usp_Customer_Do', definition));
      expect(lines.toLowerCase()).not.toContain('exec ');
      expect(lines).not.toContain('usp_');
    }
  });

  it('returns OUTPUT values in an envelope', () => {
    const analysis = translate(
      proc('usp_Customer_Count', 'SELECT Id FROM dbo.Customer', [
        {
          name: '@Total',
          sqlType: 'int',
          maxLength: 4,
          precision: 10,
          scale: 0,
          isOutput: true,
          hasDefault: false,
          defaultValue: null,
        },
      ]),
    );
    const lines = analysis.translation?.lines.join('\n') ?? '';
    expect(lines).toContain('let total: any = null;');
    expect(lines).toContain('return { rows, output: { total: total } };');
  });
});
