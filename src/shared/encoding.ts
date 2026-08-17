export function decodeUtf8Sig(data: Uint8Array): string {
	let buf = data;
	if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
		buf = buf.slice(3);
	}
	return new TextDecoder("utf-8").decode(buf);
}

export function encodeUtf8(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}