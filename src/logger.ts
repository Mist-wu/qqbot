import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
type Level = Exclude<keyof typeof LEVELS, "silent">;

const threshold = LEVELS[config.logLevel as keyof typeof LEVELS] ?? LEVELS.info;

function timestamp(): string {
  return new Date().toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function emit(level: Level, args: unknown[]): void {
  if (LEVELS[level] < threshold) return;
  const line = [`${timestamp()} [${level}]`, ...args];
  if (level === "error") console.error(...line);
  else if (level === "warn") console.warn(...line);
  else console.log(...line);
}

export const logger = {
  debug: (...args: unknown[]) => emit("debug", args),
  info: (...args: unknown[]) => emit("info", args),
  warn: (...args: unknown[]) => emit("warn", args),
  error: (...args: unknown[]) => emit("error", args),
};
