/**
 * Maps a SQL identifier onto a legal GraphQL name (`/^[_A-Za-z][_0-9A-Za-z]*$/`).
 *
 * PostgreSQL, MySQL and SQL Server all accept identifiers GraphQL cannot spell —
 * spaces, accents, punctuation — and an unmapped one produces an SDL document
 * that fails to parse, taking the whole server down at boot.
 *
 * A name that is already legal is returned unchanged, so this cannot rename a
 * field in any schema that boots today. Runs of illegal characters are not
 * collapsed, and diacritics fold to their base letter rather than being dropped,
 * both so that distinct identifiers stay distinct as often as possible.
 */
export const sanitizeGraphQLName = (name: string): string => {
  const folded = name.normalize("NFD").replace(/[̀-ͯ]/g, "");
  const replaced = folded.replace(/[^_0-9A-Za-z]/g, "_");

  if (replaced.length === 0) return "_";

  return /^[0-9]/.test(replaced) ? `_${replaced}` : replaced;
};
