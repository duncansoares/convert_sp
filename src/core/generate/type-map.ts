export interface TypeShape {
  sqlType: string;
  maxLength: number;
  precision: number;
  scale: number;
}

export interface EntityColumnType {
  type: string;
  length?: number;
  precision?: number;
  scale?: number;
  unsupported?: string;
}

const NUMERIC_INPUT = new Set([
  'int',
  'smallint',
  'tinyint',
  'bigint',
  'decimal',
  'numeric',
  'money',
  'smallmoney',
  'float',
  'real',
]);

const DATE_TYPES = new Set([
  'date',
  'datetime',
  'datetime2',
  'smalldatetime',
  'datetimeoffset',
  'time',
]);

export function charLength(shape: TypeShape): number {
  const lowered = shape.sqlType.toLowerCase();
  if (shape.maxLength === -1) {
    return -1;
  }
  if (lowered.startsWith('n')) {
    return Math.floor(shape.maxLength / 2);
  }
  return shape.maxLength;
}

/** Type used for procedure input parameters. Dates travel as ISO strings over HTTP. */
export function tsInputType(shape: TypeShape): string {
  const type = shape.sqlType.toLowerCase();
  if (type === 'bit') {
    return 'boolean';
  }
  if (type === 'bigint' || type === 'decimal' || type === 'numeric' || type === 'money' || type === 'smallmoney') {
    return 'string';
  }
  if (type === 'float' || type === 'real' || type === 'int' || type === 'smallint' || type === 'tinyint') {
    return 'number';
  }
  if (DATE_TYPES.has(type)) {
    return 'string';
  }
  if (type === 'varbinary' || type === 'binary' || type === 'image' || type === 'timestamp' || type === 'rowversion') {
    return 'Buffer';
  }
  if (type === 'sql_variant') {
    return 'unknown';
  }
  return 'string';
}

/** Type used for result sets returned by the native mssql driver. */
export function tsRowType(shape: TypeShape): string {
  const type = shape.sqlType.toLowerCase();
  if (type === 'bit') {
    return 'boolean';
  }
  if (type === 'bigint') {
    return 'string';
  }
  if (type === 'decimal' || type === 'numeric' || type === 'money' || type === 'smallmoney') {
    // mssql hands decimals back as JavaScript numbers.
    return 'number';
  }
  return tsEntityType(shape);
}

/** Type used for TypeORM entity columns, which return decimals as strings. */
export function tsEntityType(shape: TypeShape): string {
  const type = shape.sqlType.toLowerCase();
  if (type === 'bit') {
    return 'boolean';
  }
  if (type === 'bigint' || type === 'decimal' || type === 'numeric' || type === 'money' || type === 'smallmoney') {
    return 'string';
  }
  if (type === 'float' || type === 'real' || type === 'int' || type === 'smallint' || type === 'tinyint') {
    return 'number';
  }
  if (DATE_TYPES.has(type)) {
    return 'Date';
  }
  if (type === 'varbinary' || type === 'binary' || type === 'image' || type === 'timestamp' || type === 'rowversion') {
    return 'Buffer';
  }
  if (type === 'sql_variant') {
    return 'unknown';
  }
  return 'string';
}

/** datetime2/datetimeoffset/time keep their declared fractional seconds (0 is valid). */
function fractionalScale(shape: TypeShape): number {
  const scale = shape.scale;
  return Number.isFinite(scale) && scale >= 0 && scale <= 7 ? scale : 7;
}

export function mssqlTypeExpression(shape: TypeShape): string {
  const type = shape.sqlType.toLowerCase();
  const length = charLength(shape);
  switch (type) {
    case 'int':
      return 'sql.Int';
    case 'smallint':
      return 'sql.SmallInt';
    case 'tinyint':
      return 'sql.TinyInt';
    case 'bigint':
      return 'sql.BigInt';
    case 'bit':
      return 'sql.Bit';
    case 'decimal':
    case 'numeric':
      return `sql.Decimal(${shape.precision || 18}, ${shape.scale || 0})`;
    case 'money':
      return 'sql.Money';
    case 'smallmoney':
      return 'sql.SmallMoney';
    case 'float':
      return 'sql.Float';
    case 'real':
      return 'sql.Real';
    case 'date':
      return 'sql.Date';
    case 'datetime':
      return 'sql.DateTime';
    case 'datetime2':
      return `sql.DateTime2(${fractionalScale(shape)})`;
    case 'datetimeoffset':
      return `sql.DateTimeOffset(${fractionalScale(shape)})`;
    case 'smalldatetime':
      return 'sql.SmallDateTime';
    case 'time':
      return `sql.Time(${fractionalScale(shape)})`;
    case 'char':
      return `sql.Char(${Math.max(length, 1)})`;
    case 'varchar':
      return length === -1 ? 'sql.VarChar(sql.MAX)' : `sql.VarChar(${Math.max(length, 1)})`;
    case 'nchar':
      return `sql.NChar(${Math.max(length, 1)})`;
    case 'nvarchar':
      return length === -1 ? 'sql.NVarChar(sql.MAX)' : `sql.NVarChar(${Math.max(length, 1)})`;
    case 'text':
      return 'sql.Text';
    case 'ntext':
      return 'sql.NText';
    case 'uniqueidentifier':
      return 'sql.UniqueIdentifier';
    case 'binary':
      return `sql.Binary(${Math.max(shape.maxLength, 1)})`;
    case 'varbinary':
      return shape.maxLength === -1 ? 'sql.VarBinary(sql.MAX)' : `sql.VarBinary(${Math.max(shape.maxLength, 1)})`;
    case 'image':
      return 'sql.Image';
    case 'xml':
      return 'sql.Xml';
    case 'sql_variant':
      return 'sql.Variant';
    case 'timestamp':
    case 'rowversion':
      return 'sql.VarBinary(8)';
    default:
      return 'sql.NVarChar(sql.MAX)';
  }
}

export function entityColumnType(shape: TypeShape): EntityColumnType {
  const type = shape.sqlType.toLowerCase();
  const length = charLength(shape);
  switch (type) {
    case 'int':
    case 'smallint':
    case 'tinyint':
    case 'bigint':
    case 'bit':
    case 'money':
    case 'smallmoney':
    case 'float':
    case 'real':
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'datetimeoffset':
    case 'smalldatetime':
    case 'time':
    case 'uniqueidentifier':
    case 'text':
    case 'ntext':
    case 'image':
    case 'xml':
      return { type };
    case 'decimal':
    case 'numeric':
      return { type: 'decimal', precision: shape.precision || 18, scale: shape.scale || 0 };
    case 'char':
    case 'varchar':
    case 'nchar':
    case 'nvarchar':
      return length === -1 ? { type } : { type, length };
    case 'binary':
    case 'varbinary':
    case 'timestamp':
    case 'rowversion':
      return shape.maxLength === -1 ? { type: 'varbinary' } : { type: 'varbinary', length: shape.maxLength };
    case 'sql_variant':
      return { type: 'nvarchar', unsupported: 'sql_variant' };
    default:
      return { type: 'nvarchar', unsupported: type };
  }
}

export function isNumericInput(shape: TypeShape): boolean {
  return NUMERIC_INPUT.has(shape.sqlType.toLowerCase());
}

export function isDateInput(shape: TypeShape): boolean {
  return DATE_TYPES.has(shape.sqlType.toLowerCase());
}

export interface ValidationRule {
  decorator: string;
  imports: string[];
  transform?: string;
}

export function validationRules(shape: TypeShape): ValidationRule[] {
  const type = shape.sqlType.toLowerCase();
  const rules: ValidationRule[] = [];
  const length = charLength(shape);

  switch (type) {
    case 'int':
    case 'smallint':
    case 'tinyint':
      rules.push({ decorator: '@IsInt()', imports: ['IsInt'], transform: '@Type(() => Number)' });
      break;
    case 'bigint':
      rules.push({ decorator: '@IsString()', imports: ['IsString'] });
      break;
    case 'decimal':
    case 'numeric':
    case 'money':
    case 'smallmoney':
      rules.push({ decorator: '@IsString()', imports: ['IsString'] });
      break;
    case 'float':
    case 'real':
      rules.push({ decorator: '@IsNumber()', imports: ['IsNumber'], transform: '@Type(() => Number)' });
      break;
    case 'bit':
      rules.push({
        decorator: "@IsBoolean()",
        imports: ['IsBoolean'],
        transform: "@Transform(({ value }) => value === true || value === 'true' || value === '1')",
      });
      break;
    case 'date':
    case 'datetime':
    case 'datetime2':
    case 'datetimeoffset':
    case 'smalldatetime':
    case 'time':
      rules.push({ decorator: '@IsDateString()', imports: ['IsDateString'] });
      break;
    case 'uniqueidentifier':
      rules.push({ decorator: '@IsUUID()', imports: ['IsUUID'] });
      break;
    case 'varbinary':
    case 'binary':
    case 'image':
    case 'timestamp':
    case 'rowversion':
      rules.push({ decorator: '@IsString()', imports: ['IsString'] });
      break;
    default:
      rules.push({ decorator: '@IsString()', imports: ['IsString'] });
      break;
  }

  if (
    ['char', 'varchar', 'nchar', 'nvarchar'].includes(type) &&
    length > 0 &&
    length !== -1
  ) {
    rules.push({ decorator: `@MaxLength(${length})`, imports: ['MaxLength'] });
  }

  return rules;
}
