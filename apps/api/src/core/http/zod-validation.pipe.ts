import { Injectable, type ArgumentMetadata, type PipeTransform } from '@nestjs/common';
import { ZodError, type ZodSchema } from 'zod';
import { AppError } from '../errors/app-error';

/**
 * Validates a payload against a Zod schema and returns the parsed value, so
 * handlers receive coerced, trimmed, fully typed input. Unknown properties are
 * stripped by the schemas themselves (`.strict()` where rejection matters).
 */
@Injectable()
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodSchema) {}

  transform(value: unknown, _metadata: ArgumentMetadata) {
    try {
      return this.schema.parse(value);
    } catch (error) {
      if (error instanceof ZodError) {
        throw AppError.validation(
          'The request failed validation',
          error.issues.map((issue) => ({
            path: issue.path.join('.') || '(root)',
            message: issue.message,
          })),
        );
      }
      throw error;
    }
  }
}

/** `@Body(zodBody(CreateTicketSchema))` reads better than constructing the pipe inline. */
export const zodBody = (schema: ZodSchema) => new ZodValidationPipe(schema);
export const zodQuery = (schema: ZodSchema) => new ZodValidationPipe(schema);
