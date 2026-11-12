/** Placeholder used by M0 stubs; every call site must be replaced during M1. */
export function notImplemented(where: string): never {
  throw new Error(`not implemented: ${where}`);
}
