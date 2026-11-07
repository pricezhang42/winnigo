// Compile-time checks: inferred JS schemas must not degrade to any or omit nullable facts.
import type {
  EventExtraction,
  ExtractedEvent,
  ExtractionContext,
} from '../../lib/contracts/event-extraction';
type IsAny<T> = 0 extends 1 & T ? true : false;
type Assert<T extends true> = T;
type InferredEvent = Assert<IsAny<ExtractedEvent> extends false ? true : false>;
type InferredVenue = Assert<
  IsAny<NonNullable<ExtractedEvent['venue']>['name']> extends false ? true : false
>;
type NullableTitle = Assert<null extends ExtractedEvent['title'] ? true : false>;
type Version = Assert<EventExtraction['schemaVersion'] extends '1' ? true : false>;
type Winnipeg = Assert<ExtractionContext['timeZone'] extends 'America/Winnipeg' ? true : false>;
// @ts-expect-error Model output cannot set owner or repository fields.
type ForbiddenOverride = ExtractedEvent['override'];
export type ContractChecks =
  InferredEvent | InferredVenue | NullableTitle | Version | Winnipeg | ForbiddenOverride;
