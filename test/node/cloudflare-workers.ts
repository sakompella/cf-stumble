declare const rpcTargetBrand: unique symbol;

export class RpcTarget {
  declare readonly [rpcTargetBrand]: never;
}
