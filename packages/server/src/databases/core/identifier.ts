const IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const assertSafeIdentifier = (identifier: string, label = "identifier"): string => {
  if (!IDENTIFIER_PATTERN.test(identifier)) {
    throw new Error(`Invalid ${label}: ${identifier}`);
  }
  return identifier;
};
