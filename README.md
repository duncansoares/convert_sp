# convert-sp

Reads SQL Server stored procedures and generates a repository-based NestJS application.

Every procedure becomes a method. Where that method lands, and how it is named, is derived
from what the procedure actually does:

| Procedure does | Prefix | Lives on |
| --- | --- | --- |
| `INSERT` / `UPDATE` / `MERGE` / `TRUNCATE` | `post` | the table's repository, or a multi-table service |
| `DELETE` only | `delete` | the table's repository, or a multi-table service |
| reads only | `get` | the table's repository, or a multi-table service |
| touches 1 table | — | `<Table>Repository extends BaseRepository<T>` |
| touches 2+ tables | — | `<Proc>MultiTableService` injecting every repository |
| has more than 6 parameters | — | parameters grouped into one validated object |

The procedure body is translated into TypeScript that executes the same SQL through TypeORM;
nothing in the generated application calls the stored procedure. Procedures that cannot be
classified or translated statically (dynamic SQL, `EXEC` chains, cross-database references, no
table access) are **reported and skipped** rather than guessed at.

A generated example lives in `generated/demo-api`, built from `scripts/demo-database.sql`.

## Quick start

```bash
npm install
npm run build
npm start -- ui
```

The UI opens on `http://127.0.0.1:4319/?token=…`. Fill in the connection form, pick the output
folder, load the procedures, choose what to generate, and run it.

`npm run build:all` also builds the Angular interface in `web/` (needs `cd web && npm install`
once). Without that build the server serves its fallback page.

Headless usage:

```bash
node dist/cli.js profiles
node dist/cli.js analyze  --profile Prod
node dist/cli.js generate --profile Prod --out ./generated
node dist/cli.js generate --profile Prod --out ./generated --dry-run
node dist/cli.js generate --connection-file ci-connection.json --out ./generated
```

`--profile` uses a saved profile and its stored password. `--connection-file` takes
`{ server, port, database, user, password, encrypt, trustServerCertificate }` and is intended
for CI, where nothing is saved.

## Configuration and secrets

Profiles live in `%APPDATA%\convert-sp\profiles.json` (or `~/.config/convert-sp` elsewhere) and
contain the host, port, database, user, flags and output folder — never the password.

Passwords are encrypted with AES-256-GCM. Set `CONVERT_SP_PASSPHRASE` to derive the key with
scrypt and never store it. Without a passphrase a random key file is created next to the
secrets; that protects against accidental disclosure in logs or backups, but anyone who can
read the whole configuration directory can decrypt it. Use the passphrase when the machine is
shared.

The generated NestJS application does **not** use this store. It reads its own `DB_*`
environment variables, as a deployed service normally would.

## Output

The generator writes to the folder selected in the form, not to a remote destination.

```
<output>/
  src/
    main.ts, app.module.ts
    database/
      database.module.ts      env-driven TypeORM DataSource
      base.repository.ts      Repository/EntityManager accessors
      entities/*.entity.ts
      repositories/*.repository.ts
    multitable/*.multitable-service.ts
    controllers/*.controller.ts
    dto/params.generated.ts   class-validator rules derived from sys.parameters
    rows.generated.ts         result-set interfaces
    results.generated.ts      OUTPUT-parameter result envelopes
    api.generated.ts          barrel for rows, results and params classes
    common/                   SQL error filter, audit interceptor
  package.json, tsconfig.json, nest-cli.json
  .env.example, README.md
  report.md                   what was generated, skipped, or warned about
  manifest.json               content hashes for safe regeneration
```

Regeneration compares each file against `manifest.json`:

- unchanged generated files are replaced
- hand-edited files are reported as conflicts and left alone (`--force` overrides)
- files the tool never wrote are never touched
- `--dry-run` writes nothing

Methods are merged between `// @generated:start` and `// @generated:end` markers, so methods you
add outside those markers survive regeneration.

HTTP mapping:

- `get` → `GET /{table}/{action}`
- `post` → `POST /{table}/{action}`
- `delete` with ≤6 parameters → `DELETE /{table}/{action}` with query parameters
- `delete` with 7+ parameters → `POST /{table}/delete-{action}` (DELETE with a body is unreliable)

Validation happens at the controller boundary and is generated from catalog metadata: types,
`max_length`, precision/scale, defaults, and UUID/date formats. SQL Server error numbers are
mapped to meaningful responses (547 → 409, 2627/2601 → 409, 8152/2628 → 400, 50000 → 422).

## How procedures are translated

Every generated method body is executable TypeScript. The stored procedure itself is never
invoked: generated code contains no `EXEC`, and a procedure that calls another procedure with
`EXEC` is skipped and listed in `report.md`.

Translation is hybrid:

- `INSERT`, `UPDATE`, `DELETE` and simple `SELECT` statements use the TypeORM query builder on
  the table's entity (`createQueryBuilder`, `.insert().into()`, `.update().set()`,
  `.delete().from()`).
- Statements the ORM cannot express — CTEs, `IF`/`WHILE` flow control, SQL expressions and other
  constructs — are emitted as one parameterized inline SQL batch executed through
  `DataSource.manager.query()`. Those procedures are flagged with `inline-sql` in `report.md`
  so they can be reviewed by hand. Multi-line statements are emitted as string literals
  concatenated across indented lines, so the generated TypeScript stays readable.
- `SCOPE_IDENTITY()` in a trailing `SELECT` is replaced with the identity captured by the
  preceding `INSERT` and returned as the row's identity column.
- Statements run in source order; only the first result set is exposed.

Parameters follow TypeORM's two calling conventions:

- query-builder fragments use named placeholders and a named object — `:p0`, `{ p0: value }`;
- raw `query()` calls use positional placeholders and an array — `@0`, `[value]` — because the
  mssql driver binds raw parameters by index.

Procedure parameters keep their catalog types (`int`, `nvarchar(100)`, `decimal(18,2)`,
`datetime2(3)`, …) and become typed method arguments. More than six of them are grouped into a
validated params class. `OUTPUT` parameters are not inputs; they are returned in the
`{ rows, output }` envelope, and both row and output interfaces are exported from
`src/api.generated.ts`.

## How the source is read

The tool's own `mssql` driver talks TDS to the server from the local Node process — never from
the browser. The generated application connects separately through TypeORM's mssql driver. Only
catalog reads are issued by the tool:

- `sys.procedures`, `sys.sql_modules` (bodies need `VIEW DEFINITION`)
- `sys.parameters`
- `sys.dm_exec_describe_first_result_set_for_object` (compiles, does not execute)
- `sys.tables`, `sys.columns`, `sys.indexes`

The pool identifies itself as `convert-sp` and is closed after each job.

## The Angular interface

`web/` is an Angular workspace (`ng serve` with a proxy for development, `ng build` for
production). If it has not been built, the server falls back to a small built-in page that
covers the same flow, so the tool is usable before `web/node_modules` exists.

```bash
cd web
npm install
npm run build      # output: web/dist/browser, picked up automatically
npm start          # dev server on 4200 with /api proxied to 4319
```

## Development

```bash
npm run typecheck
npm test               # analyzer and generator tests, no database required
npm run verify:generated   # generate a sample project and typecheck it
npm run smoke              # exercise the local API without a database
```

The analyzer is tested against tricky T-SQL: comments and string literals containing keywords,
`UPDATE STATISTICS`, temp tables, CTEs, `MERGE`, aliased updates, `sp_executesql`, bracketed
identifiers and cross-database references.

The translator tests assert the emitted shapes: query-builder calls for ordinary DML, positional
`@0`/`@1` placeholders with array bindings for raw SQL, inline defaults, `SCOPE_IDENTITY`
capture, `OUTPUT` envelopes, and that `EXEC` is never emitted.

`verify:generated` writes a sample project to `generated/verify` from a synthetic catalog and
compiles it with the tool's TypeScript alongside ambient stubs for the NestJS/TypeORM surface the
generator emits (`scripts/verify-generated/stubs.d.ts`). That catches broken imports
and mismatched member names without a network install; it does not prove the stubs match the real
packages, so run `npm install && npm run build` inside a generated project before deploying.

`smoke` starts the server on a spare port and checks the token gate, the profile endpoints, the
directory browser, that the Angular bundle is served, and that the build assets resolve.

`GET /api/profiles/:id/procedures` and `convert-sp analyze` show the classification before
anything is written.

## Known limits

- Dynamic SQL and procedures called by other procedures are not resolved transitively; they are
  reported and skipped.
- `sys.parameters` does not expose parameter nullability, so a parameter is required unless it
  has a default. Defaulted parameters are optional in TypeScript and the declared default is
  applied inline (for example `(page ?? 1)`); when the catalog exposes no default expression the
  fallback is `null`.
- Table-valued parameters, cursors and procedures that cannot be translated — including any that
  use `EXEC` — are skipped and named in `report.md`; generation still exits successfully.
- Inline-SQL fallbacks are parameterized but are not query-builder calls; they are flagged in
  `report.md` for review.
- Only the first result set of a procedure is exposed; later `SELECT`s are noted in `report.md`.
- SQL Server authentication only; Windows integrated auth needs the `msnodesqlv8` driver.
- Tables without a primary key get no TypeORM entity. Their repository injects `DataSource` and
  runs translated statements through `manager.query`, so no entity metadata is required.
- Two tables with the same name in different schemas get schema-prefixed file and class names.
