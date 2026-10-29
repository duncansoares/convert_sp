import type { Analysis } from './types.js';

const escapeCell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function renderReport(database: string, analyses: Analysis[], generatedAt: Date): string {
  const generated = analyses.filter((analysis) => analysis.destination.kind !== 'skipped');
  const skipped = analyses.filter((analysis) => analysis.destination.kind === 'skipped');

  const lines: string[] = [];
  lines.push('# convert-sp report');
  lines.push('');
  lines.push(`- Database: \`${database}\``);
  lines.push(`- Generated: ${generatedAt.toISOString()}`);
  lines.push(`- Procedures scanned: ${analyses.length}`);
  lines.push(`- Generated: ${generated.length}`);
  lines.push(`- Skipped: ${skipped.length}`);
  lines.push('');

  lines.push('## Generated procedures');
  lines.push('');
  lines.push('| Procedure | Verb | Tables | Destination | Method |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const analysis of generated.sort((a, b) => a.key.localeCompare(b.key))) {
    const tables = analysis.tables.map((table) => `${table.schema}.${table.name}`).join(', ');
    const destination =
      analysis.destination.kind === 'repository'
        ? analysis.destination.className
        : analysis.destination.kind === 'multitable'
          ? analysis.destination.className
          : 'skipped';
    lines.push(
      `| ${escapeCell(`${analysis.procedure.schema}.${analysis.procedure.name}`)} | ${analysis.verb} | ${escapeCell(
        tables,
      )} | ${escapeCell(destination)} | ${analysis.methodName} |`,
    );
  }
  lines.push('');

  if (skipped.length > 0) {
    lines.push('## Skipped procedures');
    lines.push('');
    lines.push('| Procedure | Reason | Detail |');
    lines.push('| --- | --- | --- |');
    for (const analysis of skipped.sort((a, b) => a.key.localeCompare(b.key))) {
      const reason = analysis.destination.kind === 'skipped' ? analysis.destination.reason : '';
      const detail = analysis.issues.map((issue) => issue.message).join(' ');
      lines.push(
        `| ${escapeCell(`${analysis.procedure.schema}.${analysis.procedure.name}`)} | ${escapeCell(
          reason,
        )} | ${escapeCell(detail)} |`,
      );
    }
    lines.push('');
  }

  const withIssues = analyses.filter((analysis) => analysis.issues.length > 0);
  if (withIssues.length > 0) {
    lines.push('## Warnings');
    lines.push('');
    lines.push('| Procedure | Code | Severity | Message |');
    lines.push('| --- | --- | --- | --- |');
    for (const analysis of withIssues) {
      for (const issue of analysis.issues) {
        lines.push(
          `| ${escapeCell(`${analysis.procedure.schema}.${analysis.procedure.name}`)} | ${issue.code} | ${issue.severity} | ${escapeCell(
            issue.message,
          )} |`,
        );
      }
    }
    lines.push('');
  }

  return `${lines.join('\n')}\n`;
}
