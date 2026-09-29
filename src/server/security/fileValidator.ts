import path from 'node:path';
import crypto from 'node:crypto';

export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB max per file (Rule 20)
export const MAX_FILES_PER_PATIENT = 100;

export type AllowedMimeType =
  | 'image/jpeg'
  | 'image/png'
  | 'image/webp'
  | 'image/heic'
  | 'application/pdf';

const EXTENSION_TO_MIME: Record<string, AllowedMimeType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.pdf': 'application/pdf',
};

const MIME_TO_CANONICAL_EXT: Record<AllowedMimeType, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'application/pdf': '.pdf',
};

/**
 * Inspects file content magic bytes to determine the genuine MIME type (Rule 20).
 */
export function detectMagicByteMime(buf: Buffer): AllowedMimeType | null {
  if (buf.length < 12) return null;

  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }

  // HEIC / HEIF: bytes 4..8 == "ftyp" and brand in heic/heix/hevc/mif1
  if (buf.subarray(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('ascii').toLowerCase();
    if (['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand)) {
      return 'image/heic';
    }
  }

  // PDF: "%PDF-"
  if (buf.subarray(0, 5).toString('ascii') === '%PDF-') {
    return 'application/pdf';
  }

  return null;
}

/**
 * Scans buffer for EICAR test signature, embedded scripts, HTML/SVG polyglots, or malicious PDF actions (Rule 20).
 */
export function scanBufferForMalwareAndPayloads(
  buf: Buffer,
  detectedMime: AllowedMimeType
): { clean: boolean; reason?: string } {
  const sampleAscii = buf.subarray(0, Math.min(buf.length, 256 * 1024)).toString('latin1');

  // 1. EICAR standard antivirus test signature
  if (sampleAscii.includes('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')) {
    return { clean: false, reason: 'MALWARE_SIGNATURE_DETECTED' };
  }

  // 2. Reject HTML / SVG / Script polyglots disguised inside image or PDF headers
  const lowerSample = sampleAscii.toLowerCase();
  if (
    lowerSample.includes('<script') ||
    lowerSample.includes('<svg') ||
    lowerSample.includes('<!doctype html') ||
    lowerSample.includes('javascript:') ||
    lowerSample.includes('onerror=') ||
    lowerSample.includes('onload=') ||
    lowerSample.includes('<?php')
  ) {
    return { clean: false, reason: 'EMBEDDED_SCRIPT_OR_POLYGLOT_DETECTED' };
  }

  // 3. Reject PDFs with embedded JavaScript or Launch actions
  if (detectedMime === 'application/pdf') {
    if (
      /\/JavaScript\b/i.test(sampleAscii) ||
      /\/JS\b/i.test(sampleAscii) ||
      /\/Launch\b/i.test(sampleAscii) ||
      /\/OpenAction\b.*\/JS/is.test(sampleAscii)
    ) {
      return { clean: false, reason: 'PDF_CONTAINS_EXECUTABLE_SCRIPT' };
    }
  }

  return { clean: true };
}

/**
 * Strips EXIF / GPS / XMP APP1-APP15 metadata segments from JPEG buffers (Rule 20).
 */
export function stripJpegExifMetadata(buf: Buffer): Buffer {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const chunks: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let offset = 2;

  while (offset < buf.length) {
    if (buf[offset] !== 0xff) {
      // Entropy-coded image data reached
      chunks.push(buf.subarray(offset));
      break;
    }
    const marker = buf[offset + 1];
    // SOS (Start of Scan 0xDA) or EOI (0xD9) -> copy rest of stream
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buf.subarray(offset));
      break;
    }
    // Standalone markers without length
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buf.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    if (offset + 4 > buf.length) {
      chunks.push(buf.subarray(offset));
      break;
    }
    const segLength = buf.readUInt16BE(offset + 2);
    if (segLength < 2 || offset + 2 + segLength > buf.length) {
      chunks.push(buf.subarray(offset));
      break;
    }
    // Strip APP1 (0xE1 = EXIF/GPS/XMP), APP2..APP15 (0xE2..0xEF), and COM (0xFE = comments)
    const isMetadataSegment = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadataSegment) {
      chunks.push(buf.subarray(offset, offset + 2 + segLength));
    }
    offset += 2 + segLength;
  }

  return Buffer.concat(chunks);
}

/**
 * Strips non-essential ancillary metadata chunks (eXIf, tEXt, zTXt, iTXt, tIME) from PNG buffers (Rule 20).
 */
export function stripPngMetadata(buf: Buffer): Buffer {
  if (buf.length < 8) return buf;
  const pngSig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.subarray(0, 8).equals(pngSig)) return buf;

  const chunks: Buffer[] = [buf.subarray(0, 8)];
  let offset = 8;
  const stripTypes = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const totalChunkLen = 12 + length;
    if (offset + totalChunkLen > buf.length) {
      chunks.push(buf.subarray(offset));
      break;
    }
    if (!stripTypes.has(type)) {
      chunks.push(buf.subarray(offset, offset + totalChunkLen));
    }
    offset += totalChunkLen;
    if (type === 'IEND') break;
  }

  return Buffer.concat(chunks);
}

/**
 * Sanitizes original filename for display metadata only (never used in storage paths) (Rule 20).
 */
export function sanitizeDisplayFilename(originalName: string): string {
  const base = path.basename(originalName || 'attachment');
  return base
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}._\- ()]/gu, '_')
    .slice(0, 120);
}

export interface ValidatedUpload {
  ok: boolean;
  error?: string;
  sanitizedBuffer?: Buffer;
  detectedMime?: AllowedMimeType;
  storageFileName?: string;
  safeOriginalName?: string;
  sha256?: string;
}

/**
 * Full server-side file upload validation pipeline (Rule 20).
 */
export function validateAndSanitizeUploadedFile(params: {
  originalFilename: string;
  declaredMime?: string;
  buffer: Buffer;
}): ValidatedUpload {
  const { originalFilename, declaredMime, buffer } = params;

  if (!buffer || buffer.length === 0) {
    return { ok: false, error: 'EMPTY_FILE' };
  }

  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    return { ok: false, error: 'FILE_TOO_LARGE' };
  }

  const ext = path.extname(originalFilename || '').toLowerCase();
  const expectedMimeFromExt = EXTENSION_TO_MIME[ext];
  if (!expectedMimeFromExt) {
    return { ok: false, error: 'DISALLOWED_FILE_EXTENSION' };
  }

  const detectedMime = detectMagicByteMime(buffer);
  if (!detectedMime) {
    return { ok: false, error: 'INVALID_FILE_MAGIC_BYTES' };
  }

  // Ensure file extension matches actual magic-byte MIME
  if (detectedMime !== expectedMimeFromExt) {
    return { ok: false, error: 'EXTENSION_MIME_MISMATCH' };
  }

  // If client declared a specific MIME (other than generic octet-stream), verify it matches
  if (
    declaredMime &&
    declaredMime !== 'application/octet-stream' &&
    declaredMime.toLowerCase() !== detectedMime &&
    !(declaredMime === 'image/jpg' && detectedMime === 'image/jpeg')
  ) {
    return { ok: false, error: 'DECLARED_MIME_MISMATCH' };
  }

  // Malware & script/polyglot scan
  const scan = scanBufferForMalwareAndPayloads(buffer, detectedMime);
  if (!scan.clean) {
    return { ok: false, error: scan.reason || 'MALWARE_SCAN_FAILED' };
  }

  // Strip EXIF/GPS metadata where applicable
  let sanitizedBuffer = buffer;
  if (detectedMime === 'image/jpeg') {
    sanitizedBuffer = stripJpegExifMetadata(buffer);
  } else if (detectedMime === 'image/png') {
    sanitizedBuffer = stripPngMetadata(buffer);
  }

  const canonicalExt = MIME_TO_CANONICAL_EXT[detectedMime];
  const storageFileName = `${crypto.randomUUID()}${canonicalExt}`;
  const safeOriginalName = sanitizeDisplayFilename(originalFilename);
  const sha256 = crypto.createHash('sha256').update(sanitizedBuffer).digest('hex');

  return {
    ok: true,
    sanitizedBuffer,
    detectedMime,
    storageFileName,
    safeOriginalName,
    sha256,
  };
}
