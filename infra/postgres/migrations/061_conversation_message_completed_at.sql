BEGIN;

-- A pending browser message has only a start time. Persist an explicit finish
-- time once the complete turn has been accepted, so the UI never presents the
-- optimistic request timestamp as the delivered-message timestamp.
ALTER TABLE deviludo.conversation_messages
  ADD COLUMN completed_at timestamptz;

UPDATE deviludo.conversation_messages
   SET completed_at = created_at;

ALTER TABLE deviludo.conversation_messages
  ALTER COLUMN completed_at SET DEFAULT clock_timestamp(),
  ALTER COLUMN completed_at SET NOT NULL,
  ADD CONSTRAINT conversation_messages_completed_after_creation
    CHECK (completed_at >= created_at);

COMMIT;
