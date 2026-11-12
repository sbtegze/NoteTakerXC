-- NoteTakerXC alapséma
-- Egy közös térkép, egy (vagy kevés) felhasználó, jogosultságkezelés nélkül.
-- A notes.visibility mező a későbbi privát jegyzethez van fenntartva.

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,               -- a süti értékének SHA-256 lenyomata
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE nodes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content         TEXT NOT NULL,
  type            TEXT,                      -- pl. 'person', 'ticket', 'meeting'; NULL = rendezetlen
  aliases         TEXT[] NOT NULL DEFAULT '{}',  -- becenevek a névfelismeréshez
  children_layout TEXT NOT NULL DEFAULT 'auto'
                  CHECK (children_layout IN ('auto', 'group', 'tree', 'numbered')),
  is_inbox        BOOLEAN NOT NULL DEFAULT false,
  version         INTEGER NOT NULL DEFAULT 1,
  created_by      UUID NOT NULL REFERENCES users(id),
  updated_by      UUID NOT NULL REFERENCES users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ
);

CREATE UNIQUE INDEX nodes_one_inbox_idx ON nodes (is_inbox) WHERE is_inbox;
CREATE INDEX nodes_search_idx ON nodes USING gin (to_tsvector('hungarian', content));
CREATE INDEX nodes_type_idx ON nodes (type) WHERE deleted_at IS NULL;

CREATE TABLE edges (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id  UUID NOT NULL REFERENCES nodes(id),
  target_id  UUID NOT NULL REFERENCES nodes(id),
  -- unsorted:   frissen rögzített, még rendezetlen (szülő -> új node)
  -- belongs_to: alá tartozik (szülő -> gyerek)
  -- related:    laza, irány nélküli kapcsolat
  -- mention:    a szövegből felismert említés (bejegyzés -> említett node)
  kind       TEXT NOT NULL DEFAULT 'unsorted'
             CHECK (kind IN ('unsorted', 'belongs_to', 'related', 'mention')),
  position   DOUBLE PRECISION,
  role       TEXT,
  created_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (source_id <> target_id),
  CHECK (kind <> 'related' OR source_id < target_id),
  UNIQUE (source_id, target_id, kind)
);

CREATE INDEX edges_target_idx ON edges (target_id);

-- A szövegből felismert dátumok; egy bejegyzésben több is lehet.
CREATE TABLE node_dates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id     UUID NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  starts_on   DATE NOT NULL,
  ends_on     DATE NOT NULL,
  meaning     TEXT NOT NULL DEFAULT 'unknown'
              CHECK (meaning IN ('unknown', 'due', 'absence')),
  source_text TEXT NOT NULL,                 -- a szövegrészlet, amiből felismertük
  confirmed   BOOLEAN NOT NULL DEFAULT false, -- kézzel javított: újraelemzés nem írja felül
  CHECK (ends_on >= starts_on)
);

CREATE INDEX node_dates_node_idx ON node_dates (node_id);
CREATE INDEX node_dates_range_idx ON node_dates (starts_on, ends_on);

-- Komment egy node-hoz. Most minden publikus; a 'private' érték a későbbi bővítéshez van.
CREATE TABLE notes (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id    UUID NOT NULL REFERENCES nodes(id),
  content    TEXT NOT NULL,
  visibility TEXT NOT NULL DEFAULT 'public'
             CHECK (visibility IN ('private', 'public')),
  version    INTEGER NOT NULL DEFAULT 1,
  created_by UUID NOT NULL REFERENCES users(id),
  updated_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX notes_node_idx ON notes (node_id) WHERE deleted_at IS NULL;

CREATE TABLE change_log (
  id         BIGSERIAL PRIMARY KEY,
  entity     TEXT NOT NULL CHECK (entity IN ('node', 'edge', 'note')),
  entity_id  UUID NOT NULL,
  action     TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete', 'restore', 'remove')),
  old_state  JSONB,
  new_state  JSONB,
  changed_by UUID,
  tx_id      BIGINT NOT NULL DEFAULT txid_current(),  -- az egy műveletből eredő sorok összevonásához
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX change_log_entity_idx ON change_log (entity, entity_id);
CREATE INDEX change_log_time_idx ON change_log (changed_at DESC);

-- Verziószám és módosítási idő: csak tényleges változásnál nő.
CREATE FUNCTION bump_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(NEW) - 'version' - 'updated_at' - 'updated_by'
     IS DISTINCT FROM to_jsonb(OLD) - 'version' - 'updated_at' - 'updated_by' THEN
    NEW.version := OLD.version + 1;
    NEW.updated_at := now();
  ELSE
    NEW.version := OLD.version;
    NEW.updated_at := OLD.updated_at;
    NEW.updated_by := OLD.updated_by;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER nodes_bump_version BEFORE UPDATE ON nodes
  FOR EACH ROW EXECUTE FUNCTION bump_version();
CREATE TRIGGER notes_bump_version BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION bump_version();

-- Napló: a szerver tranzakciónként beállítja az app.user_id értékét.
CREATE FUNCTION log_change() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_entity TEXT := TG_ARGV[0];
  v_user   UUID := nullif(current_setting('app.user_id', true), '')::uuid;
  v_action TEXT;
  v_old    JSONB;
  v_new    JSONB;
BEGIN
  IF TG_OP = 'INSERT' THEN
    v_action := 'create'; v_new := to_jsonb(NEW);
  ELSIF TG_OP = 'DELETE' THEN
    v_action := 'remove'; v_old := to_jsonb(OLD);
  ELSE
    v_old := to_jsonb(OLD); v_new := to_jsonb(NEW);
    IF v_old = v_new THEN RETURN NEW; END IF;
    IF v_entity <> 'edge' AND (v_old->>'deleted_at') IS NULL AND (v_new->>'deleted_at') IS NOT NULL THEN
      v_action := 'delete';
    ELSIF v_entity <> 'edge' AND (v_old->>'deleted_at') IS NOT NULL AND (v_new->>'deleted_at') IS NULL THEN
      v_action := 'restore';
    ELSE
      v_action := 'update';
    END IF;
  END IF;
  INSERT INTO change_log (entity, entity_id, action, old_state, new_state, changed_by)
  VALUES (v_entity, coalesce(NEW.id, OLD.id), v_action, v_old, v_new, v_user);
  RETURN coalesce(NEW, OLD);
END $$;

CREATE TRIGGER nodes_log AFTER INSERT OR UPDATE OR DELETE ON nodes
  FOR EACH ROW EXECUTE FUNCTION log_change('node');
CREATE TRIGGER edges_log AFTER INSERT OR UPDATE OR DELETE ON edges
  FOR EACH ROW EXECUTE FUNCTION log_change('edge');
CREATE TRIGGER notes_log AFTER INSERT OR UPDATE OR DELETE ON notes
  FOR EACH ROW EXECUTE FUNCTION log_change('note');

-- A napló nem írható át és nem törölhető.
CREATE FUNCTION change_log_readonly() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a change_log nem módosítható';
END $$;

CREATE TRIGGER change_log_no_update BEFORE UPDATE OR DELETE ON change_log
  FOR EACH ROW EXECUTE FUNCTION change_log_readonly();
