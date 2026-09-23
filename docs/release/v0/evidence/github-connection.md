# GitHub connection observation

Observed on the owner's deployment, 2026-09-11.

`GET /api/projects` returned:

```json
{
  "ok": true,
  "projects": [
    {
      "kind": "repository",
      "id": "sakompella-emaily-demo",
      "displayName": "emaily-demo",
      "repositoryUrl": "https://github.com/sakompella/emaily-demo"
    },
    { "kind": "harness", "id": "harness", "displayName": "harness" }
  ],
  "github": { "state": "connected", "login": "sakompella", "source": "configured-token" }
}
```

A turn that listed the container showed `/workspace/AGENTS.md`, `/workspace/harness` at `ffdde44`, and `/workspace/projects/sakompella-emaily-demo` at its own HEAD `d500087`. One workspace held both repositories, and `git` worked in each.

The Worker's `GH_TOKEN` secret supplied the credential. The worker installed it with `gh auth login --with-token` on standard input after fix `7e49078`. Before that fix, the worker staged the token at `/tmp/cf-stumble-gh-token` through Computer's workspace filesystem. That filesystem has no `/tmp`, so every install failed and discarded the cause.

The `gh` credential lives in the container filesystem, not durable storage. A container recycle, including a deploy, removes it. When `GH_TOKEN` is set, the next connection reinstalls it.
