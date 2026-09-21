#!/usr/bin/env bash
# Push this machine's pi openai-codex access token to the bot. The refresh token stays here, so
# only the local pi ever refreshes it. Run again after pi has refreshed an expired token.
set -euo pipefail

HOST="${1:?用法: deploy/sync-codex-auth.sh user@host}"

python3 - <<'EOF' | ssh "$HOST" 'umask 077; mkdir -p ~/qqbot/data && cat > ~/qqbot/data/codex-auth.json.tmp && mv ~/qqbot/data/codex-auth.json.tmp ~/qqbot/data/codex-auth.json'
import json, os, sys, time
cred = json.load(open(os.path.expanduser("~/.pi/agent/auth.json")))["openai-codex"]
hours = (cred["expires"] / 1000 - time.time()) / 3600
if hours <= 0:
    sys.exit("本机 pi 的 codex token 已过期：先在 pi 里用一次 openai-codex 模型让它刷新，再重新同步")
print(json.dumps({"access": cred["access"], "expires": cred["expires"], "accountId": cred["accountId"]}))
print(f"同步 access token，剩余 {hours:.1f} 小时", file=sys.stderr)
EOF
