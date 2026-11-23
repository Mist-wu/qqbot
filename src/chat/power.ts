import { atomicWrite, readJson } from "../persist.js";

// Whether the bot is taking part in chats; toggled by admin commands and kept across restarts.
export class PowerSwitch {
  private enabled = true;

  constructor(private readonly file: string) {}

  get on(): boolean {
    return this.enabled;
  }

  async load(): Promise<void> {
    const state = await readJson<{ on?: unknown }>(this.file, { on: this.enabled });
    this.enabled = state.on !== false;
  }

  async set(on: boolean): Promise<void> {
    await atomicWrite(this.file, JSON.stringify({ on }), 0o600);
    this.enabled = on;
  }
}
