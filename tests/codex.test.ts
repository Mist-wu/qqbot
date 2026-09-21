import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { CodexAuth, accountIdFromToken } = await import("../src/search/codex-auth.js");

function jwt(accountId: string): string {
  const payload = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })).toString(
    "base64url",
  );
  return `h.${payload}.s`;
}

async function credentialFile(expires: number): Promise<string> {
  const file = join(await mkdtemp(join(tmpdir(), "qqbot-codex-")), "codex-auth.json");
  await writeFile(file, JSON.stringify({ access: jwt("acct-1"), expires }));
  return file;
}

globalThis.fetch = (async () => {
  throw new Error("the bot must never call the network for auth");
}) as typeof fetch;

test("reads the ChatGPT account id from the access token", () => {
  assert.equal(accountIdFromToken(jwt("acct-1")), "acct-1");
  assert.throws(() => accountIdFromToken("not-a-jwt"));
});

test("uses a synced access token without a refresh token", async () => {
  const auth = new CodexAuth(await credentialFile(Date.now() + 3_600_000));
  const credential = await auth.get();
  assert.equal(credential.accountId, "acct-1");
  assert.equal("refresh" in credential, false);
  assert.equal(await auth.usable(), true);
});

test("expired token is reported, and a newer sync is picked up without restart", async () => {
  const file = await credentialFile(Date.now() - 1000);
  const auth = new CodexAuth(file);
  await assert.rejects(auth.get(), /过期.*sync-codex-auth/);
  assert.equal(await auth.usable(), false);

  await writeFile(file, JSON.stringify({ access: jwt("acct-1"), expires: Date.now() + 3_600_000 }));
  assert.equal(await auth.usable(), true);
});

test("missing credential file makes search unusable", async () => {
  const auth = new CodexAuth(join(tmpdir(), "does-not-exist", "codex-auth.json"));
  assert.equal(await auth.usable(), false);
  await assert.rejects(auth.get(), /sync-codex-auth/);
});
