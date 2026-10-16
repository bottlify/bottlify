/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSVCP80.DLL, the Visual C++ 2005 standard C++ library, and MSVCP71.DLL,
 * the 2003 one, whose `std::string` has the same layout and growth:
 * `std::string`'s members as a program imports them, for a program that
 * brought no copy of its own. The members it calls per character run in
 * the guest (`inguest-string.js`), and what they hand over -- a string growing past its
 * capacity, or freeing its text -- is answered here, the whole member over
 * the runtime's own operator new and delete, so memory the inline code and
 * a program's own inlined members free is memory this allocated.
 *
 * Growth is the library's: a capacity of the length asked for rounded up to
 * a multiple of sixteen less one, or half as much again as the capacity
 * before when that is larger, so a program that reads `capacity()` sees the
 * numbers it would on Windows.
 */

import { guestEntry } from './guest-code.js';
import { COMPILED } from './inguest-string.x86.js';
import * as inGuest from './inguest-string.js';
import { STRING_BUFFER, STRING_INLINE, STRING_RESERVED, STRING_SIZE } from './inguest-string.js';

/** basic_string<char>::max_size(): the allocator's count less one. */
const MAX_SIZE = 0xfffffffe;

const STRING = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@std@@';
/** A free function template's arguments, char's traits and allocator, and std. */
const TEMPLATE = 'DU?$char_traits@D@std@@V?$allocator@D@1@@std@@';
/** basic_string<char> as an argument of such a function. */
const STRING_ARG = '$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@';

/**
 * @typedef {Object} Msvcp80Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} [fillMemory]
 */

/**
 * @param {Record<string, any>} crt  MSVCR80's table, for operator new and delete.
 * @param {Msvcp80Host} host
 */
export function createMsvcp80Functions(crt, host){
    /** @param {number} address */
    const u32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} self */
    const textOf = self=>(u32(self + STRING_RESERVED) > STRING_INLINE
        ? u32(self + STRING_BUFFER) : self + STRING_BUFFER);
    /** @param {number} address */
    const lengthOf = address=>{
        let length = 0;
        while (host.readMemory(address + length, 1)[0] !== 0)
        {
            length++;
        }
        return length;
    };

    /** The length set and the terminator after it. @param {number} self @param {number} length */
    const endAt = (self, length)=>{
        setU32(self + STRING_SIZE, length);
        host.writeMemory(textOf(self) + length, Uint8Array.of(0));
    };

    /** Empty and inline, the heap text freed. @param {number} self */
    const tidy = self=>{
        if (u32(self + STRING_RESERVED) > STRING_INLINE)
        {
            crt['??3@YAXPAX@Z'].handler([u32(self + STRING_BUFFER)]);
        }
        setU32(self + STRING_RESERVED, STRING_INLINE);
        endAt(self, 0);
    };

    /**
     * The text moved to a heap block of at least `wanted` characters, the
     * first `kept` of the old text with it: the library's `_Copy`.
     *
     * @param {number} self @param {number} wanted @param {number} kept
     */
    const regrow = (self, wanted, kept)=>{
        const before = u32(self + STRING_RESERVED);
        let reserved = (wanted | STRING_INLINE) >>> 0;
        if (reserved > MAX_SIZE)
        {
            reserved = wanted;
        }
        else if (Math.floor(before / 2) > Math.floor(reserved / 3)
            && before <= MAX_SIZE - Math.floor(before / 2))
        {
            reserved = before + Math.floor(before / 2);
        }
        const block = crt['??2@YAPAXI@Z'].handler([reserved + 1]) >>> 0;
        if (block === 0)
        {
            return false;
        }
        if (kept > 0)
        {
            host.writeMemory(block, host.readMemory(textOf(self), kept).slice());
        }
        tidy(self);
        setU32(self + STRING_BUFFER, block);
        setU32(self + STRING_RESERVED, reserved);
        endAt(self, kept);
        return true;
    };

    /**
     * Room for `wanted` characters, the text kept: the library's `_Grow`,
     * which moves a heap string back inline when asked to trim below sixteen.
     *
     * @param {number} self @param {number} wanted @param {boolean} trim
     */
    const grow = (self, wanted, trim)=>{
        const reserved = u32(self + STRING_RESERVED);
        const length = u32(self + STRING_SIZE);
        if (reserved < wanted)
        {
            return regrow(self, wanted, Math.min(length, wanted));
        }
        if (trim && wanted <= STRING_INLINE && reserved > STRING_INLINE)
        {
            const kept = Math.min(wanted, length);
            const heap = u32(self + STRING_BUFFER);
            const text = host.readMemory(heap, kept).slice();
            crt['??3@YAXPAX@Z'].handler([heap]);
            setU32(self + STRING_RESERVED, STRING_INLINE);
            host.writeMemory(self + STRING_BUFFER, text);
            endAt(self, kept);
            return false;
        }
        return wanted > 0;
    };

    /**
     * The object empty, then given `length` characters from `from`.
     *
     * @param {number} self @param {number} from @param {number} length
     */
    const assign = (self, from, length)=>{
        const text = host.readMemory(from, length).slice();
        setU32(self + STRING_RESERVED, STRING_INLINE);
        endAt(self, 0);
        if (length > STRING_INLINE)
        {
            regrow(self, length, 0);
        }
        host.writeMemory(textOf(self), text);
        endAt(self, length);
        return self;
    };

    /**
     * One member: the guest's code, the handler that answers what it hands over.
     *
     * @param {keyof typeof COMPILED} name @param {(args: number[]) => number} handler
     */
    const member = (name, handler)=>guestEntry(/** @type {Function} */ (inGuest[name]),
        COMPILED[name], host, { argBytes: COMPILED[name].params.length * 4, handler });

    /**
     * The string's text set to `bytes`: room made first when they do not
     * fit, as the library's assign grows. The bytes are read before, so a
     * string assigned or appended from itself is whole.
     *
     * @param {number} self @param {Uint8Array} bytes
     */
    const assignBytes = (self, bytes)=>{
        if (bytes.length > u32(self + STRING_RESERVED)
            && !regrow(self, bytes.length, u32(self + STRING_SIZE)))
        {
            return self;
        }
        host.writeMemory(textOf(self), bytes);
        endAt(self, bytes.length);
        return self;
    };

    /** @param {number} self @param {Uint8Array} bytes */
    const appendBytes = (self, bytes)=>{
        const length = u32(self + STRING_SIZE);
        if (length + bytes.length > u32(self + STRING_RESERVED)
            && !grow(self, length + bytes.length, false))
        {
            return self;
        }
        host.writeMemory(textOf(self) + length, bytes);
        endAt(self, length + bytes.length);
        return self;
    };

    /** A string's text, copied out. @param {number} self */
    const bytesOf = self=>host.readMemory(textOf(self), u32(self + STRING_SIZE)).slice();
    /** A C string's bytes, copied out. @param {number} at */
    const bytesAt = at=>host.readMemory(at >>> 0, lengthOf(at >>> 0)).slice();
    /** @param {Uint8Array} a @param {Uint8Array} b */
    const same = (a, b)=>a.length === b.length && a.every((byte, at)=>byte === b[at]);

    /** @param {number} argBytes @param {(args: number[]) => number} handler */
    const thiscall = (argBytes, handler)=>({ convention: 'thiscall', argBytes, handler });
    /** @param {number} argBytes @param {(args: number[]) => number} handler */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    const text = member('stringText', ([self])=>textOf(self));
    const at = member('stringAt', ([self, index])=>(textOf(self) + index) >>> 0);

    return {
        /** basic_string::basic_string() */
        [`??0${STRING}QAE@XZ`]: member('stringConstruct', ([self])=>assign(self, 0, 0)),

        /** basic_string::basic_string(const char *) */
        [`??0${STRING}QAE@PBD@Z`]: member('stringFromText', ([self, from])=>
            assign(self, from, lengthOf(from))),

        /** basic_string::basic_string(const basic_string &) */
        [`??0${STRING}QAE@ABV01@@Z`]: member('stringCopy', ([self, other])=>
            assign(self, textOf(other), u32(other + STRING_SIZE))),

        /** basic_string::~basic_string() */
        [`??1${STRING}QAE@XZ`]: member('stringDestroy', ([self])=>{
            tidy(self);
            return 0;
        }),

        /** char &basic_string::operator[](_Size_type_nosscl) */
        [`??A${STRING}QAEAADU_Size_type_nosscl@01@@Z`]: at,
        /** const char &basic_string::operator[](_Size_type_nosscl) const */
        [`??A${STRING}QBEABDU_Size_type_nosscl@01@@Z`]: at,

        /** basic_string &basic_string::operator+=(char) */
        [`??Y${STRING}QAEAAV01@D@Z`]: member('stringAppendChar', ([self, c])=>{
            const length = u32(self + STRING_SIZE);
            if (length >= u32(self + STRING_RESERVED) && !grow(self, length + 1, false))
            {
                return self;
            }
            host.writeMemory(textOf(self) + length, Uint8Array.of(c & 0xff));
            endAt(self, length + 1);
            return self;
        }),

        /** const char *basic_string::c_str() const */
        [`?c_str@${STRING}QBEPBDXZ`]: text,

        /** static const size_type basic_string::npos */
        [`?npos@${STRING}2IB`]: { data: ()=>Uint8Array.of(0xff, 0xff, 0xff, 0xff) },

        /** void basic_string::reserve(size_type) */
        [`?reserve@${STRING}QAEXI@Z`]: member('stringReserve', ([self, count])=>{
            const length = u32(self + STRING_SIZE);
            if (length <= (count >>> 0) && u32(self + STRING_RESERVED) !== (count >>> 0)
                && grow(self, count >>> 0, true))
            {
                endAt(self, length);
            }
            return 0;
        }),

        /** void basic_string::resize(size_type) -- padded with zeros */
        [`?resize@${STRING}QAEXI@Z`]: member('stringResize', ([self, count])=>{
            const length = u32(self + STRING_SIZE);
            const wanted = count >>> 0;
            if (wanted > u32(self + STRING_RESERVED) && !grow(self, wanted, false))
            {
                return 0;
            }
            if (wanted > length)
            {
                host.writeMemory(textOf(self) + length, new Uint8Array(wanted - length));
            }
            endAt(self, wanted);
            return 0;
        }),

        /** basic_string &basic_string::operator=(const basic_string &) */
        [`??4${STRING}QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>
            (self === other ? self : assignBytes(self, bytesOf(other)))),

        /** basic_string &basic_string::operator+=(const basic_string &) */
        [`??Y${STRING}QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>
            appendBytes(self, bytesOf(other))),
        /** basic_string &basic_string::operator+=(const char *) */
        [`??Y${STRING}QAEAAV01@PBD@Z`]: thiscall(8, ([self, from])=>
            appendBytes(self, bytesAt(from))),
        /** basic_string &basic_string::append(const basic_string &) */
        [`?append@${STRING}QAEAAV12@ABV12@@Z`]: thiscall(8, ([self, other])=>
            appendBytes(self, bytesOf(other))),
        /** basic_string &basic_string::append(const char *) */
        [`?append@${STRING}QAEAAV12@PBD@Z`]: thiscall(8, ([self, from])=>
            appendBytes(self, bytesAt(from))),

        /** bool operator==(const basic_string &, const char *) */
        [`??$?8${TEMPLATE}YA_NABV?${STRING_ARG}0@PBD@Z`]:
            cdecl(8, ([left, right])=>(same(bytesOf(left), bytesAt(right)) ? 1 : 0)),
        /** bool operator!=(const basic_string &, const basic_string &) */
        [`??$?9${TEMPLATE}YA_NABV?${STRING_ARG}0@0@Z`]:
            cdecl(8, ([left, right])=>(same(bytesOf(left), bytesOf(right)) ? 0 : 1)),

        /**
         * void std::_Nomemory(void): the library's allocation failure, which
         * throws std::bad_alloc. This runtime cannot throw into the guest, and
         * ends the process as an uncaught bad_alloc would.
         */
        '?_Nomemory@std@@YAXXZ': cdecl(0, ()=>crt.abort.handler([])),

        /** size_type basic_string::size() const */
        [`?size@${STRING}QBEIXZ`]: member('stringSize', ([self])=>u32(self + STRING_SIZE)),
    };
}
