import { analyzeProcedure } from './analyze/analyzer.js';
import { generateFiles } from './generate/project.js';
import type { GeneratedFile } from './generate/project.js';
import { renderReport } from './report.js';
import { translateProcedure } from './translate/translate.js';
import { writeFiles } from './emit/writer.js';
import type { WriteResult } from './emit/writer.js';
import type { Analysis, CatalogSnapshot, TableDefinition } from './types.js';

export interface AnalysisBundle {
  database: string;
  analyses: Analysis[];
  tables: TableDefinition[];
}

export function analyzeCatalog(catalog: CatalogSnapshot): AnalysisBundle {
  const analyses = catalog.procedures.map((procedure) => {
    const analysis = analyzeProcedure(procedure, catalog.database);
    if (analysis.destination.kind === 'skipped') {
      return analysis;
    }
    const translation = translateProcedure(analysis, catalog.tables, catalog.database);
    analysis.translation = translation;
    analysis.issues.push(...translation.notes);
    if (translation.mode === 'unsupported') {
      const reason = translation.reason ?? 'the body could not be translated';
      analysis.issues.push({
        code: 'translation-unsupported',
        severity: 'error',
        message: `The procedure was skipped because ${reason}.`,
      });
      analysis.destination = { kind: 'skipped', reason };
    }
    return analysis;
  });
  return { database: catalog.database, analyses, tables: catalog.tables };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\\\*/g, '.*').replace(/\\\?/g, '.')}$`, 'i');
}

export interface SelectionOptions {
  selectedKeys?: string[];
  include?: string[];
  exclude?: string[];
}

export function selectAnalyses(
  bundle: AnalysisBundle,
  options: SelectionOptions = {},
): Analysis[] {
  const include = options.include?.map(globToRegExp);
  const exclude = options.exclude?.map(globToRegExp);
  const selected = options.selectedKeys ? new Set(options.selectedKeys.map((key) => key.toLowerCase())) : null;

  return bundle.analyses.filter((analysis) => {
    if (selected && !selected.has(analysis.key)) {
      return false;
    }
    const qualified = `${analysis.procedure.schema}.${analysis.procedure.name}`;
    if (include && include.length > 0 && !include.some((pattern) => pattern.test(qualified))) {
      return false;
    }
    if (exclude && exclude.some((pattern) => pattern.test(qualified))) {
      return false;
    }
    return true;
  });
}

export interface GenerateRequest {
  bundle: AnalysisBundle;
  selectedKeys?: string[];
  include?: string[];
  exclude?: string[];
  projectName: string;
  outputDir: string;
  overwrite: 'safe' | 'force' | 'dry-run';
}

export interface GenerateResult {
  files: GeneratedFile[];
  write: WriteResult;
  report: string;
  generated: Analysis[];
  skipped: Analysis[];
}

export function planProject(request: GenerateRequest): {
  files: GeneratedFile[];
  generated: Analysis[];
  skipped: Analysis[];
  report: string;
} {
  const selected = selectAnalyses(request.bundle, {
    selectedKeys: request.selectedKeys,
    include: request.include,
    exclude: request.exclude,
  });

  const generated = selected.filter((analysis) => analysis.destination.kind !== 'skipped');
  const skipped = selected.filter((analysis) => analysis.destination.kind === 'skipped');

  const files = generateFiles({
    analyses: generated,
    tables: request.bundle.tables,
    database: request.bundle.database,
    projectName: request.projectName,
  });

  const report = renderReport(request.bundle.database, selected, new Date());
  files.push({ path: 'report.md', content: report });
  files.push({ path: '.convert-sp.json', content: `${JSON.stringify({ generator: 'convert-sp', database: request.bundle.database, generatedAt: new Date().toISOString(), procedures: selected.length, generated: generated.length, skipped: skipped.length }, null, 2)}\n` });

  return { files, generated, skipped, report };
}

export async function generateProject(request: GenerateRequest): Promise<GenerateResult> {
  const planned = planProject(request);
  const write = await writeFiles(planned.files, {
    outputDir: request.outputDir,
    database: request.bundle.database,
    overwrite: request.overwrite,
  });
  return { ...planned, write };
}
