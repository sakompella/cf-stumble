declare module "node:buffer" {
  export const Buffer: { from(data: string | Uint8Array): Buffer };
}
