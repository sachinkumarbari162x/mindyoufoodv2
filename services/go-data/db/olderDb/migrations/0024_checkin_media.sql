-- ============================================================
--  0024_checkin_media — the photograph attached to a check-in
-- ------------------------------------------------------------
--  THE FILE IS NOT IN HERE, and that is the whole design. Postgres
--  holds a key, a hash and the shape of the image; the bytes live
--  wherever the storage seam is currently pointed — a folder on
--  this machine today, object storage when this goes to
--  production. Neither this table nor anything that reads it knows
--  which.
--
--  WHY NOT A BYTEA COLUMN. Three meals a day is roughly 18 MB per
--  client per month and it never stops growing. In Postgres that
--  is a database nobody can back up, restore or vacuum in a
--  sensible time, and every one of those bytes travels through the
--  connection pool that also serves her diary.
--
--  THE HASH IS NOT DECORATION. It is what makes "this is the photo
--  they sent" checkable later: the file on disk either hashes to
--  this or it does not. It is also how a re-upload of the same
--  image is recognised instead of stored twice.
--
--  APPEND-ONLY, LIKE THE CHECK-IN IT HANGS OFF. There is no update
--  path and no delete path here. Removal comes later, as expiry
--  and as erasure, and both of those are deliberate acts with an
--  email attached — see docs/postConsultation.html.
--
--  Run inside a transaction by the migration runner.
-- ============================================================

CREATE TABLE IF NOT EXISTS crm.checkin_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  /* CASCADE from the check-in, which itself cascades from the
     programme. Deleting a client's account therefore takes the rows
     with it — and the files are removed separately, by key, because
     a database cascade cannot reach a disk. That gap is the whole
     reason erasure has to be a routine and not a DELETE. */
  checkin_id uuid NOT NULL REFERENCES crm.checkins (id) ON DELETE CASCADE,

  /* Where the bytes are, in whatever store is configured. Opaque to
     Postgres and never a path the client chose: it is derived from
     the hash, so a filename cannot be used to escape a directory or
     to overwrite somebody else's photograph. */
  storage_key text NOT NULL,

  mime text NOT NULL
    CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),

  bytes  int NOT NULL CHECK (bytes > 0),
  sha256 text NOT NULL,

  -- Enough to lay a grid out without opening every file.
  width  int,
  height int,

  /* When the picture was taken, as the phone reported it, and when
     it reached us. They differ when a photo was queued on bad
     signal, and the first is the one that belongs to the meal. */
  taken_at    timestamptz NOT NULL DEFAULT now(),
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS checkin_media_checkin
  ON crm.checkin_media (checkin_id);

/* One row per file per check-in. A phone retrying a queued upload
   must not leave two rows pointing at the same bytes. */
CREATE UNIQUE INDEX IF NOT EXISTS checkin_media_once
  ON crm.checkin_media (checkin_id, sha256);

/* Everything ever stored, oldest first — the query the expiry sweep
   will make when phase six arrives. */
CREATE INDEX IF NOT EXISTS checkin_media_age
  ON crm.checkin_media (received_at);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'myf_viewer') THEN
    REVOKE ALL ON crm.checkin_media FROM myf_viewer;
  END IF;
END $$;
