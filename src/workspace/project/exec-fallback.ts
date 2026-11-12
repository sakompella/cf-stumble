import * as Data from "effect/Data";
import type {
  BackendExecEvent,
  ExecBackend,
  ExecBackendHandle,
  ExecBackendInput,
} from "./exec-backend.js";
import { commandMayWrite } from "./exec-routing.js";
import type { ExecBackendChoice } from "./protocol.js";

type BackendRead = Awaited<ReturnType<ExecBackendHandle["reader"]["read"]>>;

type StderrEvent = Extract<BackendExecEvent, { name: "stderr" }>;

type Phase = Data.TaggedEnum<{
  Holding: { readonly isolate: ExecBackendHandle; readonly held: readonly StderrEvent[] };
  StartingContainer: object;
  Passing: { readonly handle: ExecBackendHandle; readonly fellBack: boolean };
  Abandoned: { readonly backend: ExecBackendChoice; readonly fellBack: boolean };
}>;

const Phase = Data.taggedEnum<Phase>();

type FallbackEvent = Data.TaggedEnum<{
  IsolateRead: { readonly read: BackendRead };
  IsolateBroke: object;
  ContainerStarted: { readonly handle: ExecBackendHandle };
  Abandon: object;
}>;

const FallbackEvent = Data.taggedEnum<FallbackEvent>();

type FallbackCommand = Data.TaggedEnum<{
  Deliver: { readonly events: readonly BackendExecEvent[] };
  StartContainer: object;
  Stop: { readonly handle: ExecBackendHandle };
}>;

const FallbackCommand = Data.taggedEnum<FallbackCommand>();

type Step = Readonly<{ phase: Phase; commands: readonly FallbackCommand[] }>;

function step(phase: Phase, ...commands: readonly FallbackCommand[]): Step {
  return { phase, commands };
}

const ISOLATE_REFUSED_EXIT_CODE = 129;

const NOTHING_RAN_EXIT_CODES: ReadonlySet<number> = new Set([127, ISOLATE_REFUSED_EXIT_CODE]);

const DECODER = new TextDecoder();

const ISOLATE_LIMIT_EXIT_CODE = 126;

const ISOLATE_DEADLINE_EXIT_CODE = 124;

const ISOLATE_LIMIT_MARKERS: readonly RegExp[] = [
  /limit exceeded/u,
  /maximum recursion depth/u,
  /too many commands executed/u,
  /total output size exceeded/u,
];

const ISOLATE_DEADLINE_MARKER = /exceeded (?:its )?execution deadline/u;

const ENCODER = new TextEncoder();

const RERUN_NOTE: StderrEvent = {
  name: "stderr",
  data: ENCODER.encode("rerun with backend: container\n"),
};

function isolateLimitExceeded(held: readonly StderrEvent[], exitCode: number): boolean {
  const stderr = held.map((event) => DECODER.decode(event.data)).join("");

  if (exitCode === ISOLATE_LIMIT_EXIT_CODE) {
    return ISOLATE_LIMIT_MARKERS.some((marker) => marker.test(stderr));
  }

  return exitCode === ISOLATE_DEADLINE_EXIT_CODE && ISOLATE_DEADLINE_MARKER.test(stderr);
}

function startingContainer(isolate: ExecBackendHandle): Step {
  return step(
    Phase.StartingContainer(),
    FallbackCommand.StartContainer(),
    FallbackCommand.Stop({ handle: isolate }),
  );
}

function passingIsolate(isolate: ExecBackendHandle, events: readonly BackendExecEvent[]): Step {
  return step(
    Phase.Passing({ handle: isolate, fellBack: false }),
    FallbackCommand.Deliver({ events }),
  );
}

function holdingRead(
  isolate: ExecBackendHandle,
  held: readonly StderrEvent[],
  read: BackendRead,
  mayWrite: boolean,
): Step {
  const passing = (events: readonly BackendExecEvent[]) => passingIsolate(isolate, events);

  if (read.done) {
    return mayWrite ? passing([...held, RERUN_NOTE]) : startingContainer(isolate);
  }

  const event = read.value;

  if (event.name === "stderr") return step(Phase.Holding({ isolate, held: [...held, event] }));

  if (event.name === "exit" && NOTHING_RAN_EXIT_CODES.has(event.exitCode)) {
    return step(Phase.StartingContainer(), FallbackCommand.StartContainer());
  }

  if (event.name === "exit" && isolateLimitExceeded(held, event.exitCode)) {
    return mayWrite
      ? passing([...held, RERUN_NOTE, event])
      : step(Phase.StartingContainer(), FallbackCommand.StartContainer());
  }

  return passing([...held, event]);
}

function transition(phase: Phase, event: FallbackEvent, mayWrite: boolean): Step {
  const stay = step(phase);

  const stopLate = (handle: ExecBackendHandle) => step(phase, FallbackCommand.Stop({ handle }));

  return Phase.$match(phase, {
    Holding: ({ isolate, held }) =>
      FallbackEvent.$match(event, {
        IsolateRead: ({ read }) => holdingRead(isolate, held, read, mayWrite),
        IsolateBroke: () =>
          mayWrite ? passingIsolate(isolate, [...held, RERUN_NOTE]) : startingContainer(isolate),
        ContainerStarted: ({ handle }) => stopLate(handle),
        Abandon: () =>
          step(
            Phase.Abandoned({ backend: isolate.backend, fellBack: false }),
            FallbackCommand.Stop({ handle: isolate }),
          ),
      }),
    StartingContainer: () =>
      FallbackEvent.$match(event, {
        IsolateRead: () => stay,
        IsolateBroke: () => stay,
        ContainerStarted: ({ handle }) => step(Phase.Passing({ handle, fellBack: true })),
        Abandon: () => step(Phase.Abandoned({ backend: "container", fellBack: true })),
      }),
    Passing: ({ handle, fellBack }) =>
      FallbackEvent.$match(event, {
        IsolateRead: () => stay,
        IsolateBroke: () => stay,
        ContainerStarted: ({ handle: late }) => stopLate(late),
        Abandon: () =>
          step(
            Phase.Abandoned({ backend: handle.backend, fellBack }),
            FallbackCommand.Stop({ handle }),
          ),
      }),
    Abandoned: () =>
      FallbackEvent.$match(event, {
        IsolateRead: () => stay,
        IsolateBroke: () => stay,
        ContainerStarted: ({ handle }) => stopLate(handle),
        Abandon: () => stay,
      }),
  });
}

function fallbackInput(input: ExecBackendInput): ExecBackendInput {
  return { ...input, backend: "container" };
}

function stopHandle(handle: ExecBackendHandle): Promise<void> {
  return Promise.allSettled([handle.reader.cancel(), handle.kill()]).then(() => {});
}

class FallbackExec implements ExecBackendHandle {
  readonly #container: ExecBackend;
  readonly #input: ExecBackendInput;
  readonly #mayWrite: boolean;
  readonly #ready: BackendExecEvent[] = [];
  #phase: Phase;
  #starting: Promise<void> = Promise.resolve();
  #isolateExitCode: number | undefined;

  readonly reader: ExecBackendHandle["reader"] = {
    read: () => this.#read(),
    cancel: () => this.#dispatch(FallbackEvent.Abandon()),
  };

  constructor(isolate: ExecBackendHandle, container: ExecBackend, input: ExecBackendInput) {
    this.#phase = Phase.Holding({ isolate, held: [] });
    this.#container = container;
    this.#input = input;
    this.#mayWrite = commandMayWrite(input.command);
  }

  kill(): Promise<void> {
    return this.#dispatch(FallbackEvent.Abandon());
  }

  get backend(): ExecBackendChoice {
    return Phase.$match(this.#phase, {
      Holding: ({ isolate }) => isolate.backend,
      StartingContainer: (): ExecBackendChoice => "container",
      Passing: ({ handle }) => handle.backend,
      Abandoned: ({ backend }) => backend,
    });
  }

  get fellBackFrom(): "isolate" | undefined {
    const fellBack = Phase.$match(this.#phase, {
      Holding: () => false,
      StartingContainer: () => true,
      Passing: (passing) => passing.fellBack,
      Abandoned: (abandoned) => abandoned.fellBack,
    });

    return fellBack ? "isolate" : undefined;
  }

  get isolateRefused(): boolean {
    return this.#isolateExitCode === ISOLATE_REFUSED_EXIT_CODE;
  }

  #dispatch(event: FallbackEvent): Promise<void> {
    const { phase, commands } = transition(this.#phase, event, this.#mayWrite);
    this.#phase = phase;

    return Promise.all(commands.map((command) => this.#perform(command))).then(() => {});
  }

  #perform(command: FallbackCommand): Promise<void> {
    return FallbackCommand.$match(command, {
      Deliver: ({ events }) => {
        this.#ready.push(...events);

        return Promise.resolve();
      },
      StartContainer: () => {
        this.#starting = this.#container
          .exec(fallbackInput(this.#input))
          .then((handle) => this.#dispatch(FallbackEvent.ContainerStarted({ handle })));
        this.#starting.catch(() => {});

        return Promise.resolve();
      },
      Stop: ({ handle }) => stopHandle(handle),
    });
  }

  async #read(): Promise<BackendRead> {
    for (;;) {
      const next = this.#ready.shift();

      if (next !== undefined) return { done: false, value: next };

      const read = await this.#advance();

      if (read !== null) return read;
    }
  }

  #advance(): Promise<BackendRead | null> {
    return Phase.$match(this.#phase, {
      Holding: ({ isolate }) =>
        isolate.reader
          .read()
          .then(
            (read) => {
              if (read.value?.name === "exit") this.#isolateExitCode = read.value.exitCode;

              return this.#dispatch(FallbackEvent.IsolateRead({ read }));
            },
            () => this.#dispatch(FallbackEvent.IsolateBroke()),
          )
          .then(() => null),
      StartingContainer: () => this.#starting.then(() => null),
      Passing: ({ handle }): Promise<BackendRead | null> => handle.reader.read(),
      Abandoned: (): Promise<BackendRead | null> => Promise.resolve({ done: true }),
    });
  }
}

export function isolateWithContainerFallback(
  isolate: ExecBackend,
  container: ExecBackend,
): ExecBackend {
  return {
    exec: async (input) => new FallbackExec(await isolate.exec(input), container, input),
  };
}
