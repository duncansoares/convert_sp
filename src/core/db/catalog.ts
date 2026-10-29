import mssql from 'mssql';
import type { config as MssqlConfig, ConnectionPool } from 'mssql';
import type {
  CatalogSnapshot,
  RawProcedure,
  ResultColumn,
  SqlParameter,
  TableColumn,
  TableDefinition,
} from '../types.js';

export interface ConnectionOptions {
  server: string;
  port: number;
  database: string;
  user: string;
  password: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
  connectTimeoutMs?: number;
  instanceName?: string;
}

export function buildConfig(options: ConnectionOptions): MssqlConfig {
  return {
    server: options.server,
    port: options.port,
    user: options.user,
    password: options.password,
    database: options.database,
    connectionTimeout: options.connectTimeoutMs ?? 15000,
    requestTimeout: 60000,
    options: {
      appName: 'convert-sp',
      encrypt: options.encrypt,
      trustServerCertificate: options.trustServerCertificate,
      enableArithAbort: true,
      ...(options.instanceName ? { instanceName: options.instanceName } : {}),
    },
  };
}

export async function withConnection<T>(
  options: ConnectionOptions,
  work: (pool: ConnectionPool) => Promise<T>,
): Promise<T> {
  const pool = new mssql.ConnectionPool(buildConfig(options));
  const connected = await pool.connect();
  try {
    return await work(connected);
  } finally {
    await connected.close().catch(() => undefined);
  }
}

export async function testConnection(options: ConnectionOptions): Promise<{ version: string }> {
  return withConnection(options, async (pool) => {
    const result = await pool.request().query<{ version: string }>('SELECT @@VERSION AS version');
    return { version: result.recordset[0]?.version ?? 'unknown' };
  });
}

export async function listDatabases(options: ConnectionOptions): Promise<string[]> {
  return withConnection({ ...options, database: 'master' }, async (pool) => {
    const result = await pool
      .request()
      .query<{ name: string }>(
        'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name',
      );
    return result.recordset.map((row) => row.name);
  });
}

interface ProcedureRow {
  object_id: number;
  schema_name: string;
  procedure_name: string;
  definition: string | null;
}

/**
 * SQL Server reports `has_default_value = 0` for every T-SQL parameter (it only
 * tracks defaults for CLR objects), so the defaults have to be read out of the
 * procedure header in `sys.sql_modules.definition`.
 */
export function parseDefaultedParameters(definition: string): Set<string> {
  return new Set(parseParameterDefaults(definition).keys());
}

/** Raw default expressions keyed by lower-cased parameter name. */
export function parseParameterDefaults(definition: string): Map<string, string> {
  const header = procedureHeader(definition);
  const defaults = new Map<string, string>();
  for (const segment of splitTopLevel(header)) {
    const match = /@([A-Za-z_][A-Za-z0-9_$#@]*)/.exec(segment);
    if (!match) {
      continue;
    }
    const rest = segment.slice((match.index ?? 0) + match[0].length);
    const equals = topLevelCharacterIndex(rest, '=');
    if (equals < 0) {
      continue;
    }
    const value = rest.slice(equals + 1).trim();
    if (value.length > 0) {
      defaults.set((match[1] as string).toLowerCase(), value);
    }
  }
  return defaults;
}

/** Text before the body's `AS`, so quoted strings and comments are skipped. */
function procedureHeader(definition: string): string {
  for (let cursor = 0; cursor < definition.length; ) {
    const skipped = skipNonCode(definition, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = definition[cursor] as string;
    if (char === '(') {
      cursor = skipParentheses(definition, cursor);
      continue;
    }
    const word = /^[A-Za-z]+/.exec(definition.slice(cursor))?.[0];
    const before = definition[cursor - 1] ?? ' ';
    if (
      word?.toLowerCase() === 'as' &&
      !/[A-Za-z0-9_$#@]/.test(before) &&
      !/[A-Za-z0-9_$#@]/.test(definition[cursor + word.length] ?? ' ')
    ) {
      return definition.slice(0, cursor);
    }
    cursor += 1;
  }
  return definition;
}

function skipNonCode(text: string, index: number): number | null {
  const char = text[index];
  if (char === "'" || char === '"') {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === char) {
        if (text[cursor + 1] === char) {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return text.length;
  }
  if (char === '[') {
    let cursor = index + 1;
    while (cursor < text.length) {
      if (text[cursor] === ']') {
        if (text[cursor + 1] === ']') {
          cursor += 2;
          continue;
        }
        return cursor + 1;
      }
      cursor += 1;
    }
    return text.length;
  }
  if (char === '-' && text[index + 1] === '-') {
    const end = text.indexOf('\n', index);
    return end === -1 ? text.length : end + 1;
  }
  if (char === '/' && text[index + 1] === '*') {
    const end = text.indexOf('*/', index + 2);
    return end === -1 ? text.length : end + 2;
  }
  return null;
}

function skipParentheses(text: string, openIndex: number): number {
  let depth = 0;
  for (let cursor = openIndex; cursor < text.length; ) {
    const skipped = skipNonCode(text, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = text[cursor];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return cursor + 1;
      }
    }
    cursor += 1;
  }
  return text.length;
}

function splitTopLevel(text: string): string[] {
  const segments: string[] = [];
  let start = 0;
  let depth = 0;
  for (let cursor = 0; cursor < text.length; ) {
    const skipped = skipNonCode(text, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = text[cursor];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === ',' && depth === 0) {
      segments.push(text.slice(start, cursor));
      start = cursor + 1;
    }
    cursor += 1;
  }
  segments.push(text.slice(start));
  return segments;
}

function hasTopLevelCharacter(text: string, target: string): boolean {
  return topLevelCharacterIndex(text, target) >= 0;
}

function topLevelCharacterIndex(text: string, target: string): number {
  for (let cursor = 0; cursor < text.length; ) {
    const skipped = skipNonCode(text, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    if (text[cursor] === target) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

export async function loadProcedures(options: ConnectionOptions): Promise<RawProcedure[]> {
  return withConnection(options, async (pool) => {
    const procedures = await pool.request().query<ProcedureRow>(`
      SELECT
        p.object_id,
        s.name AS schema_name,
        p.name AS procedure_name,
        m.definition
      FROM sys.procedures AS p
      JOIN sys.schemas AS s ON s.schema_id = p.schema_id
      LEFT JOIN sys.sql_modules AS m ON m.object_id = p.object_id
      WHERE p.is_ms_shipped = 0
      ORDER BY s.name, p.name
    `);

    const defaultsByObject = new Map<number, Map<string, string>>();
    for (const row of procedures.recordset) {
      defaultsByObject.set(row.object_id, parseParameterDefaults(row.definition ?? ''));
    }

    const parameters = await pool.request().query<{
      object_id: number;
      parameter_name: string;
      type_name: string;
      max_length: number;
      precision: number;
      scale: number;
      is_output: boolean;
      is_table_type: boolean;
      is_cursor: boolean;
      has_default_value: boolean;
      default_value: string | null;
    }>(`
      SELECT
        pr.object_id,
        pr.name AS parameter_name,
        COALESCE(t.name, TYPE_NAME(pr.user_type_id), 'sql_variant') AS type_name,
        pr.max_length,
        pr.precision,
        pr.scale,
        pr.is_output,
        CONVERT(bit, CASE WHEN tt.user_type_id IS NULL THEN 0 ELSE 1 END) AS is_table_type,
        CONVERT(bit, pr.is_cursor_ref) AS is_cursor,
        pr.has_default_value,
        CONVERT(nvarchar(4000), pr.default_value) AS default_value
      FROM sys.parameters AS pr
      LEFT JOIN sys.types AS t ON t.user_type_id = pr.user_type_id
      LEFT JOIN sys.table_types AS tt ON tt.user_type_id = pr.user_type_id
      WHERE pr.object_id IN (SELECT object_id FROM sys.procedures WHERE is_ms_shipped = 0)
      ORDER BY pr.object_id, pr.parameter_id
    `);

    const parametersByObject = new Map<number, SqlParameter[]>();
    for (const row of parameters.recordset) {
      const list = parametersByObject.get(row.object_id) ?? [];
      list.push({
        name: row.parameter_name,
        sqlType: row.type_name,
        maxLength: row.max_length,
        precision: row.precision,
        scale: row.scale,
        isOutput: row.is_output,
        isTableType: row.is_table_type,
        isCursor: row.is_cursor,
        hasDefault:
          defaultsByObject.get(row.object_id)?.has(row.parameter_name.replace(/^@/, '').toLowerCase()) ??
          false,
        defaultExpression:
          defaultsByObject
            .get(row.object_id)
            ?.get(row.parameter_name.replace(/^@/, '').toLowerCase()) ?? null,
        defaultValue: row.default_value,
      });
      parametersByObject.set(row.object_id, list);
    }

    const result: RawProcedure[] = [];
    for (const row of procedures.recordset) {
      const resultSet = await describeResultSet(pool, row.object_id, row.procedure_name);
      result.push({
        objectId: row.object_id,
        schema: row.schema_name,
        name: row.procedure_name,
        definition: row.definition ?? '',
        parameters: parametersByObject.get(row.object_id) ?? [],
        resultColumns: resultSet.columns,
        resultError: resultSet.error,
      });
    }
    return result;
  });
}

async function describeResultSet(
  pool: ConnectionPool,
  objectId: number,
  procedureName: string,
): Promise<{ columns: ResultColumn[] | null; error: string | null }> {
  try {
    const description = await pool
      .request()
      .input('objectId', mssql.Int, objectId)
      .query<{
        name: string;
        system_type_name: string;
        max_length: number;
        precision: number;
        scale: number;
        is_nullable: boolean;
        error_message: string | null;
        error_number: number | null;
      }>(
        'SELECT name, system_type_name, max_length, precision, scale, is_nullable, error_message, error_number FROM sys.dm_exec_describe_first_result_set_for_object(@objectId, 0)',
      );

    if (description.recordset.length === 0) {
      return { columns: null, error: null };
    }
    const first = description.recordset[0];
    if (first && first.error_number) {
      return { columns: null, error: first.error_message ?? 'unknown describe error' };
    }

    const columns: ResultColumn[] = description.recordset.map((row) => ({
      name: row.name,
      sqlType: normalizeSystemType(row.system_type_name),
      maxLength: row.max_length,
      precision: row.precision,
      scale: row.scale,
      isNullable: row.is_nullable,
    }));
    return { columns, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      columns: null,
      error: `Could not describe result set for ${procedureName}: ${message}`,
    };
  }
}

function normalizeSystemType(systemTypeName: string): string {
  const base = systemTypeName.split('(')[0]?.trim().toLowerCase() ?? '';
  return base;
}

export async function loadTables(options: ConnectionOptions): Promise<TableDefinition[]> {
  return withConnection(options, async (pool) => {
    const rows = await pool.request().query<{
      schema_name: string;
      table_name: string;
      column_name: string;
      type_name: string;
      max_length: number;
      precision: number;
      scale: number;
      is_nullable: boolean;
      is_identity: boolean;
      is_computed: boolean;
      has_default: boolean;
      is_primary_key: boolean;
      key_ordinal: number | null;
    }>(`
      SELECT
        s.name AS schema_name,
        t.name AS table_name,
        c.name AS column_name,
        ty.name AS type_name,
        c.max_length,
        c.precision,
        c.scale,
        c.is_nullable,
        c.is_identity,
        c.is_computed,
        CASE WHEN c.default_object_id <> 0 THEN 1 ELSE 0 END AS has_default,
        CASE WHEN ic.column_id IS NOT NULL THEN 1 ELSE 0 END AS is_primary_key,
        ic.key_ordinal
      FROM sys.tables AS t
      JOIN sys.schemas AS s ON s.schema_id = t.schema_id
      JOIN sys.columns AS c ON c.object_id = t.object_id
      JOIN sys.types AS ty ON ty.user_type_id = c.user_type_id
      LEFT JOIN (
        SELECT ic.object_id, ic.column_id, ic.key_ordinal
        FROM sys.index_columns AS ic
        JOIN sys.indexes AS i ON i.object_id = ic.object_id AND i.index_id = ic.index_id
        WHERE i.is_primary_key = 1
      ) AS ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
      WHERE t.is_ms_shipped = 0
      ORDER BY s.name, t.name, c.column_id
    `);

    const tables = new Map<string, TableDefinition>();
    for (const row of rows.recordset) {
      const key = `${row.schema_name}.${row.table_name}`.toLowerCase();
      let table = tables.get(key);
      if (!table) {
        table = { schema: row.schema_name, name: row.table_name, columns: [], primaryKey: [] };
        tables.set(key, table);
      }
      const column: TableColumn = {
        name: row.column_name,
        propertyName: row.column_name,
        sqlType: row.type_name,
        maxLength: row.max_length,
        precision: row.precision,
        scale: row.scale,
        isNullable: row.is_nullable,
        isIdentity: row.is_identity,
        isComputed: row.is_computed,
        hasDefault: row.has_default,
      };
      table.columns.push(column);
      if (row.is_primary_key) {
        table.primaryKey.push(row.column_name);
      }
    }
    return [...tables.values()];
  });
}

export async function loadCatalog(options: ConnectionOptions): Promise<CatalogSnapshot> {
  const [procedures, tables] = await Promise.all([
    loadProcedures(options),
    loadTables(options),
  ]);
  return { database: options.database, procedures, tables };
}
