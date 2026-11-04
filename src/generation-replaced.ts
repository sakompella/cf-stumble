export const GENERATION_REPLACED = "this generation was replaced by another and no longer serves";

export function whileServing<A>(serves: () => boolean, call: () => Promise<A>): Promise<A> {
  return serves() ? call() : Promise.reject(new Error(GENERATION_REPLACED));
}
