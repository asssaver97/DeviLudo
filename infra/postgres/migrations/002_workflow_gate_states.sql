-- Enum values have to commit before functions may use them, so this migration is
-- deliberately separate from 003 and is executed in its own transaction.
ALTER TYPE deviludo.workflow_state ADD VALUE IF NOT EXISTS 'ASSET_GENERATING' AFTER 'AGENT_RUNNING';
ALTER TYPE deviludo.workflow_state ADD VALUE IF NOT EXISTS 'RELEASE_APPROVAL_PENDING' AFTER 'SIGNING';
