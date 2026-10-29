const RESERVED_ALIAS_WORDS = new Set(
  [
    'on',
    'where',
    'group',
    'order',
    'having',
    'union',
    'inner',
    'left',
    'right',
    'full',
    'cross',
    'outer',
    'join',
    'set',
    'values',
    'with',
    'select',
    'and',
    'or',
    'option',
    'for',
    'as',
    'pivot',
    'unpivot',
    'apply',
    'when',
    'then',
    'using',
    'output',
    'into',
    'from',
    'default',
  ].map((w) => w.toLowerCase()),
);

export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[\[\]"'`]/g, ' ')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

export function toPascal(input: string): string {
  const parts = words(input);
  if (parts.length === 0) {
    return 'Value';
  }
  return parts
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function toCamel(input: string): string {
  const pascal = toPascal(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

export function toKebab(input: string): string {
  const parts = words(input);
  if (parts.length === 0) {
    return 'value';
  }
  return parts.map((part) => part.toLowerCase()).join('-');
}

export function stripProcedurePrefix(name: string): string {
  const stripped = name
    .replace(/^\[?(usp|sp|proc)_/i, '')
    .replace(/^\[?(usp|sp|proc)(?=[A-Z0-9])/, '')
    .replace(/^\[?(usp|sp|proc)\]?$/i, '');
  return stripped.length > 0 ? stripped : name;
}

/**
 * Drops a verb word that is already part of the procedure's action name, so
 * `usp_Customer_GetById` does not become `getCustomerGetById`.
 */
export function stripVerbFromAction(action: string, verb: string): string {
  const parts = words(action);
  const filtered = parts.filter((part) => part.toLowerCase() !== verb.toLowerCase());
  if (filtered.length === 0) {
    return parts.length > 0 ? (parts[0] as string) : 'Value';
  }
  return filtered
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function isReservedAliasWord(word: string): boolean {
  return RESERVED_ALIAS_WORDS.has(word.toLowerCase());
}

/** Ensures the identifier is a legal TypeScript identifier and not a keyword. */
export function safeIdentifier(input: string, fallback = 'value'): string {
  const camel = toCamel(input);
  const cleaned = camel.replace(/[^A-Za-z0-9_$]/g, '');
  if (!/^[A-Za-z_$]/.test(cleaned)) {
    return `${fallback}${cleaned}`;
  }
  return cleaned.length > 0 ? cleaned : fallback;
}

export function dedupeName(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  let index = 2;
  while (used.has(`${base}${index}`)) {
    index += 1;
  }
  const next = `${base}${index}`;
  used.add(next);
  return next;
}
