export function vectorToBuffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function bufferToVector(buf: Buffer, expectedDim: number): number[] {
  if (buf.length !== expectedDim * 4) {
    throw new Error(`float32 buffer wrong size: got ${buf.length}, expected ${expectedDim * 4}`);
  }
  // Node Buffers are views into shared slabs — buf.byteOffset may not be
  // 4-aligned, which Float32Array requires. Copy to a fresh ArrayBuffer to
  // guarantee alignment.
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  const f32 = new Float32Array(copy.buffer, 0, expectedDim);
  return Array.from(f32);
}
