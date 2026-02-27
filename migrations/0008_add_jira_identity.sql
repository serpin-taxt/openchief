-- Add Jira/Atlassian account ID to identity_mappings.
-- A single column covers Jira, JPD, and JSM since they share the same
-- Atlassian Cloud account ID namespace.

ALTER TABLE identity_mappings ADD COLUMN jira_account_id TEXT;
CREATE UNIQUE INDEX idx_identity_jira ON identity_mappings(jira_account_id);
