-- Optional PostgreSQL row-level security for regulated tenants.
--
-- The application always scopes queries by organization_id at the query layer
-- (see apps/api/src/core/prisma/tenant-guard.extension.ts). These policies add a
-- database-enforced second line of defence for deployments that require it.
--
-- Usage: the API sets `SET LOCAL app.current_org = '<org id>'` at transaction start
-- when ATRREHUB_DB_RLS=true.

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    'workspaces','memberships','roles','api_keys','audit_events','teams','queues',
    'business_hours','holidays','custom_fields','tags','customers','contact_methods',
    'customer_notes','segments','conversations','messages','participants',
    'tickets','ticket_comments','sla_policies','sla_clocks','routing_rules',
    'knowledge_bases','articles','documents','chunks','agents','agent_versions',
    'workflows','workflow_versions','executions','execution_steps','tool_definitions',
    'memory_entries','guardrail_policies','automation_rules','qc_templates',
    'qc_evaluations','notifications','usage_records','integrations','webhook_endpoints'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
      EXECUTE format(
        'CREATE POLICY tenant_isolation ON %I USING (organization_id = current_setting(''app.current_org'', true))',
        t
      );
    END IF;
  END LOOP;
END $$;
