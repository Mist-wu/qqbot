import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Whether the bot is taking part in chats; toggled by admin commands and kept across restarts.
export class PowerSwitch {
  private enabled = true;

  constructor(private readonly file: string) {}

  get on(): boolean {
    return this.enabled;
  }

  async load(): Promise<void> {
    try {
      const state = JSON.parse(await readFile(this.file, "utf8")) as { on?: unknown };
      this.enabled = state.on !== false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async set(on: boolean): Promise<void> {
    this.enabled = on;
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ on }), { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
