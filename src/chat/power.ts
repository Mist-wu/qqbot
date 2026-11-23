import { readFile } from "node:fs/promises";

import { atomicWrite } from "../persist.js";

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
    await atomicWrite(this.file, JSON.stringify({ on }), 0o600);
    this.enabled = on;
  }
}
