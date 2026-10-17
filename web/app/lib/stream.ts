import type { StreamEvent } from './types';

/** Lower-case hex SHA-256 of a string, via the Web Crypto API. */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Incremental NDJSON parser.
 *
 * Chunk boundaries fall wherever the network puts them, not on line breaks, so
 * the trailing partial line is held in `buffer` until the rest of it turns up.
 * Feed it decoded text with `push`; it returns the events completed by that chunk.
 */
export function createNdjsonParser() {
  let buffer = '';

  return {
    push(chunk: string): StreamEvent[] {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      const events: StreamEvent[] = [];
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          events.push(JSON.parse(line) as StreamEvent);
        } catch {
          continue; // Ignore anything that isn't a complete JSON object.
        }
      }
      return events;
    },
  };
}
