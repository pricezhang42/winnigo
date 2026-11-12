import type { z } from 'zod/v4';
import type {
  eventExtractionSchema,
  extractionContextSchema,
  modelEventSchema,
} from './event-extraction.mjs';

// Inferred from the runtime schemas so TypeScript cannot drift from validation.
/** The model's raw output (format v2). */
export type EventExtraction = z.infer<typeof eventExtractionSchema>;
export type ExtractedEvent = z.infer<typeof modelEventSchema>;
export type ExtractionContext = z.infer<typeof extractionContextSchema>;
