/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Guest memory read for a scan to a terminator: a string, a list of them, a
 * stream of tokens, whose caller hands over where it starts and nothing of
 * where it ends.
 *
 * A fixed length read from the start and searched was refused whenever the
 * string ended nearer than that to the end of its region -- a name at the end
 * of an allocation, a buffer at the top of a stack -- since memory refuses a
 * read that runs past the region it starts in, and past it may lie nothing at
 * all. So each window ends at the next multiple of `SCAN_WINDOW`: while the
 * regions begin and end on multiples of it -- pages do, and so does an image
 * whose sections are aligned to 256 bytes or more -- a window never reaches
 * past the region its first byte is in, and the scan reads on only once it
 * has come to the end of one without meeting the terminator.
 */

/** Bytes in a whole window: a multiple of every unit a scan compares. */
export const SCAN_WINDOW = 256;

/**
 * @typedef {Object} ScannedMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 */

/**
 * The windows from `address` on, in order, for as long as the caller asks:
 * up to its terminator or its limit. A window holds whole units only -- a
 * UTF-16 character, a dword -- so one a window's end would split is read on
 * its own, across it. After a window memory gave short of what was asked,
 * which it does only where it holds nothing more, there is none.
 *
 * @param {ScannedMemory} memory
 * @param {number} address
 * @param {number} [unit]  Bytes in what the scan compares: 1, 2 or 4.
 * @returns {Generator<Uint8Array, void, void>}
 */
export function* scanWindows(memory, address, unit = 1){
    for (let at = address >>> 0; ;)
    {
        const room = SCAN_WINDOW - at % SCAN_WINDOW;
        const length = room < unit ? unit : room - room % unit;
        const piece = memory.readMemory(at, length);
        yield piece;
        if (piece.length < length)
        {
            return;
        }
        at = (at + length) >>> 0;
    }
}

/**
 * A terminated string's bytes before its terminator, read a window at a
 * time: at most `limit` characters of `unit` bytes, fewer where memory ends
 * first. `terminated` says whether the terminator was met within the limit.
 *
 * @param {ScannedMemory} memory
 * @param {number} address
 * @param {number} [unit]  Bytes in a character: 1 or 2.
 * @param {number} [limit]  Characters read at most.
 * @returns {{ bytes: Uint8Array, terminated: boolean }}
 */
export function readToTerminator(memory, address, unit = 1, limit = Infinity){
    const most = limit * unit;
    /** @type {Uint8Array[]} */
    const pieces = [];
    let length = 0;
    let terminated = false;
    if (most <= 0)
    {
        return { bytes: new Uint8Array(0), terminated };
    }
    for (const piece of scanWindows(memory, address, unit))
    {
        let end = unit === 1 ? piece.indexOf(0) : -1;
        if (unit !== 1)
        {
            for (let at = 0; at + unit <= piece.length; at += unit)
            {
                if (piece[at] === 0 && piece[at + 1] === 0)
                {
                    end = at;
                    break;
                }
            }
        }
        const whole = end < 0 ? piece.length - piece.length % unit : end;
        const taken = Math.min(whole, most - length);
        // Copied now: a window may be a view of memory another thread writes.
        pieces.push(piece.slice(0, taken));
        length += taken;
        if (end >= 0 && taken === end)
        {
            terminated = true;
            break;
        }
        if (length >= most)
        {
            break;
        }
    }
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const piece of pieces)
    {
        bytes.set(piece, at);
        at += piece.length;
    }
    return { bytes, terminated };
}

/**
 * Characters out of a string's bytes: a byte each for `unit` 1, as Latin-1 --
 * a caller that wants an ANSI page decodes the bytes itself -- and UTF-16 for
 * 2. In slices, since a string may hold more characters than a call can be
 * handed arguments.
 *
 * @param {Uint8Array} bytes
 * @param {number} [unit]  1 or 2.
 */
export function charactersOf(bytes, unit = 1){
    const units = unit === 1 ? bytes
        : new Uint16Array(bytes.slice(0, bytes.length - bytes.length % 2).buffer);
    let text = '';
    for (let at = 0; at < units.length; at += 8192)
    {
        text += String.fromCharCode(...units.subarray(at, at + 8192));
    }
    return text;
}
