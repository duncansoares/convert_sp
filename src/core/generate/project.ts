import { dedupeName, safeIdentifier, toKebab, toPascal } from '../naming.js';
import type {
  Analysis,
  ResultColumn,
  SqlParameter,
  TableColumn,
  TableDefinition,
} from '../types.js';
import type { ProcedureTranslation } from '../translate/types.js';
import {
  entityColumnType,
  tsEntityType,
  tsInputType,
  tsRowType,
  validationRules,
} from './type-map.js';
import { entityPropertyNames } from './entity.js';

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface GenerateInput {
  analyses: Analysis[];
  tables: TableDefinition[];
  database: string;
  projectName: string;
}

const q = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

export function generateFiles(input: GenerateInput): GeneratedFile[] {
  const files: GeneratedFile[] = [];
  const supported = input.analyses
    .filter((analysis) => analysis.destination.kind !== 'skipped')
    .sort((a, b) => a.key.localeCompare(b.key));

  const tableByName = new Map<string, TableDefinition>();
  for (const table of input.tables) {
    tableByName.set(`${table.schema}.${table.name}`.toLowerCase(), table);
  }

  // ---- naming -------------------------------------------------------------
  const usedRowTypes = new Set<string>();
  const usedParams = new Set<string>();
  const usedEntities = new Set<string>();
  const usedRepos = new Set<string>();
  const usedMultitable = new Set<string>();

  const rowTypeNames = new Map<string, string>();
  const paramsClassNames = new Map<string, string>();
  for (const analysis of supported) {
    const base = toPascal(stripPrefixSafe(analysis));
    if (analysis.rowType) {
      rowTypeNames.set(analysis.key, dedupeName(`${base}Row`, usedRowTypes));
    }
    if (analysis.procedure.parameters.some((parameter) => !parameter.isOutput)) {
      paramsClassNames.set(analysis.key, dedupeName(`${base}Params`, usedParams));
    }
  }

  const outputTypeNames = new Map<string, string>();
  const resultTypeNames = new Map<string, string>();
  const outputFields = new Map<string, OutputField[]>();
  const usedOutputTypes = new Set<string>();
  const usedResultTypes = new Set<string>();
  for (const analysis of supported) {
    if (analysis.outputParams.length === 0) {
      continue;
    }
    const base = toPascal(stripPrefixSafe(analysis));
    outputTypeNames.set(analysis.key, dedupeName(`${base}Output`, usedOutputTypes));
    resultTypeNames.set(analysis.key, dedupeName(`${base}Result`, usedResultTypes));
    const usedProperties = new Set<string>();
    outputFields.set(
      analysis.key,
      analysis.outputParams.map((parameter) => {
        const mapped = tsRowType(parameter);
        return {
          name: parameter.name,
          property: dedupeName(safeIdentifier(parameter.name, 'output'), usedProperties),
          type: mapped === 'unknown' ? mapped : `${mapped} | null`,
        };
      }),
    );
  }

  // ---- tables that need a repository --------------------------------------
  interface RepositoryPlan {
    key: string;
    schema: string;
    name: string;
    className: string;
    entityName: string | null;
    definition: TableDefinition | null;
    /** File name stem; schema-qualified when two tables share a name. */
    fileBase: string;
    analyses: Analysis[];
  }

  const repositoryPlans = new Map<string, RepositoryPlan>();
  const ensureRepository = (analysis: Analysis, schema: string, name: string): RepositoryPlan => {
    const key = `${schema}.${name}`.toLowerCase();
    const existing = repositoryPlans.get(key);
    if (existing) {
      return existing;
    }
    const definition = tableByName.get(key) ?? null;
    const classBase = toPascal(name);
    const clash = [...repositoryPlans.values()].some((plan) => plan.className === `${classBase}Repository`);
    const className = dedupeName(
      clash ? `${toPascal(schema)}${classBase}Repository` : `${classBase}Repository`,
      usedRepos,
    );
    let entityName: string | null = null;
    if (definition && definition.primaryKey.length > 0) {
      entityName = dedupeName(
        clash ? `${toPascal(schema)}${classBase}` : classBase,
        usedEntities,
      );
    }
    const plan: RepositoryPlan = {
      key,
      schema,
      name,
      className,
      entityName,
      definition,
      fileBase: toKebab(name),
      analyses: [],
    };
    repositoryPlans.set(key, plan);
    plan.analyses.push(analysis);
    return plan;
  };

  for (const analysis of supported) {
    for (const table of analysis.tables) {
      ensureRepository(analysis, table.schema, table.name);
    }
  }

  // Two schemas can hold a table with the same name; keep their files apart.
  // The first table keeps the plain name, later ones get a schema prefix.
  const usedFileBases = new Set<string>();
  for (const plan of [...repositoryPlans.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    let base = plan.fileBase;
    if (usedFileBases.has(base)) {
      base = `${toKebab(plan.schema)}-${toKebab(plan.name)}`;
      let suffix = 2;
      while (usedFileBases.has(base)) {
        base = `${toKebab(plan.schema)}-${toKebab(plan.name)}-${suffix}`;
        suffix += 1;
      }
    }
    usedFileBases.add(base);
    plan.fileBase = base;
  }

  const entityNames = new Map<string, string>();
  const entityFiles = new Map<string, string>();
  for (const plan of repositoryPlans.values()) {
    if (plan.entityName) {
      entityNames.set(plan.key, plan.entityName);
      entityFiles.set(plan.key, plan.fileBase);
    }
  }

  // ---- rows ---------------------------------------------------------------
  const rowEntries: Array<{ name: string; columns: Array<{ property: string; type: string }> }> = [];
  for (const analysis of supported) {
    const rowName = rowTypeNames.get(analysis.key);
    const columns = analysis.procedure.resultColumns;
    if (!rowName || !columns) {
      continue;
    }
    const used = new Set<string>();
    rowEntries.push({
      name: rowName,
      columns: columns.map((column) => {
        const base = tsRowType(column);
        return {
          property: dedupeName(renderPropertyName(column.name), used),
          type: column.isNullable && base !== 'unknown' ? `${base} | null` : base,
        };
      }),
    });
  }

  if (rowEntries.length > 0) {
    const body = rowEntries
      .map((entry) => {
        const fields = entry.columns
          .map((column) => `  ${column.property}: ${column.type};`)
          .join('\n');
        return `export interface ${entry.name} {\n${fields}\n}`;
      })
      .join('\n\n');
    files.push({
      path: 'src/rows.generated.ts',
      content: `// Generated by convert-sp. Regenerated on every run.\n\n${body}\n`,
    });
  }

  // ---- output envelopes ---------------------------------------------------
  if (resultTypeNames.size > 0) {
    const blocks: string[] = [];
    const usedRowTypes = new Set<string>();
    for (const analysis of supported) {
      const outputName = outputTypeNames.get(analysis.key);
      const resultName = resultTypeNames.get(analysis.key);
      if (!outputName || !resultName) {
        continue;
      }
      const fields = (outputFields.get(analysis.key) ?? []).map(
        (field) => `  ${field.property}: ${field.type};`,
      );
      blocks.push(`export interface ${outputName} {\n${fields.join('\n')}\n}`);
      const rowType = rowTypeNames.get(analysis.key) ?? 'unknown';
      if (rowType !== 'unknown') {
        usedRowTypes.add(rowType);
      }
      blocks.push(
        `export interface ${resultName} {\n  rows: ${rowType}[];\n  output: ${outputName};\n}`,
      );
    }
    const rowImport =
      usedRowTypes.size > 0
        ? `import type { ${[...usedRowTypes].join(', ')} } from './rows.generated';\n\n`
        : '';
    files.push({
      path: 'src/results.generated.ts',
      content: `// Generated by convert-sp. Regenerated on every run.\n\n${rowImport}${blocks.join('\n\n')}\n`,
    });
  }

  // ---- params DTOs --------------------------------------------------------
  const paramEntries: Array<{ name: string; params: SqlParameter[] }> = [];
  for (const analysis of supported) {
    const className = paramsClassNames.get(analysis.key);
    if (!className) {
      continue;
    }
    const params = analysis.procedure.parameters.filter((parameter) => !parameter.isOutput);
    if (params.length === 0) {
      continue;
    }
    paramEntries.push({ name: className, params });
  }

  if (paramEntries.length > 0) {
    const usedImports = new Set<string>();
    const classBodies = paramEntries.map((entry) => {
      const usedNames = new Set<string>();
      const optionalAll = entry.params.every((parameter) => parameter.hasDefault);
      const fields = entry.params.map((parameter) => {
        const prop = dedupeName(safeIdentifier(parameter.name, 'param'), usedNames);
        const rules = validationRules(parameter);
        const lines: string[] = [];
        if (parameter.hasDefault) {
          lines.push('@IsOptional()');
          usedImports.add('IsOptional');
        }
        for (const rule of rules) {
          if (rule.transform) {
            lines.push(rule.transform);
            if (rule.transform.includes('@Type(')) {
              usedImports.add('Type');
            }
            if (rule.transform.includes('@Transform(')) {
              usedImports.add('Transform');
            }
          }
          lines.push(rule.decorator);
          for (const name of rule.imports) {
            usedImports.add(name);
          }
        }
        const optionalMark = optionalAll || parameter.hasDefault ? '?' : '!';
        lines.push(`${prop}${optionalMark}: ${tsInputType(parameter)};`);
        return lines.map((line) => `  ${line}`).join('\n');
      });
      return `export class ${entry.name} {\n${fields.join('\n\n')}\n}`;
    });

    const validatorImports = [...usedImports].sort().join(', ');
    const header = [
      '// Generated by convert-sp. Regenerated on every run.',
      "import { Transform, Type } from 'class-transformer';",
      `import { ${[...usedImports].filter((name) => name !== 'Type' && name !== 'Transform').sort().join(', ')} } from 'class-validator';`,
      '',
    ].join('\n');

    files.push({
      path: 'src/dto/params.generated.ts',
      content: `${header}\n${classBodies.join('\n\n')}\n`,
    });
    if (validatorImports.length === 0) {
      files.push({ path: 'src/dto/.keep', content: '' });
    }
  }

  // ---- public type surface ------------------------------------------------
  // One import path for callers that need row shapes, params classes or output envelopes.
  const barrel = ['// Generated by convert-sp. Regenerated on every run.'];
  if (rowEntries.length > 0) {
    barrel.push("export * from './rows.generated';");
  }
  if (resultTypeNames.size > 0) {
    barrel.push("export * from './results.generated';");
  }
  if (paramEntries.length > 0) {
    barrel.push("export * from './dto/params.generated';");
  }
  files.push({ path: 'src/api.generated.ts', content: `${barrel.join('\n')}\n` });

  // ---- entities -----------------------------------------------------------
  const entityEntries: Array<{ className: string; fileBase: string }> = [];
  for (const plan of repositoryPlans.values()) {
    if (!plan.entityName || !plan.definition) {
      continue;
    }
    entityEntries.push({ className: plan.entityName, fileBase: plan.fileBase });
    files.push({
      path: `src/database/entities/${plan.fileBase}.entity.ts`,
      content: renderEntity(plan.entityName, plan.definition),
    });
  }

  if (entityEntries.length > 0) {
    const exports = entityEntries
      .map((entry) => `import { ${entry.className} } from './${entry.fileBase}.entity';`)
      .join('\n');
    const list = entityEntries.map((entry) => `  ${entry.className},`).join('\n');
    files.push({
      path: 'src/database/entities/index.ts',
      content: `${exports}\n\nexport const entities = [\n${list}\n];\n`,
    });
  } else {
    files.push({
      path: 'src/database/entities/index.ts',
      content: 'export const entities: never[] = [];\n',
    });
  }

  // ---- infrastructure -----------------------------------------------------
  files.push({ path: 'src/database/base.repository.ts', content: renderBaseRepository() });
  files.push({
    path: 'src/database/database.module.ts',
    content: renderDatabaseModule(),
  });
  files.push({ path: 'src/common/sql-exception.filter.ts', content: renderExceptionFilter() });
  files.push({ path: 'src/common/audit.interceptor.ts', content: renderAuditInterceptor() });

  // ---- repositories -------------------------------------------------------
  const methodNamesByRepository = new Map<string, Set<string>>();
  const renderedRepositories: Array<{ className: string; path: string; tableKey: string }> = [];

  for (const plan of [...repositoryPlans.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const used = new Set<string>();
    methodNamesByRepository.set(plan.key, used);
    const methods = buildMethods(
      supported.filter((analysis) => {
        if (analysis.destination.kind !== 'repository') {
          return false;
        }
        return (
          `${analysis.destination.table.schema}.${analysis.destination.table.name}`.toLowerCase() ===
          plan.key
        );
      }),
      paramsClassNames,
      rowTypeNames,
      outputTypeNames,
      resultTypeNames,
      used,
    );
    const path = `src/database/repositories/${plan.fileBase}.repository.ts`;
    files.push({
      path,
      content: renderRepository(
        plan.className,
        plan.entityName,
        plan.definition,
        plan.fileBase,
        methods,
        entityNames,
        entityFiles,
      ),
    });
    renderedRepositories.push({ className: plan.className, path, tableKey: plan.key });
  }

  const repositoryImports = new Map<string, string>(
    renderedRepositories.map((repo) => [
      repo.className,
      repo.path.replace(/^src\//, '../').replace(/\.ts$/, ''),
    ]),
  );

  // ---- multitable services ------------------------------------------------
  const services: Array<{
    className: string;
    path: string;
    base: string;
    analyses: Analysis[];
    repositoryClassNames: string[];
  }> = [];

  const multitableGroups = new Map<string, Analysis[]>();
  for (const analysis of supported) {
    if (analysis.destination.kind !== 'multitable') {
      continue;
    }
    const list = multitableGroups.get(analysis.destination.className) ?? [];
    list.push(analysis);
    multitableGroups.set(analysis.destination.className, list);
  }

  const usedServiceBases = new Set<string>();
  for (const [requestedName, analyses] of multitableGroups) {
    const className = dedupeName(requestedName, usedMultitable);
    const first = analyses[0] as Analysis;
    const base = dedupeName(toKebab(stripPrefixSafe(first)), usedServiceBases);
    const path = `src/multitable/${base}.multitable-service.ts`;
    const used = new Set<string>();
    const methods = buildMethods(
      analyses,
      paramsClassNames,
      rowTypeNames,
      outputTypeNames,
      resultTypeNames,
      used,
    );
    const tableKeys = new Set<string>();
    for (const analysis of analyses) {
      for (const table of analysis.tables) {
        tableKeys.add(`${table.schema}.${table.name}`.toLowerCase());
      }
    }
    const repositoryClassNames = [...tableKeys]
      .map((key) => repositoryPlans.get(key)?.className)
      .filter((value): value is string => Boolean(value))
      .sort();
    files.push({
      path,
      content: renderMultitableService(
        className,
        methods,
        repositoryClassNames,
        repositoryImports,
        entityNames,
        entityFiles,
      ),
    });
    services.push({ className, path, base, analyses, repositoryClassNames });
  }

  // ---- controllers --------------------------------------------------------
  for (const plan of [...repositoryPlans.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const analyses = supported.filter((analysis) => {
      if (analysis.destination.kind !== 'repository') {
        return false;
      }
      return (
        `${analysis.destination.table.schema}.${analysis.destination.table.name}`.toLowerCase() ===
        plan.key
      );
    });
    if (analyses.length === 0) {
      continue;
    }
    const controllerBase = `${plan.className.replace(/Repository$/, '')}Controller`;
    files.push({
      path: `src/controllers/${plan.fileBase}.controller.ts`,
      content: renderRepositoryController(
        controllerBase,
        toKebab(plan.name),
        plan.className,
        `../database/repositories/${plan.fileBase}.repository`,
        analyses,
        paramsClassNames,
        rowTypeNames,
        outputTypeNames,
        resultTypeNames,
      ),
    });
  }

  for (const service of services) {
    const base = service.base;
    files.push({
      path: `src/controllers/${base}.sp.controller.ts`,
      content: renderServiceController(
        `${toPascal(base)}SpController`,
        base,
        service.className,
        `../multitable/${service.base}.multitable-service`,
        service.analyses,
        paramsClassNames,
        rowTypeNames,
        outputTypeNames,
        resultTypeNames,
      ),
    });
  }

  // ---- module and bootstrap ----------------------------------------------
  const controllerClasses = [
    ...[...repositoryPlans.values()]
      .filter((plan) =>
        supported.some(
          (analysis) =>
            analysis.destination.kind === 'repository' &&
            `${analysis.destination.table.schema}.${analysis.destination.table.name}`.toLowerCase() ===
              plan.key,
        ),
      )
      .map((plan) => ({
        className: `${plan.className.replace(/Repository$/, '')}Controller`,
        path: `./controllers/${plan.fileBase}.controller`,
      })),
    ...services.map((service) => ({
      className: `${toPascal(service.base)}SpController`,
      path: `./controllers/${service.base}.sp.controller`,
    })),
  ];

  const providerClasses = [
    ...[...repositoryPlans.values()].map((plan) => ({
      className: plan.className,
      path: `./database/repositories/${plan.fileBase}.repository`,
    })),
    ...services.map((service) => ({
      className: service.className,
      path: service.path.replace(/^src\//, './').replace(/\.ts$/, ''),
    })),
  ];

  files.push({
    path: 'src/app.module.ts',
    content: renderAppModule(controllerClasses, providerClasses),
  });
  files.push({ path: 'src/main.ts', content: renderMain() });
  files.push(...renderScaffold(input.projectName, input.database));

  return files;
}

function stripPrefixSafe(analysis: Analysis): string {
  const withoutPrefix = analysis.procedure.name.replace(/^\[?(usp|sp|proc)_/i, '');
  return withoutPrefix.length > 0 ? withoutPrefix : analysis.procedure.name;
}

function renderPropertyName(name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : `'${name.replace(/'/g, "\\'")}'`;
}

interface OutputField {
  /** Parameter name without the leading @. */
  name: string;
  /** camelCase property in the generated `...Output` interface. */
  property: string;
  /** TypeScript type, already nullable. */
  type: string;
}

interface BuiltMethod {
  name: string;
  signature: string;
  returnType: string;
  analysis: Analysis;
  paramsClass: string | null;
  usesParamsObject: boolean;
  paramNames: string[];
  rowType: string | null;
  /** Named `...Result` envelope when the procedure declares OUTPUT parameters. */
  resultType: string | null;
  /** Named `...Output` interface holding the OUTPUT values. */
  outputType: string | null;
  /** True when the method returns `{ rows, output }` instead of a bare row array. */
  usesOutput: boolean;
  translation: ProcedureTranslation;
}

function buildMethods(
  analyses: Analysis[],
  paramsClassNames: Map<string, string>,
  rowTypeNames: Map<string, string>,
  outputTypeNames: Map<string, string>,
  resultTypeNames: Map<string, string>,
  usedNames: Set<string>,
): BuiltMethod[] {
  return analyses
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((analysis) => {
      const parameters = analysis.procedure.parameters.filter((parameter) => !parameter.isOutput);
      const usedParamNames = new Set<string>();
      const argNames = parameters.map((parameter) =>
        dedupeName(safeIdentifier(parameter.name, 'param'), usedParamNames),
      );
      // SQL Server requires every parameter after a defaulted one to have a default
      // too, so a single cut-off point keeps the TypeScript signature legal.
      const optionalFrom = parameters.findIndex((parameter) => parameter.hasDefault);
      const signatureParts = parameters.map((parameter, index) => {
        const mark = optionalFrom >= 0 && index >= optionalFrom ? '?' : '';
        return `${argNames[index]}${mark}: ${tsInputType(parameter)}`;
      });
      const paramsClass = paramsClassNames.get(analysis.key) ?? null;
      const usesParamsObject = analysis.paramsObject && paramsClass !== null;
      const rowType = rowTypeNames.get(analysis.key) ?? null;
      const resultType = resultTypeNames.get(analysis.key) ?? null;
      const outputType = outputTypeNames.get(analysis.key) ?? null;
      const returnType = resultType ? `Promise<${resultType}>` : `Promise<${rowType ?? 'unknown'}[]>`;
      const signature = usesParamsObject
        ? `params: ${paramsClass}`
        : signatureParts.join(', ');
      if (!analysis.translation) {
        throw new Error(`Procedure ${analysis.key} was not translated; run analyzeCatalog first.`);
      }
      return {
        name: dedupeName(analysis.methodName, usedNames),
        signature,
        returnType,
        analysis,
        paramsClass,
        usesParamsObject,
        paramNames: argNames,
        rowType,
        resultType,
        outputType,
        usesOutput: resultType !== null,
        translation: analysis.translation,
      };
    });
}

interface MethodContext {
  manager: string;
  entityNames: Map<string, string>;
}

function substituteTranslation(
  text: string,
  method: BuiltMethod,
  analysis: Analysis,
  context: MethodContext,
): string {
  const parameters = new Map<string, string>();
  analysis.procedure.parameters
    .filter((parameter) => !parameter.isOutput)
    .forEach((parameter, index) => {
      const key = parameter.name.replace(/^@/, '').toLowerCase();
      const name = method.paramNames[index] as string;
      parameters.set(key, method.usesParamsObject ? `params.${name}` : name);
    });

  return text
    .replace(/\{\{manager\}\}/g, context.manager)
    .replace(/\{\{row\}\}/g, method.rowType ?? 'unknown')
    .replace(/\{\{entity:([^}]+)\}\}/g, (_match, key: string) => {
      const entity = context.entityNames.get(key.trim().toLowerCase());
      if (!entity) {
        throw new Error(`No entity was generated for table ${key}.`);
      }
      return entity;
    })
    .replace(/\{\{param:([^}]+)\}\}/g, (_match, key: string) => {
      return parameters.get(key.trim().toLowerCase()) ?? key;
    });
}

function renderMethod(
  method: BuiltMethod,
  analysis: Analysis,
  context: MethodContext,
): string {
  const body = method.translation.lines
    .map((line) => substituteTranslation(line, method, analysis, context))
    .map((line) => (line.length > 0 ? `    ${line}` : ''))
    .join('\n');
  return `  async ${method.name}(${method.signature}): ${method.returnType} {\n${body}\n  }`;
}

function entityImportLines(
  methods: BuiltMethod[],
  entityNames: Map<string, string>,
  entityFiles: Map<string, string>,
  prefix: string,
  exclude = new Set<string>(),
): string[] {
  const keys = [...new Set(methods.flatMap((method) => method.translation.entityTables))];
  const lines: string[] = [];
  for (const key of keys.sort()) {
    const name = entityNames.get(key);
    const file = entityFiles.get(key);
    if (!name || !file || exclude.has(name)) {
      continue;
    }
    lines.push(`import { ${name} } from '${prefix}/${file}.entity';`);
  }
  return lines;
}

function renderRepository(
  className: string,
  entityName: string | null,
  definition: TableDefinition | null,
  fileBase: string,
  methods: BuiltMethod[],
  entityNames: Map<string, string>,
  entityFiles: Map<string, string>,
): string {
  const imports: string[] = [];
  imports.push("import { Injectable } from '@nestjs/common';");
  imports.push("import { DataSource } from 'typeorm';");

  const builtMethods = methods;
  const rowTypes = [
    ...new Set(
      builtMethods
        .map((method) => method.rowType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (rowTypes.length > 0) {
    imports.push(`import type { ${rowTypes.join(', ')} } from '../../rows.generated';`);
  }
  const resultTypes = [
    ...new Set(
      builtMethods
        .map((method) => [method.resultType, method.outputType])
        .flat()
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (resultTypes.length > 0) {
    imports.push(`import type { ${resultTypes.join(', ')} } from '../../results.generated';`);
  }

  const dtoClasses = [
    ...new Set(
      builtMethods
        .filter((method) => method.usesParamsObject && method.paramsClass)
        .map((method) => method.paramsClass as string),
    ),
  ];
  if (dtoClasses.length > 0) {
    imports.push(`import { ${dtoClasses.join(', ')} } from '../../dto/params.generated';`);
  }

  if (entityName && definition) {
    imports.push("import { InjectRepository } from '@nestjs/typeorm';");
    imports.push("import { Repository } from 'typeorm';");
    imports.push("import { BaseRepository } from '../base.repository';");
    imports.push(`import { ${entityName} } from '../entities/${fileBase}.entity';`);
    imports.push(
      ...entityImportLines(
        methods,
        entityNames,
        entityFiles,
        '../entities',
        new Set([entityName]),
      ),
    );

    const methodText = methods
      .map((entry) =>
        renderMethod(entry, entry.analysis, {
          manager: 'this.manager',
          entityNames,
        }),
      )
      .join('\n\n');
    const generatedBlock = `  // @generated:start\n${methodText}\n  // @generated:end`;

    return `${imports.join('\n')}

@Injectable()
export class ${className} extends BaseRepository<${entityName}> {
  constructor(
    @InjectRepository(${entityName}) repository: Repository<${entityName}>,
    dataSource: DataSource,
  ) {
    super(repository, dataSource);
  }

${generatedBlock}
}
`;
  }

  const methodText = methods
    .map((entry) =>
      renderMethod(entry, entry.analysis, {
        manager: 'this.dataSource.manager',
        entityNames,
      }),
    )
    .join('\n\n');
  const generatedBlock = `  // @generated:start\n${methodText}\n  // @generated:end`;

  imports.push(...entityImportLines(methods, entityNames, entityFiles, '../entities'));

  return `${imports.join('\n')}

@Injectable()
export class ${className} {
  constructor(private readonly dataSource: DataSource) {}

${generatedBlock}
}
`;
}

function renderMultitableService(
  className: string,
  methods: BuiltMethod[],
  repositoryClassNames: string[],
  repositoryImports: Map<string, string>,
  entityNames: Map<string, string>,
  entityFiles: Map<string, string>,
): string {
  const imports = [
    "import { Injectable } from '@nestjs/common';",
    "import { DataSource } from 'typeorm';",
  ];

  const repositoryParams = repositoryClassNames.map(
    (name) => `    private readonly ${lowerFirst(name)}: ${name},`,
  );

  for (const name of repositoryClassNames) {
    const importPath = repositoryImports.get(name);
    if (importPath) {
      imports.push(`import { ${name} } from '${importPath}';`);
    }
  }

  const builtMethods = methods;
  const rowTypes = [
    ...new Set(
      builtMethods
        .map((method) => method.rowType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (rowTypes.length > 0) {
    imports.push(`import type { ${rowTypes.join(', ')} } from '../rows.generated';`);
  }
  const resultTypes = [
    ...new Set(
      builtMethods
        .map((method) => [method.resultType, method.outputType])
        .flat()
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (resultTypes.length > 0) {
    imports.push(`import type { ${resultTypes.join(', ')} } from '../results.generated';`);
  }

  const dtoClasses = [
    ...new Set(
      builtMethods
        .filter((method) => method.usesParamsObject && method.paramsClass)
        .map((method) => method.paramsClass as string),
    ),
  ];
  if (dtoClasses.length > 0) {
    imports.push(`import { ${dtoClasses.join(', ')} } from '../dto/params.generated';`);
  }

  const methodText = methods
    .map((entry) =>
      renderMethod(entry, entry.analysis, {
        manager: 'this.dataSource.manager',
        entityNames,
      }),
    )
    .join('\n\n');

  imports.push(...entityImportLines(methods, entityNames, entityFiles, '../database/entities'));

  return `${imports.join('\n')}

@Injectable()
export class ${className} {
  constructor(
${repositoryParams.join('\n')}
    private readonly dataSource: DataSource,
  ) {}

${methodText}
}
`;
}

function lowerFirst(value: string): string {
  return value.charAt(0).toLowerCase() + value.slice(1);
}

interface ControllerMethod {
  analysis: Analysis;
  method: BuiltMethod;
  httpVerb: 'get' | 'post' | 'delete';
  route: string;
  paramBinding: 'none' | 'query' | 'body';
  paramsClass: string | null;
}

function buildControllerMethods(
  analyses: Analysis[],
  paramsClassNames: Map<string, string>,
  rowTypeNames: Map<string, string>,
  outputTypeNames: Map<string, string>,
  resultTypeNames: Map<string, string>,
): ControllerMethod[] {
  const used = new Set<string>();
  const usedRoutes = new Set<string>();
  const result: ControllerMethod[] = [];

  for (const analysis of [...analyses].sort((a, b) => a.key.localeCompare(b.key))) {
    const methods = buildMethods(
      [analysis],
      paramsClassNames,
      rowTypeNames,
      outputTypeNames,
      resultTypeNames,
      used,
    );
    const method = methods[0] as BuiltMethod;
    const parameterCount = analysis.procedure.parameters.filter((p) => !p.isOutput).length;

    let httpVerb: 'get' | 'post' | 'delete' = analysis.verb;
    let route = analysis.routePath;
    if (analysis.verb === 'delete' && analysis.paramsObject) {
      httpVerb = 'post';
      route = route.length > 0 ? `delete-${route}` : 'delete';
    }
    const dedupedRoute = dedupeName(route.length > 0 ? route : 'run', usedRoutes);
    const paramBinding: 'none' | 'query' | 'body' =
      parameterCount === 0 ? 'none' : httpVerb === 'get' || httpVerb === 'delete' ? 'query' : 'body';

    result.push({
      analysis,
      method,
      httpVerb,
      route: dedupedRoute === 'run' && route.length === 0 ? '' : dedupedRoute,
      paramBinding,
      paramsClass: paramsClassNames.get(analysis.key) ?? null,
    });
  }
  return result;
}

function renderRepositoryController(
  className: string,
  baseRoute: string,
  repositoryClass: string,
  repositoryImport: string,
  analyses: Analysis[],
  paramsClassNames: Map<string, string>,
  rowTypeNames: Map<string, string>,
  outputTypeNames: Map<string, string>,
  resultTypeNames: Map<string, string>,
): string {
  const entries = buildControllerMethods(
    analyses,
    paramsClassNames,
    rowTypeNames,
    outputTypeNames,
    resultTypeNames,
  );
  const methods = entries.map((entry) => {
    const { method, httpVerb, route, paramBinding, paramsClass } = entry;
    const decorator = httpVerb === 'get' ? 'Get' : httpVerb === 'post' ? 'Post' : 'Delete';
    const routeArgument = route.length > 0 ? `(${q(route)})` : '()';
    const args: string[] = [];
    if (paramBinding === 'query' && paramsClass) {
      args.push(`@Query() query: ${paramsClass}`);
    }
    if (paramBinding === 'body' && paramsClass) {
      args.push(`@Body() body: ${paramsClass}`);
    }
    const forwarded =
      paramBinding === 'none'
        ? ''
        : method.usesParamsObject
          ? paramBinding === 'query'
            ? 'query'
            : 'body'
          : method.paramNames
              .map((name) => `${paramBinding === 'query' ? 'query' : 'body'}.${name}`)
              .join(', ');
    return `  @${decorator}${routeArgument}
  ${method.name}(${args.join(', ')}): ${method.returnType} {
    return this.repository.${method.name}(${forwarded});
  }`;
  });

  const verbs = new Set(entries.map((entry) => entry.httpVerb));
  const nestImports = ['Controller'];
  if (verbs.has('get')) nestImports.push('Get');
  if (verbs.has('post')) nestImports.push('Post');
  if (verbs.has('delete')) nestImports.push('Delete');
  if (entries.some((entry) => entry.paramBinding === 'query')) nestImports.push('Query');
  if (entries.some((entry) => entry.paramBinding === 'body')) nestImports.push('Body');

  const dtoClasses = [
    ...new Set(
      entries
        .map((entry) => entry.paramsClass)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  const imports = [
    `import { ${nestImports.join(', ')} } from '@nestjs/common';`,
    `import { ${repositoryClass} } from '${repositoryImport}';`,
  ];
  if (dtoClasses.length > 0) {
    imports.push(`import { ${dtoClasses.join(', ')} } from '../dto/params.generated';`);
  }
  const rowTypes = [
    ...new Set(
      entries
        .filter((entry) => !entry.method.usesOutput)
        .map((entry) => entry.method.rowType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (rowTypes.length > 0) {
    imports.push(`import type { ${rowTypes.join(', ')} } from '../rows.generated';`);
  }
  const resultTypes = [
    ...new Set(
      entries
        .map((entry) => entry.method.resultType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (resultTypes.length > 0) {
    imports.push(`import type { ${resultTypes.join(', ')} } from '../results.generated';`);
  }

  return `${imports.join('\n')}

@Controller(${q(baseRoute)})
export class ${className} {
  constructor(private readonly repository: ${repositoryClass}) {}

${methods.join('\n\n')}
}
`;
}

function renderServiceController(
  className: string,
  baseRoute: string,
  serviceClass: string,
  serviceImport: string,
  analyses: Analysis[],
  paramsClassNames: Map<string, string>,
  rowTypeNames: Map<string, string>,
  outputTypeNames: Map<string, string>,
  resultTypeNames: Map<string, string>,
): string {
  const entries = buildControllerMethods(
    analyses,
    paramsClassNames,
    rowTypeNames,
    outputTypeNames,
    resultTypeNames,
  );
  const methods = entries.map((entry) => {
    const { method, httpVerb, route, paramBinding, paramsClass } = entry;
    const decorator = httpVerb === 'get' ? 'Get' : httpVerb === 'post' ? 'Post' : 'Delete';
    const routeArgument = route.length > 0 ? `(${q(route)})` : '()';
    const args: string[] = [];
    if (paramBinding === 'query' && paramsClass) {
      args.push(`@Query() query: ${paramsClass}`);
    }
    if (paramBinding === 'body' && paramsClass) {
      args.push(`@Body() body: ${paramsClass}`);
    }
    const forwarded =
      paramBinding === 'none'
        ? ''
        : method.usesParamsObject
          ? paramBinding === 'query'
            ? 'query'
            : 'body'
          : method.paramNames
              .map((name) => `${paramBinding === 'query' ? 'query' : 'body'}.${name}`)
              .join(', ');
    return `  @${decorator}${routeArgument}
  ${method.name}(${args.join(', ')}): ${method.returnType} {
    return this.service.${method.name}(${forwarded});
  }`;
  });

  const verbs = new Set(entries.map((entry) => entry.httpVerb));
  const nestImports = ['Controller'];
  if (verbs.has('get')) nestImports.push('Get');
  if (verbs.has('post')) nestImports.push('Post');
  if (verbs.has('delete')) nestImports.push('Delete');
  if (entries.some((entry) => entry.paramBinding === 'query')) nestImports.push('Query');
  if (entries.some((entry) => entry.paramBinding === 'body')) nestImports.push('Body');

  const dtoClasses = [
    ...new Set(entries.map((entry) => entry.paramsClass).filter((value): value is string => Boolean(value))),
  ];
  const imports = [
    `import { ${nestImports.join(', ')} } from '@nestjs/common';`,
    `import { ${serviceClass} } from '${serviceImport}';`,
  ];
  if (dtoClasses.length > 0) {
    imports.push(`import { ${dtoClasses.join(', ')} } from '../dto/params.generated';`);
  }
  const rowTypes = [
    ...new Set(
      entries
        .filter((entry) => !entry.method.usesOutput)
        .map((entry) => entry.method.rowType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (rowTypes.length > 0) {
    imports.push(`import type { ${rowTypes.join(', ')} } from '../rows.generated';`);
  }
  const resultTypes = [
    ...new Set(
      entries
        .map((entry) => entry.method.resultType)
        .filter((value): value is string => Boolean(value)),
    ),
  ];
  if (resultTypes.length > 0) {
    imports.push(`import type { ${resultTypes.join(', ')} } from '../results.generated';`);
  }

  return `${imports.join('\n')}

@Controller(${q(baseRoute)})
export class ${className} {
  constructor(private readonly service: ${serviceClass}) {}

${methods.join('\n\n')}
}
`;
}

function renderEntity(className: string, definition: TableDefinition): string {
  const properties = entityPropertyNames(definition);
  const fields: string[] = [];
  const singleIdentity =
    definition.primaryKey.length === 1 &&
    definition.columns.some(
      (column) =>
        column.isIdentity &&
        column.name.toLowerCase() === (definition.primaryKey[0] as string).toLowerCase(),
    );

  for (const column of definition.columns) {
    if (column.isComputed) {
      continue;
    }
    const property =
      properties.get(column.name.toLowerCase()) ?? safeIdentifier(column.name, 'column');
    const isPk = definition.primaryKey.some(
      (key) => key.toLowerCase() === column.name.toLowerCase(),
    );
    const type = entityColumnType(column);
    const options: string[] = [`type: ${q(type.type)}`, `name: ${q(column.name)}`];
    if (type.length !== undefined) {
      options.push(`length: ${type.length}`);
    }
    if (type.precision !== undefined) {
      options.push(`precision: ${type.precision}`, `scale: ${type.scale ?? 0}`);
    }
    if (!isPk && column.isNullable) {
      options.push('nullable: true');
    }
    const care = column.isNullable ? ' | null' : '';

    if (isPk && singleIdentity) {
      fields.push(`  @PrimaryGeneratedColumn({ ${options.join(', ')} })\n  ${property}!: ${tsEntityType(column)}${care};`);
    } else if (isPk) {
      fields.push(`  @PrimaryColumn({ ${options.join(', ')} })\n  ${property}!: ${tsEntityType(column)}${care};`);
    } else {
      fields.push(`  @Column({ ${options.join(', ')} })\n  ${property}!: ${tsEntityType(column)}${care};`);
    }
  }

  return `// Generated by convert-sp. Regenerated on every run.
import { Column, Entity, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity({ name: ${q(definition.name)}, schema: ${q(definition.schema)} })
export class ${className} {
${fields.join('\n\n')}
}
`;
}

function renderBaseRepository(): string {
  return `import { DataSource, EntityManager, ObjectLiteral, Repository } from 'typeorm';

export abstract class BaseRepository<T extends ObjectLiteral> {
  protected constructor(
    protected readonly repository: Repository<T>,
    protected readonly dataSource: DataSource,
  ) {}

  /** TypeORM repository for ordinary CRUD on the table. */
  get delegate(): Repository<T> {
    return this.repository;
  }

  /** Entity manager used for query-builder calls inside generated methods. */
  protected get manager(): EntityManager {
    return this.dataSource.manager;
  }
}
`;
}

function renderDatabaseModule(): string {
  return `import { Global, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { entities } from './entities';

interface DbSettings {
  server: string;
  port: number;
  user: string;
  password: string;
  database: string;
  encrypt: boolean;
  trustServerCertificate: boolean;
}

/** Reads the DB_* environment variables with safe fallbacks. */
function readSettings(config: ConfigService): DbSettings {
  return {
    server: config.get<string>('DB_SERVER') ?? 'localhost',
    port: Number(config.get<string>('DB_PORT') ?? '1433'),
    user: config.get<string>('DB_USER') ?? '',
    password: config.get<string>('DB_PASSWORD') ?? '',
    database: config.get<string>('DB_NAME') ?? '',
    encrypt: (config.get<string>('DB_ENCRYPT') ?? 'true') === 'true',
    trustServerCertificate:
      (config.get<string>('DB_TRUST_SERVER_CERTIFICATE') ?? 'false') === 'true',
  };
}

@Global()
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const settings = readSettings(config);
        return {
          type: 'mssql' as const,
          host: settings.server,
          port: settings.port,
          username: settings.user,
          password: settings.password,
          database: settings.database,
          entities,
          synchronize: false,
          options: {
            encrypt: settings.encrypt,
            trustServerCertificate: settings.trustServerCertificate,
          },
        };
      },
    }),
  ],
})
export class DatabaseModule {}
`;
}

function renderExceptionFilter(): string {
  return `import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';

interface SqlServerError {
  number?: number;
  message?: string;
}

/** Maps common SQL Server error numbers onto HTTP responses. */
@Catch()
export class SqlExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(SqlExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse();
    const error = exception as SqlServerError;
    const number = error?.number;

    const status = this.statusFor(number);
    if (status === null) {
      const httpException = exception as { getStatus?: () => number; message?: string };
      if (typeof httpException?.getStatus === 'function') {
        response.status(httpException.getStatus()).send(exception);
        return;
      }
      this.logger.error(exception instanceof Error ? exception.stack : String(exception));
      response.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: 'Internal server error',
      });
      return;
    }

    response.status(status.status).json({
      statusCode: status.status,
      message: error.message ?? status.message,
      error: status.error,
    });
  }

  private statusFor(number?: number): { status: number; error: string; message: string } | null {
    switch (number) {
      case 547:
        return { status: HttpStatus.CONFLICT, error: 'Conflict', message: 'The operation violates a foreign key constraint.' };
      case 2627:
      case 2601:
        return { status: HttpStatus.CONFLICT, error: 'Conflict', message: 'The operation violates a unique constraint.' };
      case 515:
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A required value was not supplied.' };
      case 8152:
      case 2628:
        return { status: HttpStatus.BAD_REQUEST, error: 'Bad Request', message: 'A value was truncated because it exceeds the column length.' };
      case 50000:
        return { status: HttpStatus.UNPROCESSABLE_ENTITY, error: 'Unprocessable Entity', message: 'The database rejected the request.' };
      default:
        return null;
    }
  }
}
`;
}

function renderAuditInterceptor(): string {
  return `import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';

/** Emits one audit line per mutating procedure call. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('Audit');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest();
    const method: string = request?.method ?? 'GET';
    if (method === 'GET') {
      return next.handle();
    }
    const started = Date.now();
    return next.handle().pipe(
      tap({
        next: (rows) => {
          const count = Array.isArray(rows) ? rows.length : 0;
          this.logger.log(
            \`\${method} \${request?.url} rows=\${count} ms=\${Date.now() - started}\`,
          );
        },
        error: (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.logger.warn(\`\${method} \${request?.url} failed: \${message}\`);
        },
      }),
    );
  }
}
`;
}

function renderAppModule(
  controllers: Array<{ className: string; path: string }>,
  providers: Array<{ className: string; path: string }>,
): string {
  const imports = [
    "import { Module } from '@nestjs/common';",
    "import { TypeOrmModule } from '@nestjs/typeorm';",
    "import { DatabaseModule } from './database/database.module';",
    "import { entities } from './database/entities';",
  ];
  if (controllers.length > 0) {
    for (const item of controllers) {
      imports.push(`import { ${item.className} } from '${item.path}';`);
    }
  }
  for (const item of providers) {
    imports.push(`import { ${item.className} } from '${item.path}';`);
  }

  return `${imports.join('\n')}

@Module({
  imports: [DatabaseModule, TypeOrmModule.forFeature(entities)],
  controllers: [${controllers.map((item) => item.className).join(', ')}],
  providers: [${providers.map((item) => item.className).join(', ')}],
})
export class AppModule {}
`;
}

function renderMain(): string {
  return `import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AuditInterceptor } from './common/audit.interceptor';
import { SqlExceptionFilter } from './common/sql-exception.filter';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new SqlExceptionFilter());
  app.useGlobalInterceptors(new AuditInterceptor());
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
`;
}

function renderScaffold(projectName: string, database: string): GeneratedFile[] {
  const packageJson = {
    name: projectName,
    version: '0.1.0',
    private: true,
    scripts: {
      build: 'nest build',
      start: 'nest start',
      'start:dev': 'nest start --watch',
      'start:prod': 'node dist/main',
      typecheck: 'tsc --noEmit',
    },
    dependencies: {
      '@nestjs/common': '^11.0.0',
      '@nestjs/config': '^4.0.0',
      '@nestjs/core': '^11.0.0',
      '@nestjs/platform-express': '^11.0.0',
      '@nestjs/typeorm': '^11.0.0',
      'class-transformer': '^0.5.1',
      'class-validator': '^0.14.1',
      mssql: '^12.0.0',
      'reflect-metadata': '^0.2.2',
      rxjs: '^7.8.1',
      typeorm: '^0.3.20',
    },
    devDependencies: {
      '@nestjs/cli': '^11.0.0',
      '@nestjs/schematics': '^11.0.0',
      '@types/express': '^5.0.0',
      '@types/node': '^22.0.0',
      typescript: '^5.7.0',
      'ts-node': '^10.9.2',
      'tsconfig-paths': '^4.2.0',
    },
  };

  const tsconfig = {
    compilerOptions: {
      module: 'commonjs',
      declaration: true,
      removeComments: true,
      emitDecoratorMetadata: true,
      experimentalDecorators: true,
      allowSyntheticDefaultImports: true,
      target: 'ES2022',
      sourceMap: true,
      outDir: './dist',
      incremental: true,
      skipLibCheck: true,
      strict: true,
      strictPropertyInitialization: false,
      forceConsistentCasingInFileNames: true,
    },
    include: ['src/**/*.ts'],
  };

  const env = `DB_SERVER=localhost
DB_PORT=1433
DB_NAME=${database}
DB_USER=sa
DB_PASSWORD=change-me
DB_ENCRYPT=true
DB_TRUST_SERVER_CERTIFICATE=true
PORT=3000
`;

  const readme = `# ${projectName}

Generated by convert-sp from the \`${database}\` database.

## Setup

\`\`\`bash
npm install
cp .env.example .env   # fill in the real credentials
npm run start:dev
\`\`\`

## Layout

- \`src/database/repositories\` â€” one repository per table; procedures that touch a single
  table become methods on that table's repository.
- \`src/multitable\` â€” procedures that touch more than one table, with each repository injected.
- \`src/controllers\` â€” HTTP routes. \`get\` procedures use GET, \`post\` use POST, \`delete\` use
  DELETE (or POST when more than six parameters are required).
- \`src/dto/params.generated.ts\` â€” validated parameter classes.
- \`src/rows.generated.ts\` â€” result-set row interfaces.
- \`src/results.generated.ts\` â€” \`...Output\` and \`...Result\` interfaces for procedures with
  OUTPUT parameters. Such methods return \`{ rows, output }\` instead of a bare row array.
- \`src/api.generated.ts\` â€” barrel that re-exports rows, results and parameter classes.

Regenerating overwrites files between the \`@generated\` markers. Put hand-written methods
outside those markers.
`;

  return [
    { path: 'package.json', content: `${JSON.stringify(packageJson, null, 2)}\n` },
    { path: 'tsconfig.json', content: `${JSON.stringify(tsconfig, null, 2)}\n` },
    {
      path: 'tsconfig.build.json',
      content: `${JSON.stringify(
        { extends: './tsconfig.json', exclude: ['node_modules', 'test', 'dist', '**/*spec.ts'] },
        null,
        2,
      )}\n`,
    },
    {
      path: 'nest-cli.json',
      content: `${JSON.stringify(
        {
          $schema: 'https://json.schemastore.org/nest-cli',
          collection: '@nestjs/schematics',
          sourceRoot: 'src',
          compilerOptions: { deleteOutDir: true },
        },
        null,
        2,
      )}\n`,
    },
    { path: '.env.example', content: env },
    {
      path: '.gitignore',
      content: 'node_modules/\ndist/\n.env\n*.log\n',
    },
    { path: 'README.md', content: readme },
  ];
}
