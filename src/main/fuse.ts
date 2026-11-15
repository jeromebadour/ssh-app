// Reads one fuse from an Electron program file. Fuses are switches burnt into the binary at packaging time;
// they sit right after a fixed marker text as: one version byte, one count byte, then one byte per fuse
// ('1' on, '0' off, 'r' removed). Main uses this for one question only: is this binary a lab build?
const SENTINEL = Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX', 'ascii');

// The position of "EnableNodeCliInspectArguments" in fuse version 1. The packaging script checks this number
// against Electron's own fuse tool on every build.
export const FUSE_NODE_CLI_INSPECT = 3;

export type FuseState = 'on' | 'off' | 'removed' | 'unknown';

export function fuseIn(binary: Uint8Array, index: number): FuseState {
  const at = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength).indexOf(SENTINEL);
  if (at < 0) return 'unknown';
  const start = at + SENTINEL.length;
  const version = binary[start];
  const count = binary[start + 1];
  if (version !== 1 || count === undefined || index < 0 || index >= count) return 'unknown';
  const value = binary[start + 2 + index];
  return value === 0x31 ? 'on' : value === 0x30 ? 'off' : value === 0x72 ? 'removed' : 'unknown';
}
