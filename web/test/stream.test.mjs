// Run: npm test --workspace=web  (Node >= 22.18 runs the .ts import directly by stripping types)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNdjsonParser, sha256Hex } from '../app/lib/stream.ts';

test('sha256Hex matches published SHA-256 vectors', async () => {
  assert.equal(
    await sha256Hex(''),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('sha256Hex hashes UTF-8 bytes and pads to 64 lower-case hex chars', async () => {
  const h = await sha256Hex('{"message":"café"}');
  assert.match(h, /^[0-9a-f]{64}$/);
});

test('parses one event per line', () => {
  const p = createNdjsonParser();
  const events = p.push('{"type":"text","delta":"Hi"}\n{"type":"done"}\n');
  assert.deepEqual(events, [{ type: 'text', delta: 'Hi' }, { type: 'done' }]);
});

test('holds a partial line until the rest arrives', () => {
  const p = createNdjsonParser();
  assert.deepEqual(p.push('{"type":"te'), []);
  assert.deepEqual(p.push('xt","delta":"A"}'), []); // no newline yet
  assert.deepEqual(p.push('\n{"type":"done"}\n'), [
    { type: 'text', delta: 'A' },
    { type: 'done' },
  ]);
});

test('skips blank lines and malformed JSON without losing later events', () => {
  const p = createNdjsonParser();
  const events = p.push('\n  \nnot json\n{"type":"session","sessionId":"s1"}\n');
  assert.deepEqual(events, [{ type: 'session', sessionId: 's1' }]);
});

test('an unterminated final line is never emitted (matches previous page behaviour)', () => {
  const p = createNdjsonParser();
  assert.deepEqual(p.push('{"type":"done"}'), []);
});
