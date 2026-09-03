#!/usr/bin/env bash
# Run the Worker locally with the throwaway Access session from scripts/local/access-session.mjs.
#
# Cloudflare Access sits in front of the deployed Worker, not in front of `wrangler dev`. This
# script supplies the same configuration values the deployed Worker reads, so local runs
# exercise the real verification path instead of a bypass. It fails closed when no session exists.
set -euo pipefail

SESSION_FILE=".audit/local/access-session.json"

if [ ! -f "$SESSION_FILE" ]; then
  printf 'No local Access session. Run: pnpm local:access-session\n' >&2
  exit 1
fi

read_field() {
  node -e "process.stdout.write(String(JSON.parse(require('fs').readFileSync('$SESSION_FILE','utf8'))['$1']))"
}

TEAM_DOMAIN="$(read_field teamDomain)"
AUDIENCE="$(read_field audience)"
PUBLIC_KEYS="$(read_field publicKeys)"
EXPIRES_AT="$(read_field expiresAt)"
SUBJECT="$(read_field subject)"

if [ "$EXPIRES_AT" -le "$(date +%s)" ]; then
  printf 'The local Access session expired. Run: pnpm local:access-session\n' >&2
  exit 1
fi

printf 'Local Access session: team %s, audience %s\n' "$TEAM_DOMAIN" "$AUDIENCE"

exec wrangler dev \
  --var "CF_ACCESS_TEAM_DOMAIN:$TEAM_DOMAIN" \
  --var "CF_ACCESS_AUD:$AUDIENCE" \
  --var "CF_ACCESS_PUBLIC_KEYS:$PUBLIC_KEYS" \
  --var "CF_ACCESS_OWNER_SUB:$SUBJECT" \
  "$@"
