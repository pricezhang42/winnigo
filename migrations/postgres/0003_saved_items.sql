-- Saved discoveries in the account (docs/31 step 3). An item is a listing or an event ID; a saved
-- item that later disappears stays saved and is shown as no longer listed. Deleting the account
-- deletes its saved items.
CREATE TABLE saved_items (
  user_id text NOT NULL REFERENCES auth_user(id) ON DELETE CASCADE,
  item_id text NOT NULL CHECK (length(item_id) BETWEEN 1 AND 300),
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, item_id)
);
