import type { ProcedureTranslation } from './translate/types.js';

export type Verb = 'get' | 'post' | 'delete';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
}

export interface SqlParameter {
  /** Parameter name without the leading @, exactly as stored in sys.parameters. */
  name: string;
  /** sys.types name, for example int, nvarchar, decimal. */
  sqlType: string;
  /** max_length in bytes. -1 means MAX. */
  maxLength: number;
  precision: number;
  scale: number;
  isOutput: boolean;
  /** True when the parameter is a user-defined table type; generated code cannot bind it. */
  isTableType?: boolean;
  /** True when the parameter is a cursor; generated code cannot bind it. */
  isCursor?: boolean;
  hasDefault: boolean;
  /** Raw T-SQL default expression from the module header, for example `NULL`, `20` or `N'x'`. */
  defaultExpression?: string | null;
  defaultValue: string | null;
}

export interface ResultColumn {
  name: string;
  sqlType: string;
  maxLength: number;
  precision: number;
  scale: number;
  isNullable: boolean;
}

export interface TableKey {
  schema: string;
  name: string;
}

export interface TableReference extends TableKey {
  database: string | null;
  external: boolean;
}

export interface DmlTarget {
  kind: 'insert' | 'update' | 'delete' | 'merge' | 'truncate';
  table: TableReference;
}

export interface RawProcedure {
  objectId: number;
  schema: string;
  name: string;
  definition: string;
  parameters: SqlParameter[];
  resultColumns: ResultColumn[] | null;
  resultError: string | null;
}

export type Destination =
  | { kind: 'repository'; table: TableKey; className: string }
  | { kind: 'multitable'; className: string }
  | { kind: 'skipped'; reason: string };

export interface Analysis {
  procedure: RawProcedure;
  verb: Verb;
  /** Real, de-duplicated tables referenced by the procedure. */
  tables: TableReference[];
  writes: DmlTarget[];
  deletes: DmlTarget[];
  hasDynamicSql: boolean;
  calledProcedures: string[];
  cteNames: string[];
  issues: Issue[];
  destination: Destination;
  methodName: string;
  /** Route path inside the generated controller, without a leading slash. */
  routePath: string;
  /** Base route of the generated controller, without a leading slash. */
  controllerRoute: string;
  /** True when the generated method takes one params object instead of positional arguments. */
  paramsObject: boolean;
  paramsClass: string | null;
  rowType: string | null;
  outputParams: SqlParameter[];
  /** Lower-cased schema.name, useful as a stable key. */
  key: string;
  /** Translated method body; set once a catalog analysis runs. */
  translation?: ProcedureTranslation;
}

export interface TableColumn {
  name: string;
  propertyName: string;
  sqlType: string;
  maxLength: number;
  precision: number;
  scale: number;
  isNullable: boolean;
  isIdentity: boolean;
  isComputed: boolean;
  hasDefault: boolean;
}

export interface TableDefinition {
  schema: string;
  name: string;
  columns: TableColumn[];
  primaryKey: string[];
}

export interface CatalogSnapshot {
  database: string;
  procedures: RawProcedure[];
  tables: TableDefinition[];
}

export interface GenerateOptions {
  outputDir: string;
  projectName: string;
  database: string;
  overwrite: 'safe' | 'force' | 'dry-run';
}

export interface WrittenFile {
  /** Path relative to the output directory, with forward slashes. */
  path: string;
  status: 'created' | 'updated' | 'unchanged' | 'conflict' | 'deleted' | 'skipped';
}
