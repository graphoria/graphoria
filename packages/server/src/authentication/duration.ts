/**
 * Parse duration string (e.g., "5m", "1h", "7d") to seconds
 */
export const parseDurationToSeconds = (duration: string): number => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);

  switch (unit) {
    case "s":
      return value;
    case "m":
      return value * 60;
    case "h":
      return value * 60 * 60;
    case "d":
      return value * 24 * 60 * 60;
    default:
      return value; // assume seconds if no unit
  }
};

/**
 * Parse duration string (e.g., "5m", "1h", "7d") to milliseconds
 */
export const parseDurationToMs = (duration: string): number => {
  return parseDurationToSeconds(duration) * 1000;
};

const PASETO_UNIT_MAP: Record<string, string> = {
  s: "seconds",
  m: "minutes",
  h: "hours",
  d: "days",
};

/**
 * Convert compact duration string to PASETO-compatible relative time format.
 * e.g., "5m" → "5 minutes", "7d" → "7 days", "1h" → "1 hour", "30s" → "30 seconds"
 */
export const toPasetoDuration = (duration: string): string => {
  const unit = duration.slice(-1);
  const value = parseInt(duration.slice(0, -1), 10);
  const unitName = PASETO_UNIT_MAP[unit];

  if (!unitName) {
    return `${value} seconds`;
  }

  return value === 1 ? `${value} ${unitName.slice(0, -1)}` : `${value} ${unitName}`;
};
