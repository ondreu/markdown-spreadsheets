/**
 * FNV-1a, 32 bit, hex encoded.
 *
 * Used for anchor fingerprints (§7) and for the write-time conflict check (§13.1).
 * Not a security primitive — it only has to be stable across sessions and cheap
 * enough to run on every `vault.on('modify')`.
 */
export function fnv1a(input: string): string {
	let h = 0x811c9dc5;
	for (let i = 0; i < input.length; i++) {
		h ^= input.charCodeAt(i);
		// h *= 16777619, kept inside 32 bits
		h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
	}
	return h.toString(16).padStart(8, "0");
}
