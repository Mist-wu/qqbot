import { readFile } from "node:fs/promises";

const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const EXPIRY_MARGIN_MS = 60 * 1000;
const SYNC_HINT = "在本机运行 deploy/sync-codex-auth.sh 同步";

export type CodexCredential = {
  access: string;
  expires: number;
  accountId: string;
};

export function accountIdFromToken(token: string): string {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("Codex access token 不是 JWT");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
  const auth = claims[JWT_CLAIM_PATH] as { chatgpt_account_id?: unknown } | undefined;
  if (typeof auth?.chatgpt_account_id !== "string" || !auth.chatgpt_account_id) {
    throw new Error("Codex access token 中没有 ChatGPT account ID");
  }
  return auth.chatgpt_account_id;
}

export async function readCredential(file: string): Promise<CodexCredential | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<CodexCredential>;
    if (!parsed.access || typeof parsed.expires !== "number") return undefined;
    return { access: parsed.access, expires: parsed.expires, accountId: parsed.accountId || accountIdFromToken(parsed.access) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

// Holds only an access token synced from the machine whose pi owns the refresh token. The bot never
// refreshes, so it cannot rotate that token away; a newer sync is picked up from disk.
export class CodexAuth {
  private credential: CodexCredential | undefined;

  constructor(private readonly file: string) {}

  async get(): Promise<CodexCredential> {
    if (!this.credential || this.credential.expires - Date.now() < EXPIRY_MARGIN_MS) {
      this.credential = await readCredential(this.file);
    }
    if (!this.credential) throw new Error(`没有 Codex 凭证 ${this.file}，${SYNC_HINT}`);
    if (this.credential.expires <= Date.now()) {
      const at = new Date(this.credential.expires).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
      throw new Error(`Codex access token 已于 ${at} 过期，${SYNC_HINT}`);
    }
    return this.credential;
  }

  async usable(): Promise<boolean> {
    try {
      await this.get();
      return true;
    } catch {
      return false;
    }
  }
}
