#!/bin/sh
set -eu

missing=''
malformed=''

record_missing() {
    if [ -n "$missing" ]; then
        missing="$missing $1"
    else
        missing=$1
    fi
}

record_malformed() {
    if [ -n "$malformed" ]; then
        malformed="$malformed $1"
    else
        malformed=$1
    fi
}

has_non_whitespace() {
    case $1 in
        *[![:space:]]*) return 0 ;;
        *) return 1 ;;
    esac
}

# A generation is a full SHA-1 or SHA-256 harness commit. A branch name or a short ref fails here
# rather than at the submission that creates Generation 0.
is_git_object_id() {
    case ${#1} in
        40 | 64) ;;
        *) return 1 ;;
    esac

    # The character list is written out because a range like [0-9a-f] also matches uppercase
    # under a collation that interleaves the two cases, and the Supervisor accepts lowercase only.
    case $1 in
        *[!0123456789abcdef]*) return 1 ;;
        *) return 0 ;;
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

# The deployed harness commit becomes Generation 0. Nothing is built into the Worker: after the
# deploy, the owner submits this commit, the Supervisor labels and prepares it, and the owner
# activates it. A deploy without it would serve nothing, so the guard requires it.
if has_non_whitespace "${CF_STUMBLE_HARNESS_COMMIT-}"; then
    if is_git_object_id "$CF_STUMBLE_HARNESS_COMMIT"; then
        printf 'CF_STUMBLE_HARNESS_COMMIT: present (length %s)\n' "${#CF_STUMBLE_HARNESS_COMMIT}"
    else
        printf 'CF_STUMBLE_HARNESS_COMMIT: malformed (length %s)\n' "${#CF_STUMBLE_HARNESS_COMMIT}"
        record_malformed CF_STUMBLE_HARNESS_COMMIT
    fi
else
    printf 'CF_STUMBLE_HARNESS_COMMIT: missing (length 0)\n'
    record_missing CF_STUMBLE_HARNESS_COMMIT
fi

if [ -n "$missing" ]; then
    printf 'ERROR: missing required deploy-time environment variable(s): %s\n' "$missing" >&2
fi

if [ -n "$malformed" ]; then
    printf 'ERROR: malformed deploy-time environment variable(s): %s\n' "$malformed" >&2
fi

if [ -n "$missing" ] || [ -n "$malformed" ]; then
    exit 1
fi

printf '%s\n' 'Deploy configuration check passed.'
