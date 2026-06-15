/**
 * On-disk staging paths for presigned uploads (openarx-contracts-xuqi).
 *
 * A filled upload lives at {PORTAL_STORAGE_BASE}/{userId}/.uploads/{fileId} —
 * a sibling of the canonical {userId}/{coreDocId} document directories, so the
 * whole tree stays under the portal storage root that /publish-document's
 * realpath allowlist accepts. Shared by the PUT endpoint (writes), the
 * content_ref handler (reads) and the cleanup job (removes).
 */
import { join } from 'node:path';

const PORTAL_STORAGE_BASE = process.env.PORTAL_STORAGE_BASE ?? '/mnt/storagebox/openarx/portal-docs';

export function uploadDir(userId: string): string {
  return join(PORTAL_STORAGE_BASE, userId, '.uploads');
}

export function uploadFilePath(userId: string, fileId: string): string {
  return join(uploadDir(userId), fileId);
}
