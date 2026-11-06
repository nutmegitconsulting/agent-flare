// Provided by the nodejs_compat flag. The project doesn't pull in Node's types for one class.
declare module "node:async_hooks" {
  export class AsyncLocalStorage<T> {
    getStore(): T | undefined;
    run<R>(store: T, callback: () => R): R;
  }
}
