/** Node has no `cloudflare:workers`. Host classes that only extend `RpcTarget` run here, called directly instead of over RPC. */
// oxlint-disable-next-line typescript/no-extraneous-class -- The runtime's base class adds nothing these classes use.
export class RpcTarget {}
