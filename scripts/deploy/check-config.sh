#!/bin/sh
set -eu

missing=''

record_missing() {
    if [ -n "$missing" ]; then
        missing="$missing $1"
    else
        missing=$1
    fi
}

has_non_whitespace() {
    case $1 in
        *[![:space:]]*) return 0 ;;
        *) return 1 ;;
    esac
}

if has_non_whitespace "${CF_ACCESS_TEAM_DOMAIN-}"; then
    printf 'CF_ACCESS_TEAM_DOMAIN: present (length %s)\n' "${#CF_ACCESS_TEAM_DOMAIN}"
else
    printf 'CF_ACCESS_TEAM_DOMAIN: missing (length 0)\n'
    record_missing CF_ACCESS_TEAM_DOMAIN
fi

if has_non_whitespace "${CF_ACCESS_AUD-}"; then
    printf 'CF_ACCESS_AUD: present (length %s)\n' "${#CF_ACCESS_AUD}"
else
    printf 'CF_ACCESS_AUD: missing (length 0)\n'
    record_missing CF_ACCESS_AUD
fi

if has_non_whitespace "${CF_ACCESS_OWNER_SUB-}"; then
    printf 'CF_ACCESS_OWNER_SUB: present (length %s)\n' "${#CF_ACCESS_OWNER_SUB}"
else
    printf 'CF_ACCESS_OWNER_SUB: missing (length 0)\n'
    record_missing CF_ACCESS_OWNER_SUB
fi

if [ -n "$missing" ]; then
    printf 'ERROR: missing required deploy-time environment variable(s): %s\n' "$missing" >&2
    exit 1
fi

printf '%s\n' 'Deploy configuration check passed.'
