const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++)
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;

  TABLE[i] = c >>> 0;
}

/**
 * Standard CRC32 (zlib polynomial), as used by Valve for VPK entries.
 * Returns an unsigned 32-bit integer.
 */
export function crc32(data: Buffer, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++)
    crc = TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);

  return (crc ^ 0xffffffff) >>> 0;
}
