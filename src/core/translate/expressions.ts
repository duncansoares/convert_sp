import { dedupeName, safeIdentifier } from '../naming.js';
import type { SqlParameter } from '../types.js';

export interface NameMaps {
  /** Lower-case original name -> generated TypeScript name. */
  params: Map<string, string>;
  locals: Map<string, string>;
  used: Set<string>;
}

export function buildNameMaps(parameters: SqlParameter[]): NameMaps {
  const used = new Set<string>();
  const params = new Map<string, string>();
  for (const parameter of parameters) {
    if (parameter.isOutput) {
      continue;
    }
    const name = dedupeName(safeIdentifier(parameter.name, 'param'), used);
    params.set(parameter.name.replace(/^@/, '').toLowerCase(), name);
  }
  return { params, locals: new Map(), used };
}

export function ensureLocal(names: NameMaps, rawName: string): string {
  const key = rawName.replace(/^@/, '').toLowerCase();
  const existing = names.locals.get(key);
  if (existing) {
    return existing;
  }
  const name = dedupeName(safeIdentifier(rawName, 'value'), names.used);
  names.locals.set(key, name);
  return name;
}

export function outputProperties(
  outputs: SqlParameter[],
  used = new Set<string>(),
): Map<string, string> {
  const properties = new Map<string, string>();
  for (const output of outputs) {
    properties.set(
      output.name.replace(/^@/, '').toLowerCase(),
      dedupeName(safeIdentifier(output.name, 'output'), used),
    );
  }
  return properties;
}

export function quoteIdentifier(name: string): string {
  return `[${name.replace(/]/g, ']]')}]`;
}

export function tsStringLiteral(value: string): string {
  if (!/[\r\n]/.test(value) || keepsEmbeddedNewlines(value)) {
    return `'${escapeLiteral(value)}'`;
  }
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length <= 1) {
    return `'${escapeLiteral(lines[0] ?? '')}'`;
  }
  return lines
    .map(
      (line, index) =>
        `'${escapeLiteral(line)}${index < lines.length - 1 ? ' ' : ''}'`,
    )
    .join(' +\n        ');
}

function escapeLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * A newline is significant inside a `--` comment (it ends the comment) and inside
 * a string or bracketed identifier (it is data). In those cases keep the escapes.
 */
function keepsEmbeddedNewlines(value: string): boolean {
  let index = 0;
  while (index < value.length) {
    const char = value[index];
    if (char === '-' && value[index + 1] === '-') {
      return true;
    }
    if (char === "'" || char === '"') {
      let cursor = index + 1;
      while (cursor < value.length) {
        if (value[cursor] === char) {
          if (value[cursor + 1] === char) {
            cursor += 2;
            continue;
          }
          break;
        }
        if (value[cursor] === '\n' || value[cursor] === '\r') {
          return true;
        }
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }
    if (char === '[') {
      const close = value.indexOf(']', index + 1);
      if (close === -1) {
        return false;
      }
      if (/[\r\n]/.test(value.slice(index + 1, close))) {
        return true;
      }
      index = close + 1;
      continue;
    }
    if (char === '/' && value[index + 1] === '*') {
      const close = value.indexOf('*/', index + 2);
      if (close === -1) {
        return false;
      }
      index = close + 2;
      continue;
    }
    index += 1;
  }
  return false;
}

/** Converts a T-SQL string literal (`N'abc'`, `'abc'`) to a TypeScript literal. */
export function parseSqlStringLiteral(text: string): string | null {
  const match = /^N?'([\s\S]*)'$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  return tsStringLiteral((match[1] as string).replace(/''/g, "'"));
}

/** Converts a parameter default from the module header into a TypeScript expression. */
export function defaultExpressionToTs(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) {
    return 'null';
  }
  const value = raw.trim();
  if (value.length === 0 || /^null$/i.test(value)) {
    return 'null';
  }
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return value;
  }
  const string = parseSqlStringLiteral(value);
  if (string !== null) {
    return string;
  }
  if (/^(?:getutcdate|sysutcdatetime|getdate)\s*\(\s*\)$/i.test(value)) {
    return 'new Date()';
  }
  if (/^'(?:[^']|'')*'$/.test(value)) {
    return null;
  }
  return null;
}

/** SQL type declaration for a local/output variable in an inline batch. */
export function sqlTypeDeclaration(parameter: SqlParameter): string | null {
  const type = parameter.sqlType.toLowerCase();
  switch (type) {
    case 'int':
    case 'bigint':
    case 'smallint':
    case 'tinyint':
    case 'bit':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
    case 'date':
    case 'datetime':
    case 'smalldatetime':
    case 'uniqueidentifier':
    case 'xml':
    case 'sysname':
    case 'text':
    case 'ntext':
      return type === 'sysname' ? 'nvarchar(128)' : type;
    case 'datetime2':
      return `datetime2(${parameter.scale})`;
    case 'time':
      return `time(${parameter.scale})`;
    case 'decimal':
    case 'numeric':
      return `${type}(${parameter.precision}, ${parameter.scale})`;
    case 'nvarchar':
    case 'nchar':
      return parameter.maxLength === -1 ? `${type}(max)` : `${type}(${Math.floor(parameter.maxLength / 2)})`;
    case 'varchar':
    case 'char':
    case 'binary':
    case 'varbinary':
      return parameter.maxLength === -1 ? `${type}(max)` : `${type}(${parameter.maxLength})`;
    default:
      return null;
  }
}
