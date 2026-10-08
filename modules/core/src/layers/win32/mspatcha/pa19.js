/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The Patch API's PA19 patch files: how a delta patch -- what a Windows
 * Installer patch's PatchFiles action and mspatcha.dll apply -- turns an old
 * file into a new one.
 *
 * Microsoft has not published the container. What is here follows its
 * public description by reverse engineering, checked against patches made by
 * Microsoft's own compressor; every field this file reads is laid out below.
 * All integers are little-endian; a UVLI is an unsigned integer seven bits
 * to a byte, least significant first, its LAST byte marked by bit 7 set; an
 * SVLI is the same with bit 6 of its first byte the sign and the magnitude
 * starting in that byte's low six bits.
 *
 *     'PA19'
 *     u32  option flags (PATCH_OPTION_*)
 *     u32  extended option flags          when bit 31 of the flags is set
 *     u32  the new file's time, Unix      when PATCH_OPTION_NO_TIMESTAMP is SET:
 *                                         the file says the opposite of the option
 *     UVLI the new image's base           when PATCH_OPTION_NO_REBASE is clear
 *     UVLI the new file's size
 *     u32  the new file's CRC-32, its retained ranges read as zeros
 *     u8   how many old files the patch applies to (at least one; a patch
 *          that needs no old file has one, of size zero)
 *     per old file:
 *       SVLI its size, less the new file's
 *       u32  its CRC-32, ignored and retained ranges read as zeros
 *       u8   ignore ranges; each SVLI offset (after the first, from the end
 *            of the one before) and UVLI length
 *       u8   retain ranges; each SVLI old offset (the same way), SVLI new
 *            offset less the old one, UVLI length
 *       UVLI the count of a table that reverses a transform the compressor
 *            makes to 32-bit executables -- whose layout is not known here
 *       UVLI interleave count, then 3n - 1 UVLIs   when PATCH_OPTION_INTERLEAVE_FILES
 *       UVLI the length of its LZXD stream; zero when the old file already
 *            is the new one
 *     the LZXD streams, one per old file in that order, at no alignment
 *     u32  a value that brings the CRC-32 of everything up to and including
 *          it to 0xffffffff
 *
 * A patch for an old file decodes its stream with that file in the window
 * before the output (`decodeLzxd`), the old file's ignored and retained
 * ranges read as zeros; the retained ranges are then copied across from the
 * old file untouched, and the result must have the CRC the header gives.
 *
 * Not reversed here, and refused rather than guessed: the transform table
 * of 32-bit executables, interleaved streams, old files larger than the
 * window, and the normalisation (rebasing, unbinding, zeroed checksums and
 * time stamps) the compressor applies to a 32-bit PE old file before it
 * takes its CRC.
 */

import { LZXD_WINDOW, LzxError, decodeLzxd } from '../cabinet/lzx.js';
import { crc32 } from '../../filesystem/internal/bundle/crc32.js';
import { parsePe } from '../../loader/internal/pe.js';

/** The Patch API's own errors, as GetLastError reports them. */
export const PATCH_ERROR = Object.freeze({
    DECODE_FAILURE: 0xc00e4101,
    CORRUPT: 0xc00e4102,
    NEWER_FORMAT: 0xc00e4103,
    WRONG_FILE: 0xc00e4104,
    NOT_NECESSARY: 0xc00e4105,
    NOT_AVAILABLE: 0xc00e4106,
});

/** PATCH_OPTION_*: how the patch was made, as its header records it. */
export const PATCH_OPTION = Object.freeze({
    USE_LZX_A: 0x00000001,
    USE_LZX_B: 0x00000002,
    USE_LZX_LARGE: 0x00000004,
    NO_BINDFIX: 0x00010000,
    NO_LOCKFIX: 0x00020000,
    NO_REBASE: 0x00040000,
    FAIL_IF_SAME_FILE: 0x00080000,
    FAIL_IF_BIGGER: 0x00100000,
    NO_CHECKSUM: 0x00200000,
    NO_RESTIMEFIX: 0x00400000,
    NO_TIMESTAMP: 0x00800000,
    SIGNATURE_MD5: 0x01000000,
    INTERLEAVE_FILES: 0x40000000,
    RESERVED1: 0x80000000,
});

/** Every option a patch header may carry: PATCH_OPTION_VALID_FLAGS. */
const VALID_OPTIONS = 0xc0ff0007;

/**
 * The normalisations of a 32-bit PE old file an option turns off; a patch
 * with all of them off took its old file's CRC over the bytes as they are.
 */
const PE_FIXES = PATCH_OPTION.NO_BINDFIX | PATCH_OPTION.NO_LOCKFIX | PATCH_OPTION.NO_REBASE
    | PATCH_OPTION.NO_CHECKSUM | PATCH_OPTION.NO_RESTIMEFIX;

/** APPLY_OPTION_*: what the caller asks of applying. */
export const APPLY_OPTION = Object.freeze({
    FAIL_IF_EXACT: 0x00000001,
    FAIL_IF_CLOSE: 0x00000002,
    TEST_ONLY: 0x00000004,
});

/** 'PA19' read as a little-endian u32. */
const MAGIC = 0x39314150;

/** Thrown while reading a patch: the Patch API error it amounts to. */
export class PatchError extends Error {
    /** @param {number} code @param {string} message */
    constructor(code, message){
        super(message);
        this.code = code;
    }
}

/** @param {string} message */
const corrupt = message=>new PatchError(PATCH_ERROR.CORRUPT, message);

/**
 * @typedef {Object} IgnoreRange
 * @property {number} offset  In the old file.
 * @property {number} length
 */

/**
 * @typedef {Object} RetainRange
 * @property {number} oldOffset
 * @property {number} newOffset
 * @property {number} length
 */

/**
 * @typedef {Object} OldFile  One old file a patch applies to.
 * @property {number} size
 * @property {number} crc
 * @property {IgnoreRange[]} ignore
 * @property {RetainRange[]} retain
 * @property {number[]} interleave  The interleave values, empty when none.
 * @property {number} streamStart  Where its LZXD stream begins in the patch.
 * @property {number} streamSize
 */

/**
 * @typedef {Object} PatchHeader
 * @property {number} flags  PATCH_OPTION_*.
 * @property {number} extendedFlags  Zero when the header has none.
 * @property {number | null} timestamp  The new file's time, seconds since 1970.
 * @property {number | null} imageBase  The new image's base, for rebasing.
 * @property {number} newSize
 * @property {number} newCrc
 * @property {OldFile[]} oldFiles
 * @property {number} end  Where the patch's own CRC stops.
 */

/**
 * A cursor over the patch's header fields, failing as corrupt at its end.
 *
 * @param {Uint8Array} bytes
 */
function fieldReader(bytes){
    let at = 0;
    return {
        get at(){
            return at;
        },
        u8(){
            if (at >= bytes.length)
            {
                throw corrupt('the header ends early');
            }
            return bytes[at++];
        },
        u32(){
            if (at + 4 > bytes.length)
            {
                throw corrupt('the header ends early');
            }
            const value = (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16)
                | (bytes[at + 3] << 24)) >>> 0;
            at += 4;
            return value;
        },
        /**
         * A variable-length integer of at most nine bytes; `signed` takes
         * bit 6 of the first as the sign.
         *
         * @param {boolean} [signed]
         */
        vli(signed = false){
            const first = this.u8();
            let value = first & (signed ? 0x3f : 0x7f);
            let scale = signed ? 64 : 128;
            let last = first;
            for (let n = 1; (last & 0x80) === 0; n++)
            {
                if (n === 9)
                {
                    throw corrupt('a variable-length integer of more than nine bytes');
                }
                last = this.u8();
                value += (last & 0x7f) * scale;
                scale *= 128;
            }
            return signed && (first & 0x40) !== 0 ? -value : value;
        },
    };
}

/**
 * A count or offset that has to fit the 32-bit sizes the API speaks in.
 *
 * @param {number} value @param {string} what
 */
const fits = (value, what)=>{
    if (!(value >= 0 && value <= 0xffffffff))
    {
        throw corrupt(`${what} out of range`);
    }
    return value;
};

/**
 * Reads and checks a PA19 header: its fields, the ranges against the sizes
 * they lie in, and the CRC-32 over the whole patch.
 *
 * @param {Uint8Array} bytes
 * @returns {PatchHeader}
 * @throws {PatchError}
 */
export function readPatchHeader(bytes){
    /**
     * A header that cannot be read on past this point, for a reason that is
     * not damage -- unless the patch fails the CRC its last four bytes
     * normally close, and then it is.
     *
     * @param {number} code @param {string} message
     */
    const refuse = (code, message)=>(crc32(bytes) === 0xffffffff
        ? new PatchError(code, message) : corrupt('the patch fails its CRC-32'));

    const read = fieldReader(bytes);
    if (bytes.length < 4 || read.u32() !== MAGIC)
    {
        throw corrupt('no PA19 signature');
    }
    const flags = read.u32();
    if ((flags & ~VALID_OPTIONS) !== 0)
    {
        throw refuse(PATCH_ERROR.NEWER_FORMAT,
            `options 0x${((flags & ~VALID_OPTIONS) >>> 0).toString(16)} are not known here`);
    }
    const extendedFlags = (flags & PATCH_OPTION.RESERVED1) !== 0 ? read.u32() : 0;
    const timestamp = (flags & PATCH_OPTION.NO_TIMESTAMP) !== 0 ? read.u32() : null;
    const imageBase = (flags & PATCH_OPTION.NO_REBASE) === 0 ? read.vli() : null;
    const newSize = fits(read.vli(), 'the new file\'s size');
    const newCrc = read.u32();
    const count = read.u8();
    if (count === 0)
    {
        throw corrupt('a patch for no old file');
    }

    /** @type {OldFile[]} */
    const oldFiles = [];
    for (let file = 0; file < count; file++)
    {
        const size = fits(newSize + read.vli(true), 'an old file\'s size');
        const crc = read.u32();

        /** @type {IgnoreRange[]} */
        const ignore = [];
        for (let i = read.u8(), from = 0; i > 0; i--)
        {
            const offset = fits(from + read.vli(true), 'an ignore range');
            const length = fits(read.vli(), 'an ignore range');
            if (offset + length > size)
            {
                throw corrupt('an ignore range past the old file');
            }
            ignore.push({ offset, length });
            from = offset + length;
        }

        /** @type {RetainRange[]} */
        const retain = [];
        for (let i = read.u8(), from = 0; i > 0; i--)
        {
            const oldOffset = fits(from + read.vli(true), 'a retain range');
            const newOffset = fits(oldOffset + read.vli(true), 'a retain range');
            const length = fits(read.vli(), 'a retain range');
            if (oldOffset + length > size || newOffset + length > newSize)
            {
                throw corrupt('a retain range past its file');
            }
            // The new file is one file whichever old file it is made from.
            const first = oldFiles[0]?.retain[retain.length];
            if (first && (first.newOffset !== newOffset || first.length !== length))
            {
                throw corrupt('old files that retain different ranges of the new one');
            }
            retain.push({ oldOffset, newOffset, length });
            from = oldOffset + length;
        }

        if (read.vli() !== 0)
        {
            // The table's entries follow, in a layout not known here, so not
            // even the rest of the header can be read past them.
            throw refuse(PATCH_ERROR.DECODE_FAILURE,
                'the patch reverses a transform of a 32-bit executable, which is not implemented');
        }
        /** @type {number[]} */
        const interleave = [];
        if ((flags & PATCH_OPTION.INTERLEAVE_FILES) !== 0)
        {
            const ranges = read.vli();
            for (let i = 0; i < ranges * 3 - 1; i++)
            {
                interleave.push(read.vli());
            }
        }
        const streamSize = fits(read.vli(), 'a stream\'s size');
        oldFiles.push({ size, crc, ignore, retain, interleave, streamStart: 0, streamSize });
    }

    let at = read.at;
    for (const file of oldFiles)
    {
        file.streamStart = at;
        at += file.streamSize;
    }
    // A patch may stop after its header -- one made only to be tested
    // against -- and then the CRC covers what there is.
    const end = Math.min(at + 4, bytes.length);
    if (crc32(bytes.subarray(0, end)) !== 0xffffffff)
    {
        throw corrupt('the patch fails its CRC-32');
    }
    return { flags, extendedFlags, timestamp, imageBase, newSize, newCrc, oldFiles, end };
}

/**
 * A copy of a file with ranges of it read as zeros.
 *
 * @param {Uint8Array} bytes @param {{ offset: number, length: number }[]} ranges
 */
const zeroed = (bytes, ranges)=>{
    const out = bytes.slice();
    for (const { offset, length } of ranges)
    {
        out.fill(0, offset, offset + length);
    }
    return out;
};

/** @param {RetainRange[]} retain */
const retainedInOld = retain=>retain.map(r=>({ offset: r.oldOffset, length: r.length }));

/** @param {RetainRange[]} retain */
const retainedInNew = retain=>retain.map(r=>({ offset: r.newOffset, length: r.length }));

/**
 * The old file's CRC as the header records it. A patch with no stream -- the
 * old file already is the new one -- does not zero its ignored ranges for it.
 *
 * @param {Uint8Array} old @param {OldFile} file
 */
const oldCrc = (old, file)=>crc32(zeroed(old, [
    ...file.streamSize !== 0 ? file.ignore : [], ...retainedInOld(file.retain)]));

/**
 * Whether a file is a 32-bit PE image, which the compressor normalises.
 *
 * @param {Uint8Array} bytes
 */
const isPe32 = bytes=>{
    try
    {
        parsePe(bytes);
        return true;
    }
    catch (e){
        void e;
        return false;
    }
};

/**
 * @typedef {Object} PatchResult
 * @property {number} code  0, or the Patch API error.
 * @property {Uint8Array} [bytes]  The new file, unless only the header was tested.
 * @property {number} [size]  The new file's size, once the header is read.
 * @property {number | null} [timestamp]  The new file's time, seconds since 1970.
 * @property {string} [reason]  Why, when the answer is a failure.
 */

/**
 * Applies a PA19 patch.
 *
 * @param {Uint8Array | null} old  The old file; null or empty for a patch that needs none.
 * @param {Uint8Array} patch
 * @param {number} [flags]  APPLY_OPTION_*.
 * @param {{ headerOnly?: boolean }} [options]  `headerOnly`: only find the old
 *        file in the header, as TestApplyPatchToFile does.
 * @returns {PatchResult}
 */
export function applyPatch(old, patch, flags = 0, { headerOnly = false } = {}){
    /** @type {PatchHeader} */
    let header;
    try
    {
        header = readPatchHeader(patch);
    }
    catch (e){
        if (e instanceof PatchError)
        {
            return { code: e.code, reason: e.message };
        }
        throw e;
    }
    const source = old ?? new Uint8Array(0);
    const { newSize: size, timestamp } = header;
    /** @param {number} code @param {string} reason */
    const fail = (code, reason)=>({ code, size, timestamp, reason });

    const candidates = header.oldFiles.filter(file=>file.size === source.length);
    const file = candidates.find(candidate=>oldCrc(source, candidate) === candidate.crc);
    if (!file)
    {
        if (candidates.length > 0 && (header.flags & PE_FIXES) !== PE_FIXES && isPe32(source))
        {
            return fail(PATCH_ERROR.DECODE_FAILURE, 'the old file is a 32-bit PE image the patch'
                + ' may have been made against normalised, which is not implemented');
        }
        return fail(PATCH_ERROR.WRONG_FILE, 'no old file of the patch has this size and CRC');
    }
    if (file.streamSize === 0 && (flags & (APPLY_OPTION.FAIL_IF_EXACT
        | APPLY_OPTION.FAIL_IF_CLOSE)) !== 0)
    {
        return fail(PATCH_ERROR.NOT_NECESSARY, 'the old file already is the new one');
    }
    if (file.streamSize !== 0)
    {
        const window = (header.flags & PATCH_OPTION.USE_LZX_LARGE) !== 0
            ? LZXD_WINDOW.large : LZXD_WINDOW.normal;
        if (file.size > window)
        {
            return fail(PATCH_ERROR.DECODE_FAILURE,
                'an old file larger than the window is decoded interleaved: not implemented');
        }
        if (file.interleave.length > 0)
        {
            return fail(PATCH_ERROR.DECODE_FAILURE, 'interleaved streams are not implemented');
        }
    }
    if (headerOnly)
    {
        return { code: 0, size, timestamp };
    }
    if (file.streamStart + file.streamSize > patch.length)
    {
        return fail(PATCH_ERROR.NOT_AVAILABLE, 'the patch carries its header and not its data');
    }

    /** @type {Uint8Array} */
    let bytes;
    if (file.streamSize !== 0)
    {
        const reference = zeroed(source, [...file.ignore, ...retainedInOld(file.retain)]);
        try
        {
            bytes = decodeLzxd(patch.subarray(file.streamStart, file.streamStart + file.streamSize),
                reference, size, { large: (header.flags & PATCH_OPTION.USE_LZX_LARGE) !== 0 });
        }
        catch (e){
            if (e instanceof LzxError)
            {
                return fail(PATCH_ERROR.DECODE_FAILURE, e.message);
            }
            throw e;
        }
    }
    else if (file.size === size)
    {
        bytes = source.slice();
    }
    else
    {
        return fail(PATCH_ERROR.CORRUPT, 'no stream, and the old file is not the new one\'s size');
    }

    for (const range of file.retain)
    {
        const kept = source.subarray(range.oldOffset, range.oldOffset + range.length);
        bytes.set(kept, range.newOffset);
    }
    if (crc32(zeroed(bytes, retainedInNew(file.retain))) !== header.newCrc)
    {
        return fail(PATCH_ERROR.CORRUPT, 'the new file fails its CRC-32');
    }

    if (source.length === size && (flags & (APPLY_OPTION.FAIL_IF_EXACT
        | APPLY_OPTION.FAIL_IF_CLOSE)) !== 0)
    {
        // Close is the same file but for the ranges the patch sets aside.
        const aside = (flags & APPLY_OPTION.FAIL_IF_CLOSE) !== 0
            ? [...file.ignore, ...retainedInOld(file.retain), ...retainedInNew(file.retain)] : [];
        const same = zeroed(source, aside);
        const made = zeroed(bytes, aside);
        if (same.every((value, i)=>value === made[i]))
        {
            return fail(PATCH_ERROR.NOT_NECESSARY, 'the old file already is the new one');
        }
    }
    return { code: 0, bytes, size, timestamp };
}

/** The signature buffer each kind of signature needs, with its terminator. */
export const SIGNATURE_LENGTH = Object.freeze({ crc: 9, md5: 33 });

/**
 * A file's patch signature: the CRC-32, or with PATCH_OPTION_SIGNATURE_MD5
 * the MD5, of the file with its ignored and retained ranges read as zeros,
 * in lowercase hexadecimal.
 *
 * Null for a 32-bit PE image whose normalisation the options leave on,
 * since the signature is of the normalised file.
 *
 * @param {Uint8Array} bytes @param {number} flags  PATCH_OPTION_*.
 * @param {IgnoreRange[]} ignore @param {IgnoreRange[]} retain  Old-file ranges.
 * @param {() => { update(bytes: Uint8Array): void, digest(): Uint8Array }} md5
 * @returns {string | null}
 */
export function patchSignature(bytes, flags, ignore, retain, md5){
    if ((flags & PE_FIXES) !== PE_FIXES && isPe32(bytes))
    {
        return null;
    }
    const plain = zeroed(bytes, [...ignore, ...retain].filter(range=>
        range.offset < bytes.length).map(range=>({ offset: range.offset,
        length: Math.min(range.length, bytes.length - range.offset) })));
    if ((flags & PATCH_OPTION.SIGNATURE_MD5) !== 0)
    {
        const digest = md5();
        digest.update(plain);
        return [...digest.digest()].map(value=>value.toString(16).padStart(2, '0')).join('');
    }
    return crc32(plain).toString(16).padStart(8, '0');
}
