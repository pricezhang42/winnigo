-- Configurable AI sources save review-mode results as `candidate` rows (no parser to compare).
ALTER TABLE event_extraction_comparisons
  DROP CONSTRAINT event_extraction_comparisons_outcome_check;
ALTER TABLE event_extraction_comparisons
  ADD CONSTRAINT event_extraction_comparisons_outcome_check
  CHECK (outcome IN ('agree', 'differ', 'withheld', 'failed', 'skipped', 'candidate'));
