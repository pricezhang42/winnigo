/**
 * Reads a body stream into memory, stopping at `maxBytes`. The limit is enforced while
 * reading, so chunked requests without a Content-Length header are bounded too.
 * Returns the bytes, or null (after cancelling the stream) when the body is too large.
 * A missing stream reads as an empty body.
 *
 * @param {ReadableStream<Uint8Array> | null | undefined} stream
 * @param {number} maxBytes
 * @returns {Promise<Uint8Array<ArrayBuffer> | null>}
 */
export async function readLimited(stream, maxBytes) {
  const chunks = [];
  let size = 0;
  if (stream) {
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}
