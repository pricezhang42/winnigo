import type { z } from 'zod/v4';
import type {
  eventExtractionSchema,
  extractionContextSchema,
  extractedDateSchema,
  extractedEventSchema,
} from './event-extraction.mjs';

export type EventExtraction = z.infer<typeof eventExtractionSchema>;
export type ExtractionContext = z.infer<typeof extractionContextSchema>;
export type ExtractedDate = z.infer<typeof extractedDateSchema>;
export type ExtractedEvent = z.infer<typeof extractedEventSchema>;
