/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { wholeAddress } from '../common/pointers.js';

/**
 * The shell's character helpers: what class a character is of, text moved
 * between a code page and UTF-16, and a menu label's mnemonic taken out.
 * The classes are kernel32's GetStringTypeW answers and the conversions its
 * MultiByteToWideChar and WideCharToMultiByte, so a character is of one class
 * and one spelling whichever library a program asks.
 */

const CT_CTYPE1 = 1;
const CT_CTYPE3 = 4;
const C1_DIGIT = 0x04;
const C1_SPACE = 0x08;
const C1_PUNCT = 0x10;
const C1_CNTRL = 0x20;
const C1_BLANK = 0x40;
const C1_XDIGIT = 0x80;

/**
 * @typedef {Object} CharacterHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }> | undefined}
 *     [library]  kernel32, whose character tables and code pages answer.
 */

/**
 * @param {CharacterHost} host
 * @param {{ A: import('./text.js').Width, W: import('./text.js').Width }} widths
 */
export function createCharacterFunctions(host, { A, W }){
    /** @param {string} name */
    const kernel32 = name=>host.library?.('KERNEL32.dll')?.[name];

    /**
     * The CT_CTYPE1 or CT_CTYPE3 word kernel32 gives one UTF-16 unit; 0
     * without kernel32 or memory to ask it through.
     *
     * @param {number} type @param {number} unit
     */
    const typeOf = (type, unit)=>{
        const call = kernel32('GetStringTypeW');
        const block = host.allocate?.(4) ?? 0;
        if (!call || !block || !host.readMemory)
        {
            return 0;
        }
        try
        {
            host.writeMemory(block, Uint8Array.of(unit & 0xff, unit >>> 8 & 0xff, 0, 0));
            if (!call.handler([type, block, 1, block + 2]))
            {
                return 0;
            }
            const word = host.readMemory(block + 2, 2);
            return word[0] | word[1] << 8;
        }
        finally
        {
            host.free?.(block);
        }
    };

    /** @param {number} flag */
    const isClass = flag=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([unit])=>((typeOf(CT_CTYPE1, unit & 0xffff) & flag) !== 0 ? 1 : 0),
    });

    /**
     * A conversion through kernel32 into a buffer of `room` units; one too
     * long is cut to fit with its terminator, and answered as the room.
     *
     * @param {string} name  the kernel32 call
     * @param {(page: number, source: number, destination: number, room: number) => number[]} args
     * @param {import('./text.js').Width} to
     */
    const convert = (name, args, to)=>({
        argBytes: 16,
        /** @param {number[]} given */
        handler: ([page, source, destination, room])=>{
            const through = kernel32(name);
            if (!through || (destination >>> 0) === 0 || (room | 0) <= 0)
            {
                return 0;
            }
            const done = /** @type {number} */ (through.handler(args(page, source, destination,
                room | 0))) | 0;
            if (done !== 0)
            {
                return done;
            }
            // Cut short: the whole text into a block of its own, and as much
            // of it as fits copied back with a terminator.
            const needed = /** @type {number} */ (through.handler(args(page, source, 0, 0))) | 0;
            const block = needed > 0 ? host.allocate?.(needed * to.unit) ?? 0 : 0;
            if (!block || !host.readMemory)
            {
                return 0;
            }
            try
            {
                through.handler(args(page, source, block, needed));
                const kept = host.readMemory(block, ((room | 0) - 1) * to.unit).slice();
                host.writeMemory(wholeAddress(destination), kept);
                host.writeMemory(wholeAddress(destination) + kept.length, new Uint8Array(to.unit));
                return room | 0;
            }
            finally
            {
                host.free?.(block);
            }
        },
    });

    /**
     * SHStripMneumonic for either spelling: the first single ampersand of
     * a label taken out and the character after it answered; a CJK label's
     * "(&X)" goes whole. No mnemonic leaves the label and answers 0.
     *
     * @param {import('./text.js').Width} width
     */
    const stripMnemonic = width=>({
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([label])=>{
            const text = width.read(label);
            if (text === null)
            {
                return 0;
            }
            for (let at = 0; at < text.length; at++)
            {
                if (text[at] !== '&')
                {
                    continue;
                }
                if (text[at + 1] === '&')
                {
                    at++;
                    continue;
                }
                const mnemonic = text[at + 1] ?? '';
                if (mnemonic === '')
                {
                    return 0;
                }
                const bracketed = text[at - 1] === '(' && text[at + 2] === ')';
                const stripped = bracketed ? text.slice(0, at - 1) + text.slice(at + 3)
                    : text.slice(0, at) + text.slice(at + 1);
                host.writeMemory(wholeAddress(label), width.sz(stripped));
                return width.wide ? mnemonic.charCodeAt(0) : width.bytes(mnemonic)[0];
            }
            return 0;
        },
    });

    return {
        /**
         * BOOL IsCharSpaceW(WCHAR wc), IsCharBlankW, IsCharPunctW, IsCharCntrlW,
         * IsCharDigitW, IsCharXDigitW
         *
         * The character's CT_CTYPE1 class.
         */
        IsCharSpaceW: isClass(C1_SPACE),
        IsCharBlankW: isClass(C1_BLANK),
        IsCharPunctW: isClass(C1_PUNCT),
        IsCharCntrlW: isClass(C1_CNTRL),
        IsCharDigitW: isClass(C1_DIGIT),
        IsCharXDigitW: isClass(C1_XDIGIT),

        /** BOOL IsCharSpaceA(CHAR c): the byte read in the ANSI page. */
        IsCharSpaceA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([byte])=>((typeOf(CT_CTYPE1, A.char(byte).charCodeAt(0)) & C1_SPACE) !== 0
                ? 1 : 0),
        },

        /**
         * BOOL GetStringType3ExW(LPWSTR src, INT count, LPWORD type)
         *
         * GetStringTypeW's CT_CTYPE3 words for each character.
         */
        GetStringType3ExW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, count, out])=>{
                const call = kernel32('GetStringTypeW');
                return call ? call.handler([CT_CTYPE3, source, count, out]) : 0;
            },
        },

        /** DWORD SHAnsiToUnicodeCP(DWORD dwCp, LPCSTR lpSrcStr, LPWSTR lpDstStr, int iLen) */
        SHAnsiToUnicodeCP: convert('MultiByteToWideChar', (page, source, destination, room)=>
            [page, 0, source, -1, destination, room], W),
        /** DWORD SHUnicodeToAnsiCP(UINT CodePage, LPCWSTR lpSrcStr, LPSTR lpDstStr, int dstlen) */
        SHUnicodeToAnsiCP: convert('WideCharToMultiByte', (page, source, destination, room)=>
            [page, 0, source, -1, destination, room, 0, 0], A),

        /**
         * BOOL DoesStringRoundTripA(LPCSTR lpSrcStr, LPSTR lpDst, INT iLen)
         *
         * An ANSI string always comes back as it went: it is copied into the
         * buffer, cut to fit, and TRUE.
         */
        DoesStringRoundTripA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, destination, room])=>{
                const text = A.read(source) ?? '';
                if ((destination >>> 0) !== 0 && (room | 0) > 0)
                {
                    host.writeMemory(wholeAddress(destination), A.sz(text.slice(0,
                        (room | 0) - 1)));
                }
                return 1;
            },
        },

        /**
         * BOOL DoesStringRoundTripW(LPCWSTR lpSrcStr, LPSTR lpDst, INT iLen)
         *
         * The text in the ANSI page into the buffer, and TRUE when it reads
         * back as the same UTF-16 - no character was put in its place.
         */
        DoesStringRoundTripW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([source, destination, room])=>{
                const text = W.read(source) ?? '';
                const narrow = A.bytes(text);
                if ((destination >>> 0) !== 0 && (room | 0) > 0)
                {
                    const kept = narrow.subarray(0, (room | 0) - 1);
                    host.writeMemory(wholeAddress(destination), Uint8Array.from([...kept, 0]));
                }
                const back = [...narrow].map(byte=>A.char(byte)).join('');
                return back === text ? 1 : 0;
            },
        },

        /**
         * DWORD SHTruncateString(LPSTR lpStr, DWORD size)
         *
         * Where a buffer of `size` bytes may end without splitting a
         * double-byte character: the characters it holds before its
         * terminator. Only a lead byte at the very end would be cut, and the
         * ANSI page here has none, so nothing is written.
         */
        SHTruncateString: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, size])=>((text >>> 0) !== 0 && (size >>> 0) > 0
                ? (size >>> 0) - 1 : 0),
        },

        /** CHAR SHStripMneumonicA(LPSTR lpszStr) */
        SHStripMneumonicA: stripMnemonic(A),
        /** WCHAR SHStripMneumonicW(LPWSTR lpszStr) */
        SHStripMneumonicW: stripMnemonic(W),
    };
}
