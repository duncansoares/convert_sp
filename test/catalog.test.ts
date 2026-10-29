import { describe, expect, it } from 'vitest';
import { parseDefaultedParameters } from '../src/core/db/catalog.js';

describe('defaulted parameter detection', () => {
  it('reads defaults out of a T-SQL procedure header', () => {
    const definition = `CREATE PROCEDURE dbo.usp_Customer_Search
    @Term         nvarchar(100) = NULL,
    @Page         int = 1,
    @Size         int = 20
AS
BEGIN
    SET NOCOUNT ON;
    SELECT c.Id FROM dbo.Customer AS c;
END`;
    expect([...parseDefaultedParameters(definition)].sort()).toEqual(['page', 'size', 'term']);
  });

  it('reports nothing when no parameter has a default', () => {
    const definition = `CREATE PROCEDURE dbo.usp_Customer_GetById
    @CustomerId int
AS
BEGIN
    SELECT 1 AS Id;
END`;
    expect(parseDefaultedParameters(definition).size).toBe(0);
  });

  it('does not split on commas inside string defaults', () => {
    const definition = `CREATE PROCEDURE dbo.usp_Thing
    @A int,
    @B varchar(20) = 'x,y',
    @C int = 1
AS
BEGIN
    SELECT 1 AS Id;
END`;
    expect([...parseDefaultedParameters(definition)].sort()).toEqual(['b', 'c']);
  });

  it('ignores AS inside a default expression', () => {
    const definition = `CREATE PROCEDURE dbo.usp_Thing
    @CreatedAt datetime2(0) = CAST('2026-01-01' AS datetime2(0)),
    @Flag bit = 0
AS
BEGIN
    SELECT 1 AS Id;
END`;
    expect([...parseDefaultedParameters(definition)].sort()).toEqual(['createdat', 'flag']);
  });

  it('only scans the header, not the body', () => {
    const definition = `CREATE PROCEDURE dbo.usp_Thing
    @Id int
AS
BEGIN
    SELECT 1 AS Result, @Id AS Echo;
END`;
    expect(parseDefaultedParameters(definition).size).toBe(0);
  });
});
