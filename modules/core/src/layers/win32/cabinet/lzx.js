/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LZX decoding, in the two framings Windows uses it in.
 *
 * A cabinet's LZX folder (the Cabinet SDK's "LZX Data Compression Format")
 * is one stream cut into CFDATA frames of 32 KiB of output each. The
 * compressor aligns its bit buffer on a 16-bit boundary after every frame and
 * never lets a match cross one, so each frame's bytes are read with a bit
 * reader of their own; everything else -- the window, the three repeated
 * offsets, the path lengths every tree is sent as a delta against, an LZX
 * block that has not ended -- carries from one frame to the next, and a new
 * folder is a new decoder.
 *
 * LZX DELTA (LZXD), the Patch API's, is the same block format over a window
 * that already holds a reference -- the old file -- before the first byte of
 * output, so a match can reach back into it; what lies before the reference
 * reads as zeros. Its stream is one buffer of chunks, each a 16-bit byte
 * count and then the bits of up to 32 KiB of output, the bit reader starting
 * over at every chunk; a block, and a match, may run on from one chunk into
 * the next. Its window is sized from the two files and may reach 32 MiB, so
 * it has up to 290 position slots, and a match of the longest length a block
 * can say is lengthened by a further code.
 *
 * The bitstream is 16-bit little-endian words read most significant bit
 * first, and every tree is canonical Huffman sent as path lengths.
 */

const NUM_CHARS = 256;
const MIN_MATCH = 2;
const MAX_MATCH = 257;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_ELEMENTS = 20;
const ALIGNED_ELEMENTS = 8;
const MAX_PATH_LENGTH = 16;

const BLOCK_VERBATIM = 1;
const BLOCK_ALIGNED = 2;
const BLOCK_UNCOMPRESSED = 3;

/**
 * The output one CFDATA frame represents, and one LZXD chunk at most; only
 * the last may be shorter.
 */
export const FRAME_SIZE = 32768;

/** The x86 CALL translation stops after this many frames' worth of output. */
const TRANSLATED_FRAMES = 32768;

/** Thrown for input that is not an LZX stream this decoder can finish. */
export class LzxError extends Error {}

/**
 * LZXD's further length after a match of 257, by the prefix before it -- 0,
 * 10, 110 or 111: how many bits follow, and what they are added to.
 */
const LONGER_BITS = [8, 10, 12, 15];
const LONGER_BASE = [0, 0x100, 0x500, 0];

/** Position slots of the largest window, LZXD's 32 MiB. */
const MAX_POSITION_SLOTS = 290;

/**
 * The position slot table: base position and footer bits per slot. Footers
 * grow by one bit every two slots up to seventeen, and stay there.
 */
const EXTRA_BITS = new Uint8Array(MAX_POSITION_SLOTS);
const BASE_POSITION = new Uint32Array(MAX_POSITION_SLOTS);
for (let slot = 0, base = 0; slot < MAX_POSITION_SLOTS; slot++)
{
    EXTRA_BITS[slot] = slot < 4 ? 0 : Math.min(17, (slot >> 1) - 1);
    BASE_POSITION[slot] = base;
    base += 2 ** EXTRA_BITS[slot];
}

/**
 * How many position slots a window of `2^bits` bytes has: every slot whose
 * base lies inside the window.
 *
 * @param {number} bits
 */
export const positionSlots = bits=>BASE_POSITION.filter(base=>base < 2 ** bits).length;

/**
 * A canonical Huffman code as a lookup table indexed by the next `bits` bits
 * of input: each entry holds the symbol in its low half and the code's
 * length in its high half, 0 where no code lies.
 *
 * @typedef {{ table: Uint32Array, bits: number }} Code
 */

/**
 * @param {ArrayLike<number>} lengths
 * @returns {Code}
 */
function buildCode(lengths){
    let longest = 0;
    const counts = new Uint16Array(MAX_PATH_LENGTH + 1);
    for (let symbol = 0; symbol < lengths.length; symbol++)
    {
        counts[lengths[symbol]]++;
        longest = Math.max(longest, lengths[symbol]);
    }
    // A tree nothing in the block uses may be sent with no elements at all;
    // it is an error only if something is then decoded with it.
    if (longest === 0)
    {
        return { table: new Uint32Array(1), bits: 0 };
    }
    counts[0] = 0;
    // Each length's first code follows the last code of the length before,
    // shifted left once; more codes than a length has room for is no tree.
    const next = new Uint32Array(MAX_PATH_LENGTH + 1);
    let code = 0;
    for (let length = 1; length <= MAX_PATH_LENGTH; length++)
    {
        next[length] = code;
        code = (code + counts[length]) << 1;
        if (code > (2 << length))
        {
            throw new LzxError('over-subscribed path lengths');
        }
    }
    const table = new Uint32Array(1 << longest);
    for (let symbol = 0; symbol < lengths.length; symbol++)
    {
        const length = lengths[symbol];
        if (length === 0)
        {
            continue;
        }
        const assigned = next[length]++;
        const shift = longest - length;
        const first = assigned << shift;
        table.fill(symbol | (length << 16), first, first + (1 << shift));
    }
    return { table, bits: longest };
}

/**
 * Reads one frame's or chunk's bits: 16-bit little-endian words, most
 * significant bit first. Past the end it reads zeros, as a compressor's final
 * flush may leave the last code's padding to the reader; a reader that has
 * run far past the end has been fed something else.
 *
 * @param {Uint8Array} input
 */
function bitReader(input){
    let at = 0;
    let buffer = 0;
    let count = 0;

    const fill = ()=>{
        const word = (at < input.length ? input[at] : 0)
            | (at + 1 < input.length ? input[at + 1] << 8 : 0);
        at += 2;
        if (at > input.length + 8)
        {
            throw new LzxError('the frame ends inside a block');
        }
        buffer = (((buffer & ((1 << count) - 1)) << 16) | word) >>> 0;
        count += 16;
    };

    /** @param {number} n  At most 16, so one word is always enough. */
    const peek = n=>{
        if (count < n)
        {
            fill();
        }
        return (buffer >>> (count - n)) & ((1 << n) - 1);
    };

    return {
        peek,
        /** @param {number} n */
        skip: n=>{
            count -= n;
        },
        /** @param {number} n  Up to 24. */
        bits(n){
            if (n > 16)
            {
                const high = peek(n - 16);
                count -= n - 16;
                const low = peek(16);
                count -= 16;
                return high * 65536 + low;
            }
            const value = n === 0 ? 0 : peek(n);
            count -= n;
            return value;
        },
        /** @param {Code} code */
        decode(code){
            if (code.bits === 0)
            {
                throw new LzxError('a code from a tree with no elements');
            }
            const entry = code.table[peek(code.bits)];
            if (entry === 0)
            {
                throw new LzxError('a code no tree has');
            }
            count -= entry >>> 16;
            return entry & 0xffff;
        },
        /**
         * Leaves the bitstream at the next 16-bit boundary for a run of raw
         * bytes: 1 to 16 bits of padding, a whole word when already on one.
         */
        align(){
            if (count === 0)
            {
                fill();
            }
            count = 0;
        },
        /**
         * The same, as the Patch API's compressor pads: on a boundary already,
         * it writes the word of padding only some of the time, and when it
         * does the word is zero. A zero word there is taken as that padding.
         */
        alignIfPadded(){
            if (count === 0)
            {
                if (at + 1 < input.length && (input[at] | input[at + 1]) === 0)
                {
                    at += 2;
                }
                return;
            }
            count = 0;
        },
        /** Where the byte stream stands once the bits are aligned. */
        byteAt: ()=>at,
        /** @param {number} position  Resumes the bitstream at a byte offset. */
        resumeAt(position){
            at = position;
            buffer = 0;
            count = 0;
        },
        /** Whether bits past the input's end were taken as part of it. */
        overran: ()=>at * 8 - count > input.length * 8,
    };
}

/** @typedef {ReturnType<typeof bitReader>} BitReader */

/**
 * What an LZX stream carries from one block, frame or chunk to the next, and
 * the decoding of its blocks into the window -- the part both framings share.
 *
 * The window is a power of two and is written circularly. A stream with a
 * reference holds the reference and the whole output without wrapping, so
 * what a match reaches before the reference is window never written: zeros.
 *
 * @param {number} windowBits  The window is `2^windowBits` bytes.
 * @param {number} slots  Position slots the main tree has elements for.
 * @param {boolean} delta  LZXD's rules rather than a cabinet's.
 */
function createBlockDecoder(windowBits, slots, delta){
    const windowSize = 2 ** windowBits;
    const windowMask = windowSize - 1;
    const mainElements = NUM_CHARS + slots * 8;

    const window = new Uint8Array(windowSize);
    const mainLengths = new Uint8Array(mainElements);
    const lengthLengths = new Uint8Array(NUM_SECONDARY_LENGTHS);

    let position = 0;
    let r0 = 1;
    let r1 = 1;
    let r2 = 1;
    let blockType = 0;
    let blockRemaining = 0;
    /** Of an uncompressed block: whether it ended on an odd byte, owing a pad. */
    let oddPad = false;
    /** @type {Code} */
    let mainCode = buildCode([]);
    /** @type {Code} */
    let lengthCode = buildCode([]);
    /** @type {Code} */
    let alignedCode = buildCode([]);

    /**
     * Reads a pre-tree and then path lengths through it, each a delta from
     * the one the same element had in the previous tree (mod 17), or a run.
     *
     * @param {BitReader} reader
     * @param {Uint8Array} lengths @param {number} first @param {number} last
     */
    const readLengths = (reader, lengths, first, last)=>{
        const pre = new Uint8Array(PRETREE_ELEMENTS);
        for (let i = 0; i < PRETREE_ELEMENTS; i++)
        {
            pre[i] = reader.bits(4);
        }
        const pretree = buildCode(pre);
        for (let x = first; x < last;)
        {
            const code = reader.decode(pretree);
            if (code === 17 || code === 18)
            {
                const run = code === 17 ? 4 + reader.bits(4) : 20 + reader.bits(5);
                if (x + run > last)
                {
                    throw new LzxError('a run of path lengths past the tree');
                }
                lengths.fill(0, x, x + run);
                x += run;
            }
            else if (code === 19)
            {
                const run = 4 + reader.bits(1);
                const change = reader.decode(pretree);
                if (change > 16 || x + run > last)
                {
                    throw new LzxError('a run of path lengths past the tree');
                }
                lengths.fill((lengths[x] + 17 - change) % 17, x, x + run);
                x += run;
            }
            else
            {
                lengths[x] = (lengths[x] + 17 - code) % 17;
                x++;
            }
        }
    };

    /** @param {BitReader} reader @param {Uint8Array} input */
    const readBlockHeader = (reader, input)=>{
        if (oddPad)
        {
            reader.resumeAt(reader.byteAt() + 1);
            oddPad = false;
        }
        blockType = reader.bits(3);
        blockRemaining = reader.bits(24);
        if (blockRemaining === 0)
        {
            throw new LzxError('an empty block');
        }
        if (blockType === BLOCK_ALIGNED)
        {
            const aligned = new Uint8Array(ALIGNED_ELEMENTS);
            for (let i = 0; i < ALIGNED_ELEMENTS; i++)
            {
                aligned[i] = reader.bits(3);
            }
            alignedCode = buildCode(aligned);
        }
        if (blockType === BLOCK_VERBATIM || blockType === BLOCK_ALIGNED)
        {
            readLengths(reader, mainLengths, 0, NUM_CHARS);
            readLengths(reader, mainLengths, NUM_CHARS, mainElements);
            mainCode = buildCode(mainLengths);
            readLengths(reader, lengthLengths, 0, NUM_SECONDARY_LENGTHS);
            lengthCode = buildCode(lengthLengths);
        }
        else if (blockType === BLOCK_UNCOMPRESSED)
        {
            if (delta)
            {
                reader.alignIfPadded();
            }
            else
            {
                reader.align();
            }
            const at = reader.byteAt();
            if (at + 12 > input.length)
            {
                throw new LzxError('an uncompressed block with no offsets');
            }
            const view = new DataView(input.buffer, input.byteOffset + at, 12);
            r0 = view.getUint32(0, true);
            r1 = view.getUint32(4, true);
            r2 = view.getUint32(8, true);
            // An offset of zero would copy a byte onto itself; the Patch
            // API's decoder refuses one rather than produce garbage.
            if (delta && (r0 === 0 || r1 === 0 || r2 === 0))
            {
                throw new LzxError('a repeated offset of zero');
            }
            reader.resumeAt(at + 12);
            oddPad = (blockRemaining & 1) === 1;
        }
        else
        {
            throw new LzxError(`block type ${blockType} is undefined`);
        }
    };

    /**
     * Copies `count` raw bytes of an uncompressed block from where the
     * reader stands, and steps over the pad byte if that ends the block on
     * an odd one.
     *
     * @param {BitReader} reader @param {Uint8Array} input @param {number} count
     */
    const copyRaw = (reader, input, count)=>{
        const at = reader.byteAt();
        if (at + count > input.length)
        {
            throw new LzxError('an uncompressed block past its frame');
        }
        for (let i = 0; i < count; i++)
        {
            window[position] = input[at + i];
            position = (position + 1) & windowMask;
        }
        reader.resumeAt(at + count);
        blockRemaining -= count;
        if (blockRemaining === 0 && oddPad)
        {
            reader.resumeAt(reader.byteAt() + 1);
            oddPad = false;
        }
    };

    /**
     * Decodes elements of a verbatim or aligned block until at least `want`
     * bytes have come out. A match may run on past `want` -- an LZXD match
     * crosses chunks -- but never past `room`.
     *
     * @param {BitReader} reader
     * @param {number} want  At most the block's remaining bytes.
     * @param {number} room  At least `want`, at most the block's remaining bytes.
     * @returns {number} the bytes produced
     */
    const decodeElements = (reader, want, room)=>{
        let produced = 0;
        while (produced < want)
        {
            const element = reader.decode(mainCode);
            if (element < NUM_CHARS)
            {
                window[position] = element;
                position = (position + 1) & windowMask;
                produced++;
                continue;
            }
            const header = element - NUM_CHARS;
            let length = header & NUM_PRIMARY_LENGTHS;
            if (length === NUM_PRIMARY_LENGTHS)
            {
                length += reader.decode(lengthCode);
            }
            length += MIN_MATCH;

            const slot = header >> 3;
            let offset;
            if (slot === 0)
            {
                offset = r0;
            }
            else if (slot === 1)
            {
                offset = r1;
                r1 = r0;
                r0 = offset;
            }
            else if (slot === 2)
            {
                offset = r2;
                r2 = r0;
                r0 = offset;
            }
            else
            {
                const extra = EXTRA_BITS[slot];
                let footer;
                if (blockType === BLOCK_ALIGNED && extra >= 3)
                {
                    footer = reader.bits(extra - 3) * 8 + reader.decode(alignedCode);
                }
                else
                {
                    footer = reader.bits(extra);
                }
                offset = BASE_POSITION[slot] + footer - 2;
                r2 = r1;
                r1 = r0;
                r0 = offset;
            }
            // LZXD's longest length says the match is longer still: a prefix
            // of one to three bits picks how many bits of extra length follow.
            if (delta && length === MAX_MATCH)
            {
                let prefix = 0;
                while (prefix < 3 && reader.bits(1) === 1)
                {
                    prefix++;
                }
                length += LONGER_BASE[prefix] + reader.bits(LONGER_BITS[prefix]);
            }
            if (produced + length > room)
            {
                throw new LzxError('a match past its block or frame');
            }
            let from = (position - offset) & windowMask;
            for (let i = 0; i < length; i++)
            {
                window[position] = window[from];
                position = (position + 1) & windowMask;
                from = (from + 1) & windowMask;
            }
            produced += length;
        }
        blockRemaining -= produced;
        return produced;
    };

    return {
        windowSize,
        get position(){
            return position;
        },
        get blockRemaining(){
            return blockRemaining;
        },
        get uncompressed(){
            return blockType === BLOCK_UNCOMPRESSED;
        },
        readBlockHeader,
        copyRaw,
        decodeElements,
        /**
         * Puts the reference where the output's history begins.
         *
         * @param {Uint8Array} reference  No longer than the window.
         */
        preload(reference){
            window.set(reference, 0);
            position = reference.length & windowMask;
        },
        /**
         * The window's bytes from a position, unwrapped.
         *
         * @param {number} start @param {number} size  At most the window's size.
         */
        copyOut(start, size){
            const end = start + size;
            if (end <= windowSize)
            {
                return window.slice(start, end);
            }
            const out = new Uint8Array(size);
            out.set(window.subarray(start), 0);
            out.set(window.subarray(0, end - windowSize), windowSize - start);
            return out;
        },
    };
}

/**
 * Undoes the compressor's E8 preprocessing on one frame of output: every
 * CALL's absolute target back to the relative one the code holds.
 *
 * @param {Uint8Array} frame @param {number} start  The frame's offset in the stream.
 * @param {number} translationSize
 */
function untranslate(frame, start, translationSize){
    const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
    // The last six bytes of a frame are never translated, so a CALL is only
    // when all five of its bytes lie before them.
    for (let i = 0; i < frame.length - 10; i++)
    {
        if (frame[i] !== 0xe8)
        {
            continue;
        }
        const current = start + i;
        const absolute = view.getInt32(i + 1, true);
        if (absolute >= -current && absolute < translationSize)
        {
            const relative = absolute >= 0 ? absolute - current : absolute + translationSize;
            view.setInt32(i + 1, relative, true);
        }
        i += 4;
    }
}

/**
 * Reads the stream header: whether CALL translation was applied, and over
 * what size.
 *
 * @param {BitReader} reader
 */
const readTranslationSize = reader=>(reader.bits(1)
    ? reader.bits(16) * 65536 + reader.bits(16) : 0);

/**
 * @param {number} windowBits  15 to 21: the folder's window is `2^windowBits` bytes.
 */
export function createLzxDecoder(windowBits){
    if (!(windowBits >= 15 && windowBits <= 21))
    {
        throw new LzxError(`a window of 2^${windowBits} bytes is outside LZX's 2^15..2^21`);
    }
    const blocks = createBlockDecoder(windowBits, positionSlots(windowBits), false);

    let headerRead = false;
    let translationSize = 0;
    let frames = 0;
    /** Output of the whole folder so far, where the CALL translation measures from. */
    let folderOffset = 0;

    return {
        /** The window's size in bytes. */
        windowSize: blocks.windowSize,

        /**
         * Decodes one CFDATA frame.
         *
         * @param {Uint8Array} input  The frame's compressed bytes.
         * @param {number} size  The output the frame represents.
         * @returns {Uint8Array}
         */
        decodeFrame(input, size){
            if (size > FRAME_SIZE)
            {
                throw new LzxError(`a frame of ${size} bytes`);
            }
            const reader = bitReader(input);
            const start = blocks.position;
            let produced = 0;

            if (!headerRead)
            {
                headerRead = true;
                translationSize = readTranslationSize(reader);
            }

            while (produced < size)
            {
                if (blocks.blockRemaining === 0)
                {
                    blocks.readBlockHeader(reader, input);
                }
                const room = Math.min(blocks.blockRemaining, size - produced);
                if (blocks.uncompressed)
                {
                    blocks.copyRaw(reader, input, room);
                    produced += room;
                }
                else
                {
                    produced += blocks.decodeElements(reader, room, room);
                }
            }

            // A copy, since the window must keep what the matches were made from.
            const out = blocks.copyOut(start, size);
            if (translationSize !== 0 && frames < TRANSLATED_FRAMES)
            {
                untranslate(out, folderOffset, translationSize);
            }
            folderOffset += size;
            frames++;
            return out;
        },
    };
}

/** The window LZXD may grow to: 8 MiB, or 32 MiB for a patch made with large windows. */
export const LZXD_WINDOW = Object.freeze({ normal: 2 ** 23, large: 2 ** 25 });

/**
 * Decodes an LZXD stream against a reference.
 *
 * The stream does not say its window; the decoder deduces it as the
 * compressor chose it, from the two sizes: the smallest power of two from
 * 2^17 that holds the reference, rounded up to a whole chunk, and the
 * output, up to the largest window allowed.
 *
 * @param {Uint8Array} input  The whole stream: chunk after chunk.
 * @param {Uint8Array} reference  What the window holds before the output.
 * @param {number} size  The output's length.
 * @param {{ large?: boolean }} [options]  `large`: windows up to 32 MiB.
 * @returns {Uint8Array}
 */
export function decodeLzxd(input, reference, size, { large = false } = {}){
    if (size === 0)
    {
        return new Uint8Array(0);
    }
    const limit = large ? LZXD_WINDOW.large : LZXD_WINDOW.normal;
    const span = Math.ceil(reference.length / FRAME_SIZE) * FRAME_SIZE + size;
    let slotBits = 17;
    while (2 ** slotBits < span && 2 ** slotBits < limit)
    {
        slotBits++;
    }
    // The window itself holds the reference and the output whole, whatever
    // the slots reach, so nothing is overwritten and nothing wraps.
    let windowBits = slotBits;
    while (2 ** windowBits < reference.length + size)
    {
        windowBits++;
    }
    const blocks = createBlockDecoder(windowBits, positionSlots(slotBits), true);
    blocks.preload(reference);

    let next = 0;
    let produced = 0;
    let chunkEnd = 0;
    /** @type {Uint8Array} */
    let chunk = input;

    /**
     * Moves to the next chunk, once the one before has given every bit it
     * had and no more.
     *
     * @param {BitReader | null} previous
     */
    const openChunk = previous=>{
        if (previous?.overran())
        {
            throw new LzxError('a chunk read past its end');
        }
        if (next + 2 > input.length)
        {
            throw new LzxError('the stream ends before its output does');
        }
        const length = input[next] | (input[next + 1] << 8);
        if (next + 2 + length > input.length)
        {
            throw new LzxError('a chunk past the end of the stream');
        }
        chunk = input.subarray(next + 2, next + 2 + length);
        next += 2 + length;
        chunkEnd = Math.min(size, produced + FRAME_SIZE);
        return bitReader(chunk);
    };

    let reader = openChunk(null);
    const translationSize = readTranslationSize(reader);
    while (produced < size)
    {
        if (produced >= chunkEnd)
        {
            reader = openChunk(reader);
        }
        if (blocks.blockRemaining === 0)
        {
            blocks.readBlockHeader(reader, chunk);
        }
        const room = Math.min(blocks.blockRemaining, size - produced);
        const want = Math.min(room, chunkEnd - produced);
        if (blocks.uncompressed)
        {
            if (blocks.blockRemaining > size - produced)
            {
                throw new LzxError('an uncompressed block past the output');
            }
            blocks.copyRaw(reader, chunk, want);
            produced += want;
        }
        else
        {
            produced += blocks.decodeElements(reader, want, room);
        }
    }
    if (reader.overran())
    {
        throw new LzxError('a chunk read past its end');
    }

    const out = blocks.copyOut(reference.length, size);
    if (translationSize !== 0)
    {
        const translated = Math.min(size, TRANSLATED_FRAMES * FRAME_SIZE);
        for (let start = 0; start < translated; start += FRAME_SIZE)
        {
            untranslate(out.subarray(start, Math.min(translated, start + FRAME_SIZE)), start,
                translationSize);
        }
    }
    return out;
}
