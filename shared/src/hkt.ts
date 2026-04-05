export interface TypeFn {
  readonly _contract: unknown;
  readonly _api: unknown;
}

export type Apply<F extends TypeFn, Contract> = (F & {
  readonly _contract: Contract;
})['_api'];
