import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

const chains = new Map<string, Promise<void>>();

// One file is replaced in submission order. An older rename cannot land after a newer one.
export function atomicWrite(file: string, data: string, mode?: number): Promise<void> {
  const previous = chains.get(file) ?? Promise.resolve();
  const task = previous.then(() => commit(file, data, mode));
  chains.set(file, task.catch(() => {}));
  return task;
}

async function commit(file: string, data: string, mode?: number): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
