export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_accounts',
    sql: `
      CREATE TABLE users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        email text NOT NULL UNIQUE CHECK (email = lower(email)),
        name text NOT NULL,
        password_hash text NOT NULL,
        email_verified_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE organizations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        slug text NOT NULL UNIQUE,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE memberships (
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, user_id)
      );
      CREATE INDEX memberships_user_idx ON memberships (user_id, created_at);

      CREATE TABLE sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        org_id uuid REFERENCES organizations (id) ON DELETE SET NULL,
        token_hash text NOT NULL UNIQUE,
        user_agent text,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_used_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL
      );
      CREATE INDEX sessions_user_idx ON sessions (user_id);
      CREATE INDEX sessions_expires_idx ON sessions (expires_at);

      CREATE TABLE user_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('verify_email', 'reset_password')),
        token_hash text NOT NULL UNIQUE,
        expires_at timestamptz NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX user_tokens_user_idx ON user_tokens (user_id, kind);

      CREATE TABLE invitations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        email text NOT NULL CHECK (email = lower(email)),
        role text NOT NULL CHECK (role IN ('admin', 'member', 'viewer')),
        token_hash text NOT NULL UNIQUE,
        invited_by uuid REFERENCES users (id) ON DELETE SET NULL,
        expires_at timestamptz NOT NULL,
        accepted_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX invitations_pending_idx
        ON invitations (org_id, email) WHERE accepted_at IS NULL;
    `,
  },
  {
    id: '002_monitoring',
    sql: `
      CREATE TABLE monitors (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        type text NOT NULL CHECK (type IN ('http', 'keyword', 'tcp', 'ping', 'dns', 'ssl', 'heartbeat')),
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        interval_sec integer NOT NULL CHECK (interval_sec BETWEEN 20 AND 86400),
        timeout_ms integer NOT NULL DEFAULT 10000 CHECK (timeout_ms BETWEEN 1000 AND 60000),
        failure_threshold integer NOT NULL DEFAULT 2 CHECK (failure_threshold BETWEEN 1 AND 10),
        tags text[] NOT NULL DEFAULT '{}',
        paused boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'up', 'degraded', 'down', 'paused')),
        status_since timestamptz NOT NULL DEFAULT now(),
        consecutive_failures integer NOT NULL DEFAULT 0,
        last_checked_at timestamptz,
        last_response_ms integer,
        last_message text,
        next_check_at timestamptz NOT NULL DEFAULT now(),
        heartbeat_token text UNIQUE,
        ssl_expires_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX monitors_org_idx ON monitors (org_id, created_at);
      CREATE INDEX monitors_due_idx ON monitors (next_check_at) WHERE NOT paused;

      CREATE TABLE check_results (
        id bigserial PRIMARY KEY,
        monitor_id uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
        checked_at timestamptz NOT NULL DEFAULT now(),
        status text NOT NULL CHECK (status IN ('up', 'degraded', 'down')),
        response_ms integer,
        status_code integer,
        message text NOT NULL DEFAULT ''
      );
      CREATE INDEX check_results_monitor_idx ON check_results (monitor_id, checked_at DESC);
      CREATE INDEX check_results_time_idx ON check_results (checked_at);

      CREATE TABLE monitor_rollups (
        monitor_id uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
        bucket timestamptz NOT NULL,
        checks integer NOT NULL,
        ups integer NOT NULL,
        timed integer NOT NULL,
        sum_ms bigint NOT NULL,
        min_ms integer,
        max_ms integer,
        PRIMARY KEY (monitor_id, bucket)
      );
      CREATE INDEX monitor_rollups_bucket_idx ON monitor_rollups (bucket);

      CREATE TABLE monitor_events (
        id bigserial PRIMARY KEY,
        monitor_id uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        at timestamptz NOT NULL DEFAULT now(),
        kind text NOT NULL CHECK (kind IN ('created', 'down', 'up', 'degraded', 'paused', 'resumed')),
        message text NOT NULL
      );
      CREATE INDEX monitor_events_org_idx ON monitor_events (org_id, at DESC);
      CREATE INDEX monitor_events_monitor_idx ON monitor_events (monitor_id, at DESC);
    `,
  },
  {
    id: '003_alerting',
    sql: `
      ALTER TABLE organizations ADD COLUMN incident_seq integer NOT NULL DEFAULT 0;

      CREATE TABLE notification_channels (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        type text NOT NULL CHECK (type IN ('email', 'slack', 'discord', 'telegram', 'ntfy', 'gotify', 'webhook')),
        config jsonb NOT NULL DEFAULT '{}'::jsonb,
        enabled boolean NOT NULL DEFAULT true,
        last_used_at timestamptz,
        last_error text,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX notification_channels_org_idx ON notification_channels (org_id, created_at);

      CREATE TABLE oncall_schedules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        members uuid[] NOT NULL DEFAULT '{}',
        anchor_at timestamptz NOT NULL DEFAULT now(),
        period_sec integer NOT NULL DEFAULT 604800 CHECK (period_sec BETWEEN 3600 AND 31536000),
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX oncall_schedules_org_idx ON oncall_schedules (org_id, created_at);

      CREATE TABLE escalation_policies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        steps jsonb NOT NULL DEFAULT '[]'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX escalation_policies_org_idx ON escalation_policies (org_id, created_at);

      CREATE TABLE alert_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        trigger text NOT NULL DEFAULT 'down' CHECK (trigger IN ('down', 'degraded')),
        severity text NOT NULL DEFAULT 'critical' CHECK (severity IN ('critical', 'warning', 'info')),
        for_sec integer NOT NULL DEFAULT 0 CHECK (for_sec BETWEEN 0 AND 86400),
        scope_all boolean NOT NULL DEFAULT false,
        monitor_ids uuid[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        channel_ids uuid[] NOT NULL DEFAULT '{}',
        policy_id uuid REFERENCES escalation_policies (id) ON DELETE SET NULL,
        notify_recovery boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX alert_rules_org_idx ON alert_rules (org_id, created_at);

      CREATE TABLE silences (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        scope_all boolean NOT NULL DEFAULT false,
        monitor_ids uuid[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        starts_at timestamptz NOT NULL,
        ends_at timestamptz NOT NULL,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CHECK (ends_at > starts_at)
      );
      CREATE INDEX silences_org_idx ON silences (org_id, ends_at DESC);

      CREATE TABLE maintenance_windows (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        scope_all boolean NOT NULL DEFAULT false,
        monitor_ids uuid[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        starts_at timestamptz NOT NULL,
        duration_sec integer NOT NULL CHECK (duration_sec BETWEEN 60 AND 2592000),
        repeat text NOT NULL DEFAULT 'none' CHECK (repeat IN ('none', 'daily', 'weekly')),
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX maintenance_windows_org_idx ON maintenance_windows (org_id, starts_at);

      CREATE TABLE incidents (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        number integer NOT NULL,
        monitor_id uuid REFERENCES monitors (id) ON DELETE SET NULL,
        monitor_name text NOT NULL,
        title text NOT NULL,
        cause text NOT NULL DEFAULT '',
        severity text NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
        status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
        trigger text NOT NULL CHECK (trigger IN ('down', 'degraded')),
        started_at timestamptz NOT NULL,
        acknowledged_at timestamptz,
        acknowledged_by uuid REFERENCES users (id) ON DELETE SET NULL,
        resolved_at timestamptz,
        resolved_by uuid REFERENCES users (id) ON DELETE SET NULL,
        resolution text,
        assignee_id uuid REFERENCES users (id) ON DELETE SET NULL,
        postmortem text NOT NULL DEFAULT '',
        postmortem_updated_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (org_id, number)
      );
      CREATE UNIQUE INDEX incidents_one_open_per_monitor
        ON incidents (monitor_id) WHERE status <> 'resolved' AND monitor_id IS NOT NULL;
      CREATE INDEX incidents_org_idx ON incidents (org_id, started_at DESC);
      CREATE INDEX incidents_monitor_idx ON incidents (monitor_id, started_at DESC);
      CREATE INDEX incidents_active_idx ON incidents (org_id) WHERE status <> 'resolved';

      CREATE TABLE incident_events (
        id bigserial PRIMARY KEY,
        incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        at timestamptz NOT NULL DEFAULT now(),
        kind text NOT NULL,
        actor_id uuid REFERENCES users (id) ON DELETE SET NULL,
        message text NOT NULL
      );
      CREATE INDEX incident_events_incident_idx ON incident_events (incident_id, at, id);

      CREATE TABLE notification_jobs (
        id bigserial PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
        rule_id uuid REFERENCES alert_rules (id) ON DELETE SET NULL,
        kind text NOT NULL CHECK (kind IN ('alert', 'escalation', 'recovery')),
        step integer NOT NULL DEFAULT 0,
        channel_id uuid REFERENCES notification_channels (id) ON DELETE SET NULL,
        schedule_id uuid REFERENCES oncall_schedules (id) ON DELETE SET NULL,
        target_label text NOT NULL,
        run_at timestamptz NOT NULL,
        locked_until timestamptz,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
        attempts integer NOT NULL DEFAULT 0,
        last_error text,
        finished_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX notification_jobs_dedupe
        ON notification_jobs (incident_id, kind, step, (COALESCE(channel_id, schedule_id)));
      CREATE INDEX notification_jobs_due_idx ON notification_jobs (run_at) WHERE status = 'pending';
      CREATE INDEX notification_jobs_incident_idx ON notification_jobs (incident_id);
    `,
  },
  {
    id: '004_servers',
    sql: `
      CREATE TABLE enrollment_tokens (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        token_hash text NOT NULL UNIQUE,
        prefix text NOT NULL,
        max_uses integer CHECK (max_uses IS NULL OR max_uses BETWEEN 1 AND 10000),
        uses integer NOT NULL DEFAULT 0,
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX enrollment_tokens_org_idx ON enrollment_tokens (org_id, created_at DESC);

      CREATE TABLE servers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        hostname text NOT NULL DEFAULT '',
        tags text[] NOT NULL DEFAULT '{}',
        machine_id text,
        agent_key_hash text NOT NULL UNIQUE,
        enrollment_token_id uuid REFERENCES enrollment_tokens (id) ON DELETE SET NULL,
        agent_version text NOT NULL DEFAULT '',
        os text NOT NULL DEFAULT '',
        platform text NOT NULL DEFAULT '',
        kernel text NOT NULL DEFAULT '',
        arch text NOT NULL DEFAULT '',
        cpu_count integer NOT NULL DEFAULT 0,
        mem_total bigint NOT NULL DEFAULT 0,
        swap_total bigint NOT NULL DEFAULT 0,
        boot_time timestamptz,
        ip text NOT NULL DEFAULT '',
        docker boolean NOT NULL DEFAULT false,
        systemd boolean NOT NULL DEFAULT false,
        interval_sec integer NOT NULL DEFAULT 15,
        last_seen_at timestamptz,
        latest jsonb NOT NULL DEFAULT '{}'::jsonb,
        snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX servers_machine_idx ON servers (org_id, machine_id) WHERE machine_id IS NOT NULL;
      CREATE INDEX servers_org_idx ON servers (org_id, created_at);

      CREATE TABLE server_metrics (
        server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
        ts timestamptz NOT NULL,
        cpu real,
        mem real,
        swap real,
        load1 real,
        disk real,
        net_in real,
        net_out real,
        PRIMARY KEY (server_id, ts)
      );
      CREATE INDEX server_metrics_ts_idx ON server_metrics (ts);

      CREATE TABLE server_monitors (
        server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
        monitor_id uuid NOT NULL REFERENCES monitors (id) ON DELETE CASCADE,
        PRIMARY KEY (server_id, monitor_id)
      );
      CREATE INDEX server_monitors_monitor_idx ON server_monitors (monitor_id);

      CREATE TABLE server_rules (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        metric text NOT NULL CHECK (metric IN ('offline', 'cpu', 'memory', 'swap', 'disk', 'load', 'net_in', 'net_out', 'container', 'service', 'process')),
        mode text NOT NULL DEFAULT 'threshold' CHECK (mode IN ('threshold', 'anomaly')),
        threshold double precision,
        sensitivity text NOT NULL DEFAULT 'medium' CHECK (sensitivity IN ('low', 'medium', 'high')),
        target text NOT NULL DEFAULT '',
        severity text NOT NULL DEFAULT 'warning' CHECK (severity IN ('critical', 'warning', 'info')),
        for_sec integer NOT NULL DEFAULT 300 CHECK (for_sec BETWEEN 0 AND 86400),
        scope_all boolean NOT NULL DEFAULT false,
        server_ids uuid[] NOT NULL DEFAULT '{}',
        tags text[] NOT NULL DEFAULT '{}',
        channel_ids uuid[] NOT NULL DEFAULT '{}',
        policy_id uuid REFERENCES escalation_policies (id) ON DELETE SET NULL,
        notify_recovery boolean NOT NULL DEFAULT true,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX server_rules_org_idx ON server_rules (org_id, created_at);

      CREATE TABLE server_rule_state (
        rule_id uuid NOT NULL REFERENCES server_rules (id) ON DELETE CASCADE,
        server_id uuid NOT NULL REFERENCES servers (id) ON DELETE CASCADE,
        subject text NOT NULL DEFAULT '',
        breach_since timestamptz NOT NULL,
        value double precision,
        detail text NOT NULL DEFAULT '',
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (rule_id, server_id, subject)
      );

      ALTER TABLE incidents
        ADD COLUMN source text NOT NULL DEFAULT 'monitor' CHECK (source IN ('monitor', 'server')),
        ADD COLUMN server_id uuid REFERENCES servers (id) ON DELETE SET NULL,
        ADD COLUMN server_rule_id uuid REFERENCES server_rules (id) ON DELETE SET NULL,
        ADD COLUMN subject text NOT NULL DEFAULT '';
      CREATE UNIQUE INDEX incidents_one_open_per_server_rule
        ON incidents (server_rule_id, server_id, subject)
        WHERE status <> 'resolved' AND server_rule_id IS NOT NULL AND server_id IS NOT NULL;
      CREATE INDEX incidents_server_idx ON incidents (server_id, started_at DESC);
      CREATE INDEX incidents_server_open_idx ON incidents (org_id) WHERE source = 'server' AND status <> 'resolved';

      ALTER TABLE notification_jobs
        ADD COLUMN server_rule_id uuid REFERENCES server_rules (id) ON DELETE SET NULL;
    `,
  },
  {
    id: '005_status_reports',
    sql: `
      ALTER TABLE incidents
        ADD COLUMN public_title text NOT NULL DEFAULT '',
        ADD COLUMN public_hidden boolean NOT NULL DEFAULT false,
        ADD COLUMN server_metric text NOT NULL DEFAULT '';
      UPDATE incidents i SET server_metric = r.metric
        FROM server_rules r
        WHERE i.server_rule_id = r.id AND i.source = 'server' AND i.server_metric = '';

      ALTER TABLE maintenance_windows
        ADD COLUMN public boolean NOT NULL DEFAULT false;

      CREATE TABLE status_pages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$'),
        name text NOT NULL,
        headline text NOT NULL DEFAULT '',
        website_url text NOT NULL DEFAULT '',
        logo_url text NOT NULL DEFAULT '',
        accent text NOT NULL DEFAULT '#0e7490' CHECK (accent ~ '^#[0-9a-fA-F]{6}$'),
        theme text NOT NULL DEFAULT 'auto' CHECK (theme IN ('auto', 'light', 'dark')),
        footer text NOT NULL DEFAULT '',
        published boolean NOT NULL DEFAULT false,
        history_days integer NOT NULL DEFAULT 90 CHECK (history_days BETWEEN 7 AND 90),
        custom_domain text,
        domain_token text NOT NULL DEFAULT replace(gen_random_uuid()::text, '-', ''),
        domain_verified_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX status_pages_org_idx ON status_pages (org_id, created_at);
      CREATE UNIQUE INDEX status_pages_domain_idx ON status_pages (custom_domain)
        WHERE custom_domain IS NOT NULL AND domain_verified_at IS NOT NULL;

      CREATE TABLE status_components (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        page_id uuid NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
        kind text NOT NULL CHECK (kind IN ('monitor', 'server')),
        monitor_id uuid REFERENCES monitors (id) ON DELETE CASCADE,
        server_id uuid REFERENCES servers (id) ON DELETE CASCADE,
        label text NOT NULL,
        group_name text NOT NULL DEFAULT '',
        position integer NOT NULL DEFAULT 0,
        CHECK ((kind = 'monitor' AND monitor_id IS NOT NULL AND server_id IS NULL)
            OR (kind = 'server' AND server_id IS NOT NULL AND monitor_id IS NULL)),
        UNIQUE (page_id, monitor_id),
        UNIQUE (page_id, server_id)
      );
      CREATE INDEX status_components_page_idx ON status_components (page_id, position);
      CREATE INDEX status_components_monitor_idx ON status_components (monitor_id) WHERE monitor_id IS NOT NULL;
      CREATE INDEX status_components_server_idx ON status_components (server_id) WHERE server_id IS NOT NULL;

      CREATE TABLE status_subscribers (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        page_id uuid NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
        email text NOT NULL CHECK (email = lower(email)),
        token text NOT NULL UNIQUE,
        confirmed_at timestamptz,
        confirmation_sent_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (page_id, email)
      );

      CREATE TABLE status_updates (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        state text NOT NULL CHECK (state IN ('investigating', 'identified', 'monitoring', 'resolved')),
        message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 2000),
        author_id uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX status_updates_incident_idx ON status_updates (incident_id, created_at);

      CREATE TABLE status_notified (
        page_id uuid NOT NULL REFERENCES status_pages (id) ON DELETE CASCADE,
        incident_id uuid NOT NULL REFERENCES incidents (id) ON DELETE CASCADE,
        last_state text NOT NULL,
        last_update_at timestamptz,
        attempts integer NOT NULL DEFAULT 0,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (page_id, incident_id)
      );

      CREATE TABLE digest_settings (
        org_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
        enabled boolean NOT NULL DEFAULT false,
        weekday smallint NOT NULL DEFAULT 1 CHECK (weekday BETWEEN 0 AND 6),
        hour smallint NOT NULL DEFAULT 8 CHECK (hour BETWEEN 0 AND 23),
        time_zone text NOT NULL DEFAULT 'UTC',
        recipients text NOT NULL DEFAULT 'admins' CHECK (recipients IN ('admins', 'everyone')),
        extra_emails text[] NOT NULL DEFAULT '{}',
        last_sent_at timestamptz,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '006_platform_security',
    sql: `
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        created_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        name text NOT NULL,
        prefix text NOT NULL,
        key_hash text NOT NULL UNIQUE,
        scopes text[] NOT NULL,
        expires_at timestamptz,
        last_used_at timestamptz,
        last_used_ip text,
        revoked_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX api_keys_org_idx ON api_keys (org_id, created_at DESC);

      CREATE TABLE webhook_endpoints (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        name text NOT NULL,
        url text NOT NULL,
        secret_enc text NOT NULL,
        events text[] NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        disabled_reason text NOT NULL DEFAULT '',
        consecutive_failures integer NOT NULL DEFAULT 0,
        last_success_at timestamptz,
        last_failure_at timestamptz,
        created_by uuid REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX webhook_endpoints_org_idx ON webhook_endpoints (org_id, created_at);

      CREATE TABLE webhook_deliveries (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        endpoint_id uuid NOT NULL REFERENCES webhook_endpoints (id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        event_id uuid NOT NULL,
        event_type text NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'success', 'failed')),
        attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL DEFAULT now(),
        response_status integer,
        response_snippet text NOT NULL DEFAULT '',
        error text NOT NULL DEFAULT '',
        duration_ms integer,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_attempt_at timestamptz,
        delivered_at timestamptz
      );
      CREATE INDEX webhook_deliveries_due_idx ON webhook_deliveries (next_attempt_at) WHERE status = 'pending';
      CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (endpoint_id, created_at DESC);
      CREATE INDEX webhook_deliveries_created_idx ON webhook_deliveries (created_at);

      CREATE TABLE audit_events (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        actor_type text NOT NULL CHECK (actor_type IN ('user', 'api_key', 'system')),
        actor_id uuid,
        actor_label text NOT NULL DEFAULT '',
        action text NOT NULL,
        target_type text NOT NULL DEFAULT '',
        target_id text NOT NULL DEFAULT '',
        summary text NOT NULL DEFAULT '',
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        ip text,
        user_agent text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX audit_events_org_idx ON audit_events (org_id, id DESC);
      CREATE INDEX audit_events_created_idx ON audit_events (created_at);

      CREATE FUNCTION audit_events_block_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'Audit events cannot be changed';
      END;
      $$;
      CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
        FOR EACH ROW EXECUTE FUNCTION audit_events_block_update();

      CREATE TABLE user_totp (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        secret_enc text NOT NULL,
        confirmed_at timestamptz,
        last_step bigint NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE user_recovery_codes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        code_hash text NOT NULL,
        used_at timestamptz,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX user_recovery_codes_user_idx ON user_recovery_codes (user_id);

      CREATE TABLE sso_connections (
        org_id uuid PRIMARY KEY REFERENCES organizations (id) ON DELETE CASCADE,
        issuer text NOT NULL,
        client_id text NOT NULL,
        client_secret_enc text NOT NULL,
        allowed_domains text[] NOT NULL,
        default_role text NOT NULL DEFAULT 'member' CHECK (default_role IN ('viewer', 'member', 'admin')),
        auto_provision boolean NOT NULL DEFAULT true,
        enabled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE sso_identities (
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        issuer text NOT NULL,
        subject text NOT NULL,
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (org_id, issuer, subject)
      );
      CREATE INDEX sso_identities_user_idx ON sso_identities (user_id);

      ALTER TABLE sessions ADD COLUMN sso_org_id uuid REFERENCES organizations (id) ON DELETE CASCADE;
    `,
  },
  {
    id: '007_experience',
    sql: `
      CREATE TABLE user_preferences (
        user_id uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
        locale text CHECK (locale IN ('en', 'fr', 'ar')),
        notify_categories text[] NOT NULL DEFAULT ARRAY['incidents', 'servers', 'team', 'system'],
        updated_at timestamptz NOT NULL DEFAULT now()
      );

      ALTER TABLE organizations ADD COLUMN onboarding_dismissed_at timestamptz;

      CREATE TABLE inbox_notices (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        audience text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'admins')),
        category text NOT NULL CHECK (category IN ('incidents', 'servers', 'team', 'system')),
        kind text NOT NULL,
        data jsonb NOT NULL DEFAULT '{}'::jsonb,
        dedupe text,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE UNIQUE INDEX inbox_notices_dedupe_idx ON inbox_notices (org_id, dedupe) WHERE dedupe IS NOT NULL;
      CREATE INDEX inbox_notices_org_idx ON inbox_notices (org_id, id DESC);
      CREATE INDEX inbox_notices_created_idx ON inbox_notices (created_at);

      CREATE TABLE inbox_state (
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        org_id uuid NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
        read_through bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, org_id)
      );

      CREATE TABLE inbox_reads (
        user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
        notice_id bigint NOT NULL REFERENCES inbox_notices (id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, notice_id)
      );
    `,
  },
];
