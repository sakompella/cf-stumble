# Night 1 Computer build facts

Input commit: `12336475c9fd03f5280a4537a707797fc0131fbd`

Clean execution path: `/tmp/cf-stumble-computer-proof`

Commands:

```sh
npm ci
npm run build --workspace @cloudflare/computer
```

Observed result:

- Build passed with rolldown 1.2.1.
- `packages/computer/dist` contains 78 files and occupies 10,732 KiB.
- The build left the clean source worktree unchanged.
- Runtime JavaScript contains no import from `@cloudflare/dofs` or `@cloudflare/computer-rpc`. One JSDoc example names `@cloudflare/dofs`.
- The emitted package keeps `acorn`, `capnweb`, and `just-bash` as dependencies. Optional peer dependencies remain `@platformatic/vfs`, `ai`, and `zod`.
- The emitted files contain `node:` imports. Worker compatibility must use the package's required compatibility flags and a real Worker bundle check rather than rejecting every `node:` specifier.
- A Wrangler dry run imported `Workspace`, `CloudflareContainerBackend`, and `WorkerShellBackend` from the emitted package with `nodejs_compat` and `experimental`. Wrangler produced a 3,370.66 KiB upload, 772.43 KiB compressed, without unresolved imports.
- `npm pack --workspace @cloudflare/computer` produced `cloudflare-computer-0.3.0.tgz`. The tarball is 2,405,549 bytes and expands to 10,820,145 bytes. This provides a canonical package file set without inventing a local facade.

Durable local evidence:

- `.audit/evidence/night1/computer-build.log`
- `.audit/evidence/night1/wrangler-dry-run.log`
- `.audit/evidence/night1/npm-pack.json`

The generated bundle and tarball remain reproducible outputs rather than durable records. The earlier `/tmp/computer-src` checkout contained untracked proof artifacts, so its build was not accepted as clean evidence.
