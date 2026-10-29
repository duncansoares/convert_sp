import type { TableReference } from '../types.js';

const BARE = /[A-Za-z0-9_$#@]+/;

export interface QualifiedName {
  parts: string[];
  /** Index just after the last character of the last part. */
  end: number;
}

function readPart(text: string, index: number): { value: string; end: number } | null {
  if (index >= text.length) {
    return null;
  }
  const char = text[index] as string;

  if (char === '[') {
    let cursor = index + 1;
    let value = '';
    while (cursor < text.length) {
      if (text[cursor] === ']') {
        if (text[cursor + 1] === ']') {
          value += ']';
          cursor += 2;
          continue;
        }
        return { value, end: cursor + 1 };
      }
      value += text[cursor];
      cursor += 1;
    }
    return { value, end: text.length };
  }

  if (char === '"') {
    let cursor = index + 1;
    let value = '';
    while (cursor < text.length) {
      if (text[cursor] === '"') {
        if (text[cursor + 1] === '"') {
          value += '"';
          cursor += 2;
          continue;
        }
        return { value, end: cursor + 1 };
      }
      value += text[cursor];
      cursor += 1;
    }
    return { value, end: text.length };
  }

  const match = BARE.exec(text.slice(index));
  if (!match) {
    return null;
  }
  return { value: match[0], end: index + match[0].length };
}

function skipWhitespace(text: string, index: number): number {
  let cursor = index;
  while (cursor < text.length && /\s/.test(text[cursor] as string)) {
    cursor += 1;
  }
  return cursor;
}

export function parseQualifiedName(text: string, start: number): QualifiedName | null {
  let cursor = skipWhitespace(text, start);
  const first = readPart(text, cursor);
  if (!first) {
    return null;
  }
  cursor = first.end;
  const parts = [first.value];
  let lastEnd = cursor;

  for (;;) {
    const afterWhitespace = skipWhitespace(text, cursor);
    if (text[afterWhitespace] !== '.') {
      break;
    }
    const next = readPart(text, afterWhitespace + 1);
    if (!next) {
      break;
    }
    parts.push(next.value);
    cursor = next.end;
    lastEnd = cursor;
  }

  return { parts, end: lastEnd };
}

export function nextWord(text: string, index: number): { value: string; end: number } | null {
  const cursor = skipWhitespace(text, index);
  const match = BARE.exec(text.slice(cursor));
  if (!match) {
    return null;
  }
  return { value: match[0], end: cursor + match[0].length };
}

export function charAt(text: string, index: number): string {
  const cursor = skipWhitespace(text, index);
  return text[cursor] ?? '';
}

export function toTableReference(
  parts: string[],
  currentDatabase: string,
): TableReference | null {
  if (parts.length === 0 || parts.length > 4) {
    return null;
  }

  let database: string | null = null;
  let schema = 'dbo';
  let name: string;

  if (parts.length === 1) {
    name = parts[0] as string;
  } else if (parts.length === 2) {
    schema = parts[0] as string;
    name = parts[1] as string;
  } else if (parts.length === 3) {
    database = parts[0] as string;
    schema = parts[1] as string;
    name = parts[2] as string;
  } else {
    database = parts[1] as string;
    schema = parts[2] as string;
    name = parts[3] as string;
  }

  const external =
    database !== null && database.toLowerCase() !== currentDatabase.toLowerCase();

  return { database, schema, name, external };
}

export function isTempTable(name: string): boolean {
  return name.startsWith('#') || name.startsWith('@');
}

export function isSystemSchema(schema: string): boolean {
  const lowered = schema.toLowerCase();
  return (
    lowered === 'sys' ||
    lowered === 'information_schema' ||
    lowered === 'guest' ||
    lowered === 'db_owner'
  );
}
