/**
 * memoizeJsonSchema: each tool schema is converted to JSON Schema once per process,
 * not once per (stateless) request — without changing the result or validation.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { memoizeJsonSchema, isJsonSchemaMemoized, createServer } from '../../src/server/common.js';
import { controlLightSchema } from '../../src/tools/common.js';

type Std = {
  validate: (v: unknown) => unknown;
  jsonSchema: { input: (o?: unknown) => Record<string, unknown>; output: (o?: unknown) => Record<string, unknown> };
};
const std = (s: unknown): Std => (s as { '~standard': Std })['~standard'];

describe('memoizeJsonSchema', () => {
  it('converts once per schema and options, then serves the cache', () => {
    const schema = z.object({ a: z.string().describe('A') });
    const convert = vi.spyOn(std(schema).jsonSchema, 'input');
    memoizeJsonSchema(schema);

    const opts = { target: 'draft-2020-12' };
    const first = std(schema).jsonSchema.input(opts);
    const second = std(schema).jsonSchema.input(opts);
    expect(convert).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('returns an independent copy each time, so a caller mutating it cannot corrupt the cache', () => {
    const schema = z.object({ a: z.string() });
    memoizeJsonSchema(schema);
    const first = std(schema).jsonSchema.input({ target: 'draft-2020-12' });
    (first as { properties: Record<string, unknown> }).properties.injected = { type: 'string' };
    const second = std(schema).jsonSchema.input({ target: 'draft-2020-12' });
    expect(second).not.toHaveProperty('properties.injected');
  });

  it('produces exactly what the un-memoized converter produces', () => {
    const reference = std(z.object({ entity_id: z.string().describe('id'), n: z.number().int().min(1).optional() }))
      .jsonSchema.input({ target: 'draft-2020-12' });
    const schema = z.object({ entity_id: z.string().describe('id'), n: z.number().int().min(1).optional() });
    memoizeJsonSchema(schema);
    expect(std(schema).jsonSchema.input({ target: 'draft-2020-12' })).toEqual(reference);
  });

  it('leaves validation untouched', () => {
    const schema = z.object({ a: z.string() });
    memoizeJsonSchema(schema);
    expect(schema.safeParse({ a: 'ok' }).success).toBe(true);
    expect(schema.safeParse({ a: 1 }).success).toBe(false);
    expect(std(schema).validate({ a: 1 })).toHaveProperty('issues');
  });

  it('ignores values that are not converter-carrying schemas', () => {
    expect(() => memoizeJsonSchema(undefined)).not.toThrow();
    expect(() => memoizeJsonSchema({ shape: 'raw' })).not.toThrow();
  });

  it('is applied by createServer to every registered tool schema', () => {
    // (An own `~standard` property is NOT proof: zod defines it lazily on first read,
    // which the SDK does anyway. The memo's own membership set is the real signal.)
    expect(isJsonSchemaMemoized(controlLightSchema)).toBe(false);
    createServer({ haClient: {} as never });
    expect(isJsonSchemaMemoized(controlLightSchema)).toBe(true);
    // Later per-request builds reuse the same cached provider (no re-wrapping).
    const provider = std(controlLightSchema);
    createServer({ haClient: {} as never });
    expect(std(controlLightSchema)).toBe(provider);
  });
});
