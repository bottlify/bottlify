/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LZNT1, the compression NTFS and the Rtl compression calls use, as
 * [MS-XCA] 2.5 lays it out.
 *
 * The data is cut into chunks of 4096 bytes. Each chunk starts with a
 * little-endian header: its stored size less three in the low twelve bits,
 * the signature 3 above them, and the top bit set when the chunk is
 * compressed. A compressed chunk is a run of flag bytes, each followed by up
 * to eight tokens: a clear bit a literal byte, a set bit a two-byte copy
 * token whose split between displacement and length depends on how far into
 * the chunk it stands. A chunk that would not shrink is stored as it is. A
 * header of zero ends the stream before the input does.
 */

/** COMPRESSION_FORMAT_LZNT1. */
export const COMPRESSION_FORMAT_LZNT1 = 2;
/** The bytes a chunk holds once it is decompressed. */
const CHUNK = 4096;
const SIGNATURE = 0x3000;
const COMPRESSED = 0x8000;
/** The shortest copy a token can say. */
const MIN_MATCH = 3;

/**
 * The split of a copy token at a position in its chunk: the bits that say the
 * length, and how far the displacement is shifted above them.
 *
 * @param {number} position  bytes of the chunk already produced, at least 1
 */
function split(position){
    let lengthMask = 0xfff;
    let shift = 12;
    for (let at = position - 1; at >= 0x10; at >>= 1)
    {
        lengthMask >>= 1;
        shift--;
    }
    return { lengthMask, shift };
}

/**
 * Compresses one chunk of at most 4096 bytes: its tokens, or null when they
 * would take more room than the bytes themselves.
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array | null}
 */
function compressChunk(data){
    const out = new Uint8Array(data.length + Math.ceil(data.length / 8) + 2);
    let written = 0;
    let at = 0;
    while (at < data.length)
    {
        const flagAt = written++;
        let flags = 0;
        for (let bit = 0; bit < 8 && at < data.length; bit++)
        {
            const { lengthMask, shift } = split(Math.max(at, 1));
            const longest = Math.min(lengthMask + MIN_MATCH, data.length - at);
            const farthest = Math.min(at, (0xffff >>> shift) + 1);
            let bestLength = 0;
            let bestDistance = 0;
            for (let distance = 1; distance <= farthest; distance++)
            {
                let length = 0;
                while (length < longest && data[at + length] === data[at - distance + length])
                {
                    length++;
                }
                if (length > bestLength)
                {
                    bestLength = length;
                    bestDistance = distance;
                    if (length === longest)
                    {
                        break;
                    }
                }
            }
            if (bestLength >= MIN_MATCH)
            {
                const token = ((bestDistance - 1) << shift) | (bestLength - MIN_MATCH);
                out[written++] = token & 0xff;
                out[written++] = token >>> 8;
                flags |= 1 << bit;
                at += bestLength;
            }
            else
            {
                out[written++] = data[at++];
            }
            if (written >= data.length)
            {
                return null;
            }
        }
        out[flagAt] = flags;
    }
    return out.subarray(0, written);
}

/**
 * Compresses a buffer whole, chunk after chunk.
 *
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
export function compress(data){
    /** @type {Uint8Array[]} */
    const parts = [];
    for (let at = 0; at < data.length; at += CHUNK)
    {
        const chunk = data.subarray(at, Math.min(at + CHUNK, data.length));
        const tokens = compressChunk(chunk);
        const body = tokens ?? chunk;
        const header = (tokens ? COMPRESSED : 0) | SIGNATURE | (body.length + 2 - MIN_MATCH);
        parts.push(Uint8Array.of(header & 0xff, header >>> 8), body);
    }
    const total = parts.reduce((sum, part)=>sum + part.length, 0);
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const part of parts)
    {
        out.set(part, cursor);
        cursor += part.length;
    }
    return out;
}

/**
 * Decompresses a stream into at most `room` bytes.
 *
 * @param {Uint8Array} input
 * @param {number} room
 * @returns {{ bytes: Uint8Array } | { bad: true }}  bad: a chunk that cannot be read
 */
export function decompress(input, room){
    const out = new Uint8Array(room);
    let written = 0;
    let at = 0;
    while (at + 2 <= input.length && written < room)
    {
        const header = input[at] | input[at + 1] << 8;
        if (header === 0)
        {
            break;
        }
        const stored = (header & 0xfff) + MIN_MATCH - 2;
        at += 2;
        if (at + stored > input.length)
        {
            return { bad: true };
        }
        const end = at + stored;
        const chunkStart = written;
        if ((header & COMPRESSED) === 0)
        {
            const take = Math.min(stored, room - written);
            out.set(input.subarray(at, at + take), written);
            written += take;
            at = end;
            continue;
        }
        while (at < end && written < room)
        {
            const flags = input[at++];
            for (let bit = 0; bit < 8 && at < end && written < room; bit++)
            {
                if ((flags & (1 << bit)) === 0)
                {
                    out[written++] = input[at++];
                    continue;
                }
                if (at + 2 > end)
                {
                    return { bad: true };
                }
                const token = input[at] | input[at + 1] << 8;
                at += 2;
                const position = written - chunkStart;
                if (position === 0)
                {
                    return { bad: true };
                }
                const { lengthMask, shift } = split(position);
                const distance = (token >>> shift) + 1;
                if (distance > position)
                {
                    return { bad: true };
                }
                const length = (token & lengthMask) + MIN_MATCH;
                for (let copied = 0; copied < length && written < room; copied++)
                {
                    out[written] = out[written - distance];
                    written++;
                }
            }
        }
        at = end;
    }
    return { bytes: out.subarray(0, written) };
}

const STATUS_SUCCESS = 0;
const STATUS_BUFFER_TOO_SMALL = 0xc0000023;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_UNSUPPORTED_COMPRESSION = 0xc000025f;
const STATUS_BAD_COMPRESSION_BUFFER = 0xc0000242;
/** COMPRESSION_FORMAT_NONE and COMPRESSION_FORMAT_DEFAULT: no format at all. */
const FORMAT_NONE = 0;
const FORMAT_DEFAULT = 1;
/** The low byte of the format word is the format; the rest the engine. */
const FORMAT_MASK = 0xff;
/** What a compression and a fragment's decompression ask of their work space. */
const WORKSPACE = 0x10000;
const FRAGMENT_WORKSPACE = CHUNK;

/**
 * The status a format word is refused with, or null for LZNT1: none and the
 * default are no format, any other is one this system does not have.
 *
 * @param {number} format
 */
function refused(format){
    const kind = format & FORMAT_MASK;
    if (kind === FORMAT_NONE || kind === FORMAT_DEFAULT)
    {
        return STATUS_INVALID_PARAMETER;
    }
    return kind === COMPRESSION_FORMAT_LZNT1 ? null : STATUS_UNSUPPORTED_COMPRESSION;
}

/**
 * The Rtl compression calls over LZNT1.
 *
 * @param {{ readMemory: (address: number, length: number) => Uint8Array,
 *     writeMemory: (address: number, bytes: Uint8Array) => void }} host
 */
export function createCompressionFunctions(host){
    /** @param {number} at @param {number} value */
    const putDword = (at, value)=>host.writeMemory(at, Uint8Array.of(value & 0xff,
        value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24));
    /** @param {number} address @param {number} length */
    const read = (address, length)=>((length >>> 0) === 0 ? new Uint8Array(0)
        : host.readMemory(address >>> 0, length >>> 0).slice());

    /**
     * Decompresses into the caller's buffer, skipping `skip` bytes of the
     * output first: RtlDecompressBuffer's and RtlDecompressFragment's body.
     *
     * @param {number[]} args  format, out, room, input, inputLength
     * @param {number} skip @param {number} final
     */
    const decompressInto = ([format, out, room, input, length], skip, final)=>{
        const refusal = refused(format & 0xffff);
        if (refusal !== null)
        {
            return refusal;
        }
        const result = decompress(read(input, length), (room >>> 0) + skip);
        if ('bad' in result)
        {
            return STATUS_BAD_COMPRESSION_BUFFER;
        }
        const bytes = result.bytes.subarray(Math.min(skip, result.bytes.length));
        if (bytes.length > 0)
        {
            host.writeMemory(out >>> 0, bytes);
        }
        putDword(final >>> 0, bytes.length);
        return STATUS_SUCCESS;
    };

    return {
        /**
         * NTSTATUS RtlGetCompressionWorkSpaceSize(USHORT CompressionFormatAndEngine,
         *   PULONG CompressBufferWorkSpaceSize, PULONG CompressFragmentWorkSpaceSize)
         */
        RtlGetCompressionWorkSpaceSize: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([format, buffer, fragment])=>{
                const refusal = refused(format & 0xffff);
                if (refusal !== null)
                {
                    return refusal;
                }
                putDword(buffer >>> 0, WORKSPACE);
                putDword(fragment >>> 0, FRAGMENT_WORKSPACE);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlCompressBuffer(USHORT CompressionFormatAndEngine,
         *   PUCHAR UncompressedBuffer, ULONG UncompressedBufferSize,
         *   PUCHAR CompressedBuffer, ULONG CompressedBufferSize,
         *   ULONG UncompressedChunkSize, PULONG FinalCompressedSize, PVOID WorkSpace)
         *
         * The whole buffer or nothing: what does not fit is STATUS_BUFFER_TOO_SMALL.
         */
        RtlCompressBuffer: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([format, input, length, out, room, , final])=>{
                const refusal = refused(format & 0xffff);
                if (refusal !== null)
                {
                    return refusal;
                }
                const packed = compress(read(input, length));
                if (packed.length > (room >>> 0))
                {
                    return STATUS_BUFFER_TOO_SMALL;
                }
                if (packed.length > 0)
                {
                    host.writeMemory(out >>> 0, packed);
                }
                putDword(final >>> 0, packed.length);
                return STATUS_SUCCESS;
            },
        },

        /**
         * NTSTATUS RtlDecompressBuffer(USHORT CompressionFormat,
         *   PUCHAR UncompressedBuffer, ULONG UncompressedBufferSize,
         *   PUCHAR CompressedBuffer, ULONG CompressedBufferSize,
         *   PULONG FinalUncompressedSize)
         *
         * As much as the buffer holds; a chunk that cannot be read is
         * STATUS_BAD_COMPRESSION_BUFFER.
         */
        RtlDecompressBuffer: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: args=>decompressInto(args, 0, args[5]),
        },

        /** RtlDecompressBuffer with a work space it does not need here. */
        RtlDecompressBufferEx: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: args=>decompressInto(args, 0, args[5]),
        },

        /**
         * NTSTATUS RtlDecompressFragment(USHORT CompressionFormat,
         *   PUCHAR UncompressedFragment, ULONG UncompressedFragmentSize,
         *   PUCHAR CompressedBuffer, ULONG CompressedBufferSize,
         *   ULONG FragmentOffset, PULONG FinalUncompressedSize, PVOID WorkSpace)
         *
         * The decompressed bytes from FragmentOffset on.
         */
        RtlDecompressFragment: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: args=>decompressInto(args, args[5] >>> 0, args[6]),
        },
    };
}
