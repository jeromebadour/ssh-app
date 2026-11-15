// Before an engine is started, its file is hashed and compared with the hash that was written into the app's
// own code when it was built. A swapped or damaged engine is never started.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';

export function hashFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

// Returns '' when the engine is the one this app was built with, or the reason it is not.
export async function engineFault(engineFile: string, hashesFile: string, platformKey: string): Promise<string> {
  let expected: unknown;
  try {
    expected = (JSON.parse(await readFile(hashesFile, 'utf8')) as Record<string, unknown>)[platformKey];
  } catch {
    return 'the app has no record of its engine';
  }
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/.test(expected)) return 'the app has no record of its engine for this system';
  let actual: string;
  try {
    actual = await hashFile(engineFile);
  } catch {
    return 'the engine file is missing';
  }
  return actual === expected ? '' : 'the engine file is not the one this app was built with';
}
