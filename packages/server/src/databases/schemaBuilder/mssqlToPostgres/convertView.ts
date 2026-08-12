export const convertMSSQLViewToPostgres = (viewDefinition: string): string => {
  return (
    viewDefinition
      // Fix CAST syntax
      .replace(/cast\(([^)]+)\s+as\s+([^)]+)\)/gi, "$1::$2")

      // Replace ISNULL with COALESCE
      .replace(/ISNULL\s*\(([^,]+),([^)]+)\)/gi, "COALESCE($1,$2)")

      // Replace string concatenation + with ||
      .replace(/\s*\+\s*(?=('[^']*'|[^']+))/g, " || ")

      // Replace TOP with LIMIT
      .replace(/TOP\s+(\d+)/gi, "LIMIT $1")

      // Replace LEN with LENGTH
      .replace(/LEN\s*\(([^)]+)\)/gi, "LENGTH($1)")

      // Remove square brackets from identifiers
      .replace(/\[([^\]]+)\]/g, '"$1"')

      // Replace CHARINDEX with POSITION
      .replace(/CHARINDEX\s*\(([^,]+),([^)]+)\)/gi, "POSITION($1 IN $2)")

      // Replace GETDATE() with CURRENT_TIMESTAMP
      .replace(/GETDATE\(\)/gi, "CURRENT_TIMESTAMP")

      // Replace SUBSTRING with proper syntax
      .replace(/substring\s*\(([^,]+),([^,)]+)\)/gi, "substring($1 from $2)")

      // Fix numeric types
      .replace(/numeric\s*\(([^)]+)\)/gi, "numeric($1)")

      // Fix boolean comparisons
      .replace(/=\s*1/g, " = true")
      .replace(/=\s*0/g, " = false")

      // Fix CONVERT
      .replace(/CONVERT\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/gi, "$2::$1")

      // Fix CREATE VIEW syntax
      .replace(
        /CREATE\s+VIEW\s+(\[?)(\w+)(\]?)\.(\[?)(\w+)(\]?)/gi,
        'CREATE OR REPLACE VIEW "$2"."$5"',
      )
  );
};
