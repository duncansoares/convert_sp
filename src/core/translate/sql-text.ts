import { stripCommentsAndStrings } from '../analyze/tokenize.js';

const STATEMENT_STARTERS = new Set([
  'select',
  'insert',
  'update',
  'delete',
  'declare',
  'set',
  'truncate',
  'exec',
  'execute',
  'merge',
  'if',
  'while',
  'begin',
  'end',
  'with',
  'print',
  'raiserror',
  'throw',
  'return',
  'goto',
  'waitfor',
  'use',
  'create',
  'alter',
  'drop',
]);

/** Index after a string, quoted identifier or comment, or null for ordinary code. */
export function skipNonCode(text: string, index: number): number | null {
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

export function skipParentheses(text: string, openIndex: number): number {
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

export function splitTopLevel(text: string, separator = ','): string[] {
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
    } else if (char === separator && depth === 0) {
      segments.push(text.slice(start, cursor));
      start = cursor + 1;
    }
    cursor += 1;
  }
  segments.push(text.slice(start));
  return segments;
}

/** First top-level occurrence of a keyword or phrase, case-insensitively. */
export function findTopLevelKeyword(text: string, phrase: string, from = 0): number {
  const target = phrase.toLowerCase();
  let depth = 0;
  for (let cursor = from; cursor < text.length; ) {
    const skipped = skipNonCode(text, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = text[cursor];
    if (char === '(') {
      depth += 1;
      cursor += 1;
      continue;
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1);
      cursor += 1;
      continue;
    }
    if (depth !== 0) {
      cursor += 1;
      continue;
    }
    if (
      text.slice(cursor, cursor + target.length).toLowerCase() === target &&
      !/[A-Za-z0-9_$#@]/.test(text[cursor - 1] ?? ' ') &&
      !/[A-Za-z0-9_$#@]/.test(text[cursor + target.length] ?? ' ')
    ) {
      return cursor;
    }
    cursor += 1;
  }
  return -1;
}

export function firstWord(text: string): string {
  return (/^\s*([A-Za-z_][A-Za-z0-9_$#@]*)/.exec(text)?.[1] ?? '').toLowerCase();
}

function canSplit(current: string, next: string): boolean {
  if (current.trim().length === 0) {
    return false;
  }
  const first = firstWord(current);
  // These words belong to the statement that is already in progress.
  if (next === 'set' && first === 'update') {
    return false;
  }
  if (next === 'select') {
    if (first === 'with') {
      // `WITH cte AS (...) SELECT ...` is one statement.
      return false;
    }
    if (first === 'insert') {
      // `INSERT INTO ... SELECT ...` is one statement, but an INSERT that
      // already has a VALUES clause has finished.
      const code = stripCommentsAndStrings(current);
      return /\bvalues\b/i.test(code);
    }
    if (first === 'select') {
      return !/\bunion\s+(?:all\s+)?$/i.test(current.trim());
    }
  }
  return true;
}

/**
 * Splits a procedure body into statements. Semicolons are the primary
 * separator; a line that starts with a statement keyword also starts a new
 * statement, which covers the common T-SQL style without semicolons.
 */
export function splitStatements(body: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let cursor = 0;

  const push = (end: number): void => {
    const text = body.slice(start, end).trim();
    if (text.length > 0) {
      statements.push(text);
    }
    start = end;
  };

  while (cursor < body.length) {
    const skipped = skipNonCode(body, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = body[cursor];
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
    } else if (depth === 0 && char === ';') {
      push(cursor);
      start = cursor + 1;
    } else if (depth === 0 && (char === '\n' || char === '\r')) {
      let next = cursor + 1;
      while (next < body.length && /\s/.test(body[next] as string)) {
        next += 1;
      }
      const word = /^([A-Za-z_][A-Za-z0-9_$#@]*)/.exec(body.slice(next))?.[1]?.toLowerCase();
      if (word && STATEMENT_STARTERS.has(word) && canSplit(body.slice(start, cursor), word)) {
        push(cursor);
        start = next;
        cursor = next;
        continue;
      }
    }
    cursor += 1;
  }
  push(body.length);

  return statements.filter((statement) => !/^(begin|end)$/i.test(statement.trim()));
}

/** True when the body contains control flow that cannot be flattened into ORM calls. */
export function hasFlowControl(definition: string): boolean {
  const code = stripCommentsAndStrings(definition);
  return (
    /\b(if|while|merge|try|catch|goto|waitfor|throw|raiserror|cursor|deallocate)\b/i.test(code) ||
    /\b(open|close)\b/i.test(code) ||
    /\bexec(?:ute)?\b/i.test(code) ||
    /\b(begin\s+tran|commit|rollback|save\s+tran)/i.test(code) ||
    /\breturn\b/i.test(code)
  );
}

/** Text after the procedure header's top-level `AS`. */
export function extractProcedureBody(definition: string): string {
  let cursor = 0;
  while (cursor < definition.length) {
    const skipped = skipNonCode(definition, cursor);
    if (skipped !== null) {
      cursor = skipped;
      continue;
    }
    const char = definition[cursor];
    if (char === '(') {
      cursor = skipParentheses(definition, cursor);
      continue;
    }
    const word = /^[A-Za-z]+/.exec(definition.slice(cursor))?.[0];
    if (
      word?.toLowerCase() === 'as' &&
      !/[A-Za-z0-9_$#@]/.test(definition[cursor - 1] ?? ' ') &&
      !/[A-Za-z0-9_$#@]/.test(definition[cursor + word.length] ?? ' ')
    ) {
      return definition.slice(cursor + word.length);
    }
    cursor += 1;
  }
  return definition;
}

export interface ParameterRewrite {
  text: string;
  /** Lower-case parameter names that were replaced, in first-use order. */
  names: string[];
}

/**
 * Replaces `@name` references outside strings and comments. `resolve` returns
 * the replacement text (for example `:customerId`) or null when the variable
 * is unknown.
 */
export function replaceParameters(
  text: string,
  resolve: (name: string) => string | null,
): ParameterRewrite | null {
  const names: string[] = [];
  let output = '';
  let cursor = 0;

  while (cursor < text.length) {
    const skipped = skipNonCode(text, cursor);
    if (skipped !== null) {
      output += text.slice(cursor, skipped);
      cursor = skipped;
      continue;
    }

    const char = text[cursor];
    if (char === '@') {
      if (text[cursor + 1] === '@') {
        output += '@@';
        cursor += 2;
        continue;
      }
      const match = /^@([A-Za-z_][A-Za-z0-9_$#@]*)/.exec(text.slice(cursor));
      if (!match) {
        output += char;
        cursor += 1;
        continue;
      }
      const name = (match[1] as string).toLowerCase();
      const replacement = resolve(name);
      if (replacement === null) {
        return null;
      }
      if (!names.includes(name)) {
        names.push(name);
      }
      output += replacement;
      cursor += match[0].length;
      continue;
    }

    output += char;
    cursor += 1;
  }

  return { text: output, names };
}
