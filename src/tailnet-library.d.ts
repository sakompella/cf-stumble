declare module "*tailnet/index.js" {
  export type Status = Readonly<{
    state: string;
    name?: string;
    addrs?: readonly string[];
    peers?: number;
    loginURL?: string;
    wasmMemoryBytes: number;
  }>;

  interface Node {
    ready(): Promise<Status>;
    status(): Status;
    fetch(request: Request): Promise<Response>;
    alarm(): Promise<void>;
    logout(): Promise<void>;
  }

  export const Tailnet: {
    start(
      ctx: DurableObjectState,
      options: {
        authKey: string | undefined;
        hostname: string;
        ephemeral: boolean;
        onLog: (line: string) => void;
      },
    ): Promise<Node>;
  };
}
