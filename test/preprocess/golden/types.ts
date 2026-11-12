import type { PreprocessInput } from '../../../src/core/contracts';

/** Source of one golden fixture; `expected` is produced by `UPDATE_GOLDEN=1` and then reviewed. */
export interface GoldenCase {
  /** Starts with the spec ID it pins down, e.g. `PRE-05 ...`. Also the fixture file name. */
  name: string;
  input: PreprocessInput;
}
