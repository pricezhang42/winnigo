export function eventPhotoType(bytes) {
  return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    ? 'image/jpeg'
    : bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : null;
}
