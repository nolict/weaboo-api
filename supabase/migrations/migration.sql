-- ============================================================
-- WEABOO API — Supabase Migration
-- Table: anime_mappings
-- Purpose: Persistent "Triangle Mapping" MAL <-> Samehadaku <-> Animasu
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLE: anime_mappings
-- ============================================================
CREATE TABLE IF NOT EXISTS anime_mappings (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  mal_id           INTEGER      UNIQUE NOT NULL,
  title_main       TEXT         NOT NULL,
  slug_samehadaku  VARCHAR(255),
  slug_animasu     VARCHAR(255),

  -- 64-character hex string representing 256-bit perceptual hash
  -- (blockhash-core produces a 256-bit hash stored as 64 hex chars)
  phash_v1         VARCHAR(64),

  release_year     INTEGER,
  total_episodes   INTEGER,
  last_sync        TIMESTAMP WITH TIME ZONE DEFAULT NOW(),

  -- Soft constraints
  CONSTRAINT chk_phash_length CHECK (phash_v1 IS NULL OR LENGTH(phash_v1) = 64)
);

-- Indexes for fast slug lookups (both providers query direction)
CREATE INDEX IF NOT EXISTS idx_anime_mappings_mal_id          ON anime_mappings (mal_id);
CREATE INDEX IF NOT EXISTS idx_anime_mappings_slug_samehadaku ON anime_mappings (slug_samehadaku);
CREATE INDEX IF NOT EXISTS idx_anime_mappings_slug_animasu    ON anime_mappings (slug_animasu);

-- ============================================================
-- FUNCTION: hamming_distance(text, text) → integer
--
-- Calculates the Hamming distance between two hex-encoded hash strings.
-- Each hex character represents 4 bits; we XOR nibble-by-nibble and
-- count set bits (popcount) to get the total bit difference.
--
-- Performance note: This function is IMMUTABLE so PostgreSQL can
-- inline and cache results in index scans / CTEs.
-- ============================================================
CREATE OR REPLACE FUNCTION hamming_distance(hash1 TEXT, hash2 TEXT)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE STRICT
AS $$
DECLARE
  len      INTEGER;
  i        INTEGER;
  nibble1  INTEGER;
  nibble2  INTEGER;
  xored    INTEGER;
  dist     INTEGER := 0;
BEGIN
  -- Guard: if lengths differ the hashes are incomparable
  IF LENGTH(hash1) <> LENGTH(hash2) THEN
    RETURN -1;
  END IF;

  len := LENGTH(hash1);

  FOR i IN 1..len LOOP
    -- Convert each hex char to its integer value (0–15).
    -- Use ('x' || char)::bit(4)::int — cast to 4-bit, not 8-bit,
    -- so we only get nibble range 0-15 without sign extension issues.
    nibble1 := ('x' || SUBSTRING(hash1, i, 1))::bit(4)::integer;
    nibble2 := ('x' || SUBSTRING(hash2, i, 1))::bit(4)::integer;

    -- XOR the two nibbles (result is 0–15)
    xored := nibble1 # nibble2;

    -- Popcount for a 4-bit value using Brian Kernighan's method
    WHILE xored > 0 LOOP
      dist := dist + (xored & 1);
      xored := xored >> 1;
    END LOOP;
  END LOOP;

  RETURN dist;
END;
$$;

-- ============================================================
-- HELPER: find_mapping_by_phash
--
-- Finds the closest existing mapping by Hamming distance on phash_v1.
-- Returns the single row with the smallest distance below p_threshold,
-- or nothing if no match qualifies.
--
-- Called via supabase.rpc('find_mapping_by_phash', { p_hash, p_threshold })
-- ============================================================
CREATE OR REPLACE FUNCTION find_mapping_by_phash(p_hash TEXT, p_threshold INTEGER)
RETURNS SETOF anime_mappings
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM anime_mappings
  WHERE phash_v1 IS NOT NULL
    AND hamming_distance(phash_v1, p_hash) < p_threshold
  ORDER BY hamming_distance(phash_v1, p_hash) ASC
  LIMIT 1;
$$;

-- ============================================================
-- TABLE: mal_metadata
--
-- Permanent cache for full MAL (MyAnimeList) metadata per anime.
-- Keyed by mal_id (FK to anime_mappings.mal_id).
-- Populated on first request, never expires (reference data).
-- Studios and genres stored as JSONB arrays for flexibility.
-- ============================================================
CREATE TABLE IF NOT EXISTS mal_metadata (
  mal_id          INTEGER      PRIMARY KEY REFERENCES anime_mappings(mal_id) ON DELETE CASCADE,
  title           TEXT         NOT NULL,
  title_english   TEXT,
  title_japanese  TEXT,
  synopsis        TEXT,
  type            VARCHAR(20),           -- TV, Movie, OVA, ONA, Special, Music
  episodes        INTEGER,
  status          VARCHAR(50),           -- Airing, Finished Airing, Not yet aired
  duration        VARCHAR(50),           -- e.g. "24 min per ep"
  score           NUMERIC(4,2),
  rank            INTEGER,
  release_year    INTEGER,
  season          VARCHAR(20),           -- spring, summer, fall, winter
  genres          JSONB        NOT NULL DEFAULT '[]'::jsonb,
  studios         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  image_url       TEXT,
  large_image_url TEXT,
  cached_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mal_metadata_mal_id ON mal_metadata (mal_id);

-- ============================================================
-- HELPER: upsert_mal_metadata
--
-- Inserts or fully replaces MAL metadata for a given mal_id.
-- Always overwrites on conflict (MAL data is authoritative).
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_mal_metadata(
  p_mal_id          INTEGER,
  p_title           TEXT,
  p_title_english   TEXT         DEFAULT NULL,
  p_title_japanese  TEXT         DEFAULT NULL,
  p_synopsis        TEXT         DEFAULT NULL,
  p_type            VARCHAR(20)  DEFAULT NULL,
  p_episodes        INTEGER      DEFAULT NULL,
  p_status          VARCHAR(50)  DEFAULT NULL,
  p_duration        VARCHAR(50)  DEFAULT NULL,
  p_score           NUMERIC(4,2) DEFAULT NULL,
  p_rank            INTEGER      DEFAULT NULL,
  p_release_year    INTEGER      DEFAULT NULL,
  p_season          VARCHAR(20)  DEFAULT NULL,
  p_genres          JSONB        DEFAULT '[]'::jsonb,
  p_studios         JSONB        DEFAULT '[]'::jsonb,
  p_image_url       TEXT         DEFAULT NULL,
  p_large_image_url TEXT         DEFAULT NULL
)
RETURNS mal_metadata
LANGUAGE plpgsql
AS $$
DECLARE
  result mal_metadata;
BEGIN
  INSERT INTO mal_metadata (
    mal_id, title, title_english, title_japanese,
    synopsis, type, episodes, status, duration,
    score, rank, release_year, season,
    genres, studios, image_url, large_image_url,
    cached_at
  )
  VALUES (
    p_mal_id, p_title, p_title_english, p_title_japanese,
    p_synopsis, p_type, p_episodes, p_status, p_duration,
    p_score, p_rank, p_release_year, p_season,
    p_genres, p_studios, p_image_url, p_large_image_url,
    NOW()
  )
  ON CONFLICT (mal_id) DO UPDATE SET
    title           = EXCLUDED.title,
    title_english   = EXCLUDED.title_english,
    title_japanese  = EXCLUDED.title_japanese,
    synopsis        = EXCLUDED.synopsis,
    type            = EXCLUDED.type,
    episodes        = EXCLUDED.episodes,
    status          = EXCLUDED.status,
    duration        = EXCLUDED.duration,
    score           = EXCLUDED.score,
    rank            = EXCLUDED.rank,
    release_year    = EXCLUDED.release_year,
    season          = EXCLUDED.season,
    genres          = EXCLUDED.genres,
    studios         = EXCLUDED.studios,
    image_url       = EXCLUDED.image_url,
    large_image_url = EXCLUDED.large_image_url,
    cached_at       = NOW()
  RETURNING * INTO result;

  RETURN result;
END;
$$;

-- ============================================================
-- HELPER: upsert_anime_mapping
--
-- Inserts a new mapping or updates an existing one by mal_id.
-- Caller passes only the fields it knows; NULLs are preserved.
-- ============================================================
CREATE OR REPLACE FUNCTION upsert_anime_mapping(
  p_mal_id          INTEGER,
  p_title_main      TEXT,
  p_slug_samehadaku VARCHAR(255) DEFAULT NULL,
  p_slug_animasu    VARCHAR(255) DEFAULT NULL,
  p_phash_v1        VARCHAR(64)  DEFAULT NULL,
  p_release_year    INTEGER      DEFAULT NULL,
  p_total_episodes  INTEGER      DEFAULT NULL
)
RETURNS anime_mappings
LANGUAGE plpgsql
AS $$
DECLARE
  result anime_mappings;
BEGIN
  INSERT INTO anime_mappings (
    mal_id, title_main, slug_samehadaku, slug_animasu,
    phash_v1, release_year, total_episodes, last_sync
  )
  VALUES (
    p_mal_id, p_title_main, p_slug_samehadaku, p_slug_animasu,
    p_phash_v1, p_release_year, p_total_episodes, NOW()
  )
  ON CONFLICT (mal_id) DO UPDATE SET
    title_main      = COALESCE(EXCLUDED.title_main,      anime_mappings.title_main),
    slug_samehadaku = COALESCE(EXCLUDED.slug_samehadaku, anime_mappings.slug_samehadaku),
    slug_animasu    = COALESCE(EXCLUDED.slug_animasu,    anime_mappings.slug_animasu),
    phash_v1        = COALESCE(EXCLUDED.phash_v1,        anime_mappings.phash_v1),
    release_year    = COALESCE(EXCLUDED.release_year,    anime_mappings.release_year),
    total_episodes  = COALESCE(EXCLUDED.total_episodes,  anime_mappings.total_episodes),
    last_sync       = NOW()
  RETURNING * INTO result;

  RETURN result;
END;
$$;
