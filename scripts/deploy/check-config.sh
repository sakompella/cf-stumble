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

is_git_object_id() {
    case ${#1} in
        40 | 64) ;;
        *) return 1 ;;
    esac

    case $1 in
        *[!0123456789abcdef]*) return 1 ;;
        *) return 0 ;;
    esac
}

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
