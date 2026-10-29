import { parseQualifiedName, nextWord, toTableReference } from '../analyze/identifiers.js';
import { stripCommentsAndStrings, stripSqlComments } from '../analyze/tokenize.js';
import { entityPropertyNames, identityColumn } from '../generate/entity.js';
import { dedupeName, safeIdentifier } from '../naming.js';
import type {
  Analysis,
  Issue,
  SqlParameter,
  TableDefinition,
  TableReference,
} from '../types.js';
import {
  buildNameMaps,
  defaultExpressionToTs,
  ensureLocal,
  outputProperties,
  quoteIdentifier,
  sqlTypeDeclaration,
  tsStringLiteral,
} from './expressions.js';
import type { NameMaps } from './expressions.js';
import {
  extractProcedureBody,
  findTopLevelKeyword,
  firstWord,
  hasFlowControl,
  replaceParameters,
  skipNonCode,
  skipParentheses,
  splitStatements,
  splitTopLevel,
} from './sql-text.js';
import type { ProcedureTranslation } from './types.js';

/** Internal signal: this statement cannot be translated one-for-one. */
class TranslationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranslationError';
  }
}

interface Binding {
  name: string;
  value: string;
}

class Bindings {
  private readonly entries: Binding[] = [];

  add(value: string): string {
    const existing = this.entries.find((entry) => entry.value === value);
    if (existing) {
      return existing.name;
    }
    const name = `p${this.entries.length}`;
    this.entries.push({ name, value });
    return name;
  }

  /** Parameter names used in an inline SQL or query-builder fragment. */
  names(): string[] {
    return this.entries.map((entry) => entry.name);
  }

  value(name: string): string {
    return this.entries.find((entry) => entry.name === name)?.value ?? 'null';
  }

  /** Zero-based position of a binding, used for raw `@0`, `@1` placeholders. */
  index(name: string): number {
    return this.entries.findIndex((entry) => entry.name === name);
  }

  /** `{ p0: expr, p1: expr }`, or an empty string when there is nothing to bind. */
  object(): string {
    if (this.entries.length === 0) {
      return '';
    }
    return `{ ${this.entries.map((entry) => `${entry.name}: ${entry.value}`).join(', ')} }`;
  }

  argument(): string {
    const object = this.object();
    return object.length > 0 ? `, ${object}` : '';
  }

  /** `, [expr, ...]` for TypeORM's raw `query`, which binds positionally. */
  queryArgument(): string {
    if (this.entries.length === 0) {
      return '';
    }
    return `, [${this.entries.map((entry) => entry.value).join(', ')}]`;
  }
}

interface SimpleSelectColumn {
  expression: string;
  output: string;
}

interface SimpleSelect {
  key: string;
  alias: string;
  distinct: boolean;
  top: number | null;
  columns: SimpleSelectColumn[];
  where: string | null;
  orderBy: Array<{ expression: string; direction: 'ASC' | 'DESC' }>;
}

export interface SimpleInsert {
  key: string;
  table: TableReference;
  definition: TableDefinition | null;
  columns: string[];
  values: string[];
}

interface SimpleUpdate {
  key: string;
  table: TableReference;
  definition: TableDefinition | null;
  assignments: Array<{ column: string; expression: string }>;
  where: string | null;
}

interface SimpleDelete {
  key: string;
  table: TableReference;
  definition: TableDefinition | null;
  where: string | null;
}

const RESERVED_ALIAS = new Set([
  'where',
  'order',
  'group',
  'having',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'cross',
  'outer',
  'on',
  'option',
  'for',
  'union',
  'offset',
  'fetch',
  'pivot',
  'unpivot',
  'apply',
  'tablesample',
]);

const NUMERIC_TYPES = new Set([
  'int',
  'bigint',
  'smallint',
  'tinyint',
  'bit',
  'money',
  'smallmoney',
  'float',
  'real',
  'decimal',
  'numeric',
]);

const STRING_TYPES = new Set([
  'char',
  'varchar',
  'nchar',
  'nvarchar',
  'text',
  'ntext',
  'xml',
  'sysname',
  'uniqueidentifier',
  'date',
  'datetime',
  'datetime2',
  'datetimeoffset',
  'smalldatetime',
  'time',
]);

function tableReference(
  parts: string[],
  database: string,
  definitions: Map<string, TableDefinition>,
): { key: string; table: TableReference; definition: TableDefinition | null } {
  const table = toTableReference(parts, database);
  if (!table || table.external) {
    throw new TranslationError(`Unsupported table reference ${parts.join('.')}.`);
  }
  const key = `${table.schema}.${table.name}`.toLowerCase();
  return { key, table, definition: definitions.get(key) ?? null };
}

function hasEntity(definition: TableDefinition | null): definition is TableDefinition {
  return definition !== null && definition.primaryKey.length > 0;
}

function bareAlias(value: string): string {
  if (value.startsWith('[') && value.endsWith(']')) {
    return value.slice(1, -1).replace(/]]/g, ']');
  }
  return value;
}

function columnName(value: string): string {
  return bareAlias(value.trim());
}

function selectColumnPart(text: string): { name: string; namespace: string | null } | null {
  const match = /^(?:([A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\])\.)?(\*|[A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\])$/.exec(
    text.trim(),
  );
  if (!match) {
    return null;
  }
  return {
    namespace: match[1] ? columnName(match[1]) : null,
    name: columnName(match[2] as string),
  };
}

function parseAliasedExpression(text: string): { expression: string; alias: string | null } {
  const match = /^([\s\S]*?)\s+as\s+([A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\])\s*$/i.exec(text);
  if (match) {
    return { expression: (match[1] as string).trim(), alias: columnName(match[2] as string) };
  }
  return { expression: text.trim(), alias: null };
}

function parseSimpleSelect(
  statement: string,
  database: string,
  definitions: Map<string, TableDefinition>,
): SimpleSelect | null {
  const fromIndex = findTopLevelKeyword(statement, 'from');
  if (fromIndex < 0) {
    return null;
  }
  let header = statement.slice(0, fromIndex).trim();
  const select = /^select\s+/i.exec(header);
  if (!select) {
    return null;
  }
  header = header.slice(select[0].length);
  let distinct = false;
  const distinctMatch = /^distinct\s+/i.exec(header);
  if (distinctMatch) {
    distinct = true;
    header = header.slice(distinctMatch[0].length);
  }
  let top: number | null = null;
  const topMatch = /^top\s*(?:\(\s*(\d+)\s*\)|(\d+))\s+/i.exec(header);
  if (topMatch) {
    top = Number(topMatch[1] ?? topMatch[2]);
    header = header.slice(topMatch[0].length);
  }
  if (/^top\b/i.test(header)) {
    return null;
  }

  const afterFrom = statement.slice(fromIndex + 'from'.length);
  const name = parseQualifiedName(afterFrom, 0);
  if (!name) {
    return null;
  }
  const resolved = tableReference(name.parts, database, definitions);
  if (!resolved.definition) {
    return null;
  }

  let cursor = name.end;
  let alias = bareAlias(name.parts[name.parts.length - 1] as string);
  const word = nextWord(afterFrom, cursor);
  if (word) {
    if (word.value.toUpperCase() === 'AS') {
      const aliasWord = nextWord(afterFrom, word.end);
      if (!aliasWord) {
        return null;
      }
      alias = bareAlias(aliasWord.value);
      cursor = aliasWord.end;
    } else if (!RESERVED_ALIAS.has(word.value.toLowerCase())) {
      alias = bareAlias(word.value);
      cursor = word.end;
    }
  }

  const rest = afterFrom.slice(cursor).trim();
  const code = stripCommentsAndStrings(rest);
  if (
    /\b(join|group|having|union|except|intersect|offset|option|pivot|unpivot|apply|tablesample)\b/i.test(
      code,
    ) ||
    /\bselect\b/i.test(code) ||
    /;/.test(code)
  ) {
    return null;
  }

  const whereIndex = findTopLevelKeyword(rest, 'where');
  const orderIndex = findTopLevelKeyword(rest, 'order by');
  if (orderIndex >= 0 && whereIndex >= 0 && orderIndex < whereIndex) {
    return null;
  }
  const whereEnd = orderIndex >= 0 ? orderIndex : rest.length;
  const where =
    whereIndex >= 0
      ? rest.slice(whereIndex + 'where'.length, whereEnd).trim()
      : null;
  if (where !== null && where.length === 0) {
    return null;
  }
  const orderText = orderIndex >= 0 ? rest.slice(orderIndex + 'order by'.length).trim() : null;
  const orderBy: Array<{ expression: string; direction: 'ASC' | 'DESC' }> = [];
  if (orderText !== null) {
    for (const item of splitTopLevel(orderText)) {
      const match = /^((?:[A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\])\.(?:[A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\]))(?:\s+(asc|desc))?$/i.exec(
        item.trim(),
      );
      if (!match) {
        return null;
      }
      orderBy.push({
        expression: match[1] as string,
        direction: (match[2]?.toUpperCase() as 'ASC' | 'DESC' | undefined) ?? 'ASC',
      });
    }
  }

  const columns: SimpleSelectColumn[] = [];
  for (const item of splitTopLevel(header)) {
    const { expression, alias: outputAlias } = parseAliasedExpression(item);
    const part = selectColumnPart(expression);
    if (!part) {
      return null;
    }
    if (part.namespace !== null && part.namespace.toLowerCase() !== alias.toLowerCase()) {
      return null;
    }
    if (part.name === '*') {
      for (const column of resolved.definition.columns) {
        columns.push({
          expression: `${alias}.${quoteIdentifier(column.name)}`,
          output: column.name,
        });
      }
      continue;
    }
    columns.push({
      expression: `${alias}.${quoteIdentifier(part.name)}`,
      output: outputAlias ?? part.name,
    });
  }
  if (columns.length === 0) {
    return null;
  }

  return {
    key: resolved.key,
    alias,
    distinct,
    top,
    columns,
    where,
    orderBy,
  };
}

export function parseInsert(
  statement: string,
  database: string,
  definitions: Map<string, TableDefinition>,
): SimpleInsert | null {
  const match = /^\s*insert\s+(?:into\s+)?/i.exec(statement);
  if (!match) {
    return null;
  }
  const name = parseQualifiedName(statement, match[0].length);
  if (!name) {
    return null;
  }
  const resolved = tableReference(name.parts, database, definitions);
  let cursor = name.end;
  const open = /^\s*\(/.exec(statement.slice(cursor));
  if (!open) {
    return null;
  }
  const openIndex = cursor + open[0].length - 1;
  const closeIndex = skipParentheses(statement, openIndex);
  if (closeIndex <= openIndex) {
    return null;
  }
  const columns = splitTopLevel(statement.slice(openIndex + 1, closeIndex - 1)).map((part) =>
    columnName(part.trim()),
  );
  if (columns.some((column) => column.length === 0)) {
    return null;
  }
  cursor = closeIndex;
  const valuesStart = /^\s*values\s*\(/i.exec(statement.slice(cursor));
  if (!valuesStart) {
    return null;
  }
  const valuesOpen = cursor + valuesStart[0].length - 1;
  const valuesClose = skipParentheses(statement, valuesOpen);
  if (valuesClose <= valuesOpen) {
    return null;
  }
  const after = statement.slice(valuesClose).trim();
  if (after.length > 0 && after !== ';') {
    return null;
  }
  const values = splitTopLevel(statement.slice(valuesOpen + 1, valuesClose - 1));
  if (values.length !== columns.length) {
    return null;
  }
  if (/\b(output|exec|execute)\b/i.test(stripCommentsAndStrings(statement))) {
    return null;
  }
  return { key: resolved.key, table: resolved.table, definition: resolved.definition, columns, values };
}

function parseUpdate(
  statement: string,
  database: string,
  definitions: Map<string, TableDefinition>,
): SimpleUpdate | null {
  const match = /^\s*update\s+/i.exec(statement);
  if (!match) {
    return null;
  }
  const name = parseQualifiedName(statement, match[0].length);
  if (!name) {
    return null;
  }
  const resolved = tableReference(name.parts, database, definitions);
  const afterName = statement.slice(name.end);
  if (/^\s*top\b/i.test(afterName)) {
    return null;
  }
  const setIndex = findTopLevelKeyword(afterName, 'set');
  if (setIndex < 0) {
    return null;
  }
  const afterSet = afterName.slice(setIndex + 'set'.length);
  if (findTopLevelKeyword(afterSet, 'from') >= 0) {
    return null;
  }
  const whereIndex = findTopLevelKeyword(afterSet, 'where');
  const assignmentText = whereIndex >= 0 ? afterSet.slice(0, whereIndex) : afterSet;
  const where = whereIndex >= 0 ? afterSet.slice(whereIndex + 'where'.length).trim() : null;
  if (where !== null && where.length === 0) {
    return null;
  }
  const assignments = splitTopLevel(assignmentText).map((part) => {
    const equals = findTopLevelEquals(part);
    if (equals < 0) {
      throw new TranslationError('UPDATE assignment without an equals sign.');
    }
    return {
      column: columnName(part.slice(0, equals).trim()),
      expression: part.slice(equals + 1).trim(),
    };
  });
  if (assignments.some((entry) => entry.column.length === 0 || entry.expression.length === 0)) {
    return null;
  }
  if (/\b(output|exec|execute)\b/i.test(stripCommentsAndStrings(statement))) {
    return null;
  }
  return {
    key: resolved.key,
    table: resolved.table,
    definition: resolved.definition,
    assignments,
    where,
  };
}

function findTopLevelEquals(text: string): number {
  let depth = 0;
  for (let cursor = 0; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (char === '=' && depth === 0) {
      // Ignore comparison operators such as >=, <=, != and =.
      const before = text[cursor - 1] ?? '';
      const after = text[cursor + 1] ?? '';
      if (after === '=' || ['>', '<', '!', '='].includes(before)) {
        continue;
      }
      return cursor;
    }
  }
  return -1;
}

function parseDelete(
  statement: string,
  database: string,
  definitions: Map<string, TableDefinition>,
): SimpleDelete | null {
  const match = /^\s*delete\s+(?:from\s+)?/i.exec(statement);
  if (!match) {
    return null;
  }
  const name = parseQualifiedName(statement, match[0].length);
  if (!name) {
    return null;
  }
  const resolved = tableReference(name.parts, database, definitions);
  const rest = statement.slice(name.end).trim();
  if (/^top\b/i.test(rest) || findTopLevelKeyword(rest, 'from') >= 0) {
    return null;
  }
  if (/\b(output|join|exec|execute)\b/i.test(stripCommentsAndStrings(rest))) {
    return null;
  }
  const whereIndex = findTopLevelKeyword(rest, 'where');
  const where = whereIndex >= 0 ? rest.slice(whereIndex + 'where'.length).trim() : null;
  if (where !== null && where.length === 0) {
    return null;
  }
  if (whereIndex < 0 && rest.length > 0) {
    return null;
  }
  return { key: resolved.key, table: resolved.table, definition: resolved.definition, where };
}

function parseDeclaredType(text: string): { sqlType: string; tsType: string; zero: string } | null {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?/.exec(text.trim());
  if (!match) {
    return null;
  }
  const sqlType = (match[1] as string).toLowerCase();
  if (sqlType === 'table' || sqlType === 'cursor') {
    return null;
  }
  if (sqlType === 'bit') {
    return { sqlType, tsType: 'boolean', zero: 'false' };
  }
  if (STRING_TYPES.has(sqlType)) {
    return { sqlType, tsType: 'string', zero: "''" };
  }
  if (NUMERIC_TYPES.has(sqlType)) {
    return { sqlType, tsType: 'number', zero: '0' };
  }
  return { sqlType, tsType: 'any', zero: 'null' };
}

function declaredIdentifier(text: string): { name: string; end: number } | null {
  const match = /^\s*@([A-Za-z_][A-Za-z0-9_$#@]*)/.exec(text);
  if (!match) {
    return null;
  }
  return { name: match[1] as string, end: match[0].length };
}

function selectAssignmentParts(statement: string): {
  assignments: Array<{ target: string; expression: string }>;
  fromClause: string | null;
} | null {
  const match = /^\s*select\s+(?:distinct\s+)?([\s\S]*)$/i.exec(statement);
  if (!match) {
    return null;
  }
  const list = match[1] as string;
  if (!/^\s*@/.test(list)) {
    return null;
  }
  const fromIndex = findTopLevelKeyword(list, 'from');
  const assignmentText = fromIndex >= 0 ? list.slice(0, fromIndex) : list;
  const fromClause = fromIndex >= 0 ? list.slice(fromIndex) : null;
  const assignments: Array<{ target: string; expression: string }> = [];
  for (const part of splitTopLevel(assignmentText)) {
    const equals = findTopLevelEquals(part);
    if (equals < 0) {
      return null;
    }
    const target = /^\s*@([A-Za-z_][A-Za-z0-9_$#@]*)\s*$/.exec(part.slice(0, equals));
    if (!target) {
      return null;
    }
    assignments.push({
      target: target[1] as string,
      expression: part.slice(equals + 1).trim(),
    });
  }
  if (assignments.length === 0) {
    return null;
  }
  return { assignments, fromClause };
}

function isSimpleValue(text: string): boolean {
  const value = text.trim();
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return true;
  }
  if (/^N?'(?:[^']|'')*'$/i.test(value)) {
    return true;
  }
  if (/^(null|0x[0-9a-f]+)$/i.test(value)) {
    return true;
  }
  return /^@[A-Za-z_][A-Za-z0-9_$#@]*$/.test(value);
}

function sqlTypeForLocal(sqlType: string, size: string | undefined): string {
  if (sqlType === 'nvarchar' || sqlType === 'nchar') {
    return size?.toLowerCase() === 'max' ? 'nvarchar(max)' : `nvarchar(${size ?? 'max'})`;
  }
  return size ? `${sqlType}(${size})` : sqlType;
}

class Translator {
  private readonly lines: string[] = [];
  private readonly notes: Issue[] = [];
  private readonly entityTables = new Set<string>();
  private readonly names: NameMaps;
  private readonly outputProps: Map<string, string>;
  private readonly parameterByName = new Map<string, SqlParameter>();
  private readonly declaredLocals = new Set<string>();
  private readonly needsIdentity: boolean;
  private usedRaw = false;
  private emittedSelect = false;
  private counter = 0;
  private lastInsert: { variable: string; identity: string } | null = null;

  constructor(
    private readonly analysis: Analysis,
    private readonly database: string,
    private readonly definitions: Map<string, TableDefinition>,
    body: string,
  ) {
    this.names = buildNameMaps(analysis.procedure.parameters);
    this.names.used.add('rows');
    this.names.used.add('output');
    this.names.used.add('result');
    this.outputProps = outputProperties(analysis.outputParams, this.names.used);
    this.needsIdentity = /scope_identity\s*\(/i.test(stripCommentsAndStrings(body));
    for (const parameter of analysis.procedure.parameters) {
      this.parameterByName.set(parameter.name.replace(/^@/, '').toLowerCase(), parameter);
    }
  }

  run(statements: string[]): ProcedureTranslation {
    for (const parameter of this.analysis.outputParams) {
      const property = this.outputProps.get(parameter.name.replace(/^@/, '').toLowerCase());
      if (!property) {
        continue;
      }
      this.lines.push(`let ${property}: any = null;`);
    }
    this.lines.push('let rows: {{row}}[] = [];');
    if (this.lines.length > 0) {
      this.lines.push('');
    }

    for (const statement of statements) {
      if (/^\s*set\s+(nocount|xact_abort|ansi_[a-z_]+|arithabort|quoted_identifier)\b/i.test(statement)) {
        continue;
      }
      this.translateStatement(statement.trim());
    }

    this.lines.push('');
    if (this.analysis.outputParams.length > 0) {
      const entries = this.analysis.outputParams
        .map((parameter) => {
          const property = this.outputProps.get(parameter.name.replace(/^@/, '').toLowerCase());
          return property ? `${property}: ${property}` : null;
        })
        .filter((value): value is string => value !== null);
      this.lines.push(`return { rows, output: { ${entries.join(', ')} } };`);
    } else {
      this.lines.push('return rows;');
    }

    return {
      mode: this.usedRaw ? 'hybrid' : 'orm',
      lines: this.lines,
      notes: this.notes,
      entityTables: [...this.entityTables],
    };
  }

  private note(code: string, message: string, severity: Issue['severity'] = 'info'): void {
    if (this.notes.some((issue) => issue.code === code && issue.message === message)) {
      return;
    }
    this.notes.push({ code, severity, message });
  }

  private next(prefix: string): string {
    this.counter += 1;
    return `${prefix}${this.counter}`;
  }

  private translateStatement(statement: string): void {
    const word = firstWord(statement);
    switch (word) {
      case 'set':
        this.translateSet(statement);
        return;
      case 'declare':
        this.translateDeclare(statement);
        return;
      case 'select':
        this.translateSelect(statement);
        return;
      case 'with':
        this.rawSelect(statement);
        return;
      case 'insert':
        this.translateInsert(statement);
        return;
      case 'update':
        this.translateUpdate(statement);
        return;
      case 'delete':
        this.translateDelete(statement);
        return;
      case 'truncate':
        this.translateTruncate(statement);
        return;
      case 'print':
        return;
      case 'exec':
      case 'execute':
        throw new TranslationError('EXEC calls are not supported.');
      case '':
        return;
      default:
        throw new TranslationError(`Unsupported statement starting with ${word}.`);
    }
  }

  private resolve(name: string): string | null {
    const key = name.toLowerCase();
    const parameter = this.parameterByName.get(key);
    if (parameter && !parameter.isOutput) {
      return this.parameterExpression(parameter);
    }
    const local = this.names.locals.get(key);
    if (local) {
      return local;
    }
    return this.outputProps.get(key) ?? null;
  }

  private parameterExpression(parameter: SqlParameter): string {
    const key = parameter.name.replace(/^@/, '').toLowerCase();
    const base = `{{param:${key}}}`;
    if (!parameter.hasDefault) {
      return base;
    }
    const fallback = defaultExpressionToTs(parameter.defaultExpression ?? null);
    if (fallback === null) {
      this.note(
        'default-expression',
        `The default for @${parameter.name} could not be translated; NULL is used instead.`,
        'warning',
      );
      return `(${base} ?? null)`;
    }
    return `(${base} ?? ${fallback})`;
  }

  private bind(text: string, bindings: Bindings): string {
    return this.bindWith(text, bindings, (name) => `:${name}`);
  }

  /** Binds named parameters for TypeORM's raw `query`, which uses `@0`, `@1`, ... */
  private bindRaw(text: string, bindings: Bindings): string {
    return this.bindWith(text, bindings, (name) => `@${bindings.index(name)}`);
  }

  private bindWith(
    text: string,
    bindings: Bindings,
    format: (name: string) => string,
  ): string {
    const withIdentity = this.bindIdentity(stripSqlComments(text), bindings, format);
    const result = replaceParameters(withIdentity, (name) => {
      const expression = this.resolve(name);
      if (expression === null) {
        return null;
      }
      return format(bindings.add(expression));
    });
    if (result === null) {
      throw new TranslationError(`Unknown variable in SQL: ${text.slice(0, 120)}`);
    }
    return result.text;
  }

  /** Replaces `SCOPE_IDENTITY()` with the identity captured by the last INSERT. */
  private bindIdentity(
    text: string,
    bindings: Bindings,
    format: (name: string) => string,
  ): string {
    if (!/scope_identity/i.test(text)) {
      return text;
    }
    let output = '';
    let cursor = 0;
    while (cursor < text.length) {
      const skipped = skipNonCode(text, cursor);
      if (skipped !== null) {
        output += text.slice(cursor, skipped);
        cursor = skipped;
        continue;
      }
      const match = /^scope_identity\s*\(\s*\)/i.exec(text.slice(cursor));
      if (match) {
        const identity = this.identityExpression();
        if (identity === null) {
          throw new TranslationError('SCOPE_IDENTITY() has no preceding INSERT.');
        }
        output += format(bindings.add(identity));
        cursor += match[0].length;
        continue;
      }
      output += text[cursor];
      cursor += 1;
    }
    return output;
  }

  private simpleValue(text: string, bindings: Bindings): string | null {
    const value = text.trim();
    if (/^-?\d+(?:\.\d+)?$/.test(value)) {
      return value;
    }
    const string = /^N?'([\s\S]*)'$/i.exec(value);
    if (string) {
      return tsStringLiteral((string[1] as string).replace(/''/g, "'"));
    }
    if (/^null$/i.test(value)) {
      return 'null';
    }
    if (/^0x[0-9a-f]+$/i.test(value)) {
      return `Buffer.from(${tsStringLiteral(value.slice(2))}, 'hex')`;
    }
    if (/^@[A-Za-z_][A-Za-z0-9_$#@]*$/.test(value)) {
      const expression = this.resolve(value.slice(1));
      if (expression === null) {
        throw new TranslationError(`Unknown variable ${value}.`);
      }
      return expression;
    }
    return null;
  }

  private localName(raw: string): string {
    const key = raw.replace(/^@/, '').toLowerCase();
    const name = ensureLocal(this.names, raw);
    this.declaredLocals.add(key);
    return name;
  }

  private assignmentTarget(raw: string): { key: string; name: string } {
    const key = raw.replace(/^@/, '').toLowerCase();
    const output = this.outputProps.get(key);
    if (output) {
      return { key, name: output };
    }
    const local = this.names.locals.get(key);
    if (local) {
      return { key, name: local };
    }
    return { key, name: this.localName(raw) };
  }

  private identityExpression(): string | null {
    return this.lastInsert?.identity ?? null;
  }

  private translateDeclare(statement: string): void {
    const match = /^\s*declare\s+([\s\S]*)$/i.exec(statement);
    if (!match) {
      throw new TranslationError('Malformed DECLARE.');
    }
    const declarators = splitTopLevel(match[1] as string);
    for (const declarator of declarators) {
      const identifier = declaredIdentifier(declarator);
      if (!identifier) {
        throw new TranslationError('Unsupported DECLARE form.');
      }
      const rest = declarator.slice(identifier.end);
      const equals = findTopLevelEquals(rest);
      const typeText = equals >= 0 ? rest.slice(0, equals) : rest;
      const expression = equals >= 0 ? rest.slice(equals + 1).trim() : null;
      const typeMatch = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*$/.exec(typeText);
      if (!typeMatch) {
        throw new TranslationError('Unsupported DECLARE type.');
      }
      const sqlType = (typeMatch[1] as string).toLowerCase();
      if (sqlType === 'table' || sqlType === 'cursor') {
        throw new TranslationError('Table and cursor variables are not supported.');
      }
      const parsedType = parseDeclaredType(
        sqlTypeForLocal(sqlType, typeMatch[2] as string | undefined),
      );
      if (!parsedType) {
        throw new TranslationError(`Unsupported local type ${sqlType}.`);
      }
      const name = this.localName(identifier.name);

      if (expression === null) {
        this.lines.push(`let ${name}: ${parsedType.tsType} = ${parsedType.zero};`);
        continue;
      }

      if (/^scope_identity\s*\(\s*\)$/i.test(expression)) {
        const identity = this.identityExpression();
        if (identity === null) {
          throw new TranslationError('SCOPE_IDENTITY() has no preceding INSERT.');
        }
        this.lines.push(`let ${name}: ${parsedType.tsType} = ${identity};`);
        continue;
      }

      const value = this.simpleValue(expression, new Bindings());
      if (value !== null) {
        this.lines.push(`let ${name}: ${parsedType.tsType} = ${value};`);
        continue;
      }

      this.lines.push(`let ${name}: ${parsedType.tsType} = ${parsedType.zero};`);
      this.rawScalar(expression, name);
    }
  }

  private translateSet(statement: string): void {
    if (
      /^\s*set\s+(nocount|xact_abort|ansi_[a-z_]+|arithabort|quoted_identifier)\b/i.test(statement)
    ) {
      return;
    }
    const match = /^\s*set\s+@([A-Za-z_][A-Za-z0-9_$#@]*)\s*=\s*([\s\S]+)$/i.exec(statement);
    if (!match) {
      throw new TranslationError('Unsupported SET statement.');
    }
    const target = this.assignmentTarget(match[1] as string);
    const expression = (match[2] as string).trim();
    const value = this.simpleValue(expression, new Bindings());
    if (value !== null) {
      this.lines.push(`${target.name} = ${value};`);
      return;
    }
    this.rawScalar(expression, target.name);
  }

  private rawScalar(expression: string, target: string): void {
    const bindings = new Bindings();
    const sql = this.bindRaw(expression, bindings);
    const variable = this.next('scalar');
    this.usedRaw = true;
    this.lines.push(
      `const ${variable} = (await {{manager}}.query(${tsStringLiteral(`SELECT ${sql} AS [value]`)}${bindings.queryArgument()})) ?? [];`,
    );
    this.lines.push(`${target} = ${variable}[0]?.value ?? null;`);
  }

  private translateSelect(statement: string): void {
    const identitySelect =
      /^\s*select\s+scope_identity\s*\(\s*\)(?:\s+as\s+([A-Za-z_][A-Za-z0-9_$]*|\[[^\]]+\]))?\s*$/i.exec(
        statement,
      );
    if (identitySelect) {
      const identity = this.identityExpression();
      if (identity === null) {
        throw new TranslationError('SCOPE_IDENTITY() has no preceding INSERT.');
      }
      if (this.emittedSelect) {
        this.note(
          'additional-result-set',
          'Only the first result set is exposed; a later SELECT was skipped.',
          'warning',
        );
        return;
      }
      const key = identitySelect[1] ? columnName(identitySelect[1]) : 'Id';
      const property = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : `[${tsStringLiteral(key)}]`;
      this.lines.push(`rows = [{ ${property}: ${identity} }] as unknown as {{row}}[];`);
      this.emittedSelect = true;
      return;
    }
    const assignment = selectAssignmentParts(statement);
    if (assignment) {
      this.translateSelectAssignment(assignment);
      return;
    }
    const parsed = parseSimpleSelect(statement, this.database, this.definitions);
    if (parsed) {
      this.ormSelect(statement, parsed);
      return;
    }
    this.rawSelect(statement);
  }

  private translateSelectAssignment(assignment: {
    assignments: Array<{ target: string; expression: string }>;
    fromClause: string | null;
  }): void {
    const targets = assignment.assignments.map((entry) => this.assignmentTarget(entry.target));

    if (assignment.fromClause === null) {
      assignment.assignments.forEach((entry, index) => {
        const target = targets[index] as { key: string; name: string };
        const value = this.simpleValue(entry.expression, new Bindings());
        if (value !== null) {
          this.lines.push(`${target.name} = ${value};`);
          return;
        }
        this.rawScalar(entry.expression, target.name);
      });
      return;
    }

    const bindings = new Bindings();
    const selectList = assignment.assignments
      .map((entry, index) => `${this.bindRaw(entry.expression, bindings)} AS [v${index}]`)
      .join(', ');
    const fromTail = this.bindRaw(assignment.fromClause, bindings);
    const variable = this.next('scalar');
    this.usedRaw = true;
    this.lines.push(
      `const ${variable} = (await {{manager}}.query(${tsStringLiteral(`SELECT ${selectList} ${fromTail}`)}${bindings.queryArgument()})) ?? [];`,
    );
    targets.forEach((target, index) => {
      this.lines.push(`${target.name} = ${variable}[0]?.v${index} ?? null;`);
    });
  }

  private ormSelect(statement: string, parsed: SimpleSelect): void {
    if (!hasEntity(this.definitions.get(parsed.key) ?? null)) {
      this.rawSelect(statement);
      return;
    }
    if (this.emittedSelect) {
      this.note(
        'additional-result-set',
        'Only the first result set is exposed; a later SELECT was skipped.',
        'warning',
      );
      return;
    }
    this.entityTables.add(parsed.key);
    const bindings = new Bindings();
    const where = parsed.where === null ? null : this.bind(parsed.where, bindings);
    const lines = [
      'rows = (await {{manager}}',
      `  .createQueryBuilder({{entity:${parsed.key}}}, ${tsStringLiteral(parsed.alias)})`,
      `  .select([${parsed.columns
        .map((column) => tsStringLiteral(`${column.expression} AS ${quoteIdentifier(column.output)}`))
        .join(', ')}])`,
    ];
    if (parsed.distinct) {
      lines.push('  .distinct(true)');
    }
    if (where !== null) {
      lines.push(`  .where(${tsStringLiteral(where)}${bindings.argument()})`);
    }
    if (parsed.orderBy.length > 0) {
      for (const item of parsed.orderBy) {
        lines.push(`  .addOrderBy(${tsStringLiteral(item.expression)}, '${item.direction}')`);
      }
    }
    if (parsed.top !== null) {
      lines.push(`  .take(${parsed.top})`);
    }
    lines.push('  .getRawMany()) as unknown as {{row}}[];');
    this.lines.push(...lines);
    this.emittedSelect = true;
  }

  private rawSelect(statement: string): void {
    if (this.emittedSelect) {
      this.note(
        'additional-result-set',
        'Only the first result set is exposed; a later SELECT was skipped.',
        'warning',
      );
      return;
    }
    const bindings = new Bindings();
    this.note(
      'inline-sql',
      'The SELECT is emitted as parameterized inline SQL rather than a query-builder call.',
    );
    const sql = this.bindRaw(statement, bindings);
    this.usedRaw = true;
    this.lines.push(
      `rows = (await {{manager}}.query(${tsStringLiteral(sql)}${bindings.queryArgument()})) as unknown as {{row}}[];`,
    );
    this.emittedSelect = true;
  }

  private translateInsert(statement: string): void {
    const parsed = parseInsert(statement, this.database, this.definitions);
    if (!parsed) {
      this.rawStatement(statement);
      return;
    }
    if (!hasEntity(parsed.definition)) {
      this.rawInsert(statement, parsed);
      return;
    }
    if (this.needsIdentity && identityColumn(parsed.definition)) {
      this.rawInsert(statement, parsed);
      return;
    }
    const properties = entityPropertyNames(parsed.definition);
    const bindings = new Bindings();
    const entries: string[] = [];
    for (let index = 0; index < parsed.columns.length; index += 1) {
      const column = parsed.columns[index] as string;
      const property = properties.get(column.toLowerCase());
      if (!property) {
        this.rawInsert(statement, parsed);
        return;
      }
      const value = this.simpleValue(parsed.values[index] as string, bindings);
      if (value === null) {
        this.rawInsert(statement, parsed);
        return;
      }
      entries.push(`${property}: ${value}`);
    }
    this.entityTables.add(parsed.key);
    const variable = this.next('insert');
    this.lines.push(
      `const ${variable} = await {{manager}}`,
      '  .createQueryBuilder()',
      '  .insert()',
      `  .into({{entity:${parsed.key}}})`,
      `  .values({ ${entries.join(', ')} } as any)`,
      '  .execute();',
    );
    const identity = identityColumn(parsed.definition);
    if (identity) {
      const property = properties.get(identity.name.toLowerCase()) ?? identity.name;
      this.lastInsert = {
        variable,
        identity: `Number(${variable}.identifiers[0]?.${property} ?? 0)`,
      };
    } else {
      this.lastInsert = null;
    }
  }

  private rawInsert(statement: string, parsed: SimpleInsert): void {
    const identity = parsed.definition ? identityColumn(parsed.definition) : null;
    const bindings = new Bindings();
    this.note(
      'inline-sql',
      'The INSERT is emitted as parameterized inline SQL rather than a query-builder call.',
    );
    const trimmed = statement.trim().replace(/;\s*$/, '');
    const bound = this.bindRaw(trimmed, bindings);
    const sql = identity ? `${bound}; SELECT SCOPE_IDENTITY() AS [__identity]` : bound;
    this.usedRaw = true;
    const variable = this.next('insert');
    this.lines.push(
      `const ${variable} = await {{manager}}.query(${tsStringLiteral(sql)}${bindings.queryArgument()});`,
    );
    this.lastInsert = identity
      ? { variable, identity: `Number(${variable}[0]?.__identity ?? 0)` }
      : null;
  }

  private translateUpdate(statement: string): void {
    const parsed = parseUpdate(statement, this.database, this.definitions);
    if (!parsed || !hasEntity(parsed.definition)) {
      this.rawStatement(statement);
      return;
    }
    const properties = entityPropertyNames(parsed.definition);
    const bindings = new Bindings();
    const setEntries: string[] = [];
    const setParameters: string[] = [];
    for (const assignment of parsed.assignments) {
      const property = properties.get(assignment.column.toLowerCase());
      if (!property) {
        this.rawStatement(statement);
        return;
      }
      const value = this.simpleValue(assignment.expression, new Bindings());
      if (value !== null) {
        setEntries.push(`${property}: ${value}`);
        continue;
      }
      const before = bindings.names().length;
      const expression = this.bind(assignment.expression, bindings);
      for (const name of bindings.names().slice(before)) {
        setParameters.push(name);
      }
      setEntries.push(`${property}: () => ${tsStringLiteral(expression)}`);
    }
    const where = parsed.where === null ? null : this.bind(parsed.where, bindings);
    this.entityTables.add(parsed.key);
    this.lines.push(
      'await {{manager}}',
      '  .createQueryBuilder()',
      `  .update({{entity:${parsed.key}}})`,
      `  .set({ ${setEntries.join(', ')} } as any)`,
    );
    const rendered = bindings.object();
    if (setParameters.length > 0) {
      this.lines.push(
        `  .setParameters({ ${setParameters
          .map((name) => `${name}: ${bindings.value(name)}`)
          .join(', ')} })`,
      );
    }
    if (where !== null && rendered.length > 0) {
      this.lines.push(`  .where(${tsStringLiteral(where)}, ${rendered})`);
    } else if (where !== null) {
      this.lines.push(`  .where(${tsStringLiteral(where)})`);
    }
    this.lines.push('  .execute();');
  }

  private translateDelete(statement: string): void {
    const parsed = parseDelete(statement, this.database, this.definitions);
    if (!parsed || !hasEntity(parsed.definition)) {
      this.rawStatement(statement);
      return;
    }
    const bindings = new Bindings();
    const where = parsed.where === null ? null : this.bind(parsed.where, bindings);
    this.entityTables.add(parsed.key);
    this.lines.push(
      'await {{manager}}',
      '  .createQueryBuilder()',
      '  .delete()',
      `  .from({{entity:${parsed.key}}})`,
    );
    const rendered = bindings.object();
    if (where !== null && rendered.length > 0) {
      this.lines.push(`  .where(${tsStringLiteral(where)}, ${rendered})`);
    } else if (where !== null) {
      this.lines.push(`  .where(${tsStringLiteral(where)})`);
    }
    this.lines.push('  .execute();');
  }

  private translateTruncate(statement: string): void {
    const match = /^\s*truncate\s+table\s+([\s\S]+)$/i.exec(statement);
    if (!match) {
      throw new TranslationError('Malformed TRUNCATE TABLE.');
    }
    const name = parseQualifiedName(match[1] as string, 0);
    if (!name) {
      throw new TranslationError('Malformed TRUNCATE TABLE name.');
    }
    const resolved = tableReference(name.parts, this.database, this.definitions);
    this.usedRaw = true;
    this.lines.push(
      `await {{manager}}.query(${tsStringLiteral(
        `TRUNCATE TABLE ${quoteIdentifier(resolved.table.schema)}.${quoteIdentifier(resolved.table.name)}`,
      )});`,
    );
  }

  private rawStatement(statement: string): void {
    const word = firstWord(statement);
    if (word === 'select' || word === 'with') {
      this.rawSelect(statement);
      return;
    }
    const bindings = new Bindings();
    this.note(
      'inline-sql',
      'The statement is emitted as parameterized inline SQL rather than a query-builder call.',
    );
    const sql = this.bindRaw(statement, bindings);
    this.usedRaw = true;
    this.lines.push(
      `await {{manager}}.query(${tsStringLiteral(sql)}${bindings.queryArgument()});`,
    );
  }
}

/**
 * Translates a procedure body into generated method lines. Simple statements use
 * TypeORM's query builder; constructs the ORM cannot express (CTEs, flow control,
 * SQL expressions) fall back to one parameterized inline batch. Nothing ever calls
 * the stored procedure itself.
 */
export function translateProcedure(
  analysis: Analysis,
  tables: TableDefinition[],
  database: string,
): ProcedureTranslation {
  const definitions = new Map<string, TableDefinition>();
  for (const table of tables) {
    definitions.set(`${table.schema}.${table.name}`.toLowerCase(), table);
  }
  const body = extractProcedureBody(analysis.procedure.definition);
  if (body.trim().length === 0) {
    return {
      mode: 'unsupported',
      lines: [],
      notes: [],
      reason: 'the procedure body is empty',
      entityTables: [],
    };
  }

  const code = stripCommentsAndStrings(body);
  if (/\bexec(?:ute)?\b/i.test(code)) {
    return {
      mode: 'unsupported',
      lines: [],
      notes: [
        {
          code: 'exec-call',
          severity: 'error',
          message:
            'The body calls another procedure with EXEC; generated code never calls stored procedures.',
        },
      ],
      reason: 'EXEC calls cannot be translated',
      entityTables: [],
    };
  }

  if (hasFlowControl(body)) {
    return translateBatch(analysis, body, definitions, database, 'the body contains flow control');
  }

  const translator = new Translator(analysis, database, definitions, body);
  try {
    return translator.run(splitStatements(body));
  } catch (error) {
    if (error instanceof TranslationError) {
      const fallback = translateBatch(
        analysis,
        body,
        definitions,
        database,
        `statement translation failed (${error.message})`,
      );
      fallback.mode = 'sql';
      fallback.notes.unshift({
        code: 'inline-sql',
        severity: 'info',
        message: `The body is emitted as one parameterized SQL batch: ${error.message}`,
      });
      return fallback;
    }
    throw error;
  }
}

function replaceInputParameters(
  text: string,
  analysis: Analysis,
  bindings: Bindings,
): string {
  const parameters = new Map<string, SqlParameter>();
  for (const parameter of analysis.procedure.parameters) {
    if (!parameter.isOutput) {
      parameters.set(parameter.name.replace(/^@/, '').toLowerCase(), parameter);
    }
  }
  const result = replaceParameters(text, (name) => {
    const parameter = parameters.get(name.toLowerCase());
    if (!parameter) {
      // Locals and OUTPUT parameters are declared inside the batch itself.
      return `@${name}`;
    }
    return `@${bindings.index(bindings.add(parameterExpressionFor(parameter)))}`;
  });
  return result === null ? text : result.text;
}

function parameterExpressionFor(parameter: SqlParameter): string {
  const key = parameter.name.replace(/^@/, '').toLowerCase();
  const base = `{{param:${key}}}`;
  if (!parameter.hasDefault) {
    return base;
  }
  const fallback = defaultExpressionToTs(parameter.defaultExpression ?? null);
  return fallback === null ? `(${base} ?? null)` : `(${base} ?? ${fallback})`;
}

function translateBatch(
  analysis: Analysis,
  body: string,
  definitions: Map<string, TableDefinition>,
  database: string,
  reason: string,
): ProcedureTranslation {
  const notes: Issue[] = [];
  const bindings = new Bindings();
  const sql = stripSqlComments(replaceInputParameters(body, analysis, bindings));
  const declarations: string[] = [];
  const properties = outputProperties(analysis.outputParams);
  for (const output of analysis.outputParams) {
    const key = output.name.replace(/^@/, '').toLowerCase();
    if (new RegExp(`\\bdeclare\\s+@${key}\\b`, 'i').test(stripCommentsAndStrings(body))) {
      continue;
    }
    declarations.push(`DECLARE @${output.name.replace(/^@/, '')} ${sqlTypeDeclaration(output) ?? 'nvarchar(max)'};`);
  }

  const code = stripCommentsAndStrings(body);
  const dataSelect =
    /(^|[;\s])select\s+(?!@)/i.test(code) || /^\s*with\b/i.test(code);
  const outputSelect = analysis.outputParams.length > 0 && !dataSelect;
  const finalSql = [
    ...declarations,
    sql.trim(),
    outputSelect
      ? `SELECT ${analysis.outputParams
          .map((output) => {
            const property = properties.get(output.name.replace(/^@/, '').toLowerCase()) ?? 'value';
            return `@${output.name.replace(/^@/, '')} AS ${quoteIdentifier(property)}`;
          })
          .join(', ')};`
      : '',
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  const lines: string[] = [];
  for (const output of analysis.outputParams) {
    const property = properties.get(output.name.replace(/^@/, '').toLowerCase());
    if (property) {
      lines.push(`let ${property}: any = null;`);
    }
  }

  if (outputSelect) {
    lines.push(
      `const batch = await {{manager}}.query(${tsStringLiteral(finalSql)}${bindings.queryArgument()});`,
    );
    lines.push('let rows: {{row}}[] = [];');
    for (const output of analysis.outputParams) {
      const property = properties.get(output.name.replace(/^@/, '').toLowerCase());
      if (property) {
        lines.push(`${property} = batch[0]?.[${tsStringLiteral(property)}] ?? null;`);
      }
    }
  } else {
    lines.push(
      `let rows = ((await {{manager}}.query(${tsStringLiteral(finalSql)}${bindings.queryArgument()})) ?? []) as unknown as {{row}}[];`,
    );
    if (analysis.outputParams.length > 0) {
      notes.push({
        code: 'output-in-batch',
        severity: 'warning',
        message:
          'OUTPUT parameters are assigned inside a SQL batch that also returns rows; only the first result set is available, so the OUTPUT values are null.',
      });
    }
  }

  if (analysis.outputParams.length > 0) {
    const entries = analysis.outputParams
      .map((output) => {
        const property = properties.get(output.name.replace(/^@/, '').toLowerCase());
        return property ? `${property}: ${property}` : null;
      })
      .filter((value): value is string => value !== null);
    lines.push(`return { rows, output: { ${entries.join(', ')} } };`);
  } else {
    lines.push('return rows;');
  }

  notes.unshift({
    code: 'inline-sql',
    severity: 'info',
    message: `Emitted as a parameterized inline SQL batch because ${reason}.`,
  });

  return {
    mode: 'sql',
    lines,
    notes,
    entityTables: [],
  };
}
