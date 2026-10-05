import { describe, expect, it } from 'vitest';
import { parseMarkdown } from '../../../shared/markdown/parse';
import { serializeMarkdown } from '../../../shared/markdown/serialize';
import { canonicalDoc } from '../../../shared/markdown/canonical';
import { schema } from './helpers';
import { SAMPLES, fuzz } from './fuzzer';
describe('random edits always serialize to an equivalent document', () => {
  SAMPLES.forEach((sample, s) => {
    it(`sample ${s}`, () => fuzz(sample, 1000 + s, 80, 5));
  });
});

describe('generated output for documents without source', () => {
  SAMPLES.forEach((sample, s) => {
    it(`sample ${s}`, () => {
      const { doc } = parseMarkdown(sample, schema);
      const { base: emptyBase } = parseMarkdown('', schema);
      const text = serializeMarkdown(doc, emptyBase);
      expect(canonicalDoc(parseMarkdown(text, schema).doc)).toBe(canonicalDoc(doc));
    });
  });
});
