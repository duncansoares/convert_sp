/**
 * Minimal ambient declarations for the packages a generated project depends on.
 *
 * They exist so `scripts/verify-generated.mjs` can typecheck generated output on a
 * machine with no network and no NestJS install. They describe only the surface the
 * generator actually emits; they are not a substitute for the real packages at runtime.
 */

declare module '@nestjs/common' {
  import type { Observable } from 'rxjs';

  export interface ArgumentsHost {
    switchToHttp(): { getRequest(): any; getResponse(): any };
  }

  export interface ExecutionContext {
    switchToHttp(): { getRequest(): any; getResponse(): any };
    getHandler(): any;
    getClass(): any;
  }

  export interface CallHandler {
    handle(): Observable<unknown>;
  }

  export interface NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<unknown>;
  }

  export interface ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost): void;
  }

  export interface PipeTransform {
    transform(value: any, metadata?: any): any;
  }

  export function Injectable(options?: any): ClassDecorator;
  export function Controller(prefix?: string): ClassDecorator;
  export function Module(options: any): ClassDecorator;
  export function Global(): ClassDecorator;
  export function Catch(...exceptions: any[]): ClassDecorator;
  export function Get(path?: string): MethodDecorator;
  export function Post(path?: string): MethodDecorator;
  export function Put(path?: string): MethodDecorator;
  export function Patch(path?: string): MethodDecorator;
  export function Delete(path?: string): MethodDecorator;
  export function Query(property?: string): ParameterDecorator;
  export function Param(property?: string): ParameterDecorator;
  export function Body(property?: string): ParameterDecorator;
  export function Req(): ParameterDecorator;
  export function Res(): ParameterDecorator;
  export function Inject(token: any): ParameterDecorator;

  export class HttpException {
    constructor(response: string | object, status?: number);
    getStatus(): number;
    getResponse(): string | object;
  }

  export const HttpStatus: {
    OK: number;
    CREATED: number;
    NO_CONTENT: number;
    BAD_REQUEST: number;
    UNAUTHORIZED: number;
    FORBIDDEN: number;
    NOT_FOUND: number;
    CONFLICT: number;
    UNPROCESSABLE_ENTITY: number;
    INTERNAL_SERVER_ERROR: number;
  };

  export class Logger {
    constructor(context?: string);
    log(message: any): void;
    warn(message: any): void;
    error(message: any, stack?: string): void;
  }

  export class ValidationPipe implements PipeTransform {
    constructor(options?: any);
    transform(value: any): any;
  }
}

declare module '@nestjs/core' {
  export interface INestApplication {
    useGlobalPipes(...pipes: any[]): this;
    useGlobalFilters(...filters: any[]): this;
    useGlobalInterceptors(...interceptors: any[]): this;
    listen(port?: number): Promise<any>;
    close(): Promise<void>;
  }

  export const NestFactory: {
    create(module: any): Promise<INestApplication>;
  };
}

declare module '@nestjs/config' {
  export class ConfigService {
    get<T = string>(key: string): T | undefined;
  }

  export const ConfigModule: {
    forRoot(options?: any): any;
  };
}

declare module '@nestjs/typeorm' {
  export const TypeOrmModule: {
    forRootAsync(options: any): any;
    forRoot(options: any): any;
    forFeature(entities: any[]): any;
  };

  export function InjectRepository(entity: any): ParameterDecorator;
}

declare module 'typeorm' {
  export interface ObjectLiteral {
    [key: string]: any;
  }

  export class EntityManager {
    createQueryBuilder(entity?: any, alias?: string): any;
    query<T = any>(sql: string, parameters?: any): Promise<T>;
  }

  export class DataSource {
    manager: EntityManager;
  }

  export class Repository<T extends ObjectLiteral> {
    find(options?: any): Promise<T[]>;
    findOne(options?: any): Promise<T | null>;
    save(entity: any): Promise<any>;
    insert(entity: any): Promise<any>;
    update(criteria: any, partial: any): Promise<any>;
    delete(criteria: any): Promise<any>;
    createQueryBuilder(alias?: string): any;
  }

  export function Column(options?: any): PropertyDecorator;
  export function Entity(options?: any): ClassDecorator;
  export function PrimaryColumn(options?: any): PropertyDecorator;
  export function PrimaryGeneratedColumn(
    strategy?: any,
    options?: any,
  ): PropertyDecorator;
}

declare module 'mssql' {
  export interface config {
    server: string;
    port?: number;
    user?: string;
    password?: string;
    database?: string;
    connectionTimeout?: number;
    requestTimeout?: number;
    options?: {
      appName?: string;
      encrypt?: boolean;
      trustServerCertificate?: boolean;
      enableArithAbort?: boolean;
      instanceName?: string;
      [key: string]: any;
    };
    [key: string]: any;
  }

  export interface IResult<T> {
    recordset: T[];
    recordsets: T[][];
    rowsAffected: number[];
    output: Record<string, unknown>;
  }

  export class Request {
    input(name: string, type: any, value?: unknown): Request;
    output(name: string, type: any, value?: unknown): Request;
    query<T = any>(command: string): Promise<IResult<T>>;
    execute<T = any>(procedure: string): Promise<IResult<T>>;
  }

  export class ConnectionPool {
    constructor(config: config);
    connect(): Promise<ConnectionPool>;
    request(): Request;
    close(): Promise<void>;
    connected: boolean;
  }

  export const MAX: number;
  export const Int: any;
  export const BigInt: any;
  export const SmallInt: any;
  export const TinyInt: any;
  export const Bit: any;
  export const Decimal: any;
  export const Numeric: any;
  export const Money: any;
  export const SmallMoney: any;
  export const Float: any;
  export const Real: any;
  export const Date: any;
  export const DateTime: any;
  export const DateTime2: any;
  export const DateTimeOffset: any;
  export const SmallDateTime: any;
  export const Time: any;
  export const Char: any;
  export const VarChar: any;
  export const NChar: any;
  export const NVarChar: any;
  export const Text: any;
  export const NText: any;
  export const UniqueIdentifier: any;
  export const Binary: any;
  export const VarBinary: any;
  export const Image: any;
  export const Xml: any;
  export const Variant: any;
}

declare module 'class-transformer' {
  export function Type(typeFn: () => unknown): PropertyDecorator;
  export function Transform(
    transformFn: (params: { value: any; key: string; obj: any }) => any,
  ): PropertyDecorator;
}

declare module 'class-validator' {
  export function IsString(options?: any): PropertyDecorator;
  export function IsInt(options?: any): PropertyDecorator;
  export function IsNumber(options?: any): PropertyDecorator;
  export function IsBoolean(options?: any): PropertyDecorator;
  export function IsDateString(options?: any): PropertyDecorator;
  export function IsUUID(version?: any, options?: any): PropertyDecorator;
  export function IsOptional(options?: any): PropertyDecorator;
  export function MaxLength(length: number, options?: any): PropertyDecorator;
  export function Min(value: number, options?: any): PropertyDecorator;
  export function Max(value: number, options?: any): PropertyDecorator;
  export function IsNotEmpty(options?: any): PropertyDecorator;
}

declare module 'rxjs' {
  export interface Subscription {
    unsubscribe(): void;
  }

  export interface Observable<T> {
    pipe(...operators: any[]): Observable<any>;
    subscribe(observer?: any, error?: any, complete?: any): Subscription;
  }

  export function tap<T>(
    observer: {
      next?: (value: T) => void;
      error?: (error: any) => void;
      complete?: () => void;
    },
  ): (source: Observable<T>) => Observable<T>;
  export function map<T, R>(project: (value: T) => R): (source: Observable<T>) => Observable<R>;
  export function interval(period: number): Observable<number>;
}

declare module 'reflect-metadata' {}

declare const process: {
  env: Record<string, string | undefined>;
  exit(code?: number): never;
};
