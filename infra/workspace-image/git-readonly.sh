#!/bin/sh

set -f

real_git="${CF_STUMBLE_REAL_GIT:-/usr/bin/git}"

if [ "${CF_STUMBLE_CONTAINER_GIT_WRITE:-}" = 1 ]; then
  exec "$real_git" "$@"
fi

has_word() {
  pattern="$1"
  shift
  for word in "$@"; do
    case "$word" in
      $pattern) return 0 ;;
    esac
  done
  return 1
}

has_any() {
  patterns="$1"
  shift
  for pattern in $patterns; do
    if has_word "$pattern" "$@"; then return 0; fi
  done
  return 1
}

positionals() {
  count=0
  skip=0
  first=""
  for word in "$@"; do
    if [ "$skip" = 1 ]; then
      skip=0
      continue
    fi
    case "$word" in
      -f | --file | --blob | --contains | --no-contains | --merged | --no-merged | --points-at | --sort | --format | --type | --default) skip=1 ;;
      -*) ;;
      *)
        count=$((count + 1))
        [ -n "$first" ] || first="$word"
        ;;
    esac
  done
}

listing() {
  modify="$1"
  list="$2"
  shift 2
  if has_any "$modify" "$@"; then
    echo write
  elif has_any "$list" "$@"; then
    echo read
  else
    positionals "$@"
    if [ "$count" = 0 ]; then echo read; else echo write; fi
  fi
}

verdict() {
  sub="$2"
  shift "$(($1 + 2))"
  case "$sub" in
    status | log | show | diff | blame | grep | ls-files | ls-tree | ls-remote | cat-file | rev-parse | rev-list | describe | shortlog | merge-base | for-each-ref | show-ref | archive | check-ignore | version | help | clone)
      echo read
      ;;
    config)
      positionals "$@"
      if has_any '--get* -l --list' "$@" || [ "$first" = get ] || [ "$first" = list ]; then
        echo read
      elif has_any '--unset* --add --replace-all --rename-section --remove-section -e --edit' "$@"; then
        echo write
      elif [ "$count" = 1 ]; then
        echo read
      else
        echo write
      fi
      ;;
    branch)
      listing '-d -D -m -M -c -C -f --delete --move --copy --force --set-upstream-to* -u --unset-upstream --edit-description' \
        '-l --list -a -r --all --remotes --show-current --contains --no-contains --merged --no-merged --points-at -v -vv' "$@"
      ;;
    tag)
      listing '-d -a -s -u -m -F -f --delete --annotate --sign --local-user* --message* --file* --force' \
        '-l --list -n* --contains --no-contains --merged --no-merged --points-at' "$@"
      ;;
    remote)
      positionals "$@"
      case "$first" in
        "" | show | get-url) echo read ;;
        *) echo write ;;
      esac
      ;;
    stash)
      positionals "$@"
      case "$first" in
        list | show) echo read ;;
        *) echo write ;;
      esac
      ;;
    *) echo write ;;
  esac
}

index=0
skip=0
sub=""
for word in "$@"; do
  index=$((index + 1))
  if [ "$skip" = 1 ]; then
    skip=0
    continue
  fi
  case "$word" in
    -C | -c | --git-dir | --work-tree | --namespace | --config-env) skip=1 ;;
    -*) ;;
    *)
      sub="$word"
      break
      ;;
  esac
done

if [ -z "$sub" ] || [ "$(verdict "$index" "$sub" "$@")" = read ]; then
  GIT_OPTIONAL_LOCKS=0 exec "$real_git" "$@"
fi

if [ "${CF_STUMBLE_GIT_FALLBACK:-}" = 1 ]; then
  printf 'git %s: the workspace git does not support this form. Use another form of the command.\n' "$sub" >&2
else
  printf 'git %s changes .git, so it only runs as its own command (no pipes, &&, or other programs), e.g. "git commit -m msg".\n' "$sub" >&2
fi
exit 1
