declare const rpcTargetBrand: unique symbol;

export class RpcTarget {
  declare readonly [rpcTargetBrand]: never;
}

export class WorkerEntrypoint {
  declare readonly ctx: never;
  declare readonly env: never;
}
