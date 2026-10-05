import { it } from 'vitest';
import { SAMPLES, fuzz } from './fuzzer';
const ROUNDS = Number(process.env.FUZZ_ROUNDS ?? 0);
const SEED = Number(process.env.FUZZ_SEED ?? 5000);
SAMPLES.forEach((sample, s) => {
  it.skipIf(!ROUNDS)(`heavy fuzz sample ${s}`, () => fuzz(sample, SEED + s, ROUNDS, 6), 1_200_000);
});
