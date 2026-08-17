BEGIN;

-- Provider configuration belongs to Claude Code only. The selected local
-- runtime is intentionally not represented by a second Provider profile:
-- Codex CLI authentication is the host-owned official ChatGPT session.
DROP TABLE deviludo.instance_agent_provider_profiles;

COMMIT;
