/**
 * Utility functions for SQL data type categorization and mapping
 * Supports MSSQL, MySQL, and PostgreSQL data types
 */

export enum SqlTypeCategory {
  INTEGER = "INTEGER",
  FLOAT = "FLOAT",
  BOOLEAN = "BOOLEAN",
  DATE_TIME = "DATE_TIME",
  STRING = "STRING",
}

/**
 * Categorizes a SQL data type into one of the standard categories
 * @param dataType - The SQL data type to categorize (case-insensitive)
 * @returns The category of the data type
 */
export const categorizeSqlType = (dataType: string): SqlTypeCategory => {
  const lowerType = dataType.toLowerCase();

  // Integer types (all databases)
  if (
    lowerType === "int" ||
    lowerType === "integer" ||
    lowerType === "smallint" ||
    lowerType === "bigint" ||
    lowerType === "tinyint" ||
    lowerType === "mediumint" ||
    lowerType === "numeric" ||
    lowerType === "number"
  ) {
    return SqlTypeCategory.INTEGER;
  }

  // Floating-point types (all databases)
  if (
    lowerType === "float" ||
    lowerType === "real" ||
    lowerType === "double" ||
    lowerType === "double precision" ||
    lowerType === "decimal" ||
    lowerType === "money" ||
    lowerType === "smallmoney"
  ) {
    return SqlTypeCategory.FLOAT;
  }

  // Boolean types (all databases)
  if (lowerType === "bit" || lowerType === "bool" || lowerType === "boolean") {
    return SqlTypeCategory.BOOLEAN;
  }

  // Date and time types (all databases)
  if (
    lowerType === "date" ||
    lowerType === "time" ||
    lowerType === "datetime" ||
    lowerType === "datetime2" ||
    lowerType === "smalldatetime" ||
    lowerType === "timestamp" ||
    lowerType === "timestamptz" ||
    lowerType === "timestamp with time zone" ||
    lowerType === "timestamp without time zone" ||
    lowerType === "time with time zone" ||
    lowerType === "time without time zone" ||
    lowerType === "timetz" ||
    lowerType === "year" ||
    lowerType === "interval"
  ) {
    return SqlTypeCategory.DATE_TIME;
  }

  // All other types default to STRING
  // This includes:
  // - Character strings: char, varchar, nchar, nvarchar, text, ntext, tinytext, mediumtext, longtext
  // - Binary types: binary, varbinary, image, blob, tinyblob, mediumblob, longblob, bytea
  // - Special types: uniqueidentifier, uuid, guid, xml, json, jsonb, sql_variant, geography, geometry, hierarchyid, datetimeoffset, cursor, table, vector, enum, set
  // - PostgreSQL-specific: inet, cidr, macaddr, macaddr8, point, line, lseg, box, path, polygon, circle, tsquery, tsvector, ranges, array types
  return SqlTypeCategory.STRING;
};

/**
 * Checks if a SQL data type is numeric (integer or floating-point)
 * @param dataType - The SQL data type to check
 * @returns True if the type is numeric, false otherwise
 */
export const isNumericType = (dataType: string): boolean => {
  const category = categorizeSqlType(dataType);
  return category === SqlTypeCategory.INTEGER || category === SqlTypeCategory.FLOAT;
};
