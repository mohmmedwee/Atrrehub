import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToOpenApi } from './zod-openapi';

describe('zodToOpenApi', () => {
  it('describes primitives with their formats', () => {
    expect(zodToOpenApi(z.string())).toEqual({ type: 'string' });
    expect(zodToOpenApi(z.string().email())).toEqual({ type: 'string', format: 'email' });
    expect(zodToOpenApi(z.string().url())).toEqual({ type: 'string', format: 'url' });
    expect(zodToOpenApi(z.string().datetime())).toEqual({ type: 'string', format: 'date-time' });
    expect(zodToOpenApi(z.boolean())).toEqual({ type: 'boolean' });
    expect(zodToOpenApi(z.date())).toEqual({ type: 'string', format: 'date-time' });
  });

  it('carries string and number bounds across', () => {
    expect(zodToOpenApi(z.string().min(2).max(80))).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 80,
    });
    expect(zodToOpenApi(z.number().int().min(1).max(500))).toEqual({
      type: 'integer',
      minimum: 1,
      maximum: 500,
    });
    expect(zodToOpenApi(z.number())).toEqual({ type: 'number' });
  });

  it('distinguishes required from optional properties', () => {
    const schema = z.object({ name: z.string(), nickname: z.string().optional() });
    const result = zodToOpenApi(schema);
    expect(result.required).toEqual(['name']);
    expect(result.properties?.nickname).toEqual({ type: 'string' });
  });

  it('treats a defaulted field as optional and publishes the default', () => {
    // The caller may omit it, which is the whole point of a default, so a
    // document that marks it required would make every generated client wrong.
    const result = zodToOpenApi(z.object({ limit: z.number().default(50) }));
    expect(result.required).toBeUndefined();
    expect(result.properties?.limit).toEqual({ type: 'number', default: 50 });
  });

  it('records whether unknown keys are rejected', () => {
    expect(zodToOpenApi(z.object({ a: z.string() }).strict()).additionalProperties).toBe(false);
    expect(zodToOpenApi(z.object({ a: z.string() })).additionalProperties).toBe(true);
  });

  it('describes enums, literals and arrays', () => {
    expect(zodToOpenApi(z.enum(['a', 'b']))).toEqual({ type: 'string', enum: ['a', 'b'] });
    expect(zodToOpenApi(z.literal('x'))).toEqual({ type: 'string', enum: ['x'] });
    expect(zodToOpenApi(z.array(z.string()).min(1).max(3))).toEqual({
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      maxItems: 3,
    });
  });

  it('describes records and unions', () => {
    expect(zodToOpenApi(z.record(z.string()))).toEqual({
      type: 'object',
      additionalProperties: { type: 'string' },
    });
    expect(zodToOpenApi(z.union([z.string(), z.number()])).oneOf).toEqual([
      { type: 'string' },
      { type: 'number' },
    ]);
  });

  it('marks nullable fields nullable without making them optional', () => {
    const result = zodToOpenApi(z.object({ closedAt: z.string().nullable() }));
    expect(result.required).toEqual(['closedAt']);
    expect(result.properties?.closedAt).toEqual({ type: 'string', nullable: true });
  });

  it('sees through a refinement to the shape underneath', () => {
    const schema = z.object({ a: z.string() }).refine(() => true);
    expect(zodToOpenApi(schema).properties?.a).toEqual({ type: 'string' });
  });

  it('nests objects and arrays of objects', () => {
    const schema = z.object({
      contacts: z.array(z.object({ value: z.string(), primary: z.boolean().optional() })),
    });
    const contacts = zodToOpenApi(schema).properties?.contacts;
    expect(contacts?.type).toBe('array');
    expect(contacts?.items?.required).toEqual(['value']);
  });

  it('degrades to an untyped schema rather than throwing on something it cannot describe', () => {
    // A build that fails because one endpoint uses an exotic schema is worse
    // than a document that is slightly vague about that one endpoint.
    expect(() => zodToOpenApi(z.any())).not.toThrow();
    expect(() => zodToOpenApi(z.unknown())).not.toThrow();
    expect(zodToOpenApi(z.any())).toEqual({});
  });

  it('handles the schemas the API actually uses', () => {
    const EndpointSchema = z
      .object({
        name: z.string().min(2).max(80),
        url: z.string().url().max(2000),
        events: z.array(z.string().min(1).max(80)).min(1).max(100),
        isActive: z.boolean().optional(),
      })
      .strict();

    expect(zodToOpenApi(EndpointSchema)).toEqual({
      type: 'object',
      additionalProperties: false,
      required: ['name', 'url', 'events'],
      properties: {
        name: { type: 'string', minLength: 2, maxLength: 80 },
        url: { type: 'string', format: 'url', maxLength: 2000 },
        events: {
          type: 'array',
          items: { type: 'string', minLength: 1, maxLength: 80 },
          minItems: 1,
          maxItems: 100,
        },
        isActive: { type: 'boolean' },
      },
    });

    // `.partial()` is what every PATCH handler applies, and it must make
    // everything optional rather than dropping the required list silently.
    expect(zodToOpenApi(EndpointSchema.partial()).required).toBeUndefined();
  });
});
