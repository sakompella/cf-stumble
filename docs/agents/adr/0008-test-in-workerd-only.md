# Test behaviour in workerd only

The project has one runtime for behavioural coverage and typechecking: workerd with Workers types, rather than a fast Node path plus a separate Workers suite. The code deploys in workerd, and the former Node setup had masked Worker-specific typing errors; one runtime makes a passing gate evidence about the program that will run.

Property-based tests are a bounded exception, not a repeal. Hegel's generation engine is a native library reached through FFI, and workerd exposes no Node-API and throws on `process.dlopen`, so a property test cannot run there at all — the choice is a Node project or no generative testing. What keeps the original reasoning intact is that Node only ever adds a generative layer over modules workerd already covers: every `<name>.props.test.ts` must have a `<name>.test.ts` beside it, so a green Node run can never be the only evidence that a module works.

## Consequences

`test/docs/props-siblings.test.ts` enforces that pairing and itself runs in workerd, so the guard holds even when the Node project is skipped or broken. Left as a convention the rule would decay silently, because nothing marks the day a property test lands without a sibling. Typechecking stays single-runtime: one `tsconfig.json` compiles the property tests too, against `@cloudflare/workers-types` only.
