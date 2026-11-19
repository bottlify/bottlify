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
 * @property {4 | 8} [pointerSize]  8 in a 64-bit process, whose string is 40 bytes.
 * @property {import('./float.js').FloatHost} [fpu]  Where a float is answered.
 */

/**
 * The x86-64 leaves of the library a program calls in its inner loops, as code:
 * a constant, a byte moved, `this` handed back. Crysis asks
 * `numeric_limits<float>::max()` a third of all its calls into the host a
 * frame, each a crossing for one constant.
 */
export const LONG_LEAVES = Object.freeze({
    /** mov rax, rcx; ret */
    self: Uint8Array.of(0x48, 0x89, 0xc8, 0xc3),
    /** ret */
    nothing: Uint8Array.of(0xc3),
    /** mov al, [r8]; mov [rdx], al; ret */
    construct: Uint8Array.of(0x41, 0x8a, 0x00, 0x88, 0x02, 0xc3),
    /** mov rax, -1; ret */
    every: Uint8Array.of(0x48, 0xc7, 0xc0, 0xff, 0xff, 0xff, 0xff, 0xc3),
    /** mov eax, 0xff; ret */
    byteMax: Uint8Array.of(0xb8, 0xff, 0x00, 0x00, 0x00, 0xc3),
    /** mov eax, 0x7fff; ret */
    shortMax: Uint8Array.of(0xb8, 0xff, 0x7f, 0x00, 0x00, 0xc3),
    /** mov eax, 0x7f7fffff; movd xmm0, eax; ret */
    floatMax: Uint8Array.of(0xb8, 0xff, 0xff, 0x7f, 0x7f, 0x66, 0x0f, 0x6e, 0xc0, 0xc3),
    /** mov rax, 0x7fefffffffffffff; movq xmm0, rax; ret */
    doubleMax: Uint8Array.of(0x48, 0xb8, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xef, 0x7f,
        0x66, 0x48, 0x0f, 0x6e, 0xc0, 0xc3),
});

/**
 * @param {Record<string, any>} crt  MSVCR80's table, for operator new and delete.
 * @param {Msvcp80Host} host
 * @returns {Record<string, any>}  The members under the names of the process's width.
 */
export function createMsvcp80Functions(crt, host){
    /**
     * The string as the caller's compiler lays it out: the container's iterator
     * list, sixteen bytes of text or the pointer to it, the length and the
     * capacity, the three words a pointer wide.
     */
    const POINTER = host.pointerSize === 8 ? 8 : 4;
    const BUFFER = POINTER === 8 ? 8 : STRING_BUFFER;
    const SIZE = POINTER === 8 ? 24 : STRING_SIZE;
    const RESERVED = POINTER === 8 ? 32 : STRING_RESERVED;
    /** @param {number} address */
    const u32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** A length, a capacity or a pointer: a word of the pointer's width. */
    const setWord = (/** @type {number} */ address, /** @type {number} */ value)=>{
        setU32(address, value);
        if (POINTER === 8)
        {
            setU32(address + 4, 0);
        }
    };
    /** @param {number} self */
    const textOf = self=>(u32(self + RESERVED) > STRING_INLINE
        ? u32(self + BUFFER) : self + BUFFER);
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
        setWord(self + SIZE, length);
        host.writeMemory(textOf(self) + length, Uint8Array.of(0));
    };

    /** Empty and inline, the heap text freed. @param {number} self */
    const tidy = self=>{
        if (u32(self + RESERVED) > STRING_INLINE)
        {
            crt['??3@YAXPAX@Z'].handler([u32(self + BUFFER)]);
        }
        setWord(self + RESERVED, STRING_INLINE);
        endAt(self, 0);
    };

    /**
     * The text moved to a heap block of at least `wanted` characters, the
     * first `kept` of the old text with it: the library's `_Copy`.
     *
     * @param {number} self @param {number} wanted @param {number} kept
     */
    const regrow = (self, wanted, kept)=>{
        const before = u32(self + RESERVED);
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
        setWord(self + BUFFER, block);
        setWord(self + RESERVED, reserved);
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
        const reserved = u32(self + RESERVED);
        const length = u32(self + SIZE);
        if (reserved < wanted)
        {
            return regrow(self, wanted, Math.min(length, wanted));
        }
        if (trim && wanted <= STRING_INLINE && reserved > STRING_INLINE)
        {
            const kept = Math.min(wanted, length);
            const heap = u32(self + BUFFER);
            const text = host.readMemory(heap, kept).slice();
            crt['??3@YAXPAX@Z'].handler([heap]);
            setWord(self + RESERVED, STRING_INLINE);
            host.writeMemory(self + BUFFER, text);
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
        setWord(self + RESERVED, STRING_INLINE);
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
        if (bytes.length > u32(self + RESERVED)
            && !regrow(self, bytes.length, u32(self + SIZE)))
        {
            return self;
        }
        host.writeMemory(textOf(self), bytes);
        endAt(self, bytes.length);
        return self;
    };

    /** @param {number} self @param {Uint8Array} bytes */
    const appendBytes = (self, bytes)=>{
        const length = u32(self + SIZE);
        if (length + bytes.length > u32(self + RESERVED)
            && !grow(self, length + bytes.length, false))
        {
            return self;
        }
        host.writeMemory(textOf(self) + length, bytes);
        endAt(self, length + bytes.length);
        return self;
    };

    /** A string's text, copied out. @param {number} self */
    const bytesOf = self=>host.readMemory(textOf(self), u32(self + SIZE)).slice();
    /** A C string's bytes, copied out. @param {number} at */
    const bytesAt = at=>host.readMemory(at >>> 0, lengthOf(at >>> 0)).slice();
    /** @param {Uint8Array} a @param {Uint8Array} b */
    const same = (a, b)=>a.length === b.length && a.every((byte, at)=>byte === b[at]);

    /** @param {number} argBytes @param {(args: number[]) => number} handler */
    const thiscall = (argBytes, handler)=>({ convention: 'thiscall', argBytes, handler });
    /** @param {number} argBytes @param {(args: number[]) => number} handler */
    const cdecl = (argBytes, handler)=>({ convention: 'cdecl', argBytes, handler });

    /**
     * A 64-bit process's members, under the names its compiler gives them
     * (`QEAA` for a member, `PEBD` for a `const char *`, `_K` for a size):
     * each answered here whole, the object in the 64-bit layout - and those
     * `inguest-string.js` holds run its x86-64 in the guest first.
     */
    function longMembers(){
        const ALLOCATOR = '?$allocator@D@std@@';
        const COMPLEX = 'V?$complex@M@0@';
        /** @param {number} at */
        const f32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
            .getFloat32(0, true);
        /** A complex<float> written to the caller's result. @param {number} out */
        const complex = (out, /** @type {number} */ re, /** @type {number} */ im)=>{
            host.writeMemory(out >>> 0, new Uint8Array(Float32Array.of(re, im).buffer));
            return out;
        };
        /** An empty string: no iterators, inline, no text. @param {number} self */
        const fresh = self=>{
            setWord(self, 0);
            return self;
        };
        /** @param {number} self @param {number} count */
        const resize = (self, count)=>{
            const length = u32(self + SIZE);
            const wanted = count >>> 0;
            if (wanted > u32(self + RESERVED) && !grow(self, wanted, false))
            {
                return 0;
            }
            if (wanted > length)
            {
                host.writeMemory(textOf(self) + length, new Uint8Array(wanted - length));
            }
            endAt(self, wanted);
            return 0;
        };
        /**
         * A member with code in the guest (`inguest-string.js`), whose x86-64
         * a 64-bit process runs, its handler here what that code hands over.
         *
         * @param {keyof typeof COMPILED} name
         * @param {{ convention: string, argBytes: number,
         *     handler: (args: number[]) => number }} own
         */
        const inGuestLong = (name, own)=>guestEntry(/** @type {Function} */ (inGuest[name]),
            COMPILED[name], host, { argBytes: own.argBytes, handler: own.handler });
        /** @type {import('./float.js').FloatHost | undefined} */
        const fpu = host.fpu;
        return {
            /** basic_string::basic_string() */
            [`??0${STRING}QEAA@XZ`]: inGuestLong('stringConstruct',
                cdecl(4, ([self])=>assign(fresh(self), 0, 0))),
            /** basic_string::basic_string(const char *) */
            [`??0${STRING}QEAA@PEBD@Z`]: inGuestLong('stringFromText', cdecl(8, ([self, from])=>
                assign(fresh(self), from, lengthOf(from)))),
            /** basic_string::basic_string(const basic_string &) */
            [`??0${STRING}QEAA@AEBV01@@Z`]: inGuestLong('stringCopy', cdecl(8, ([self, other])=>
                assign(fresh(self), textOf(other), u32(other + SIZE)))),
            /** basic_string::~basic_string() */
            [`??1${STRING}QEAA@XZ`]: inGuestLong('stringDestroy', cdecl(4, ([self])=>{
                tidy(self);
                return 0;
            })),
            /** char &basic_string::operator[](_Size_type_nosscl) */
            [`??A${STRING}QEAAAEADU_Size_type_nosscl@01@@Z`]: inGuestLong('stringAt',
                cdecl(8, ([self, index])=>(textOf(self) + index) >>> 0)),
            /** const char &basic_string::operator[](_Size_type_nosscl) const */
            [`??A${STRING}QEBAAEBDU_Size_type_nosscl@01@@Z`]: inGuestLong('stringAt',
                cdecl(8, ([self, index])=>(textOf(self) + index) >>> 0)),
            /** basic_string &basic_string::operator+=(char) */
            [`??Y${STRING}QEAAAEAV01@D@Z`]: inGuestLong('stringAppendChar',
                cdecl(8, ([self, c])=>appendBytes(self, Uint8Array.of(c & 0xff)))),
            /** basic_string &basic_string::operator+=(const char *) */
            [`??Y${STRING}QEAAAEAV01@PEBD@Z`]: cdecl(8, ([self, from])=>
                appendBytes(self, bytesAt(from))),
            /** basic_string &basic_string::operator+=(const basic_string &) */
            [`??Y${STRING}QEAAAEAV01@AEBV01@@Z`]: cdecl(8, ([self, other])=>
                appendBytes(self, bytesOf(other))),
            /** basic_string &basic_string::append(const basic_string &) */
            [`?append@${STRING}QEAAAEAV12@AEBV12@@Z`]: cdecl(8, ([self, other])=>
                appendBytes(self, bytesOf(other))),
            /** basic_string &basic_string::append(const char *) */
            [`?append@${STRING}QEAAAEAV12@PEBD@Z`]: cdecl(8, ([self, from])=>
                appendBytes(self, bytesAt(from))),
            /** void basic_string::reserve(size_type) */
            [`?reserve@${STRING}QEAAX_K@Z`]: inGuestLong('stringReserve',
                cdecl(8, ([self, count])=>{
                    const length = u32(self + SIZE);
                    if (length <= (count >>> 0) && u32(self + RESERVED) !== (count >>> 0)
                        && grow(self, count >>> 0, true))
                    {
                        endAt(self, length);
                    }
                    return 0;
                })),
            /** basic_string &basic_string::operator=(const basic_string &) */
            [`??4${STRING}QEAAAEAV01@AEBV01@@Z`]: cdecl(8, ([self, other])=>
                (self === other ? self : assignBytes(self, bytesOf(other)))),
            /** const char *basic_string::c_str() const */
            [`?c_str@${STRING}QEBAPEBDXZ`]: inGuestLong('stringText',
                cdecl(4, ([self])=>textOf(self))),
            /** void basic_string::resize(size_type) -- padded with zeros */
            [`?resize@${STRING}QEAAX_K@Z`]: inGuestLong('stringResize', cdecl(8,
                ([self, count])=>resize(self, count))),
            /** size_type basic_string::size() const */
            [`?size@${STRING}QEBA_KXZ`]: inGuestLong('stringSize',
                cdecl(4, ([self])=>u32(self + SIZE))),
            /** static const size_type basic_string::npos */
            [`?npos@${STRING}2_KB`]: { data: ()=>new Uint8Array(8).fill(0xff) },

            /** allocator<char>::allocator(), and from another: nothing to build. */
            [`??0${ALLOCATOR}QEAA@XZ`]: { ...cdecl(4, ([self])=>self),
                long: ()=>LONG_LEAVES.self },
            [`??0${ALLOCATOR}QEAA@AEBV01@@Z`]: { ...cdecl(8, ([self])=>self),
                long: ()=>LONG_LEAVES.self },
            /** char *allocator<char>::allocate(size_type): operator new's. */
            [`?allocate@${ALLOCATOR}QEAAPEAD_K@Z`]: cdecl(8, ([, count])=>
                crt['??2@YAPAXI@Z'].handler([count >>> 0]) >>> 0),
            /** void allocator<char>::deallocate(char *, size_type) */
            [`?deallocate@${ALLOCATOR}QEAAXPEAD_K@Z`]: cdecl(12, ([, block])=>{
                crt['??3@YAXPAX@Z'].handler([block >>> 0]);
                return 0;
            }),
            /** void allocator<char>::construct(char *, const char &) */
            [`?construct@${ALLOCATOR}QEAAXPEADAEBD@Z`]: { ...cdecl(12, ([, at, from])=>{
                host.writeMemory(at >>> 0, host.readMemory(from >>> 0, 1).slice());
                return 0;
            }), long: ()=>LONG_LEAVES.construct },
            /** void allocator<char>::destroy(char *): a char has nothing to destroy. */
            [`?destroy@${ALLOCATOR}QEAAXPEAD@Z`]: { ...cdecl(8, ()=>0),
                long: ()=>LONG_LEAVES.nothing },
            /** size_type allocator<char>::max_size() const: every size_t, sign-extended. */
            [`?max_size@${ALLOCATOR}QEBA_KXZ`]: { ...cdecl(4, ()=>0xffffffff),
                long: ()=>LONG_LEAVES.every },

            /** numeric_limits<unsigned char>::max(), <short>, <float> and <double>. */
            '?max@?$numeric_limits@E@std@@SAEXZ': { ...cdecl(0, ()=>0xff),
                long: ()=>LONG_LEAVES.byteMax },
            '?max@?$numeric_limits@F@std@@SAFXZ': { ...cdecl(0, ()=>0x7fff),
                long: ()=>LONG_LEAVES.shortMax },
            ...fpu?.setSingleResult ? {
                '?max@?$numeric_limits@M@std@@SAMXZ': { ...cdecl(0, ()=>{
                    /** @type {any} */ (fpu).setSingleResult(3.4028234663852886e38);
                    return 0;
                }), long: ()=>LONG_LEAVES.floatMax },
                '?max@?$numeric_limits@N@std@@SANXZ': { ...cdecl(0, ()=>{
                    fpu.setResult(Number.MAX_VALUE);
                    return 0;
                }), long: ()=>LONG_LEAVES.doubleMax },
            } : {},

            // complex<float>'s operators: the result is a class, returned through
            // the pointer the caller passes first.
            /** complex<float> operator*(const complex<float> &, const complex<float> &) */
            [`??$?DM@std@@YA?A${COMPLEX}AEBV10@0@Z`]: cdecl(12, ([out, left, right])=>{
                const [a, b, c, d] = [f32(left), f32(left + 4), f32(right), f32(right + 4)];
                return complex(out, Math.fround(Math.fround(a * c) - Math.fround(b * d)),
                    Math.fround(Math.fround(a * d) + Math.fround(b * c)));
            }),
            /** complex<float> operator+(const complex<float> &, const complex<float> &) */
            [`??$?HM@std@@YA?A${COMPLEX}AEBV10@0@Z`]: cdecl(12, ([out, left, right])=>
                complex(out, f32(left) + f32(right), f32(left + 4) + f32(right + 4))),
            /** complex<float> conj(const complex<float> &) */
            [`??$conj@M@std@@YA?A${COMPLEX}AEBV10@@Z`]: cdecl(8, ([out, of])=>
                complex(out, f32(of), -f32(of + 4))),

            '?_Nomemory@std@@YAXXZ': cdecl(0, ()=>crt.abort.handler([])),
        };
    }

    if (POINTER === 8)
    {
        return longMembers();
    }

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
            assign(self, textOf(other), u32(other + SIZE))),

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
            const length = u32(self + SIZE);
            if (length >= u32(self + RESERVED) && !grow(self, length + 1, false))
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
            const length = u32(self + SIZE);
            if (length <= (count >>> 0) && u32(self + RESERVED) !== (count >>> 0)
                && grow(self, count >>> 0, true))
            {
                endAt(self, length);
            }
            return 0;
        }),

        /** void basic_string::resize(size_type) -- padded with zeros */
        [`?resize@${STRING}QAEXI@Z`]: member('stringResize', ([self, count])=>{
            const length = u32(self + SIZE);
            const wanted = count >>> 0;
            if (wanted > u32(self + RESERVED) && !grow(self, wanted, false))
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
        [`?size@${STRING}QBEIXZ`]: member('stringSize', ([self])=>u32(self + SIZE)),
    };
}
