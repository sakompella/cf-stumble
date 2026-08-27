# Test behaviour in workerd only

The project uses one runtime for behavioural coverage and typechecking: workerd with Workers types, rather than a fast Node path and a separate Workers suite. The code deploys in workerd, and the old Node setup masked Worker-specific typing errors. One runtime makes a passing gate evidence about the program that will run.

Property-based tests are a bounded exception, not a repeal. Hegel's generation engine is a native library reached through FFI, and workerd exposes no Node-API and throws on `process.dlopen`, so property tests cannot run there. The choice is a Node project or no generative testing. Node only adds a generative layer over modules workerd already covers: every `<name>.props.test.ts` needs a `<name>.test.ts` beside it, so a green Node run is never the only evidence that a module works.

## Consequences

`test/docs/props-siblings.test.ts` enforces that pairing and runs in workerd itself, so the guard holds even when the Node project is skipped or broken. A convention would decay silently because nothing would mark the day a property test landed without a sibling. Typechecking stays in one runtime: one `tsconfig.json` compiles the property tests too, against `@cloudflare/workers-types` only.
