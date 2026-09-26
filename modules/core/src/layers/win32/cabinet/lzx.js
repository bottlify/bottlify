/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * LZX decoding, as a cabinet's LZX folders use it (the Cabinet SDK's "LZX
 * Data Compression Format").
 *
 * An LZX folder is one stream cut into CFDATA frames of 32 KiB of output
 * each. The compressor aligns its bit buffer on a 16-bit boundary after every
 * frame and never lets a match cross one, so each frame's bytes are read
 * with a bit reader of their own; everything else -- the window, the three
 * repeated offsets, the path lengths every tree is sent as a delta against,
 * an LZX block that has not ended -- carries from one frame to the next,
 * and a new folder is a new decoder.
 *
 * The bitstream is 16-bit little-endian words read most significant bit
 * first, and every tree is canonical Huffman sent as path lengths.
 */

const NUM_CHARS = 256;
const MIN_MATCH = 2;
const NUM_PRIMARY_LENGTHS = 7;
const NUM_SECONDARY_LENGTHS = 249;
const PRETREE_ELEMENTS = 20;
const ALIGNED_ELEMENTS = 8;
const MAX_PATH_LENGTH = 16;

const BLOCK_VERBATIM = 1;
const BLOCK_ALIGNED = 2;
const BLOCK_UNCOMPRESSED = 3;

/** The output one CFDATA frame represents; only the last of a folder may be shorter. */
export const FRAME_SIZE = 32768;

/** The x86 CALL translation stops after this many frames of a folder. */
const TRANSLATED_FRAMES = 32768;

/** Thrown for input that is not an LZX stream this decoder can finish. */
export class LzxError extends Error {}

/**
 * The position slot table: base position and footer bits per slot, up to
 * the 2 MB window's fifty.
 */
const EXTRA_BITS = new Uint8Array(50);
const BASE_POSITION = new Uint32Array(50);
for (let slot = 0, base = 0; slot < 50; slot++)
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
 * Reads one frame's bits: 16-bit little-endian words, most significant bit
 * first. Past the end it reads zeros, as a compressor's final flush may
 * leave the last code's padding to the reader; a reader that has run far past
 * the end has been fed something else.
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
        /** Where the byte stream stands once the bits are aligned. */
        byteAt: ()=>at,
        /** @param {number} position  Resumes the bitstream at a byte offset. */
        resumeAt(position){
            at = position;
            buffer = 0;
            count = 0;
        },
    };
}

/**
 * @param {number} windowBits  15 to 21: the folder's window is `2^windowBits` bytes.
 */
export function createLzxDecoder(windowBits){
    if (!(windowBits >= 15 && windowBits <= 21))
    {
        throw new LzxError(`a window of 2^${windowBits} bytes is outside LZX's 2^15..2^21`);
    }
    const windowSize = 2 ** windowBits;
    const windowMask = windowSize - 1;
    const mainElements = NUM_CHARS + positionSlots(windowBits) * 8;

    const window = new Uint8Array(windowSize);
    const mainLengths = new Uint8Array(mainElements);
    const lengthLengths = new Uint8Array(NUM_SECONDARY_LENGTHS);

    let position = 0;
    let r0 = 1;
    let r1 = 1;
    let r2 = 1;
    let headerRead = false;
    let translationSize = 0;
    let frames = 0;
    /** Output of the whole folder so far, where the CALL translation measures from. */
    let folderOffset = 0;
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
     * @param {ReturnType<typeof bitReader>} reader
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
                const delta = reader.decode(pretree);
                if (delta > 16 || x + run > last)
                {
                    throw new LzxError('a run of path lengths past the tree');
                }
                lengths.fill((lengths[x] + 17 - delta) % 17, x, x + run);
                x += run;
            }
            else
            {
                lengths[x] = (lengths[x] + 17 - code) % 17;
                x++;
            }
        }
    };

    /** @param {ReturnType<typeof bitReader>} reader @param {Uint8Array} input */
    const readBlockHeader = (reader, input)=>{
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
            reader.align();
            const at = reader.byteAt();
            if (at + 12 > input.length)
            {
                throw new LzxError('an uncompressed block with no offsets');
            }
            const view = new DataView(input.buffer, input.byteOffset + at, 12);
            r0 = view.getUint32(0, true);
            r1 = view.getUint32(4, true);
            r2 = view.getUint32(8, true);
            reader.resumeAt(at + 12);
            oddPad = (blockRemaining & 1) === 1;
        }
        else
        {
            throw new LzxError(`block type ${blockType} is undefined`);
        }
    };

    /**
     * Undoes the compressor's E8 preprocessing on one frame's output: every
     * CALL's absolute target back to the relative one the code holds. Done
     * on a copy, since the window must keep what the matches were made from.
     *
     * @param {Uint8Array} frame @param {number} start  The frame's offset in the folder.
     */
    const untranslate = (frame, start)=>{
        if (translationSize === 0 || frames >= TRANSLATED_FRAMES)
        {
            return;
        }
        const view = new DataView(frame.buffer, frame.byteOffset, frame.length);
        // The last six bytes of a frame are never translated, so a CALL is
        // only when all five of its bytes lie before them.
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
    };

    return {
        /** The window's size in bytes. */
        windowSize,

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
            const out = new Uint8Array(size);
            let produced = 0;

            if (!headerRead)
            {
                headerRead = true;
                if (reader.bits(1))
                {
                    translationSize = reader.bits(16) * 65536 + reader.bits(16);
                }
            }

            while (produced < size)
            {
                if (blockRemaining === 0)
                {
                    if (oddPad)
                    {
                        reader.resumeAt(reader.byteAt() + 1);
                        oddPad = false;
                    }
                    readBlockHeader(reader, input);
                }
                const room = Math.min(blockRemaining, size - produced);

                if (blockType === BLOCK_UNCOMPRESSED)
                {
                    const at = reader.byteAt();
                    const take = Math.min(room, input.length - at);
                    if (take < room)
                    {
                        throw new LzxError('an uncompressed block past its frame');
                    }
                    for (let i = 0; i < take; i++)
                    {
                        const value = input[at + i];
                        out[produced++] = value;
                        window[position] = value;
                        position = (position + 1) & windowMask;
                    }
                    reader.resumeAt(at + take);
                    blockRemaining -= take;
                    if (blockRemaining === 0 && oddPad)
                    {
                        reader.resumeAt(reader.byteAt() + 1);
                        oddPad = false;
                    }
                    continue;
                }

                const end = produced + room;
                while (produced < end)
                {
                    const element = reader.decode(mainCode);
                    if (element < NUM_CHARS)
                    {
                        out[produced++] = element;
                        window[position] = element;
                        position = (position + 1) & windowMask;
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
                    if (produced + length > end)
                    {
                        throw new LzxError('a match past its block or frame');
                    }
                    let from = (position - offset) & windowMask;
                    for (let i = 0; i < length; i++)
                    {
                        const value = window[from];
                        out[produced++] = value;
                        window[position] = value;
                        position = (position + 1) & windowMask;
                        from = (from + 1) & windowMask;
                    }
                }
                blockRemaining -= room;
            }

            untranslate(out, folderOffset);
            folderOffset += size;
            frames++;
            return out;
        },
    };
}
