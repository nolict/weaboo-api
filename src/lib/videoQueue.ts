import type { VideoQueueEntry, VideoStoreEntry, VideoQueueStatus } from '../types/anime'

import { supabase } from './supabase'

// ── Table name constants ─────────────────────────────────────────────────────
const QUEUE_TABLE = 'video_queue'
const STORE_TABLE = 'video_store'

// ── video_queue helpers ──────────────────────────────────────────────────────

/**
 * Enqueue a video for download and upload to HuggingFace.
 * Uses the Supabase RPC `enqueue_video` which handles upsert logic:
 * - If entry doesn't exist → insert as 'pending'
 * - If status is 'failed' → reset to 'pending' and update video_url
 * - If status is 'ready' → no-op (already archived)
 */
export async function enqueueVideo(
  malId: number,
  episode: number,
  provider: string,
  videoUrl: string,
  resolution: string | null
): Promise<VideoQueueEntry | null> {
  const { data, error } = await supabase.rpc('enqueue_video', {
    p_mal_id: malId,
    p_episode: episode,
    p_provider: provider,
    p_video_url: videoUrl,
    p_resolution: resolution ?? null,
  })

  if (error !== null) {
    // Non-fatal: log but don't crash the streaming response
    console.error(`[VideoQueue] enqueueVideo failed: ${error.message}`)
    return null
  }

  return data as VideoQueueEntry | null
}

/**
 * Find a video_queue entry for a specific (malId, episode, provider, resolution).
 * Returns null if no entry exists yet.
 * Used to prevent re-enqueueing jobs that are already pending/processing.
 */
export async function findVideoQueueEntry(
  malId: number,
  episode: number,
  provider: string,
  resolution: string | null
): Promise<VideoQueueEntry | null> {
  let query = supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('mal_id', malId)
    .eq('episode', episode)
    .eq('provider', provider)

  if (resolution !== null) {
    query = query.eq('resolution', resolution)
  } else {
    query = query.is('resolution', null)
  }

  const { data, error } = await query.maybeSingle()

  if (error !== null) {
    console.error(`[VideoQueue] findVideoQueueEntry failed: ${error.message}`)
    return null
  }

  return data as VideoQueueEntry | null
}

/**
 * Find a video_store entry for a specific (malId, episode, provider, resolution).
 * Returns null if the video has not been archived to HuggingFace yet.
 */
export async function findVideoStore(
  malId: number,
  episode: number,
  provider: string,
  resolution: string | null
): Promise<VideoStoreEntry | null> {
  let query = supabase
    .from(STORE_TABLE)
    .select('*')
    .eq('mal_id', malId)
    .eq('episode', episode)
    .eq('provider', provider)

  if (resolution !== null) {
    query = query.eq('resolution', resolution)
  } else {
    query = query.is('resolution', null)
  }

  const { data, error } = await query.maybeSingle()

  if (error !== null) {
    console.error(`[VideoQueue] findVideoStore failed: ${error.message}`)
    return null
  }

  return data as VideoStoreEntry | null
}

/**
 * Find all video_store entries for a given (malId, episode).
 * Returns an array keyed by provider+resolution for quick lookup.
 */
export async function findVideoStoreByEpisode(
  malId: number,
  episode: number
): Promise<VideoStoreEntry[]> {
  const { data, error } = await supabase
    .from(STORE_TABLE)
    .select('*')
    .eq('mal_id', malId)
    .eq('episode', episode)

  if (error !== null) {
    console.error(`[VideoQueue] findVideoStoreByEpisode failed: ${error.message}`)
    return []
  }

  return (data ?? []) as VideoStoreEntry[]
}

/**
 * Update the status of a video_queue entry by its UUID.
 * Optionally pass an error message when marking as 'failed'.
 */
export async function updateQueueStatus(
  id: string,
  status: VideoQueueStatus,
  errorMessage?: string
): Promise<void> {
  const { error } = await supabase.rpc('update_video_queue_status', {
    p_id: id,
    p_status: status,
    p_error: errorMessage ?? null,
  })

  if (error !== null) {
    console.error(`[VideoQueue] updateQueueStatus failed: ${error.message}`)
  }
}

/**
 * Upsert a completed video upload result into video_store.
 * Also marks the corresponding video_queue entry as 'ready'.
 */
export async function upsertVideoStore(payload: {
  malId: number
  episode: number
  provider: string
  resolution: string | null
  fileKey: string
  hfAccount: number
  hfRepo: string
  hfPath: string
  hfDirectUrl: string
  streamUrl: string
}): Promise<VideoStoreEntry | null> {
  const { data, error } = await supabase.rpc('upsert_video_store', {
    p_mal_id: payload.malId,
    p_episode: payload.episode,
    p_provider: payload.provider,
    p_resolution: payload.resolution ?? null,
    p_file_key: payload.fileKey,
    p_hf_account: payload.hfAccount,
    p_hf_repo: payload.hfRepo,
    p_hf_path: payload.hfPath,
    p_hf_direct_url: payload.hfDirectUrl,
    p_stream_url: payload.streamUrl,
  })

  if (error !== null) {
    console.error(`[VideoQueue] upsertVideoStore failed: ${error.message}`)
    return null
  }

  return data as VideoStoreEntry | null
}

/**
 * Fetch all pending queue entries (for polling use by HF Space worker).
 * Returns up to `limit` entries ordered by created_at ASC.
 */
export async function fetchPendingQueue(limit = 10): Promise<VideoQueueEntry[]> {
  const { data, error } = await supabase
    .from(QUEUE_TABLE)
    .select('*')
    .eq('status', 'pending')
    .order('created_at', { ascending: true })
    .limit(limit)

  if (error !== null) {
    console.error(`[VideoQueue] fetchPendingQueue failed: ${error.message}`)
    return []
  }

  return (data ?? []) as VideoQueueEntry[]
}
