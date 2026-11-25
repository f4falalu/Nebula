-- Nebula V2 schema (PRD v2.0 §31). Timestamps are UTC timestamptz; business
-- dates are Africa/Lagos. Rules from §31.8 are enforced here, not only in the API.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------- enums
CREATE TYPE role_code AS ENUM ('ra', 'supervisor', 'admin');
CREATE TYPE record_status AS ENUM ('draft', 'processing', 'validation_pending', 'validated', 'finalized', 'reopened', 'cancelled');
CREATE TYPE operational_stage AS ENUM ('finance', 'invoicing', 'pick_and_pack', 'dispatched', 'completed');
CREATE TYPE lifecycle_event_status AS ENUM ('completed', 'not_applicable');
CREATE TYPE fulfillment_status AS ENUM ('open', 'partial', 'closed');
CREATE TYPE fulfillment_stage AS ENUM ('invoiced', 'issued', 'delivered');
CREATE TYPE record_type AS ENUM ('entry', 'correction', 'void');
CREATE TYPE conversion_status AS ENUM ('resolved', 'unknown', 'incompatible');
CREATE TYPE approval_status AS ENUM ('proposed', 'approved', 'rejected', 'retired');
CREATE TYPE alias_status AS ENUM ('candidate', 'approved', 'rejected');
CREATE TYPE edit_request_status AS ENUM ('pending', 'approved', 'rejected', 'used', 'expired', 'withdrawn');
CREATE TYPE document_category AS ENUM ('original_requisition', 'processed', 'lifecycle_evidence', 'supporting');
CREATE TYPE job_status AS ENUM ('queued', 'processing', 'completed', 'failed');
CREATE TYPE user_status AS ENUM ('pending', 'active', 'inactive');

-- Raise unless the transaction declared an approved edit context.
CREATE FUNCTION nebula_setting(name text) RETURNS text LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('nebula.' || name, true), '') $$;

CREATE FUNCTION forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'P0001';
END $$;

-- ---------------------------------------------------------------- identity
CREATE TABLE users (
  id text PRIMARY KEY,
  clerk_user_id text UNIQUE,
  email text,
  full_name text,
  status user_status NOT NULL DEFAULT 'pending',
  role role_code,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE permission_grants (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  permission text NOT NULL CHECK (permission IN ('requisition.reopen', 'edit_request.approve', 'documents.download')),
  granted_by text NOT NULL REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_by text REFERENCES users(id),
  revoked_at timestamptz,
  reason text
);

-- ---------------------------------------------------------------- master data
CREATE TABLE facilities (
  id text PRIMARY KEY,
  name text NOT NULL,
  lga text,
  location text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX facilities_name_trgm ON facilities USING gin (name gin_trgm_ops);

CREATE TABLE programmes (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  description text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'))
);

CREATE TABLE items (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  generic_name text,
  strength text,
  form text,
  pack_size text,
  base_unit text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX items_name_trgm ON items USING gin (name gin_trgm_ops);

CREATE TABLE aliases (
  id text PRIMARY KEY,
  entity_type text NOT NULL CHECK (entity_type IN ('facility', 'item')),
  entity_id text NOT NULL,
  alias text NOT NULL,
  normalized text NOT NULL,
  occurrences integer NOT NULL DEFAULT 0,
  status alias_status NOT NULL,
  decided_by text REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_id, normalized)
);

CREATE TABLE unit_conversions (
  id text PRIMARY KEY,
  item_id text REFERENCES items(id),
  from_unit text NOT NULL,
  to_unit text NOT NULL,
  factor numeric NOT NULL CHECK (factor >= 0),
  incompatible boolean NOT NULL DEFAULT false,
  status approval_status NOT NULL,
  proposed_by text NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text REFERENCES users(id),
  approved_at timestamptz,
  retired_by text REFERENCES users(id),
  retired_at timestamptz,
  notes text,
  CHECK (incompatible OR factor > 0)
);
CREATE UNIQUE INDEX one_approved_conversion ON unit_conversions (COALESCE(item_id, ''), from_unit) WHERE status = 'approved';

CREATE TABLE substitution_equivalences (
  id text PRIMARY KEY,
  requested_item_id text NOT NULL REFERENCES items(id),
  substitute_item_id text NOT NULL REFERENCES items(id),
  factor numeric NOT NULL CHECK (factor > 0),
  basis text[] NOT NULL CHECK (cardinality(basis) > 0),
  justification text NOT NULL,
  status approval_status NOT NULL,
  proposed_by text NOT NULL REFERENCES users(id),
  proposed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text REFERENCES users(id),
  approved_at timestamptz,
  retired_by text REFERENCES users(id),
  retired_at timestamptz,
  CHECK (requested_item_id <> substitute_item_id)
);
CREATE UNIQUE INDEX one_approved_equivalence ON substitution_equivalences (requested_item_id, substitute_item_id) WHERE status = 'approved';

-- Non-secret settings (JSON values) and encrypted secrets.
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE secrets (
  key text PRIMARY KEY,
  ciphertext text NOT NULL,
  hint text,
  updated_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- requisitions
CREATE TABLE requisition_number_counter (
  entry_date date PRIMARY KEY,
  last_serial integer NOT NULL
);

CREATE TABLE requisitions (
  id text PRIMARY KEY,
  requisition_number text NOT NULL UNIQUE,
  entry_date date NOT NULL,
  entry_serial integer NOT NULL,
  facility_id text REFERENCES facilities(id),
  facility_extracted_text text,
  facility_candidates jsonb NOT NULL DEFAULT '[]',
  primary_programme_id text REFERENCES programmes(id),
  requisition_date date,
  requisition_date_estimated boolean NOT NULL DEFAULT false,
  received_at timestamptz NOT NULL,
  received_via text,
  entry_at timestamptz NOT NULL DEFAULT now(),
  record_status record_status NOT NULL DEFAULT 'draft',
  first_validated_at timestamptz,
  first_validated_by text REFERENCES users(id),
  validated_at timestamptz,
  validated_by text REFERENCES users(id),
  finalized_at timestamptz,
  finalized_by text REFERENCES users(id),
  fulfillment_status fulfillment_status NOT NULL DEFAULT 'open',
  fulfillment_closed_at timestamptz,
  fulfillment_closed_by text REFERENCES users(id),
  fulfillment_closure_reason text,
  cancelled_at timestamptz,
  cancelled_by text REFERENCES users(id),
  cancellation_reason text,
  reopened_at timestamptz,
  reopened_by text REFERENCES users(id),
  reopen_reason text,
  created_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_date, entry_serial),
  CHECK (received_at <= entry_at),
  CHECK (requisition_date IS NULL OR requisition_date <= (received_at AT TIME ZONE 'Africa/Lagos')::date),
  CHECK (record_status <> 'cancelled' OR cancellation_reason IS NOT NULL),
  CHECK (record_status <> 'reopened' OR reopen_reason IS NOT NULL)
);
CREATE INDEX requisitions_facility ON requisitions (facility_id);

CREATE TABLE documents (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  category document_category NOT NULL,
  lifecycle_event_id text,
  document_type text NOT NULL,
  file_name text NOT NULL,
  mime_type text NOT NULL,
  storage_key text NOT NULL,
  sha256 text NOT NULL,
  file_size bigint NOT NULL,
  page_count integer NOT NULL DEFAULT 1,
  first_page integer NOT NULL DEFAULT 0,
  description text,
  uploaded_by text NOT NULL REFERENCES users(id),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (category <> 'lifecycle_evidence' OR lifecycle_event_id IS NOT NULL)
);

CREATE TABLE document_pages (
  requisition_id text NOT NULL REFERENCES requisitions(id),
  page_number integer NOT NULL,
  programme_id text REFERENCES programmes(id),
  updated_by text REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (requisition_id, page_number)
);

CREATE TABLE requisition_lines (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  line_number integer NOT NULL,
  page_number integer,
  bounding_box jsonb,
  raw_extracted_text text,
  item_extracted_text text,
  corrected_text text,
  item_id text REFERENCES items(id),
  programme_id text REFERENCES programmes(id),
  programme_overridden boolean NOT NULL DEFAULT false,
  quantity_requested numeric CHECK (quantity_requested IS NULL OR quantity_requested >= 0),
  unit_requested text,
  base_quantity_requested numeric,
  base_unit text,
  conversion_id text REFERENCES unit_conversions(id),
  conversion_status conversion_status,
  strength text,
  form text,
  pack_size text,
  candidates jsonb NOT NULL DEFAULT '[]',
  match_method text,
  match_confirmed_by text REFERENCES users(id),
  match_confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((base_quantity_requested IS NULL) = (conversion_status IS DISTINCT FROM 'resolved'))
);
CREATE INDEX lines_requisition ON requisition_lines (requisition_id);
CREATE INDEX lines_item ON requisition_lines (item_id);

CREATE TABLE processing_jobs (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  attempt integer NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  model_name text,
  pages integer,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  raw_output text,
  error text,
  cost_usd numeric,
  created_by text NOT NULL REFERENCES users(id)
);
CREATE INDEX jobs_queue ON processing_jobs (status, queued_at);

-- ---------------------------------------------------------------- lifecycle & fulfillment
CREATE TABLE lifecycle_events (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  stage operational_stage NOT NULL,
  status lifecycle_event_status NOT NULL,
  not_applicable_reason text,
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL REFERENCES users(id),
  notes text,
  chronology_override boolean NOT NULL DEFAULT false,
  override_reason text,
  record_type record_type NOT NULL DEFAULT 'entry',
  supersedes_id text UNIQUE REFERENCES lifecycle_events(id),
  correction_reason text,
  edit_request_id text,
  CHECK (status <> 'not_applicable' OR (not_applicable_reason IS NOT NULL AND btrim(not_applicable_reason) <> '')),
  CHECK (NOT (stage = 'completed' AND status = 'not_applicable')),
  CHECK ((record_type = 'entry') = (supersedes_id IS NULL)),
  CHECK (record_type = 'entry' OR (correction_reason IS NOT NULL AND btrim(correction_reason) <> '')),
  CHECK (NOT chronology_override OR (override_reason IS NOT NULL AND btrim(override_reason) <> '')),
  CHECK (occurred_at <= recorded_at + interval '1 minute')
);
ALTER TABLE documents ADD CONSTRAINT documents_event FOREIGN KEY (lifecycle_event_id) REFERENCES lifecycle_events(id);

CREATE TABLE fulfillment_records (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  requisition_line_id text REFERENCES requisition_lines(id) ON DELETE RESTRICT,
  item_id text NOT NULL REFERENCES items(id),
  stage fulfillment_stage NOT NULL,
  quantity numeric,
  unit text,
  base_quantity numeric,
  base_unit text,
  conversion_id text REFERENCES unit_conversions(id),
  conversion_status conversion_status NOT NULL,
  substitution boolean NOT NULL DEFAULT false,
  additional boolean NOT NULL DEFAULT false,
  reference text,
  document_id text REFERENCES documents(id),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  recorded_by text NOT NULL REFERENCES users(id),
  notes text,
  record_type record_type NOT NULL DEFAULT 'entry',
  supersedes_id text UNIQUE REFERENCES fulfillment_records(id),
  correction_reason text,
  edit_request_id text,
  CHECK ((requisition_line_id IS NULL) = additional),
  CHECK ((record_type = 'entry') = (supersedes_id IS NULL)),
  CHECK (record_type = 'entry' OR (correction_reason IS NOT NULL AND btrim(correction_reason) <> '')),
  CHECK (record_type = 'void' OR (quantity IS NOT NULL AND quantity >= 0 AND unit IS NOT NULL)),
  CHECK (record_type = 'void' OR ((base_quantity IS NULL) = (conversion_status <> 'resolved'))),
  CHECK (occurred_at <= recorded_at + interval '1 minute')
);
CREATE INDEX fulfillment_requisition ON fulfillment_records (requisition_id);

CREATE TABLE edit_requests (
  id text PRIMARY KEY,
  requisition_id text NOT NULL REFERENCES requisitions(id),
  requested_by text NOT NULL REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  reason text NOT NULL CHECK (btrim(reason) <> ''),
  requested_changes jsonb NOT NULL CHECK (jsonb_array_length(requested_changes) > 0),
  status edit_request_status NOT NULL DEFAULT 'pending',
  decided_by text REFERENCES users(id),
  decided_at timestamptz,
  decision text CHECK (decision IN ('approved', 'rejected')),
  rejection_reason text,
  approval_expires_at timestamptz,
  used_at timestamptz,
  closed_at timestamptz,
  closure_reason text CHECK (closure_reason IN ('used', 'expired', 'withdrawn', 'rejected')),
  CHECK (decided_by IS NULL OR decided_by <> requested_by),
  CHECK (decision IS DISTINCT FROM 'rejected' OR (rejection_reason IS NOT NULL AND btrim(rejection_reason) <> '')),
  CHECK (decision IS DISTINCT FROM 'approved' OR approval_expires_at IS NOT NULL)
);

-- ---------------------------------------------------------------- audit & usage
CREATE TABLE audit_events (
  id text PRIMARY KEY,
  requisition_id text REFERENCES requisitions(id),
  actor_user_id text REFERENCES users(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'system')),
  event_type text NOT NULL,
  entity_type text NOT NULL,
  entity_id text,
  old_value jsonb,
  new_value jsonb,
  reason text,
  edit_request_id text,
  correlation_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_requisition ON audit_events (requisition_id, created_at);
CREATE INDEX audit_created ON audit_events (created_at);

-- One row per AI call (document reading). Append-only; the spending cap and
-- per-user limits are computed from it.
CREATE TABLE ai_usage (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id),
  requisition_id text REFERENCES requisitions(id),
  job_id text REFERENCES processing_jobs(id),
  provider text NOT NULL DEFAULT 'openrouter',
  model text NOT NULL,
  pages integer NOT NULL DEFAULT 0,
  prompt_tokens integer,
  completion_tokens integer,
  cost_usd numeric NOT NULL DEFAULT 0,
  outcome text NOT NULL CHECK (outcome IN ('ok', 'error', 'refused_limit')),
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_user_time ON ai_usage (user_id, created_at);
CREATE INDEX ai_usage_time ON ai_usage (created_at);

-- ---------------------------------------------------------------- append-only triggers
CREATE TRIGGER lifecycle_events_append_only BEFORE UPDATE OR DELETE ON lifecycle_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fulfillment_records_append_only BEFORE UPDATE OR DELETE ON fulfillment_records FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER documents_append_only BEFORE UPDATE OR DELETE ON documents FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ai_usage_append_only BEFORE UPDATE OR DELETE ON ai_usage FOR EACH ROW EXECUTE FUNCTION forbid_change();
CREATE TRIGGER lifecycle_events_no_truncate BEFORE TRUNCATE ON lifecycle_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER fulfillment_records_no_truncate BEFORE TRUNCATE ON fulfillment_records FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER documents_no_truncate BEFORE TRUNCATE ON documents FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();
CREATE TRIGGER ai_usage_no_truncate BEFORE TRUNCATE ON ai_usage FOR EACH STATEMENT EXECUTE FUNCTION forbid_change();

-- A correction/void must supersede a record of the same requisition and stage
-- that is not itself a void.
CREATE FUNCTION check_supersedes() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t record;
BEGIN
  IF NEW.supersedes_id IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT requisition_id, stage::text AS stage, record_type::text AS record_type FROM %I WHERE id = $1', TG_TABLE_NAME)
    INTO t USING NEW.supersedes_id;
  IF t IS NULL THEN RAISE EXCEPTION 'superseded record not found'; END IF;
  IF t.requisition_id <> NEW.requisition_id OR t.stage <> NEW.stage::text THEN
    RAISE EXCEPTION 'a correction must be for the same requisition and stage';
  END IF;
  IF t.record_type = 'void' THEN RAISE EXCEPTION 'a void record cannot be superseded'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER lifecycle_events_supersedes BEFORE INSERT ON lifecycle_events FOR EACH ROW EXECUTE FUNCTION check_supersedes();
CREATE TRIGGER fulfillment_records_supersedes BEFORE INSERT ON fulfillment_records FOR EACH ROW EXECUTE FUNCTION check_supersedes();

-- Substitution flag must match the line's item.
CREATE FUNCTION check_substitution() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE line_item text;
BEGIN
  IF NEW.requisition_line_id IS NULL THEN
    IF NEW.substitution THEN RAISE EXCEPTION 'an additional item cannot be a substitution'; END IF;
    RETURN NEW;
  END IF;
  SELECT item_id INTO line_item FROM requisition_lines WHERE id = NEW.requisition_line_id AND requisition_id = NEW.requisition_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'line does not belong to this requisition'; END IF;
  IF NEW.substitution IS DISTINCT FROM (NEW.item_id IS DISTINCT FROM line_item) THEN
    RAISE EXCEPTION 'substitution flag must be true exactly when the supplied item differs from the requested item';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fulfillment_records_substitution BEFORE INSERT ON fulfillment_records FOR EACH ROW EXECUTE FUNCTION check_substitution();

-- ---------------------------------------------------------------- finalization lock
-- Changes to locked data of a Finalized requisition need either an approved,
-- unexpired, unused edit request named in nebula.edit_request_id, or (for
-- lines only) the conversion-resolution exception.
CREATE FUNCTION edit_context_ok(req_id text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM edit_requests
    WHERE id = nebula_setting('edit_request_id') AND requisition_id = req_id
      AND status = 'approved' AND approval_expires_at > now() AND used_at IS NULL)
$$;

CREATE FUNCTION requisitions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.requisition_number IS DISTINCT FROM OLD.requisition_number OR NEW.entry_at IS DISTINCT FROM OLD.entry_at
     OR NEW.entry_date IS DISTINCT FROM OLD.entry_date OR NEW.entry_serial IS DISTINCT FROM OLD.entry_serial
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR (OLD.first_validated_at IS NOT NULL AND NEW.first_validated_at IS DISTINCT FROM OLD.first_validated_at) THEN
    RAISE EXCEPTION 'requisition number, entry time, creator and first validation time are immutable';
  END IF;
  IF OLD.record_status = 'cancelled' AND NEW.record_status <> 'cancelled' THEN
    RAISE EXCEPTION 'cancellation is final';
  END IF;
  IF OLD.record_status = 'finalized' AND NEW.record_status = 'finalized' AND (
       NEW.facility_id IS DISTINCT FROM OLD.facility_id OR NEW.facility_extracted_text IS DISTINCT FROM OLD.facility_extracted_text
    OR NEW.primary_programme_id IS DISTINCT FROM OLD.primary_programme_id OR NEW.requisition_date IS DISTINCT FROM OLD.requisition_date
    OR NEW.requisition_date_estimated IS DISTINCT FROM OLD.requisition_date_estimated OR NEW.received_at IS DISTINCT FROM OLD.received_at)
    AND NOT edit_context_ok(OLD.id) THEN
    RAISE EXCEPTION 'this requisition is finalized: changing its details needs an approved edit request or a reopen';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
CREATE TRIGGER requisitions_guard BEFORE UPDATE ON requisitions FOR EACH ROW EXECUTE FUNCTION requisitions_guard();
CREATE TRIGGER requisitions_no_delete BEFORE DELETE ON requisitions FOR EACH ROW EXECUTE FUNCTION forbid_change();

CREATE FUNCTION lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st record_status; req text;
BEGIN
  req := COALESCE(NEW.requisition_id, OLD.requisition_id);
  SELECT record_status INTO st FROM requisitions WHERE id = req;
  IF st = 'cancelled' THEN RAISE EXCEPTION 'this requisition is cancelled'; END IF;
  IF st <> 'finalized' OR edit_context_ok(req) THEN RETURN COALESCE(NEW, OLD); END IF;
  -- Conversion resolution: only base-quantity fields of an 'unknown' line may change.
  IF TG_OP = 'UPDATE' AND nebula_setting('conversion_resolution') = 'on' AND OLD.conversion_status = 'unknown'
     AND (to_jsonb(NEW) - ARRAY['base_quantity_requested','base_unit','conversion_id','conversion_status','updated_at'])
       = (to_jsonb(OLD) - ARRAY['base_quantity_requested','base_unit','conversion_id','conversion_status','updated_at']) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'this requisition is finalized: changing its lines needs an approved edit request or a reopen';
END $$;
CREATE TRIGGER lines_guard BEFORE INSERT OR UPDATE OR DELETE ON requisition_lines FOR EACH ROW EXECUTE FUNCTION lines_guard();

CREATE FUNCTION pages_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE st record_status; req text;
BEGIN
  req := COALESCE(NEW.requisition_id, OLD.requisition_id);
  SELECT record_status INTO st FROM requisitions WHERE id = req;
  IF st = 'finalized' AND TG_OP <> 'INSERT' AND NOT edit_context_ok(req) THEN
    RAISE EXCEPTION 'this requisition is finalized: changing page programmes needs an approved edit request or a reopen';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER pages_guard BEFORE UPDATE OR DELETE ON document_pages FOR EACH ROW EXECUTE FUNCTION pages_guard();

-- Requisition-number counter: called inside the creating transaction.
CREATE FUNCTION next_requisition_serial(d date) RETURNS integer LANGUAGE sql AS $$
  INSERT INTO requisition_number_counter AS c (entry_date, last_serial) VALUES (d, 1)
  ON CONFLICT (entry_date) DO UPDATE SET last_serial = c.last_serial + 1
  RETURNING last_serial
$$;
