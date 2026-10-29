import type { PipeTransform } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Parses input with a Zod schema; a ZodError is rendered as a 400 by the filter. */
export class ZodValidationPipe implements PipeTransform {
  constructor(private readonly schema: ZodType) {}

  transform(value: unknown): unknown {
    return this.schema.parse(value);
  }
}
