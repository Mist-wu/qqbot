import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname } from "node:path";

// Property access stays live so tests can pause or fail one commit.
export const files = {
  mkdir: fs.mkdir,
  writeFile: fs.writeFile,
  rename: fs.rename,
  unlink: fs.unlink,
};

const chains = new Map<string, Promise<void>>();

// One file is replaced in submission order. An older rename cannot land after a newer one.
export function atomicWrite(file: string, data: string | Buffer, mode?: number): Promise<void> {
  const previous = chains.get(file) ?? Promise.resolve();
  const task = previous.then(() => commit(file, data, mode));
  chains.set(
    file,
    task.then(
      () => undefined,
      () => undefined,
    ),
  );
  return task;
}

async function commit(file: string, data: string | Buffer, mode?: number): Promise<void> {
  await files.mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await files.writeFile(tmp, data, mode === undefined ? undefined : { mode });
    await files.rename(tmp, file);
  } catch (error) {
    await files.unlink(tmp).catch(() => undefined);
    throw error;
  }
}
