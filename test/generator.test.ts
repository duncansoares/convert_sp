import { describe, expect, it } from 'vitest';
import { generateFiles } from '../src/core/generate/project.js';
import { analyzeCatalog } from '../src/core/pipeline.js';
import type { CatalogSnapshot, RawProcedure, TableDefinition } from '../src/core/types.js';

const database = 'Acme';

const customerTable: TableDefinition = {
  schema: 'dbo',
  name: 'Customer',
  primaryKey: ['Id'],
  columns: [
    {
      name: 'Id',
      propertyName: 'Id',
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isNullable: false,
      isIdentity: true,
      isComputed: false,
      hasDefault: false,
    },
    {
      name: 'Name',
      propertyName: 'Name',
      sqlType: 'nvarchar',
      maxLength: 200,
      precision: 0,
      scale: 0,
      isNullable: false,
      isIdentity: false,
      isComputed: false,
      hasDefault: false,
    },
  ],
};

const orderTable: TableDefinition = {
  schema: 'dbo',
  name: 'OrderHeader',
  primaryKey: ['Id'],
  columns: [
    {
      name: 'Id',
      propertyName: 'Id',
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isNullable: false,
      isIdentity: true,
      isComputed: false,
      hasDefault: false,
    },
  ],
};

function proc(name: string, definition: string, parameterCount = 0): RawProcedure {
  return {
    objectId: Math.floor(Math.random() * 10000),
    schema: 'dbo',
    name,
    definition,
    parameters: Array.from({ length: parameterCount }, (_, index) => ({
      name: index === 0 ? 'CustomerId' : `Param${index + 1}`,
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isOutput: false,
      hasDefault: false,
      defaultValue: null,
    })),
    resultColumns: [
      { name: 'Id', sqlType: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false },
    ],
    resultError: null,
  };
}

function generate(procedures: RawProcedure[]) {
  const catalog: CatalogSnapshot = {
    database,
    procedures,
    tables: [customerTable, orderTable],
  };
  const bundle = analyzeCatalog(catalog);
  const files = generateFiles({
    analyses: bundle.analyses.filter((analysis) => analysis.destination.kind !== 'skipped'),
    tables: bundle.tables,
    database,
    projectName: 'acme-api',
  });
  const read = (path: string): string => files.find((file) => file.path === path)?.content ?? '';
  return { files, read, bundle };
}

describe('generated project', () => {
  it('places single-table procedures on the table repository with a get prefix', () => {
    const { read } = generate([
      proc('usp_Customer_GetById', 'SELECT * FROM dbo.Customer WHERE Id = @CustomerId', 1),
    ]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain('export class CustomerRepository extends BaseRepository<Customer>');
    expect(repository).toContain('getCustomerById(customerId: number): Promise<CustomerGetByIdRow[]>');
    expect(repository).toContain('createQueryBuilder(Customer, ');
    expect(repository).toContain('where(\'Id = :p0\', { p0: customerId })');
    expect(repository).toContain('.getRawMany()');
    expect(repository).not.toContain('execute<');
  });

  it('exposes the method through a controller route', () => {
    const { read } = generate([
      proc('usp_Customer_GetById', 'SELECT * FROM dbo.Customer WHERE Id = @CustomerId', 1),
    ]);
    const controller = read('src/controllers/customer.controller.ts');
    expect(controller).toContain("@Controller('customer')");
    expect(controller).toContain("@Get('get-by-id')");
  });

  it('creates a multitable service when two tables are touched', () => {
    const { read } = generate([
      proc(
        'usp_Order_Create',
        'INSERT INTO dbo.OrderHeader (Id) VALUES (1); INSERT INTO dbo.Customer (Id) VALUES (1);',
      ),
    ]);
    const service = read('src/multitable/order-create.multitable-service.ts');
    expect(service).toContain('export class OrderCreateMultiTableService');
    expect(service).toContain('CustomerRepository');
    expect(service).toContain('OrderHeaderRepository');
  });

  it('uses a params class when a procedure has more than six parameters', () => {
    const { read } = generate([
      proc(
        'usp_Customer_Search',
        'SELECT * FROM dbo.Customer',
        7,
      ),
    ]);
    const repository = read('src/database/repositories/customer.repository.ts');
    const dto = read('src/dto/params.generated.ts');
    expect(repository).toContain('getCustomerSearch(params: CustomerSearchParams)');
    expect(dto).toContain('export class CustomerSearchParams');
    expect(dto).toContain('@IsInt()');
  });

  it('generates a delete prefix for delete-only procedures', () => {
    const { read } = generate([
      proc('usp_Customer_Delete', 'DELETE FROM dbo.Customer WHERE Id = @CustomerId', 1),
    ]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain('deleteCustomer(customerId: number)');
  });

  it('maps delete with more than six parameters to POST', () => {
    const { read } = generate([
      proc('usp_Customer_Purge', 'DELETE FROM dbo.Customer', 7),
    ]);
    const controller = read('src/controllers/customer.controller.ts');
    expect(controller).toContain("@Post('delete-purge')");
  });

  it('translates @parameters into bound query parameters', () => {
    const { read } = generate([
      proc('usp_Customer_GetById', 'SELECT * FROM dbo.Customer WHERE Id = @CustomerId', 1),
    ]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain(':p0');
    expect(repository).not.toContain('@CustomerId');
  });

  it('makes defaulted parameters optional and applies their value in SQL', () => {
    const procedure = proc(
      'usp_Customer_Create',
      'INSERT INTO dbo.Customer (Name, Email) VALUES (@Name, @Email)',
    );
    procedure.parameters = [
      {
        name: '@Name',
        sqlType: 'nvarchar',
        maxLength: 100,
        precision: 0,
        scale: 0,
        isOutput: false,
        hasDefault: false,
        defaultValue: null,
      },
      {
        name: '@Email',
        sqlType: 'nvarchar',
        maxLength: 128,
        precision: 0,
        scale: 0,
        isOutput: false,
        hasDefault: true,
        defaultValue: null,
      },
    ];
    const { read } = generate([procedure]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain('postCustomerCreate(name: string, email?: string)');
    expect(repository).toContain('[name, (email ?? null)]');
    const dto = read('src/dto/params.generated.ts');
    expect(dto).toContain('@IsOptional()');
    expect(dto).toContain('email?: string;');
  });

  it('accepts datetime2 parameters as ISO strings', () => {
    const procedure = proc(
      'usp_Customer_Search',
      'SELECT * FROM dbo.Customer WHERE Id > @CreatedAfter',
    );
    procedure.parameters = [
      {
        name: '@CreatedAfter',
        sqlType: 'datetime2',
        maxLength: 6,
        precision: 0,
        scale: 3,
        isOutput: false,
        hasDefault: false,
        defaultValue: null,
      },
    ];
    const { read } = generate([procedure]);
    expect(read('src/database/repositories/customer.repository.ts')).toContain(
      'createdAfter: string',
    );
  });

  it('types decimal result columns as numbers and entity columns as strings', () => {
    const catalog: CatalogSnapshot = {
      database,
      procedures: [
        {
          ...proc('usp_Account_List', 'SELECT * FROM dbo.Account'),
          resultColumns: [
            {
              name: 'Balance',
              sqlType: 'decimal',
              maxLength: 9,
              precision: 18,
              scale: 2,
              isNullable: false,
            },
          ],
        },
      ],
      tables: [
        {
          schema: 'dbo',
          name: 'Account',
          primaryKey: ['Id'],
          columns: [
            {
              name: 'Id',
              propertyName: 'Id',
              sqlType: 'int',
              maxLength: 4,
              precision: 10,
              scale: 0,
              isNullable: false,
              isIdentity: true,
              isComputed: false,
              hasDefault: false,
            },
            {
              name: 'Balance',
              propertyName: 'Balance',
              sqlType: 'decimal',
              maxLength: 9,
              precision: 18,
              scale: 2,
              isNullable: false,
              isIdentity: false,
              isComputed: false,
              hasDefault: false,
            },
          ],
        },
      ],
    };
    const bundle = analyzeCatalog(catalog);
    const files = generateFiles({
      analyses: bundle.analyses,
      tables: bundle.tables,
      database,
      projectName: 'acme-api',
    });
    const rows = files.find((file) => file.path === 'src/rows.generated.ts')?.content ?? '';
    const entity =
      files.find((file) => file.path === 'src/database/entities/account.entity.ts')?.content ?? '';
    expect(rows).toContain('Balance: number;');
    expect(entity).toContain('balance!: string;');
  });

  it('constrains repository entity types like TypeORM does', () => {
    const { read } = generate([
      proc('usp_Customer_GetById', 'SELECT * FROM dbo.Customer', 1),
    ]);
    expect(read('src/database/base.repository.ts')).toContain(
      'BaseRepository<T extends ObjectLiteral>',
    );
  });

  it('wires repositories and controllers into the module', () => {
    const { read } = generate([
      proc('usp_Customer_GetById', 'SELECT * FROM dbo.Customer', 1),
      proc('usp_Order_Create', 'INSERT INTO dbo.OrderHeader (Id) VALUES (1); INSERT INTO dbo.Customer (Id) VALUES (1);'),
    ]);
    const module = read('src/app.module.ts');
    expect(module).toContain('CustomerController');
    expect(module).toContain('CustomerRepository');
    expect(module).toContain('OrderCreateMultiTableService');
  });

  it('imports the parameter classes it uses', () => {
    const { read } = generate([proc('usp_Customer_Search', 'SELECT * FROM dbo.Customer', 7)]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain("from '../../dto/params.generated'");
    expect(repository).toContain('CustomerSearchParams');
  });

  it('calls the executor directly on a table without a primary key', () => {
    const catalog: CatalogSnapshot = {
      database,
      procedures: [proc('usp_Lookup_Read', 'SELECT * FROM dbo.Lookup', 1)],
      tables: [
        {
          schema: 'dbo',
          name: 'Lookup',
          primaryKey: [],
          columns: [
            {
              name: 'Value',
              propertyName: 'Value',
              sqlType: 'int',
              maxLength: 4,
              precision: 10,
              scale: 0,
              isNullable: false,
              isIdentity: false,
              isComputed: false,
              hasDefault: false,
            },
          ],
        },
      ],
    };
    const bundle = analyzeCatalog(catalog);
    const files = generateFiles({
      analyses: bundle.analyses,
      tables: bundle.tables,
      database,
      projectName: 'acme-api',
    });
    const repository =
      files.find((file) => file.path === 'src/database/repositories/lookup.repository.ts')
        ?.content ?? '';
    expect(repository).toContain('constructor(private readonly dataSource: DataSource)');
    expect(repository).toContain('this.dataSource.manager.query(');
    expect(repository).not.toContain('SpExecutor');
  });

  it('marks nullable result columns as nullable', () => {
    const catalog: CatalogSnapshot = {
      database,
      procedures: [
        {
          ...proc('usp_Customer_Get', 'SELECT * FROM dbo.Customer'),
          resultColumns: [
            { name: 'Id', sqlType: 'int', maxLength: 4, precision: 10, scale: 0, isNullable: false },
            { name: 'Note', sqlType: 'nvarchar', maxLength: 100, precision: 0, scale: 0, isNullable: true },
          ],
        },
      ],
      tables: [customerTable],
    };
    const bundle = analyzeCatalog(catalog);
    const files = generateFiles({
      analyses: bundle.analyses,
      tables: bundle.tables,
      database,
      projectName: 'acme-api',
    });
    const rows = files.find((file) => file.path === 'src/rows.generated.ts')?.content ?? '';
    expect(rows).toContain('Id: number;');
    expect(rows).toContain('Note: string | null;');
  });

  it('keeps same-named tables in different schemas apart', () => {
    const column = (name: string, sqlType: string) => ({
      name,
      propertyName: name,
      sqlType,
      maxLength: 4,
      precision: 10,
      scale: 0,
      isNullable: false,
      isIdentity: name === 'Id',
      isComputed: false,
      hasDefault: false,
    });
    const catalog: CatalogSnapshot = {
      database,
      procedures: [
        proc('usp_Dbo_Customer_Get', 'SELECT * FROM dbo.Customer'),
        proc('usp_Sales_Customer_Get', 'SELECT * FROM sales.Customer'),
      ],
      tables: [
        { schema: 'dbo', name: 'Customer', primaryKey: ['Id'], columns: [column('Id', 'int')] },
        { schema: 'sales', name: 'Customer', primaryKey: ['Id'], columns: [column('Id', 'int')] },
      ],
    };
    const bundle = analyzeCatalog(catalog);
    const files = generateFiles({
      analyses: bundle.analyses,
      tables: bundle.tables,
      database,
      projectName: 'acme-api',
    });
    const paths = files.map((file) => file.path);
    expect(paths).toContain('src/database/repositories/customer.repository.ts');
    expect(paths).toContain('src/database/repositories/sales-customer.repository.ts');
    expect(paths).toContain('src/controllers/customer.controller.ts');
    expect(paths).toContain('src/controllers/sales-customer.controller.ts');
    expect(new Set(paths).size).toBe(paths.length);

    const module = files.find((file) => file.path === 'src/app.module.ts')?.content ?? '';
    expect(module).toContain('CustomerController');
    expect(module).toContain('SalesCustomerController');
    expect(module).toContain('SalesCustomerRepository');

    const entities =
      files.find((file) => file.path === 'src/database/entities/index.ts')?.content ?? '';
    expect(entities).toContain("'./customer.entity'");
    expect(entities).toContain("'./sales-customer.entity'");
  });

  it('applies defaulted parameter values inline', () => {
    const catalog: CatalogSnapshot = {
      database,
      procedures: [
        {
          ...proc(
            'usp_Customer_Find',
            'SELECT * FROM dbo.Customer WHERE Id = @Page OR Id = @Size',
          ),
          parameters: [
            {
              name: 'Term',
              sqlType: 'nvarchar',
              maxLength: 200,
              precision: 0,
              scale: 0,
              isOutput: false,
              hasDefault: false,
              defaultValue: null,
            },
            {
              name: 'Page',
              sqlType: 'int',
              maxLength: 4,
              precision: 10,
              scale: 0,
              isOutput: false,
              hasDefault: true,
              defaultExpression: '1',
              defaultValue: '((1))',
            },
            {
              name: 'Size',
              sqlType: 'int',
              maxLength: 4,
              precision: 10,
              scale: 0,
              isOutput: false,
              hasDefault: true,
              defaultExpression: '20',
              defaultValue: '((20))',
            },
          ],
        },
      ],
      tables: [customerTable],
    };
    const bundle = analyzeCatalog(catalog);
    const files = generateFiles({
      analyses: bundle.analyses,
      tables: bundle.tables,
      database,
      projectName: 'acme-api',
    });
    const repository =
      files.find((file) => file.path === 'src/database/repositories/customer.repository.ts')
        ?.content ?? '';
    expect(repository).toContain('getCustomerFind(term: string, page?: number, size?: number)');
    expect(repository).toContain('p0: (page ?? 1)');
    expect(repository).toContain('p1: (size ?? 20)');
  });

  it('returns OUTPUT parameters in a named result envelope', () => {
    const procedure = proc(
      'usp_Customer_Stats',
      'SELECT * FROM dbo.Customer WHERE Id = @CustomerId',
      1,
    );
    procedure.parameters.push(
      {
        name: '@OrderCount',
        sqlType: 'int',
        maxLength: 4,
        precision: 10,
        scale: 0,
        isOutput: true,
        hasDefault: false,
        defaultValue: null,
      },
      {
        name: '@Total_Amount',
        sqlType: 'decimal',
        maxLength: 9,
        precision: 18,
        scale: 2,
        isOutput: true,
        hasDefault: false,
        defaultValue: null,
      },
    );
    const { read } = generate([procedure]);

    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain(
      'getCustomerStats(customerId: number): Promise<CustomerStatsResult>',
    );
    expect(repository).toContain('let orderCount: any = null;');
    expect(repository).toContain('let totalAmount: any = null;');
    expect(repository).toContain(
      'return { rows, output: { orderCount: orderCount, totalAmount: totalAmount } };',
    );
    expect(repository).not.toContain('exec ');
    expect(repository).not.toContain('EXEC ');
    expect(repository).toContain(
      "import type { CustomerStatsResult, CustomerStatsOutput } from '../../results.generated';",
    );
    expect(repository).toContain(
      "import type { CustomerStatsRow } from '../../rows.generated';",
    );

    const results = read('src/results.generated.ts');
    expect(results).toContain("import type { CustomerStatsRow } from './rows.generated';");
    expect(results).toContain('export interface CustomerStatsOutput');
    expect(results).toContain('orderCount: number | null;');
    expect(results).toContain('totalAmount: number | null;');
    expect(results).toContain('export interface CustomerStatsResult');
    expect(results).toContain('rows: CustomerStatsRow[];');
    expect(results).toContain('output: CustomerStatsOutput;');

    const barrel = read('src/api.generated.ts');
    expect(barrel).toContain("export * from './rows.generated';");
    expect(barrel).toContain("export * from './results.generated';");

    const dto = read('src/dto/params.generated.ts');
    expect(dto).not.toContain('orderCount');
    expect(dto).not.toContain('OrderCount');

    const controller = read('src/controllers/customer.controller.ts');
    expect(controller).toContain('Promise<CustomerStatsResult>');
    expect(controller).toContain("import type { CustomerStatsResult } from '../results.generated';");
    expect(controller).not.toContain("import type { CustomerStatsRow }");
  });

  it('never emits EXEC and returns OUTPUT values in the envelope', () => {
    const procedure = proc(
      'usp_Customer_Count',
      'SELECT COUNT(*) AS [Count] FROM dbo.Customer',
    );
    procedure.parameters.push({
      name: '@Count',
      sqlType: 'int',
      maxLength: 4,
      precision: 10,
      scale: 0,
      isOutput: true,
      hasDefault: false,
      defaultValue: null,
    });
    const { read, files } = generate([procedure]);
    const repository = read('src/database/repositories/customer.repository.ts');
    expect(repository).toContain('let count: any = null;');
    expect(repository).toContain('return { rows, output: { count: count } };');
    expect(repository).not.toContain('EXEC');
    expect(files.map((file) => file.path)).not.toContain('src/database/sp.executor.ts');
    expect(read('src/database/base.repository.ts')).toContain('BaseRepository');
  });

  it('always emits a buildable scaffold', () => {
    const { files } = generate([
      proc('usp_Customer_Get', 'SELECT * FROM dbo.Customer'),
    ]);
    const paths = files.map((file) => file.path);
    for (const expected of [
      'package.json',
      'tsconfig.json',
      'nest-cli.json',
      'src/main.ts',
      'src/database/database.module.ts',
      'src/database/base.repository.ts',
      'src/common/sql-exception.filter.ts',
    ]) {
      expect(paths).toContain(expected);
    }
    expect(paths).not.toContain('src/database/sp.executor.ts');
  });
});
