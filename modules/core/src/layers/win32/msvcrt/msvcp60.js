/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSVCP60.DLL, Visual C++ 6's standard C++ library, which Windows itself
 * carries from 2000 on, so no setup installs it: `std::basic_string` of char
 * and of wchar_t as Visual C++ 6's <xstring> lays it out and shares it.
 *
 * A program built with that compiler reads and writes the string's members
 * itself in the members its headers inline, and calls these for the rest,
 * so the layout and the sharing are the program's as much as the library's:
 * three words after an allocator's byte - the text (`_Ptr`), its length
 * (`_Len`) and the room for it (`_Res`) - with a reference count in the byte
 * before the text. A copy shares the text and counts it; the first change to
 * a shared text gives the changed string a copy of its own; a text handed
 * out to be written through (`begin()`, `operator[]`) is frozen at 255 and
 * never shared again. The room asked for is rounded up to a multiple of 32
 * less one (of 8 less one for an element over 32 bytes) and two more elements
 * are allocated, the count's and the terminator's, through the runtime's own
 * operator new, as the library's allocator does.
 *
 * A position past the end, or a length past what can be held, is the
 * library's `_Xran` and `_Xlen`, which throw out_of_range and length_error
 * into the program through the runtime's `_CxxThrowException`. The library's
 * exception classes are the runtime's `exception` (three words) with the
 * message after them as a string, and carry the type data a throw and a
 * catch read, under the names the compiler gives it.
 */

import { createStreams } from './msvcp60-streams.js';

/** No string can be longer: max_size(), the allocator's count less the two extra elements. */
const npos = 0xffffffff;

/** The count of a text that is never shared again. */
const FROZEN = 255;

/** The char string's decorated class, as an argument. */
const NARROW = '?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@';

/** A throw on its way into the program: what the call answers. */
class Thrown {
    /** @param {any} raised */
    constructor(raised){
        this.raised = raised;
    }
}

/** A string's size, and an exception's: msvcrt's three words, then the message as a string. */
const STRING_SIZE = 16;
const EXCEPTION_SIZE = 12;
const ERROR_SIZE = EXCEPTION_SIZE + STRING_SIZE;

/**
 * The library's exception classes, each with its bases nearest first; every
 * one is an `exception` of the runtime's.
 *
 * @type {Record<string, string[]>}
 */
const ERRORS = {
    logic_error: [],
    domain_error: ['logic_error'],
    length_error: ['logic_error'],
    out_of_range: ['logic_error'],
    runtime_error: [],
    overflow_error: ['runtime_error'],
    underflow_error: ['runtime_error'],
    range_error: ['runtime_error'],
};

/** The compiler's names for the type of a class, its catchable type and its throw. */
/** @param {string} name */
const typeOf = name=>(name === 'exception' ? '??_R0?AVexception@@@8' : `??_R0?AV${name}@std@@@8`);
/** @param {string} name */
const catchableOf = name=>`_CT${typeOf(name)}`;
/** @param {string} name */
const throwInfoOf = name=>`_TI${typeOf(name)}`;
/** @param {string} name */
const copierOf = name=>(name === 'exception' ? '??0exception@@QAE@ABV0@@Z'
    : `??0${name}@std@@QAE@ABV01@@Z`);

/**
 * @typedef {Object} StringMembers
 * @property {(self: number, built?: boolean) => void} tidy
 * @property {(self: number, elements: Uint8Array) => number} assignElements
 * @property {(self: number, other: number) => number} assignString
 * @property {(self: number) => number} cstr
 * @property {(self: number) => Uint8Array} whole  The text's elements, as a copy.
 */

/** Where each member is, from the object. */
const PTR = 4;
const LEN = 8;
const RES = 12;

/**
 * The decorated name of basic_string of an element: `D` for char, `G` for
 * wchar_t (Visual C++ 6 had no native wchar_t: it is unsigned short).
 *
 * @param {'D' | 'G'} element
 */
const stringOf = element=>`?$basic_string@${element}U?$char_traits@${element}@std@@`
    + `V?$allocator@${element}@2@@std@@`;

/** @typedef {import('./msvcp60-streams.js').Msvcp60Host} Msvcp60Host */

/**
 * @param {Record<string, any>} crt  msvcrt's table: operator new and delete, malloc,
 *        its `exception` and `_CxxThrowException`.
 * @param {Msvcp60Host} host
 * @returns {Record<string, any>}
 */
export function createMsvcp60Functions(crt, host){
    /** @param {number} address */
    const u32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** @param {number} address */
    const u8 = address=>host.readMemory(address >>> 0, 1)[0];
    /** @param {number} address @param {number} value */
    const setU8 = (address, value)=>host.writeMemory(address >>> 0, Uint8Array.of(value & 0xff));
    /** @param {number} size */
    const allocate = size=>crt['??2@YAPAXI@Z'].handler([size]) >>> 0;
    /** @param {number} block */
    const free = block=>crt['??3@YAXPAX@Z'].handler([block]);

    /**
     * A handler that may throw into the program: a failure deep inside an
     * operation stops it where it is, and the call answers with the throw.
     *
     * @param {(args: number[]) => any} handler
     */
    const throwing = handler=>(/** @type {number[]} */ args)=>{
        try
        {
            return handler(args);
        }
        catch (e){
            if (e instanceof Thrown)
            {
                return e.raised;
            }
            throw e;
        }
    };
    /** @param {number} argBytes @param {(args: number[]) => any} handler */
    const thiscall = (argBytes, handler)=>
        ({ convention: 'thiscall', argBytes, handler: throwing(handler) });
    /** @param {number} argBytes @param {(args: number[]) => any} handler */
    const cdecl = (argBytes, handler)=>
        ({ convention: 'cdecl', argBytes, handler: throwing(handler) });

    /**
     * The strings' members by element size: the exceptions hold their message
     * in a char string, the streams read and make strings of both.
     *
     * @type {Record<number, StringMembers>}
     */
    const stringsBy = {};
    /** The char string's. */
    const narrowOf = ()=>stringsBy[1];

    /**
     * Throws an exception of one of the library's classes into the program,
     * made with a message, as `_Xran` and `_Xlen` do: the object is on the
     * runtime's heap, where the compiler would have put it in the throwing
     * frame, and the catch that ends it destroys it without freeing it.
     *
     * @param {string} name @param {string} message
     * @returns {never}
     */
    const raise = (name, message)=>{
        const members = narrowOf();
        const object = allocate(ERROR_SIZE);
        const text = new TextEncoder().encode(message);
        const scratch = allocate(STRING_SIZE);
        members.tidy(scratch);
        members.assignElements(scratch, text);
        constructError(object, name, scratch);
        members.tidy(scratch, true);
        free(scratch);
        throw new Thrown(crt._CxxThrowException.handler([object,
            host.addressOf(throwInfoOf(name))]));
    };

    /**
     * The library's out-of-range and too-long failures: what the program sees
     * when it asks for a position past the end or a string too long to hold.
     *
     * @param {'range' | 'length'} what
     * @returns {never}
     */
    const fail = what=>(what === 'range' ? raise('out_of_range', 'invalid string position')
        : raise('length_error', 'string too long'));

    /**
     * The members of basic_string of one element size.
     *
     * @param {1 | 2} unit @param {'D' | 'G'} element
     */
    function strings(unit, element){
        const STRING = stringOf(element);
        /** The decorated `const E *`, `E *` and `E` of the element. */
        const CPTR = `PB${element}`;
        const PTRN = `PA${element}`;
        const MIN_SIZE = 31;
        /** max_size(): the allocator's count of elements, less two. */
        const MAX = Math.floor(0xffffffff / unit) - 2;
        const NULLSTR = `?_C@?1??_Nullstr@${STRING}CAP${CPTR.slice(1)}XZ@4${element}B`;

        /** @param {number} at @param {number} index */
        const elementAt = (at, index)=>{
            const bytes = host.readMemory((at + index * unit) >>> 0, unit);
            return unit === 1 ? bytes[0] : bytes[0] | bytes[1] << 8;
        };
        /** @param {number} at @param {number} value */
        const setElement = (at, value)=>host.writeMemory(at >>> 0, unit === 1
            ? Uint8Array.of(value & 0xff) : Uint8Array.of(value & 0xff, value >>> 8 & 0xff));
        /** The elements at a place, as a copy. @param {number} at @param {number} count */
        const read = (at, count)=>(count === 0 ? new Uint8Array(0)
            : host.readMemory(at >>> 0, count * unit).slice());
        /**
         * Elements written at a place: none written is no access, as a
         * string of no text has no place (its `_Ptr` is null).
         *
         * @param {number} at @param {Uint8Array} elements
         */
        const write = (at, elements)=>{
            if (elements.length > 0)
            {
                host.writeMemory(at >>> 0, elements);
            }
        };
        /** @param {number} at */
        const lengthAt = at=>{
            let length = 0;
            while (elementAt(at, length) !== 0)
            {
                length++;
            }
            return length;
        };

        const ptr = (/** @type {number} */ self)=>u32(self + PTR);
        const len = (/** @type {number} */ self)=>u32(self + LEN);
        const res = (/** @type {number} */ self)=>u32(self + RES);
        /** @param {number} text */
        const refcnt = text=>u8(text - 1);
        /** A text another string shares. @param {number} text */
        const shared = text=>text !== 0 && refcnt(text) !== 0 && refcnt(text) !== FROZEN;
        const nullstr = ()=>host.addressOf(NULLSTR);
        /** c_str(): the text, or the static empty one. @param {number} self */
        const cstr = self=>ptr(self) || nullstr();

        /** _Eos: the length set and the terminator after it. @param {number} self @param {number} n */
        const eos = (self, n)=>{
            setU32(self + LEN, n);
            setElement(ptr(self) + n * unit, 0);
        };

        /** _Tidy(built): the text given up - freed, or one count fewer. */
        const tidy = (/** @type {number} */ self, built = false)=>{
            const text = ptr(self);
            if (built && text !== 0)
            {
                if (refcnt(text) === 0 || refcnt(text) === FROZEN)
                {
                    free(text - 1);
                }
                else
                {
                    setU8(text - 1, refcnt(text) - 1);
                }
            }
            setU32(self + PTR, 0);
            setU32(self + LEN, 0);
            setU32(self + RES, 0);
        };

        /**
         * _Copy: a text of its own with room for at least `n` elements, the
         * old text's first ones kept.
         *
         * @param {number} self @param {number} n
         */
        const copy = (self, n)=>{
            let room = (n | MIN_SIZE) >>> 0;
            if (MAX < room)
            {
                room = n;
            }
            const block = allocate((room + 2) * unit);
            const text = block + unit;
            const kept = Math.min(len(self), room);
            if (kept > 0)
            {
                write(text, read(ptr(self), kept));
            }
            tidy(self, true);
            setU32(self + PTR, text);
            setU8(text - 1, 0);
            setU32(self + RES, room);
            eos(self, kept);
        };

        /**
         * _Grow: room for `n` elements in a text of this string's own, or the
         * text given up for none; false when there is nothing to write into.
         *
         * @param {number} self @param {number} n @param {boolean} [trim]
         */
        const grow = (self, n, trim = false)=>{
            if (MAX < n)
            {
                fail('length');
            }
            if (shared(ptr(self)))
            {
                if (n === 0)
                {
                    setU8(ptr(self) - 1, refcnt(ptr(self)) - 1);
                    tidy(self);
                    return false;
                }
                copy(self, n);
                return true;
            }
            if (n === 0)
            {
                if (trim)
                {
                    tidy(self, true);
                }
                else if (ptr(self) !== 0)
                {
                    eos(self, 0);
                }
                return false;
            }
            if (trim && (MIN_SIZE < res(self) || res(self) < n))
            {
                tidy(self, true);
                copy(self, n);
            }
            else if (!trim && res(self) < n)
            {
                copy(self, n);
            }
            return true;
        };

        /** _Freeze: the text this string's own and never shared again. @param {number} self */
        const freeze = self=>{
            if (shared(ptr(self)))
            {
                grow(self, len(self));
            }
            if (ptr(self) !== 0)
            {
                setU8(ptr(self) - 1, FROZEN);
            }
        };

        /** _Split: a shared text copied, so this string can change its own. @param {number} self */
        const split = self=>{
            if (shared(ptr(self)))
            {
                const elements = read(ptr(self), len(self));
                tidy(self, true);
                assignElements(self, elements);
            }
        };

        /** assign(const E *, n), the elements already read. @param {number} self @param {Uint8Array} elements */
        const assignElements = (self, elements)=>{
            const n = elements.length / unit;
            if (grow(self, n, true))
            {
                write(ptr(self), elements);
                eos(self, n);
            }
            return self;
        };

        /** assign(const basic_string &, pos, count). @param {number} self @param {number} other */
        const assignString = (self, other, pos = 0, count = npos)=>{
            const size = len(other);
            if (size < pos)
            {
                return fail('range');
            }
            const n = Math.min(size - pos, count >>> 0);
            if (self === other)
            {
                erase(self, pos + n, npos);
                erase(self, 0, pos);
            }
            else if (n > 0 && n === size && refcnt(cstr(other)) < FROZEN - 1)
            {
                tidy(self, true);
                setU32(self + PTR, ptr(other));
                setU32(self + LEN, size);
                setU8(ptr(self) - 1, refcnt(ptr(self)) + 1);
            }
            else if (grow(self, n, true))
            {
                write(ptr(self), read(cstr(other) + pos * unit, n));
                eos(self, n);
            }
            return self;
        };

        /** assign(n, c). @param {number} self @param {number} n @param {number} c */
        const assignFill = (self, n, c)=>{
            if ((n >>> 0) === npos)
            {
                return fail('length');
            }
            if (grow(self, n >>> 0, true))
            {
                write(ptr(self), filled(n >>> 0, c));
                eos(self, n >>> 0);
            }
            return self;
        };

        /** n elements of value c. @param {number} n @param {number} c */
        const filled = (n, c)=>{
            const bytes = new Uint8Array(n * unit);
            for (let i = 0; i < n; i++)
            {
                bytes[i * unit] = c & 0xff;
                if (unit === 2)
                {
                    bytes[i * 2 + 1] = c >>> 8 & 0xff;
                }
            }
            return bytes;
        };

        /** append of elements already read. @param {number} self @param {Uint8Array} elements */
        const appendElements = (self, elements)=>{
            const m = elements.length / unit;
            const length = len(self);
            if (npos - length <= m)
            {
                return fail('length');
            }
            if (m > 0 && grow(self, length + m))
            {
                write(ptr(self) + length * unit, elements);
                eos(self, length + m);
            }
            return self;
        };

        /** append(const basic_string &, pos, count). @param {number} self @param {number} other */
        const appendString = (self, other, pos = 0, count = npos)=>{
            const size = len(other);
            if (size < pos)
            {
                return fail('range');
            }
            const n = Math.min(size - pos, count >>> 0);
            return appendElements(self, read(cstr(other) + pos * unit, n));
        };

        /** erase(pos, count). @param {number} self @param {number} pos @param {number} count */
        const erase = (self, pos, count)=>{
            const length = len(self);
            if (length < pos)
            {
                return fail('range');
            }
            split(self);
            const m = Math.min(length - pos, count >>> 0);
            if (m > 0)
            {
                const text = ptr(self);
                write(text + pos * unit, read(text + (pos + m) * unit,
                    length - pos - m));
                if (grow(self, length - m))
                {
                    eos(self, length - m);
                }
            }
            return self;
        };

        /**
         * replace(pos, count, elements): the elements put in place of the
         * `count` at `pos`.
         *
         * @param {number} self @param {number} pos @param {number} count
         * @param {Uint8Array} elements
         */
        const replaceElements = (self, pos, count, elements)=>{
            const length = len(self);
            if (length < pos)
            {
                return fail('range');
            }
            const n0 = Math.min(length - pos, count >>> 0);
            const m = elements.length / unit;
            if (npos - m <= length - n0)
            {
                return fail('length');
            }
            split(self);
            const tail = read(ptr(self) + (pos + n0) * unit, length - pos - n0);
            const n = length - n0 + m;
            if (grow(self, n))
            {
                const text = ptr(self);
                write(text + pos * unit, elements);
                write(text + (pos + m) * unit, tail);
                eos(self, n);
            }
            else if (n === 0)
            {
                setU32(self + LEN, 0);
            }
            return self;
        };

        /** The elements of a string from a position, as many as asked and there are. */
        const elementsOf = (/** @type {number} */ other, pos = 0, count = npos)=>{
            const size = len(other);
            if (size < pos)
            {
                fail('range');
                return new Uint8Array(0);
            }
            return read(cstr(other) + pos * unit, Math.min(size - pos, count >>> 0));
        };

        /**
         * char_traits::compare of two runs, then their lengths: below zero,
         * zero or above.
         *
         * @param {Uint8Array} left @param {Uint8Array} right
         */
        const compare = (left, right)=>{
            const n = Math.min(left.length, right.length) / unit;
            for (let i = 0; i < n; i++)
            {
                const a = unit === 1 ? left[i] : left[i * 2] | left[i * 2 + 1] << 8;
                const b = unit === 1 ? right[i] : right[i * 2] | right[i * 2 + 1] << 8;
                if (a !== b)
                {
                    return a < b ? -1 : 1;
                }
            }
            return left.length < right.length ? -1 : left.length === right.length ? 0 : 1;
        };

        /** @param {number} self */
        const whole = self=>read(cstr(self), len(self));
        /** @param {number} at */
        const zeroTerminated = at=>read(at, lengthAt(at));

        /** @param {Uint8Array} bytes @param {number} i */
        const valueAt = (bytes, i)=>(unit === 1 ? bytes[i] : bytes[i * 2] | bytes[i * 2 + 1] << 8);
        /**
         * find(pattern, pos): the first place at or after `pos` the pattern
         * starts, npos for none; an empty pattern is found at `pos` itself.
         *
         * @param {Uint8Array} hay @param {Uint8Array} pattern @param {number} pos
         */
        const find = (hay, pattern, pos)=>{
            const length = hay.length / unit;
            const n = pattern.length / unit;
            if (n === 0 && pos <= length)
            {
                return pos;
            }
            const last = length - n;
            for (let at = pos >>> 0; at <= last; at++)
            {
                let i = 0;
                while (i < n && valueAt(hay, at + i) === valueAt(pattern, i))
                {
                    i++;
                }
                if (i === n)
                {
                    return at;
                }
            }
            return npos;
        };
        /**
         * rfind(pattern, pos): the last place at or before `pos` the pattern
         * starts, npos for none.
         *
         * @param {Uint8Array} hay @param {Uint8Array} pattern @param {number} pos
         */
        const rfind = (hay, pattern, pos)=>{
            const length = hay.length / unit;
            const n = pattern.length / unit;
            if (n === 0)
            {
                return Math.min(pos >>> 0, length);
            }
            if (n > length)
            {
                return npos;
            }
            for (let at = Math.min(pos >>> 0, length - n); at >= 0; at--)
            {
                let i = 0;
                while (i < n && valueAt(hay, at + i) === valueAt(pattern, i))
                {
                    i++;
                }
                if (i === n)
                {
                    return at;
                }
            }
            return npos;
        };

        /** The result object of a function returning a string, made from elements. */
        const made = (/** @type {number} */ out, /** @type {Uint8Array} */ elements)=>{
            tidy(out);
            assignElements(out, elements);
            return out;
        };

        /** One element as a run. @param {number} c */
        const one = c=>filled(1, c);

        const T = `${element}U?$char_traits@${element}@std@@V?$allocator@${element}@1@@std@@`;
        const ARG = `$basic_string@${element}U?$char_traits@${element}@std@@`
            + `V?$allocator@${element}@2@@`;
        /** The free operators' names, template and plain: `??$?<op><T>` and `??<op>std@@`. */
        const named = (/** @type {string} */ op, /** @type {string} */ rest)=>[
            `??$?${op}${T}${rest}`, `??${op}std@@${rest}`];
        const allocator = `ABV?$allocator@${element}@1@`;

        /**
         * rbegin / rend: a reverse_iterator, the one pointer it holds, made
         * in the caller's result.
         *
         * @param {string} kind @param {boolean} constant
         */
        const reverse = (kind, constant)=>{
            const [p, r, q] = constant ? [CPTR, 'AB', 'QBE'] : [PTRN, 'AA', 'QAE'];
            const iterator = `reverse_iterator@${p}${element}${r}${element}${p}H@2@`;
            return `?${kind}@${STRING}${q}?AV?$${iterator}XZ`;
        };
        const rbegin = (/** @type {boolean} */ constant)=>reverse('rbegin', constant);
        const rend = (/** @type {boolean} */ constant)=>reverse('rend', constant);

        /** @type {Record<string, any>} */
        const table = {
            [NULLSTR]: { data: ()=>new Uint8Array(unit) },
            [`?_Nullstr@${STRING}CAP${CPTR.slice(1)}XZ`]: cdecl(0, ()=>nullstr()),
            [`?npos@${STRING}2IB`]: { data: ()=>Uint8Array.of(0xff, 0xff, 0xff, 0xff) },

            [`??0${STRING}QAE@${allocator}@Z`]: thiscall(8, ([self])=>{
                tidy(self);
                return self;
            }),
            [`??_F${STRING}QAEXXZ`]: thiscall(4, ([self])=>{
                tidy(self);
                return 0;
            }),
            [`??0${STRING}QAE@ABV01@@Z`]: thiscall(8, ([self, other])=>{
                tidy(self);
                return assignString(self, other);
            }),
            [`??0${STRING}QAE@ABV01@II${allocator}@Z`]: thiscall(20, ([self, other, pos, count])=>{
                tidy(self);
                return assignString(self, other, pos >>> 0, count);
            }),
            [`??0${STRING}QAE@${CPTR}I${allocator}@Z`]: thiscall(16, ([self, from, count])=>{
                tidy(self);
                return assignElements(self, read(from, count >>> 0));
            }),
            [`??0${STRING}QAE@${CPTR}${allocator}@Z`]: thiscall(12, ([self, from])=>{
                tidy(self);
                return assignElements(self, zeroTerminated(from));
            }),
            [`??0${STRING}QAE@I${element}${allocator}@Z`]: thiscall(16, ([self, count, c])=>{
                tidy(self);
                return assignFill(self, count, c);
            }),
            [`??0${STRING}QAE@${CPTR}0${allocator}@Z`]: thiscall(16, ([self, first, last])=>{
                tidy(self);
                return assignElements(self, read(first, ((last >>> 0) - (first >>> 0)) / unit));
            }),
            [`??1${STRING}QAE@XZ`]: thiscall(4, ([self])=>{
                tidy(self, true);
                return 0;
            }),

            [`??4${STRING}QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>
                assignString(self, other)),
            [`??4${STRING}QAEAAV01@${element}@Z`]: thiscall(8, ([self, c])=>
                assignElements(self, one(c))),
            [`??4${STRING}QAEAAV01@${CPTR}@Z`]: thiscall(8, ([self, from])=>
                assignElements(self, zeroTerminated(from))),
            [`?assign@${STRING}QAEAAV12@ABV12@@Z`]: thiscall(8, ([self, other])=>
                assignString(self, other)),
            [`?assign@${STRING}QAEAAV12@ABV12@II@Z`]: thiscall(16, ([self, other, pos, count])=>
                assignString(self, other, pos >>> 0, count)),
            [`?assign@${STRING}QAEAAV12@I${element}@Z`]: thiscall(12, ([self, count, c])=>
                assignFill(self, count, c)),
            [`?assign@${STRING}QAEAAV12@${CPTR}0@Z`]: thiscall(12, ([self, first, last])=>
                assignElements(self, read(first, ((last >>> 0) - (first >>> 0)) / unit))),
            [`?assign@${STRING}QAEAAV12@${CPTR}@Z`]: thiscall(8, ([self, from])=>
                assignElements(self, zeroTerminated(from))),
            [`?assign@${STRING}QAEAAV12@${CPTR}I@Z`]: thiscall(12, ([self, from, count])=>
                assignElements(self, read(from, count >>> 0))),

            [`??Y${STRING}QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>
                appendString(self, other)),
            [`??Y${STRING}QAEAAV01@${element}@Z`]: thiscall(8, ([self, c])=>
                appendElements(self, one(c))),
            [`??Y${STRING}QAEAAV01@${CPTR}@Z`]: thiscall(8, ([self, from])=>
                appendElements(self, zeroTerminated(from))),
            [`?append@${STRING}QAEAAV12@ABV12@@Z`]: thiscall(8, ([self, other])=>
                appendString(self, other)),
            [`?append@${STRING}QAEAAV12@ABV12@II@Z`]: thiscall(16, ([self, other, pos, count])=>
                appendString(self, other, pos >>> 0, count)),
            [`?append@${STRING}QAEAAV12@I${element}@Z`]: thiscall(12, ([self, count, c])=>
                ((count >>> 0) === npos ? fail('length')
                    : appendElements(self, filled(count >>> 0, c)))),
            [`?append@${STRING}QAEAAV12@${CPTR}0@Z`]: thiscall(12, ([self, first, last])=>
                appendElements(self, read(first, ((last >>> 0) - (first >>> 0)) / unit))),
            [`?append@${STRING}QAEAAV12@${CPTR}@Z`]: thiscall(8, ([self, from])=>
                appendElements(self, zeroTerminated(from))),
            [`?append@${STRING}QAEAAV12@${CPTR}I@Z`]: thiscall(12, ([self, from, count])=>
                appendElements(self, read(from, count >>> 0))),

            [`?c_str@${STRING}QBE${CPTR}XZ`]: thiscall(4, ([self])=>cstr(self)),
            [`?data@${STRING}QBE${CPTR}XZ`]: thiscall(4, ([self])=>cstr(self)),
            [`?size@${STRING}QBEIXZ`]: thiscall(4, ([self])=>len(self)),
            [`?length@${STRING}QBEIXZ`]: thiscall(4, ([self])=>len(self)),
            [`?capacity@${STRING}QBEIXZ`]: thiscall(4, ([self])=>res(self)),
            [`?max_size@${STRING}QBEIXZ`]: thiscall(4, ()=>MAX),
            [`?empty@${STRING}QBE_NXZ`]: thiscall(4, ([self])=>(len(self) === 0 ? 1 : 0)),
            [`?begin@${STRING}QAE${PTRN}XZ`]: thiscall(4, ([self])=>{
                freeze(self);
                return ptr(self);
            }),
            [`?begin@${STRING}QBE${CPTR}XZ`]: thiscall(4, ([self])=>ptr(self)),
            [`?end@${STRING}QAE${PTRN}XZ`]: thiscall(4, ([self])=>{
                freeze(self);
                return (ptr(self) + len(self) * unit) >>> 0;
            }),
            [`?end@${STRING}QBE${CPTR}XZ`]: thiscall(4, ([self])=>
                (ptr(self) + len(self) * unit) >>> 0),
            [`??A${STRING}QAEAA${element}I@Z`]: thiscall(8, ([self, pos])=>{
                if (len(self) < (pos >>> 0) || ptr(self) === 0)
                {
                    return nullstr();
                }
                freeze(self);
                return (ptr(self) + (pos >>> 0) * unit) >>> 0;
            }),
            [`??A${STRING}QBEAB${element}I@Z`]: thiscall(8, ([self, pos])=>
                (ptr(self) === 0 ? nullstr() : (ptr(self) + (pos >>> 0) * unit) >>> 0)),
            [`?at@${STRING}QAEAA${element}I@Z`]: thiscall(8, ([self, pos])=>{
                if (len(self) <= (pos >>> 0))
                {
                    return fail('range');
                }
                freeze(self);
                return (ptr(self) + (pos >>> 0) * unit) >>> 0;
            }),
            [`?at@${STRING}QBEAB${element}I@Z`]: thiscall(8, ([self, pos])=>
                (len(self) <= (pos >>> 0) ? fail('range')
                    : (ptr(self) + (pos >>> 0) * unit) >>> 0)),

            [`?erase@${STRING}QAEAAV12@II@Z`]: thiscall(12, ([self, pos, count])=>
                erase(self, pos >>> 0, count)),
            [`?erase@${STRING}QAE${PTRN}${PTRN}@Z`]: thiscall(8, ([self, at])=>{
                const pos = ((at >>> 0) - ptr(self)) / unit;
                erase(self, pos, 1);
                return (ptr(self) + pos * unit) >>> 0;
            }),
            [`?erase@${STRING}QAE${PTRN}${PTRN}0@Z`]: thiscall(12, ([self, first, last])=>{
                const pos = ((first >>> 0) - ptr(self)) / unit;
                erase(self, pos, ((last >>> 0) - (first >>> 0)) / unit);
                return (ptr(self) + pos * unit) >>> 0;
            }),
            [`?copy@${STRING}QBEI${PTRN}II@Z`]: thiscall(16, ([self, to, count, pos])=>{
                const length = len(self);
                if (length < (pos >>> 0))
                {
                    return fail('range');
                }
                const n = Math.min(length - (pos >>> 0), count >>> 0);
                if (n > 0)
                {
                    write(to >>> 0, read(ptr(self) + (pos >>> 0) * unit, n));
                }
                return n;
            }),
            [`?swap@${STRING}QAEXAAV12@@Z`]: thiscall(8, ([self, other])=>{
                for (const at of [PTR, LEN, RES])
                {
                    const mine = u32(self + at);
                    setU32(self + at, u32(other + at));
                    setU32(other + at, mine);
                }
                return 0;
            }),
            [`?reserve@${STRING}QAEXI@Z`]: thiscall(8, ([self, count])=>{
                if (res(self) < (count >>> 0))
                {
                    grow(self, count >>> 0);
                }
                return 0;
            }),
            [`?resize@${STRING}QAEXI${element}@Z`]: thiscall(12, ([self, count, c])=>
                resize(self, count >>> 0, c)),
            [`?resize@${STRING}QAEXI@Z`]: thiscall(8, ([self, count])=>
                resize(self, count >>> 0, 0)),
            [`?substr@${STRING}QBE?AV12@II@Z`]: thiscall(16, ([self, out, pos, count])=>
                made(out, elementsOf(self, pos >>> 0, count))),

            [`?compare@${STRING}QBEHABV12@@Z`]: thiscall(8, ([self, other])=>
                compare(whole(self), whole(other))),
            [`?compare@${STRING}QBEHIIABV12@@Z`]: thiscall(16, ([self, pos, count, other])=>
                compare(elementsOf(self, pos >>> 0, count), whole(other))),
            [`?compare@${STRING}QBEHIIABV12@II@Z`]: thiscall(24,
                ([self, pos, count, other, opos, ocount])=>compare(
                    elementsOf(self, pos >>> 0, count), elementsOf(other, opos >>> 0, ocount))),
            [`?compare@${STRING}QBEH${CPTR}@Z`]: thiscall(8, ([self, from])=>
                compare(whole(self), zeroTerminated(from))),
            [`?compare@${STRING}QBEHII${CPTR}@Z`]: thiscall(16, ([self, pos, count, from])=>
                compare(elementsOf(self, pos >>> 0, count), zeroTerminated(from))),
            [`?compare@${STRING}QBEHII${CPTR}I@Z`]: thiscall(20, ([self, pos, count, from, n])=>
                compare(elementsOf(self, pos >>> 0, count), read(from, n >>> 0))),

            [`?find@${STRING}QBEIABV12@I@Z`]: thiscall(12, ([self, other, pos])=>
                find(whole(self), whole(other), pos >>> 0)),
            [`?find@${STRING}QBEI${CPTR}I@Z`]: thiscall(12, ([self, from, pos])=>
                find(whole(self), zeroTerminated(from), pos >>> 0)),
            [`?find@${STRING}QBEI${CPTR}II@Z`]: thiscall(16, ([self, from, pos, n])=>
                find(whole(self), read(from, n >>> 0), pos >>> 0)),
            [`?find@${STRING}QBEI${element}I@Z`]: thiscall(12, ([self, c, pos])=>
                find(whole(self), one(c), pos >>> 0)),
            [`?rfind@${STRING}QBEIABV12@I@Z`]: thiscall(12, ([self, other, pos])=>
                rfind(whole(self), whole(other), pos >>> 0)),
            [`?rfind@${STRING}QBEI${CPTR}I@Z`]: thiscall(12, ([self, from, pos])=>
                rfind(whole(self), zeroTerminated(from), pos >>> 0)),
            [`?rfind@${STRING}QBEI${CPTR}II@Z`]: thiscall(16, ([self, from, pos, n])=>
                rfind(whole(self), read(from, n >>> 0), pos >>> 0)),
            [`?rfind@${STRING}QBEI${element}I@Z`]: thiscall(12, ([self, c, pos])=>
                rfind(whole(self), one(c), pos >>> 0)),

            [`?replace@${STRING}QAEAAV12@IIABV12@@Z`]: thiscall(16, ([self, pos, count, other])=>
                replaceElements(self, pos >>> 0, count, whole(other))),
            [`?replace@${STRING}QAEAAV12@IIABV12@II@Z`]: thiscall(24,
                ([self, pos, count, other, opos, ocount])=>replaceElements(self, pos >>> 0, count,
                    elementsOf(other, opos >>> 0, ocount))),
            [`?replace@${STRING}QAEAAV12@II${CPTR}@Z`]: thiscall(16, ([self, pos, count, from])=>
                replaceElements(self, pos >>> 0, count, zeroTerminated(from))),
            [`?replace@${STRING}QAEAAV12@II${CPTR}I@Z`]: thiscall(20,
                ([self, pos, count, from, n])=>replaceElements(self, pos >>> 0, count,
                    read(from, n >>> 0))),
            [`?replace@${STRING}QAEAAV12@III${element}@Z`]: thiscall(20,
                ([self, pos, count, n, c])=>replaceElements(self, pos >>> 0, count,
                    filled(n >>> 0, c))),
            [`?insert@${STRING}QAEAAV12@IABV12@@Z`]: thiscall(12, ([self, pos, other])=>
                replaceElements(self, pos >>> 0, 0, whole(other))),
            [`?insert@${STRING}QAEAAV12@I${CPTR}@Z`]: thiscall(12, ([self, pos, from])=>
                replaceElements(self, pos >>> 0, 0, zeroTerminated(from))),
            [`?insert@${STRING}QAEAAV12@I${CPTR}I@Z`]: thiscall(16, ([self, pos, from, n])=>
                replaceElements(self, pos >>> 0, 0, read(from, n >>> 0))),
            [`?insert@${STRING}QAEAAV12@II${element}@Z`]: thiscall(16, ([self, pos, n, c])=>
                replaceElements(self, pos >>> 0, 0, filled(n >>> 0, c))),

            [`?insert@${STRING}QAEAAV12@IABV12@II@Z`]: thiscall(20, ([self, pos, other, opos, n])=>
                replaceElements(self, pos >>> 0, 0, elementsOf(other, opos >>> 0, n))),
            [`?insert@${STRING}QAE${PTRN}${PTRN}${element}@Z`]: thiscall(12, ([self, at, c])=>{
                const pos = offsetOf(self, at);
                replaceElements(self, pos, 0, one(c));
                return (ptr(self) + pos * unit) >>> 0;
            }),
            [`?insert@${STRING}QAEX${PTRN}I${element}@Z`]: thiscall(16, ([self, at, n, c])=>{
                replaceElements(self, offsetOf(self, at), 0, filled(n >>> 0, c));
                return 0;
            }),
            [`?insert@${STRING}QAEX${PTRN}${CPTR}1@Z`]: thiscall(16, ([self, at, first, last])=>{
                replaceElements(self, offsetOf(self, at), 0, between(first, last));
                return 0;
            }),
            ...Object.fromEntries(iteratorReplaces()),

            [rbegin(false)]: thiscall(8, ([self, out])=>{
                freeze(self);
                setU32(out, ptr(self) + len(self) * unit);
                return out;
            }),
            [rbegin(true)]: thiscall(8, ([self, out])=>{
                setU32(out, ptr(self) + len(self) * unit);
                return out;
            }),
            [rend(false)]: thiscall(8, ([self, out])=>{
                freeze(self);
                setU32(out, ptr(self));
                return out;
            }),
            [rend(true)]: thiscall(8, ([self, out])=>{
                setU32(out, ptr(self));
                return out;
            }),
            [`?get_allocator@${STRING}QBE?AV?$allocator@${element}@2@XZ`]: thiscall(8,
                ([, out])=>{
                    setU8(out, 0);
                    return out;
                }),
            ...Object.fromEntries(setFinds()),

            [`?_Copy@${STRING}AAEXI@Z`]: thiscall(8, ([self, n])=>{
                copy(self, n >>> 0);
                return 0;
            }),
            [`?_Eos@${STRING}AAEXI@Z`]: thiscall(8, ([self, n])=>{
                eos(self, n >>> 0);
                return 0;
            }),
            [`?_Freeze@${STRING}AAEXXZ`]: thiscall(4, ([self])=>{
                freeze(self);
                return 0;
            }),
            [`?_Grow@${STRING}AAE_NI_N@Z`]: thiscall(12, ([self, n, trim])=>
                (grow(self, n >>> 0, (trim & 0xff) !== 0) ? 1 : 0)),
            [`?_Split@${STRING}AAEXXZ`]: thiscall(4, ([self])=>{
                split(self);
                return 0;
            }),
            [`?_Tidy@${STRING}AAEX_N@Z`]: thiscall(8, ([self, built])=>{
                tidy(self, (built & 0xff) !== 0);
                return 0;
            }),
            [`?_Refcnt@${STRING}AAEAAE${CPTR}@Z`]: thiscall(8, ([, text])=>
                ((text >>> 0) - 1) >>> 0),
            [`?_Pdif@${STRING}CAI${CPTR}0@Z`]: cdecl(8, ([left, right])=>
                ((right >>> 0) === 0 ? 0 : ((left >>> 0) - (right >>> 0)) / unit)),
            [`?_Psum@${STRING}CA${PTRN}${PTRN}I@Z`]: cdecl(8, ([at, n])=>
                ((at >>> 0) === 0 ? 0 : ((at >>> 0) + (n >>> 0) * unit) >>> 0)),
            [`?_Psum@${STRING}CA${CPTR}${CPTR}I@Z`]: cdecl(8, ([at, n])=>
                ((at >>> 0) === 0 ? 0 : ((at >>> 0) + (n >>> 0) * unit) >>> 0)),
        };

        /** A pointer into the text as a position. @param {number} self @param {number} at */
        function offsetOf(self, at){
            return ((at >>> 0) - ptr(self)) / unit;
        }
        /** The elements of a run [first, last). @param {number} first @param {number} last */
        function between(first, last){
            return read(first, ((last >>> 0) - (first >>> 0)) / unit);
        }

        /**
         * replace(first, last, ...) by iterators, each over replace by
         * position: the five sources a position's replace takes.
         *
         * @returns {[string, any][]}
         */
        function iteratorReplaces(){
            const name = (/** @type {string} */ args)=>`?replace@${STRING}QAEAAV12@${PTRN}0${args}@Z`;
            /** @param {number} self @param {number} first @param {number} last @param {Uint8Array} elements */
            const put = (self, first, last, elements)=>replaceElements(self, offsetOf(self, first),
                ((last >>> 0) - (first >>> 0)) / unit, elements);
            return [
                [name('ABV12@'), thiscall(16, ([self, first, last, other])=>
                    put(self, first, last, whole(other)))],
                [name(`I${element}`), thiscall(20, ([self, first, last, n, c])=>
                    put(self, first, last, filled(n >>> 0, c)))],
                [name(`${CPTR}1`), thiscall(20, ([self, first, last, from, to])=>
                    put(self, first, last, between(from, to)))],
                [name(CPTR), thiscall(16, ([self, first, last, from])=>
                    put(self, first, last, zeroTerminated(from)))],
                [name(`${CPTR}I`), thiscall(20, ([self, first, last, from, n])=>
                    put(self, first, last, read(from, n >>> 0)))],
            ];
        }

        /**
         * find_first_of, find_first_not_of, find_last_of, find_last_not_of:
         * the first (last) position from `pos` whose element is (is not) one
         * of a set, npos for none; the last ones search from min(pos, size-1).
         *
         * @returns {[string, any][]}
         */
        function setFinds(){
            /** @type {[string, boolean, boolean][]} */
            const kinds = [['find_first_of', true, true], ['find_first_not_of', true, false],
                ['find_last_of', false, true], ['find_last_not_of', false, false]];
            return kinds.flatMap(([kind, forward, member])=>{
                /** @param {Uint8Array} hay @param {Uint8Array} set @param {number} pos */
                const search = (hay, set, pos)=>{
                    const length = hay.length / unit;
                    const values = new Set(Array.from({ length: set.length / unit },
                        (_, i)=>valueAt(set, i)));
                    if (member && values.size === 0)
                    {
                        return npos;
                    }
                    if (forward)
                    {
                        for (let at = pos >>> 0; at < length; at++)
                        {
                            if (values.has(valueAt(hay, at)) === member)
                            {
                                return at;
                            }
                        }
                        return npos;
                    }
                    for (let at = Math.min(pos >>> 0, length - 1); at >= 0; at--)
                    {
                        if (values.has(valueAt(hay, at)) === member)
                        {
                            return at;
                        }
                    }
                    return npos;
                };
                const name = (/** @type {string} */ args)=>`?${kind}@${STRING}QBEI${args}@Z`;
                return /** @type {[string, any][]} */ ([
                    [name('ABV12@I'), thiscall(12, ([self, other, pos])=>
                        search(whole(self), whole(other), pos))],
                    [name(`${element}I`), thiscall(12, ([self, c, pos])=>
                        search(whole(self), one(c), pos))],
                    [name(`${CPTR}I`), thiscall(12, ([self, from, pos])=>
                        search(whole(self), zeroTerminated(from), pos))],
                    [name(`${CPTR}II`), thiscall(16, ([self, from, pos, n])=>
                        search(whole(self), read(from, n >>> 0), pos))],
                ]);
            });
        }

        /** resize(n, c). @param {number} self @param {number} n @param {number} c */
        function resize(self, n, c){
            const length = len(self);
            if (n <= length)
            {
                erase(self, n, npos);
            }
            else
            {
                appendElements(self, filled(n - length, c));
            }
            return 0;
        }

        // The free operators: + makes a new string in the caller's result;
        // the comparisons answer a bool. Each with string, text and element
        // arguments as the library exports them.
        const relations = /** @type {[string, (order: number) => boolean][]} */ ([
            ['8', order=>order === 0], ['9', order=>order !== 0], ['M', order=>order < 0],
            ['O', order=>order > 0], ['N', order=>order <= 0], ['P', order=>order >= 0]]);
        for (const [op, holds] of relations)
        {
            const answer = (/** @type {number} */ order)=>(holds(order) ? 1 : 0);
            for (const name of named(op, `YA_NABV?${ARG}0@0@Z`))
            {
                table[name] = cdecl(8, ([left, right])=>answer(compare(whole(left), whole(right))));
            }
            for (const name of named(op, `YA_NABV?${ARG}0@${CPTR}@Z`))
            {
                table[name] = cdecl(8, ([left, right])=>
                    answer(compare(whole(left), zeroTerminated(right))));
            }
            for (const name of named(op, `YA_N${CPTR}ABV?${ARG}0@@Z`))
            {
                table[name] = cdecl(8, ([left, right])=>
                    answer(compare(zeroTerminated(left), whole(right))));
            }
        }
        const join = (/** @type {Uint8Array} */ a, /** @type {Uint8Array} */ b)=>{
            const bytes = new Uint8Array(a.length + b.length);
            bytes.set(a);
            bytes.set(b, a.length);
            return bytes;
        };
        const RESULT = `YA?AV?${ARG}0@`;
        for (const name of named('H', `${RESULT}ABV10@0@Z`))
        {
            table[name] = cdecl(12, ([out, left, right])=>
                made(out, join(whole(left), whole(right))));
        }
        for (const name of named('H', `${RESULT}ABV10@${CPTR}@Z`))
        {
            table[name] = cdecl(12, ([out, left, right])=>
                made(out, join(whole(left), zeroTerminated(right))));
        }
        for (const name of named('H', `${RESULT}ABV10@${element}@Z`))
        {
            table[name] = cdecl(12, ([out, left, c])=>made(out, join(whole(left), one(c))));
        }
        for (const name of named('H', `${RESULT}${CPTR}ABV10@@Z`))
        {
            table[name] = cdecl(12, ([out, left, right])=>
                made(out, join(zeroTerminated(left), whole(right))));
        }
        for (const name of named('H', `${RESULT}${element}ABV10@@Z`))
        {
            table[name] = cdecl(12, ([out, c, right])=>made(out, join(one(c), whole(right))));
        }
        stringsBy[unit] = { tidy, assignElements, assignString, cstr, whole };
        return table;
    }

    const strings1 = strings(1, 'D');
    const strings2 = strings(2, 'G');
    return { ...strings1, ...strings2, ...errors(), ...restartable(),
        ...createStreams({ crt, host, thiscall, cdecl, raise, strings: stringsBy, allocate, free,
            u32, setU32 }) };

    /**
     * The C library's restartable conversions, which the C runtime Visual
     * C++ 6 shipped did not have and its C++ library carries for <cwchar>:
     * the runtime's own, the conversion state in the caller's memory.
     */
    function restartable(){
        return Object.fromEntries(['btowc', 'wctob', 'mbrlen', 'mbrtowc', 'wcrtomb', 'mbsrtowcs',
            'wcsrtombs'].filter(name=>crt[name]).map(name=>[name, crt[name]]));
    }

    /**
     * An exception of the library around a message: the runtime's exception
     * named "" (the message is the string's, not the base's), then the string.
     *
     * @param {number} self @param {string} name @param {number} message  a string
     */
    function constructError(self, name, message){
        const members = narrowOf();
        const empty = crt.malloc.handler([1]) >>> 0;
        setU8(empty, 0);
        setU32(self, host.addressOf(`??_7${name}@std@@6B@`));
        setU32(self + 4, empty);
        setU32(self + 8, empty === 0 ? 0 : 1);
        members.tidy(self + EXCEPTION_SIZE);
        members.assignString(self + EXCEPTION_SIZE, message);
        return self;
    }

    /**
     * The exception classes: their members, vtables, and the type data a
     * throw of each and a catch of it read.
     */
    function errors(){
        const members = narrowOf();
        /** @param {number} self */
        const destroy = self=>{
            crt['??1exception@@UAE@XZ'].handler([self]);
            members.tidy(self + EXCEPTION_SIZE, true);
            return 0;
        };
        /** @param {number} self @param {number} other @param {string} name */
        const copy = (self, other, name)=>{
            crt['??0exception@@QAE@ABV0@@Z'].handler([self, other]);
            setU32(self, host.addressOf(`??_7${name}@std@@6B@`));
            members.tidy(self + EXCEPTION_SIZE);
            members.assignString(self + EXCEPTION_SIZE, other + EXCEPTION_SIZE);
            return self;
        };
        /** @param {number} count @param {Record<number, number>} [values] */
        const words = (count, values = {})=>{
            const bytes = new Uint8Array(count * 4);
            const view = new DataView(bytes.buffer);
            for (const [at, value] of Object.entries(values))
            {
                view.setUint32(Number(at) * 4, value >>> 0, true);
            }
            return bytes;
        };
        /** The type descriptor: type_info's vtable (left null), a spare, the name. */
        const descriptor = (/** @type {string} */ decorated)=>({ data: ()=>{
            const bytes = new Uint8Array(8 + decorated.length + 1);
            bytes.set([...decorated].map(character=>character.charCodeAt(0)), 8);
            return bytes;
        } });
        /** @type {Record<string, any>} */
        const exports = {
            [typeOf('exception')]: descriptor('.?AVexception@@'),
            [copierOf('exception')]: crt['??0exception@@QAE@ABV0@@Z'],
            // A catchable type: by value (not a simple type), at offset 0
            // (pdisp -1: no virtual base), of its size, copied by its copy constructor.
            [catchableOf('exception')]: { data: ()=>words(7, { 3: -1, 5: EXCEPTION_SIZE }),
                pointers: [{ at: 4, to: typeOf('exception') },
                    { at: 24, to: copierOf('exception') }] },
        };
        for (const [name, bases] of Object.entries(ERRORS))
        {
            const family = bases[0] ?? name;
            const chain = [name, ...bases, 'exception'];
            Object.assign(exports, {
                [typeOf(name)]: descriptor(`.?AV${name}@std@@`),
                [`??0${name}@std@@QAE@ABV${NARROW}@1@@Z`]:
                    thiscall(8, ([self, message])=>constructError(self, name, message)),
                [copierOf(name)]: thiscall(8, ([self, other])=>copy(self, other, name)),
                [`??1${name}@std@@UAE@XZ`]: thiscall(4, ([self])=>destroy(self)),
                [`??4${name}@std@@QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>{
                    if (self !== other)
                    {
                        crt['??4exception@@QAEAAV0@ABV0@@Z'].handler([self, other]);
                        members.assignString(self + EXCEPTION_SIZE, other + EXCEPTION_SIZE);
                    }
                    return self;
                }),
                // The deleting destructor the vtable holds: one object, freed if asked.
                [`??_G${name}@std@@UAEPAXI@Z`]: thiscall(8, ([self, flags])=>{
                    destroy(self);
                    if ((flags & 1) !== 0)
                    {
                        free(self);
                    }
                    return self;
                }),
                // Throws a copy of the object, as `throw *this` does.
                [`?_Doraise@${name}@std@@MBEXXZ`]: thiscall(4, ([self])=>{
                    const object = allocate(ERROR_SIZE);
                    copy(object, self, name);
                    throw new Thrown(crt._CxxThrowException.handler([object,
                        host.addressOf(throwInfoOf(name))]));
                }),
                // The vtable, exported at its first slot: no complete object
                // locator before it, so typeid of one finds no type.
                [`??_7${name}@std@@6B@`]: { data: ()=>words(4), entry: 4, pointers: [
                    { at: 4, to: `??_G${name}@std@@UAEPAXI@Z` },
                    { at: 8, to: `?what@${family}@std@@UBEPBDXZ` },
                    { at: 12, to: `?_Doraise@${name}@std@@MBEXXZ` }] },
                [catchableOf(name)]: { data: ()=>words(7, { 3: -1, 5: ERROR_SIZE }),
                    pointers: [{ at: 4, to: typeOf(name) }, { at: 24, to: copierOf(name) }] },
                [`_CTA${chain.length}${typeOf(name)}`]: { data: ()=>words(1 + chain.length,
                    { 0: chain.length }), pointers: chain.map((type, index)=>
                    ({ at: 4 + index * 4, to: catchableOf(type) })) },
                [throwInfoOf(name)]: { data: ()=>words(4), pointers: [
                    { at: 4, to: `??1${name}@std@@UAE@XZ` },
                    { at: 12, to: `_CTA${chain.length}${typeOf(name)}` }] },
            });
            if (bases.length === 0)
            {
                // what(): the message the string holds; an object of no
                // string answers as an empty one.
                exports[`?what@${name}@std@@UBEPBDXZ`] = thiscall(4, ([self])=>
                    members.cstr(self + EXCEPTION_SIZE));
            }
        }
        exports['?_Xran@std@@YAXXZ'] = cdecl(0, ()=>fail('range'));
        exports['?_Xlen@std@@YAXXZ'] = cdecl(0, ()=>fail('length'));
        return exports;
    }
}
