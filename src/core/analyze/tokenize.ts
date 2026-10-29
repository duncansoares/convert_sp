/**
 * Replaces comments and string literals with spaces so keyword and table scanning
 * cannot be fooled by text such as `-- insert into dbo.Fake` or `'UPDATE X SET'`.
 *
 * Bracket identifiers and double-quoted identifiers are preserved because the
 * analyzer needs the real object names.
 */
export function stripCommentsAndStrings(sql: string): string {
  const out: string[] = [];
  let index = 0;
  const length = sql.length;

  const blank = (text: string): string => text.replace(/[^\r\n]/g, ' ');

  while (index < length) {
    const current = sql[index] as string;

    if (current === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? length : end;
      out.push(blank(sql.slice(index, stop)));
      index = stop;
      continue;
    }

    if (current === '/' && sql[index + 1] === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      out.push(blank(sql.slice(index, cursor)));
      index = cursor;
      continue;
    }

    if (current === "'") {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === "'") {
          if (sql[cursor + 1] === "'") {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      out.push(blank(sql.slice(index, closed ? cursor : length)));
      index = closed ? cursor : length;
      continue;
    }

    if (current === '[') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === ']') {
          if (sql[cursor + 1] === ']') {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      out.push(sql.slice(index, cursor));
      index = cursor;
      continue;
    }

    if (current === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === '"') {
          if (sql[cursor + 1] === '"') {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      out.push(sql.slice(index, cursor));
      index = cursor;
      continue;
    }

    out.push(current);
    index += 1;
  }

  return out.join('');
}

/**
 * Removes SQL comments while leaving string literals, bracket identifiers and
 * double-quoted identifiers untouched. Comments are replaced with a single space
 * so removing one cannot join two tokens together.
 */
export function stripSqlComments(sql: string): string {
  const out: string[] = [];
  let index = 0;
  const length = sql.length;

  while (index < length) {
    const current = sql[index] as string;

    if (current === '-' && sql[index + 1] === '-') {
      const end = sql.indexOf('\n', index);
      out.push(' ');
      index = end === -1 ? length : end;
      continue;
    }

    if (current === '/' && sql[index + 1] === '*') {
      let depth = 1;
      let cursor = index + 2;
      while (cursor < length && depth > 0) {
        if (sql[cursor] === '/' && sql[cursor + 1] === '*') {
          depth += 1;
          cursor += 2;
          continue;
        }
        if (sql[cursor] === '*' && sql[cursor + 1] === '/') {
          depth -= 1;
          cursor += 2;
          continue;
        }
        cursor += 1;
      }
      out.push(' ');
      index = cursor;
      continue;
    }

    if (current === "'" || current === '"') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === current) {
          if (sql[cursor + 1] === current) {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      out.push(sql.slice(index, closed ? cursor : length));
      index = closed ? cursor : length;
      continue;
    }

    if (current === '[') {
      let cursor = index + 1;
      let closed = false;
      while (cursor < length) {
        if (sql[cursor] === ']') {
          if (sql[cursor + 1] === ']') {
            cursor += 2;
            continue;
          }
          cursor += 1;
          closed = true;
          break;
        }
        cursor += 1;
      }
      out.push(sql.slice(index, closed ? cursor : length));
      index = closed ? cursor : length;
      continue;
    }

    out.push(current);
    index += 1;
  }

  return out.join('');
}

export interface CompactResult {
  /** Definition with comments and literals removed. */
  code: string;
  /** Code with all whitespace runs collapsed to a single space, for simple scanning. */
  compact: string;
}

export function compact(sql: string): CompactResult {
  const code = stripCommentsAndStrings(sql);
  return { code, compact: code.replace(/\s+/g, ' ') };
}
