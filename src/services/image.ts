import axios from 'axios'
import sharp from 'sharp'

import { DEFAULT_USER_AGENT, PHASH_BITS } from '../config/constants'
import type { PHash } from '../types/anime'
import { Logger } from '../utils/logger'

// ── Constants ────────────────────────────────────────────────────────────────
// blockhash-core uses a grid of (bits × bits) cells.
// PHASH_BITS = 256 → grid side = sqrt(256) = 16 → 16×16 cells → 256-bit hash
// Encoded as 64 hex characters (4 bits per char).
const GRID_SIZE = Math.sqrt(PHASH_BITS) // 16

// ── Core pHash implementation (pure, no disk I/O) ───────────────────────────

/**
 * Compute the average grayscale value of an 8-bit single-channel pixel buffer.
 * Used to determine the DCT-like threshold for each cell.
 */
function computeAverage(pixels: Uint8Array, width: number, height: number): number {
  let sum = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      sum += pixels[y * width + x]
    }
  }
  return sum / (width * height)
}

/**
 * Simple block-hash algorithm:
 *  1. Split image into GRID_SIZE×GRID_SIZE blocks.
 *  2. Average pixel brightness per block.
 *  3. Compare each block's average to the total image average.
 *  4. Bit = 1 if block ≥ total average, else 0.
 *  5. Pack bits into a hex string (MSB first within each group of 4).
 *
 * This mirrors the blockhash-core algorithm without requiring a native module.
 */
function blockHash(pixels: Uint8Array, width: number, height: number): PHash {
  const blockWidth = width / GRID_SIZE
  const blockHeight = height / GRID_SIZE

  // Compute per-block averages
  const blockAverages: number[] = []

  for (let row = 0; row < GRID_SIZE; row++) {
    for (let col = 0; col < GRID_SIZE; col++) {
      let blockSum = 0
      let pixelCount = 0

      const yStart = Math.floor(row * blockHeight)
      const yEnd = Math.ceil((row + 1) * blockHeight)
      const xStart = Math.floor(col * blockWidth)
      const xEnd = Math.ceil((col + 1) * blockWidth)

      for (let y = yStart; y < yEnd && y < height; y++) {
        for (let x = xStart; x < xEnd && x < width; x++) {
          blockSum += pixels[y * width + x]
          pixelCount++
        }
      }

      blockAverages.push(pixelCount > 0 ? blockSum / pixelCount : 0)
    }
  }

  const totalAverage = computeAverage(pixels, width, height)

  // Convert block averages to bits, then pack into hex
  let hexHash = ''
  for (let i = 0; i < blockAverages.length; i += 4) {
    let nibble = 0
    for (let bit = 0; bit < 4; bit++) {
      const idx = i + bit
      if (idx < blockAverages.length && blockAverages[idx] >= totalAverage) {
        nibble |= 1 << (3 - bit)
      }
    }
    hexHash += nibble.toString(16)
  }

  return hexHash
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * generatePHash — Downloads a poster image entirely in RAM (ArrayBuffer),
 * processes it with sharp (resize → grayscale → raw pixels), computes a
 * 256-bit block-hash, and returns it as a 64-character hex string.
 *
 * ⚠️  NO local file I/O: the image bytes live only in memory and are GC'd
 * once this function returns.
 *
 * @param imageUrl  Absolute URL of the poster image
 * @returns         64-char hex pHash, or null on failure
 */
export async function generatePHash(imageUrl: string): Promise<PHash | null> {
  try {
    Logger.debug(`🖼️  Generating pHash for: ${imageUrl}`)

    // 1. Download image as raw binary into an ArrayBuffer — stays in RAM
    const response = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15_000,
      headers: { 'User-Agent': DEFAULT_USER_AGENT },
    })

    const imageBuffer = Buffer.from(response.data)

    // 2. Resize to GRID_SIZE×GRID_SIZE, convert to grayscale, get raw pixels
    //    sharp processes entirely in memory — no temp files created.
    const { data: pixels, info } = await sharp(imageBuffer)
      .resize(GRID_SIZE, GRID_SIZE, { fit: 'fill' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const pixelArray = new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength)

    // 3. Compute the block-hash
    const hash = blockHash(pixelArray, info.width, info.height)

    Logger.debug(`✅ pHash generated: ${hash} (${hash.length} chars)`)
    return hash
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    Logger.warning(`⚠️  pHash generation failed for ${imageUrl}: ${msg}`)
    return null
  }
}

/**
 * hammingDistance — Calculates the bit-level Hamming distance between two
 * hex-encoded hash strings in JavaScript (mirrors the SQL function).
 * Used for local pre-filtering before making a database call.
 *
 * @returns Number of differing bits, or -1 if lengths differ
 */
export function hammingDistance(hash1: PHash, hash2: PHash): number {
  if (hash1.length !== hash2.length) return -1

  let dist = 0
  for (let i = 0; i < hash1.length; i++) {
    const n1 = parseInt(hash1[i], 16)
    const n2 = parseInt(hash2[i], 16)
    let xored = n1 ^ n2
    // popcount nibble
    while (xored !== 0) {
      dist += xored & 1
      xored >>= 1
    }
  }
  return dist
}
