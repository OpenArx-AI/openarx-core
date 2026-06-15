/**
 * Magic-byte sniffing for upload intake (openarx-contracts-xuqi).
 *
 * Used at two points: the PUT endpoint validates the first chunk against the
 * declared content type, and the content_ref handler routes a ZIP to archive
 * extraction vs. a single file to single-file staging.
 */
export type DetectedKind = 'zip' | 'pdf' | 'text' | 'binary';

/** Classify from the leading bytes. ZIP = PK\x03\x04, PDF = %PDF-; a NUL byte
 *  is the cheap "opaque binary, not source text" tell; everything else is
 *  treated as text (latex/markdown have no reliable signature). */
export function detectKind(head: Buffer): DetectedKind {
  if (head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) {
    return 'zip';
  }
  if (head.length >= 5 && head.toString('latin1', 0, 5) === '%PDF-') {
    return 'pdf';
  }
  if (head.includes(0x00)) return 'binary';
  return 'text';
}

/**
 * PUT-time acceptance. When create_upload_url declared an expected_content_type
 * the bytes must match its signature; otherwise accept zip/pdf/text and reject
 * only opaque binary. Permissive on text formats by design.
 *
 * @returns null when acceptable, else a human-readable reason for the 400.
 */
export function checkUploadMagic(head: Buffer, expectedContentType: string | null): string | null {
  const kind = detectKind(head);
  if (expectedContentType === 'application/zip') {
    return kind === 'zip' ? null : 'declared application/zip but bytes are not a ZIP (PK\\x03\\x04 signature)';
  }
  if (expectedContentType === 'application/pdf') {
    return kind === 'pdf' ? null : 'declared application/pdf but bytes are not a PDF (%PDF- signature)';
  }
  // text/x-tex, text/markdown, or no declared type → accept anything that is
  // not opaque binary.
  return kind === 'binary'
    ? 'payload looks like opaque binary but has no ZIP/PDF signature and no matching expected_content_type'
    : null;
}
