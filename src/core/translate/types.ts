import type { Issue } from '../types.js';

export type TranslationMode = 'orm' | 'hybrid' | 'sql' | 'unsupported';

/**
 * A procedure body translated to TypeScript. The lines contain a handful of
 * placeholders that the project generator fills in:
 *
 * - `{{manager}}`      EntityManager expression
 * - `{{entity:key}}`   TypeORM entity class for the lower-cased schema.table key
 * - `{{param:name}}`   TypeScript expression for a procedure parameter
 * - `{{row}}`          generated row interface
 * - `{{outputType}}`   generated OUTPUT envelope interface
 */
export interface ProcedureTranslation {
  mode: TranslationMode;
  lines: string[];
  notes: Issue[];
  reason?: string;
  /** Lower-cased schema.table keys whose entities are referenced. */
  entityTables: string[];
}
