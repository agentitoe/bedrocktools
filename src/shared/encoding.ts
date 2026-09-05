/** Shared singleton encoder/decoder: avoids per-call allocation. */
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8");

/**
 * Decode UTF-8 bytes, stripping a leading BOM if present.
 * Uses `subarray` (zero-copy view) instead of `slice` (copy).
 */
export function decodeUtf8Sig(data: Uint8Array): string {
	if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
		return utf8Decoder.decode(data.subarray(3));
	}
	return utf8Decoder.decode(data);
}

/**
 * Encode text as UTF-8 bytes via the shared encoder.
 */
export function encodeUtf8(text: string): Uint8Array {
	return utf8Encoder.encode(text);
}