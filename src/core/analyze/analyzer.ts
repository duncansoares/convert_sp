import {
  charAt,
  isSystemSchema,
  isTempTable,
  nextWord,
  parseQualifiedName,
  toTableReference,
} from './identifiers.js';
import { stripCommentsAndStrings } from './tokenize.js';
import { isReservedAliasWord, stripProcedurePrefix, stripVerbFromAction, toKebab, toPascal } from '../naming.js';
import type {
  Analysis,
  Destination,
  DmlTarget,
  Issue,
  RawProcedure,
  TableReference,
  Verb,
} from '../types.js';

const SYSTEM_OBJECTS = new Set(['statistics', 'index', 'text', 'usage']);

// Words that can follow FROM/JOIN but never start a table name.
const RESERVED_AFTER_FROM = new Set([
  'order',
  'group',
  'having',
  'select',
  'where',
  'union',
  'except',
  'intersect',
  'option',
  'pivot',
  'unpivot',
  'tablesample',
]);

function isParameterReference(text: string, index: number): boolean {
  return charAt(text, index - 1) === '@';
}

function previousWord(text: string, index: number): string {
  const before = text.slice(0, index).trimEnd();
  const match = /([A-Za-z_][A-Za-z0-9_$]*)$/.exec(before);
  return (match?.[1] ?? '').toLowerCase();
}

function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  for (let cursor = openIndex; cursor < text.length; cursor += 1) {
    const char = text[cursor];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
  }
  return text.length;
}

export function findCteNames(code: string): string[] {
  const names: string[] = [];
  const withPattern = /\bwith\b/gi;
  let match: RegExpExecArray | null;

  while ((match = withPattern.exec(code)) !== null) {
    let cursor = match.index + match[0].length;
    for (;;) {
      const nameMatch = /^\s*([A-Za-z_][A-Za-z0-9_$]*)\s*(?:\([^)]*\))?\s+as\s*\(/i.exec(
        code.slice(cursor),
      );
      if (!nameMatch) {
        break;
      }
      names.push(nameMatch[1] as string);
      const openIndex = cursor + nameMatch[0].length - 1;
      const closeIndex = findMatchingParen(code, openIndex);
      cursor = closeIndex + 1;
      const separator = /^\s*,/.exec(code.slice(cursor));
      if (!separator) {
        break;
      }
      cursor += separator[0].length;
    }
  }

  return names;
}

interface ScanResult {
  tables: TableReference[];
  writes: DmlTarget[];
  deletes: DmlTarget[];
  dynamic: boolean;
  calledProcedures: string[];
  selectInto: TableReference[];
}

export function scanStatements(code: string, currentDatabase: string): ScanResult {
  const cteNames = new Set(findCteNames(code).map((name) => name.toLowerCase()));
  const aliases = new Map<string, TableReference>();
  const tables = new Map<string, TableReference>();
  const writes: DmlTarget[] = [];
  const deletes: DmlTarget[] = [];
  const selectInto: TableReference[] = [];

  const addTable = (table: TableReference): void => {
    const key = `${table.schema}.${table.name}`.toLowerCase();
    if (!tables.has(key)) {
      tables.set(key, table);
    }
  };

  const classify = (
    parts: string[],
  ): { table: TableReference; temp: boolean; cte: boolean; system: boolean } | null => {
    if (parts.length === 0) {
      return null;
    }
    if (parts.length === 1) {
      const lowered = (parts[0] as string).toLowerCase();
      if (cteNames.has(lowered)) {
        return { table: { schema: '', name: lowered, database: null, external: false }, temp: false, cte: true, system: false };
      }
      const aliased = aliases.get(lowered);
      if (aliased) {
        return { table: aliased, temp: false, cte: false, system: false };
      }
    }
    const table = toTableReference(parts, currentDatabase);
    if (!table) {
      return null;
    }
    return {
      table,
      temp: isTempTable(table.name),
      cte: false,
      system: isSystemSchema(table.schema),
    };
  };

  // Pass 1: table references and aliases.
  const referencePattern = /\b(from|join)\b/gi;
  let reference: RegExpExecArray | null;
  while ((reference = referencePattern.exec(code)) !== null) {
    if (isParameterReference(code, reference.index)) {
      continue;
    }
    const afterKeyword = reference.index + reference[0].length;
    if (charAt(code, afterKeyword) === '(') {
      continue;
    }
    const name = parseQualifiedName(code, afterKeyword);
    if (!name) {
      continue;
    }
    if (RESERVED_AFTER_FROM.has((name.parts[0] as string).toLowerCase())) {
      continue;
    }
    const nextCharacter = charAt(code, name.end);
    if (nextCharacter === '(') {
      continue;
    }
    const resolved = classify(name.parts);
    if (!resolved || resolved.temp || resolved.cte || resolved.system) {
      continue;
    }
    addTable(resolved.table);

    const aliasToken = nextWord(code, name.end);
    if (aliasToken) {
      let alias: string | null = null;
      if (aliasToken.value.toUpperCase() === 'AS') {
        alias = nextWord(code, aliasToken.end)?.value ?? null;
      } else if (!isReservedAliasWord(aliasToken.value)) {
        alias = aliasToken.value;
      }
      if (alias) {
        aliases.set(alias.toLowerCase(), resolved.table);
      }
    }
  }

  const recordTarget = (
    kind: DmlTarget['kind'],
    parts: string[],
  ): void => {
    const resolved = classify(parts);
    if (!resolved || resolved.temp || resolved.cte || resolved.system) {
      return;
    }
    addTable(resolved.table);
    const target: DmlTarget = { kind, table: resolved.table };
    if (kind === 'delete') {
      deletes.push(target);
    } else {
      writes.push(target);
    }
  };

  // Pass 2: INSERT targets.
  const insertPattern = /\binsert\b/gi;
  let insert: RegExpExecArray | null;
  while ((insert = insertPattern.exec(code)) !== null) {
    if (isParameterReference(code, insert.index)) {
      continue;
    }
    let cursor = insert.index + insert[0].length;
    const word = nextWord(code, cursor);
    if (!word) {
      continue;
    }
    if (word.value.toUpperCase() === 'EXEC' || word.value.toUpperCase() === 'EXECUTE') {
      continue;
    }
    if (word.value.toUpperCase() === 'INTO') {
      cursor = word.end;
    }
    const name = parseQualifiedName(code, cursor);
    if (!name) {
      continue;
    }
    recordTarget('insert', name.parts);
  }

  // Pass 3: MERGE targets.
  const mergePattern = /\bmerge\b/gi;
  let merge: RegExpExecArray | null;
  while ((merge = mergePattern.exec(code)) !== null) {
    if (isParameterReference(code, merge.index)) {
      continue;
    }
    let cursor = merge.index + merge[0].length;
    const word = nextWord(code, cursor);
    if (word && word.value.toUpperCase() === 'INTO') {
      cursor = word.end;
    }
    const name = parseQualifiedName(code, cursor);
    if (!name) {
      continue;
    }
    recordTarget('merge', name.parts);
  }

  // Pass 4: UPDATE targets.
  const updatePattern = /\bupdate\b/gi;
  let update: RegExpExecArray | null;
  while ((update = updatePattern.exec(code)) !== null) {
    if (isParameterReference(code, update.index)) {
      continue;
    }
    if (previousWord(code, update.index) === 'on') {
      continue;
    }
    let cursor = update.index + update[0].length;
    const top = /^\s*top\s*\(\s*\d+\s*\)/i.exec(code.slice(cursor));
    if (top) {
      cursor += top[0].length;
    }
    const name = parseQualifiedName(code, cursor);
    if (!name) {
      continue;
    }
    const lastName = (name.parts[name.parts.length - 1] as string).toLowerCase();
    if (SYSTEM_OBJECTS.has(lastName)) {
      continue;
    }
    recordTarget('update', name.parts);
  }

  // Pass 5: DELETE targets.
  const deletePattern = /\bdelete\b/gi;
  let deletion: RegExpExecArray | null;
  while ((deletion = deletePattern.exec(code)) !== null) {
    if (isParameterReference(code, deletion.index)) {
      continue;
    }
    if (previousWord(code, deletion.index) === 'on') {
      continue;
    }
    let cursor = deletion.index + deletion[0].length;
    const word = nextWord(code, cursor);
    if (word && word.value.toUpperCase() === 'FROM') {
      cursor = word.end;
    }
    const name = parseQualifiedName(code, cursor);
    if (!name) {
      continue;
    }
    recordTarget('delete', name.parts);
  }

  // Pass 6: TRUNCATE targets.
  const truncatePattern = /\btruncate\s+table\b/gi;
  let truncate: RegExpExecArray | null;
  while ((truncate = truncatePattern.exec(code)) !== null) {
    if (isParameterReference(code, truncate.index)) {
      continue;
    }
    const name = parseQualifiedName(code, truncate.index + truncate[0].length);
    if (!name) {
      continue;
    }
    recordTarget('truncate', name.parts);
  }

  // Pass 7: SELECT ... INTO creates a table.
  const intoPattern = /\binto\b/gi;
  let into: RegExpExecArray | null;
  while ((into = intoPattern.exec(code)) !== null) {
    if (isParameterReference(code, into.index)) {
      continue;
    }
    const before = previousWord(code, into.index);
    if (before === 'insert' || before === 'merge') {
      continue;
    }
    const name = parseQualifiedName(code, into.index + into[0].length);
    if (!name) {
      continue;
    }
    if (before === 'select') {
      const resolved = classify(name.parts);
      if (resolved && !resolved.temp && !resolved.cte && !resolved.system) {
        addTable(resolved.table);
        selectInto.push(resolved.table);
        writes.push({ kind: 'insert', table: resolved.table });
      }
    }
  }

  const dynamic =
    /\bexec(?:ute)?\s*\(/i.test(code) ||
    /\bsp_executesql\b/i.test(code) ||
    /\bexec(?:ute)?\s+@/i.test(code);

  const calledProcedures: string[] = [];
  const execPattern = /\bexec(?:ute)?\s+(?!\()/gi;
  let exec: RegExpExecArray | null;
  while ((exec = execPattern.exec(code)) !== null) {
    if (isParameterReference(code, exec.index)) {
      continue;
    }
    const name = parseQualifiedName(code, exec.index + exec[0].length);
    if (!name) {
      continue;
    }
    const first = (name.parts[0] as string).toLowerCase();
    if (first === 'sp_executesql' || first.startsWith('@')) {
      continue;
    }
    calledProcedures.push(name.parts.map((part) => part.toLowerCase()).join('.'));
  }

  return {
    tables: [...tables.values()],
    writes,
    deletes,
    dynamic,
    calledProcedures,
    selectInto,
  };
}

function decideDestination(
  procedure: RawProcedure,
  tables: TableReference[],
  dynamic: boolean,
  issues: Issue[],
): Destination {
  const unbindable = procedure.parameters.filter(
    (parameter) => parameter.isTableType || parameter.isCursor,
  );
  if (unbindable.length > 0) {
    issues.push({
      code: 'unsupported-parameter',
      severity: 'error',
      message: `Unsupported parameter type on ${unbindable
        .map((parameter) => `@${parameter.name}`)
        .join(', ')}; the procedure was skipped.`,
    });
    return { kind: 'skipped', reason: 'unsupported parameter type' };
  }

  if (dynamic) {
    issues.push({
      code: 'dynamic-sql',
      severity: 'error',
      message: 'Dynamic SQL prevents static table analysis; the procedure was skipped.',
    });
    return { kind: 'skipped', reason: 'dynamic SQL' };
  }

  const external = tables.filter((table) => table.external);
  if (external.length > 0) {
    issues.push({
      code: 'external-table',
      severity: 'error',
      message: `References objects outside the current database: ${external
        .map((table) => `${table.database}.${table.schema}.${table.name}`)
        .join(', ')}.`,
    });
    return { kind: 'skipped', reason: 'cross-database reference' };
  }

  if (tables.length === 0) {
    issues.push({
      code: 'no-tables',
      severity: 'warning',
      message: 'No table access could be determined; the procedure was skipped.',
    });
    return { kind: 'skipped', reason: 'no table access' };
  }

  if (tables.length === 1) {
    const table = tables[0] as TableReference;
    return {
      kind: 'repository',
      table: { schema: table.schema, name: table.name },
      className: `${toPascal(table.name)}Repository`,
    };
  }

  const base = toPascal(stripProcedurePrefix(procedure.name));
  return { kind: 'multitable', className: `${base}MultiTableService` };
}

export function analyzeProcedure(procedure: RawProcedure, currentDatabase: string): Analysis {
  const code = stripCommentsAndStrings(procedure.definition);
  const scan = scanStatements(code, currentDatabase);
  const issues: Issue[] = [];

  const destination = decideDestination(procedure, scan.tables, scan.dynamic, issues);

  const blockingWrites = scan.writes.filter((target) => !target.table.external);
  const blockingDeletes = scan.deletes.filter((target) => !target.table.external);

  let verb: Verb = 'get';
  if (blockingWrites.length > 0) {
    verb = 'post';
  } else if (blockingDeletes.length > 0) {
    verb = 'delete';
  }

  const outputParams = procedure.parameters.filter((parameter) => parameter.isOutput);
  if (outputParams.length > 0) {
    issues.push({
      code: 'output-params',
      severity: 'info',
      message: `OUTPUT parameters are returned in the generated result object (${outputParams
        .map((parameter) => `@${parameter.name}`)
        .join(', ')}).`,
    });
  }

  if (scan.selectInto.length > 0) {
    issues.push({
      code: 'select-into',
      severity: 'warning',
      message: `SELECT INTO creates ${scan.selectInto
        .map((table) => `${table.schema}.${table.name}`)
        .join(', ')}; the procedure is treated as a write.`,
    });
  }

  if (scan.calledProcedures.length > 0) {
    issues.push({
      code: 'nested-procedure',
      severity: 'info',
      message: `Calls ${[...new Set(scan.calledProcedures)].join(', ')}; nested procedure table usage is not resolved.`,
    });
  }

  const stripped = stripProcedurePrefix(procedure.name);
  const pascal = toPascal(stripped);
  const methodName = `${verb}${stripVerbFromAction(pascal, verb)}`;

  let controllerRoute = '';
  let routePath = '';

  if (destination.kind === 'repository') {
    controllerRoute = toKebab(destination.table.name);
    let path = toKebab(pascal);
    const tablePrefix = `${toKebab(destination.table.name)}-`;
    if (path === toKebab(destination.table.name)) {
      path = '';
    } else if (path.startsWith(tablePrefix)) {
      path = path.slice(tablePrefix.length);
    }
    routePath = path;
  } else if (destination.kind === 'multitable') {
    controllerRoute = toKebab(stripped);
    routePath = '';
  }

  const inputParams = procedure.parameters.filter((parameter) => !parameter.isOutput);
  const paramsObject = inputParams.length > 6;

  return {
    procedure,
    verb,
    tables: scan.tables,
    writes: scan.writes,
    deletes: scan.deletes,
    hasDynamicSql: scan.dynamic,
    calledProcedures: [...new Set(scan.calledProcedures)],
    cteNames: findCteNames(code),
    issues,
    destination,
    methodName,
    routePath,
    controllerRoute,
    paramsObject,
    paramsClass: paramsObject ? `${pascal}Params` : null,
    rowType: procedure.resultColumns && procedure.resultColumns.length > 0 ? `${pascal}Row` : null,
    outputParams,
    key: `${procedure.schema}.${procedure.name}`.toLowerCase(),
  };
}
