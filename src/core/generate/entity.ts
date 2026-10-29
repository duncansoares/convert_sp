import { dedupeName, safeIdentifier } from '../naming.js';
import type { TableColumn, TableDefinition } from '../types.js';

/** Entity property names keyed by lower-cased SQL column name. */
export function entityPropertyNames(definition: TableDefinition): Map<string, string> {
  const used = new Set<string>();
  const properties = new Map<string, string>();
  for (const column of definition.columns) {
    if (column.isComputed) {
      continue;
    }
    const property = dedupeName(safeIdentifier(column.name, 'column'), used);
    properties.set(column.name.toLowerCase(), property);
  }
  return properties;
}

export function entityProperty(
  definition: TableDefinition,
  columnName: string,
): string | null {
  return entityPropertyNames(definition).get(columnName.toLowerCase()) ?? null;
}

export function identityColumn(definition: TableDefinition): TableColumn | null {
  return definition.columns.find((column) => column.isIdentity) ?? null;
}
