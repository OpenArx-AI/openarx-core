import { createHash } from 'node:crypto';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function cacheKey(model: string, dim: number, text: string): string {
  return `emb:${model}:${dim}:${sha256Hex(text)}`;
}
