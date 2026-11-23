// Shared by picture descriptions and voice transcripts. A failure is dropped so the next look retries.
export class MediaCache {
  private readonly slots = new Map<string, Promise<string | undefined>>();

  constructor(private readonly max = 500) {}

  get size(): number {
    return this.slots.size;
  }

  get(key: string, load: () => Promise<string | undefined>): Promise<string | undefined> {
    const existing = this.slots.get(key);
    if (existing) return existing;
    const pending = load().then(
      (value) => {
        if (value === undefined && this.slots.get(key) === pending) this.slots.delete(key);
        return value;
      },
      (error: unknown) => {
        if (this.slots.get(key) === pending) this.slots.delete(key);
        throw error;
      },
    );
    this.slots.set(key, pending);
    if (this.slots.size > this.max) {
      const oldest = this.slots.keys().next().value;
      if (oldest !== undefined && oldest !== key) this.slots.delete(oldest);
    }
    return pending;
  }
}
