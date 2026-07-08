import { logger } from "../logging";

export const benchmark = async <T>(fn: () => Promise<T>): Promise<T> => {
  const start = Bun.nanoseconds();

  const result = await fn();

  const finish = Bun.nanoseconds();

  logger("benchmark").debug({ durationMs: (finish - start) / 1e6 }, "execution time");

  return result;
};
