/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Visual C++ 6's iostreams and locales, of char and of wchar_t (which that
 * compiler spells unsigned short), as MSVCP60 exports them.
 *
 * The objects are the program's, in its own memory and in the compiler's
 * layout, because its headers inline most of the library: a stream buffer's
 * read and write areas are walked by inline code through three indirect
 * pointers each (`eback()`, `gptr()` and the count left), and only when an
 * area is empty does it call the buffer's virtual `underflow` or `overflow`.
 * A stream reaches its `basic_ios` - a virtual base - through the vbtable at
 * its start, so one istream function serves a plain istream, the istream in
 * a stringstream and one in a class the program derived. A constructor of a
 * class with a virtual base takes one more argument than its name says: it
 * builds that base only when it is the most derived class's.
 *
 * A buffer's virtual functions are called through its vtable. Those of the
 * library's own buffers (stringbuf, filebuf) answer here directly; a buffer
 * of the program's own class, whose virtuals are its code, is beyond what a
 * call from here can run: such a call reads as end of stream, said once as
 * a loss.
 *
 * A locale is one pointer to its implementation, a facet whose reference
 * count inline code moves. What a locale says here is what numbers need:
 * its decimal point, from Windows's own locale data; "C" and the names
 * setlocale takes ("German", "English_United States.1252").
 */

import { LOCALES } from '../kernel32/locales.js';
import { LCTYPE, localeValues } from '../kernel32/locale-data.js';

/** ios_base::iostate. */
const GOODBIT = 0;
const EOFBIT = 1;
const FAILBIT = 2;
const BADBIT = 4;

/** ios_base::fmtflags. */
const F = Object.freeze({
    skipws: 0x1, unitbuf: 0x2, uppercase: 0x4, showbase: 0x8, showpoint: 0x10, showpos: 0x20,
    left: 0x40, right: 0x80, internal: 0x100, dec: 0x200, oct: 0x400, hex: 0x800,
    scientific: 0x1000, fixed: 0x2000, boolalpha: 0x4000,
    adjustfield: 0x1c0, basefield: 0xe00, floatfield: 0x3000,
});

/** ios_base::openmode. */
const IN = 0x1;
const OUT = 0x2;
const ATE = 0x4;
const APP = 0x8;
const TRUNC = 0x10;
const BINARY = 0x20;

/** ios_base::seekdir, and the offset that says a seek failed. */
const BEG = 0;
const CUR = 1;
const END = 2;
const BADOFF = -1;

/**
 * What an integer extractor accepts and stores: the least and greatest value
 * (an unsigned one takes a negative number as strtoul does, its bits) and
 * the bytes it writes.
 *
 * @type {Record<string, [bigint, bigint, number]>}
 */
const RANGES = {
    short: [-0x8000n, 0x7fffn, 2], ushort: [-0xffffn, 0xffffn, 2],
    int: [-0x80000000n, 0x7fffffffn, 4], uint: [-0xffffffffn, 0xffffffffn, 4],
    int64: [-(1n << 63n), (1n << 63n) - 1n, 8], uint64: [-((1n << 64n) - 1n), (1n << 64n) - 1n, 8],
    bool: [0n, 1n, 1], pointer: [0n, 0xffffffffn, 4],
};

/** The largest count, which ignore() and the readers take as no count. */
const INT_MAX = 0x7fffffff;

/** ios_base and basic_ios, the virtual base every stream has. */
const IOS = Object.freeze({ VTABLE: 0, STATE: 4, EXCEPT: 8, FMTFL: 12, PREC: 16, WIDE: 20,
    ARR: 24, CALLS: 28, LOC: 32, STDSTR: 36, BUF: 40, TIE: 44, FILL: 48, SIZE: 52 });

/**
 * basic_streambuf: the read area's start, next and count and the write
 * area's, each reached through a pointer to it (which normally points at
 * the buffer's own field), then the locale.
 */
const SB = Object.freeze({ VTABLE: 0, RBUF: 4, WBUF: 8, PRBUF: 12, PWBUF: 16, RPOS: 20,
    WPOS: 24, PRPOS: 28, PWPOS: 32, RSIZE: 36, WSIZE: 40, PRSIZE: 44, PWSIZE: 48, LOC: 52,
    SIZE: 56 });

/** basic_stringbuf after its base: what it keeps of its own text. */
const STRBUF = Object.freeze({ PENDSAVE: 56, SEEKHIGH: 60, ALSIZE: 64, STATE: 68, SIZE: 76 });

/** basic_filebuf after its base. */
const FILEBUF = Object.freeze({ CVT: 56, STATE0: 60, STATE: 64, STR: 68, CLOSE: 72, LOC: 76,
    FILE: 80, SIZE: 84 });

/** A stringbuf's state: its storage is its own, it may not grow, it may not be read. */
const ALLOCATED = 1;
const CONSTANT = 2;
const NOREAD = 4;

/** How much a stringbuf's storage grows by at least. */
const MINSIZE = 32;

/** fpos<int>: an offset, the file's position, the conversion state. */
const FPOS = Object.freeze({ OFF: 0, POS: 8, STATE: 16, SIZE: 24 });

/** A locale's implementation: a facet (vtable, references), then what it says. */
const LOCIMP = Object.freeze({ VTABLE: 0, REFS: 4, LCID: 8, DECIMAL: 12, THOUSANDS: 14,
    NAME: 16, SIZE: 20 });

/**
 * The library's own statics that the real one keeps unnamed: the classic
 * locale's implementation and the locale object of it.
 */
const CLASSIC_LOCIMP = '?_Classic@_Locimp@locale@std@@0V123@A';
const CLASSIC_LOCALE = '?_Classic@locale@std@@0V12@A';

/**
 * The standard streams: their kind, the FILE of the runtime's they are over
 * (stdin, stdout, stderr, by index in its array), their index as standard
 * streams, and whether they are tied to cout.
 */
const STANDARD = /** @type {const} */ ([
    { name: 'cin', kind: 'istream', file: 0, index: 1, tied: true },
    { name: 'cout', kind: 'ostream', file: 1, index: 2, tied: false },
    { name: 'cerr', kind: 'ostream', file: 2, index: 3, tied: true },
    { name: 'clog', kind: 'ostream', file: 2, index: 4, tied: false },
]);
/**
 * The static buffer of a standard stream, which the library keeps unnamed.
 *
 * @param {string} name @param {'D' | 'G'} E
 */
const standardBufferOf = (name, E)=>
    `?_${name}buf@std@@0V?$basic_filebuf@${E}U?$char_traits@${E}@std@@@1@A`;
/** A FILE of the runtime's, 32 bits. */
const FILE_SIZE = 32;

/** The streambuf's virtual functions, in their vtable's order after the destructor. */
const VIRTUALS = ['overflow', 'pbackfail', 'showmanyc', 'underflow', 'uflow', 'xsgetn',
    'xsputn', 'seekoff', 'seekpos', 'setbuf', 'sync', 'imbue'];
/** @param {string} name */
const slotOf = name=>4 + 4 * VIRTUALS.indexOf(name);

/**
 * The stream classes: the istream and ostream parts at their offsets, the
 * buffer a class holds, and where its basic_ios lies.
 *
 * @typedef {Object} StreamClass
 * @property {string} name
 * @property {boolean} allocator  The class's name carries the allocator.
 * @property {{ kind: 'istream' | 'ostream', at: number }[]} parts
 * @property {'string' | 'file' | null} buffer
 * @property {number} bufferAt
 * @property {number} iosAt
 */

/** @type {StreamClass[]} */
const STREAMS = [
    { name: 'basic_istream', allocator: false, parts: [{ kind: 'istream', at: 0 }],
        buffer: null, bufferAt: 0, iosAt: 8 },
    { name: 'basic_ostream', allocator: false, parts: [{ kind: 'ostream', at: 0 }],
        buffer: null, bufferAt: 0, iosAt: 4 },
    { name: 'basic_iostream', allocator: false,
        parts: [{ kind: 'istream', at: 0 }, { kind: 'ostream', at: 8 }],
        buffer: null, bufferAt: 0, iosAt: 12 },
    { name: 'basic_stringstream', allocator: true,
        parts: [{ kind: 'istream', at: 0 }, { kind: 'ostream', at: 8 }],
        buffer: 'string', bufferAt: 12, iosAt: 12 + STRBUF.SIZE },
    { name: 'basic_istringstream', allocator: true, parts: [{ kind: 'istream', at: 0 }],
        buffer: 'string', bufferAt: 8, iosAt: 8 + STRBUF.SIZE },
    { name: 'basic_ostringstream', allocator: true, parts: [{ kind: 'ostream', at: 0 }],
        buffer: 'string', bufferAt: 4, iosAt: 4 + STRBUF.SIZE },
    { name: 'basic_fstream', allocator: false,
        parts: [{ kind: 'istream', at: 0 }, { kind: 'ostream', at: 8 }],
        buffer: 'file', bufferAt: 12, iosAt: 12 + FILEBUF.SIZE },
    { name: 'basic_ifstream', allocator: false, parts: [{ kind: 'istream', at: 0 }],
        buffer: 'file', bufferAt: 8, iosAt: 8 + FILEBUF.SIZE },
    { name: 'basic_ofstream', allocator: false, parts: [{ kind: 'ostream', at: 0 }],
        buffer: 'file', bufferAt: 4, iosAt: 4 + FILEBUF.SIZE },
];

/**
 * The C library's fopen modes for each openmode the library takes, as its
 * table has them; binary adds "b", any other combination fails.
 */
const FOPEN_MODES = new Map([
    [IN, 'r'], [OUT, 'w'], [OUT | TRUNC, 'w'], [OUT | APP, 'a'], [IN | OUT, 'r+'],
    [IN | OUT | TRUNC, 'w+'], [IN | OUT | APP, 'a+'],
]);

/**
 * @typedef {Object} StringMembers
 * @property {(self: number, built?: boolean) => void} tidy
 * @property {(self: number, elements: Uint8Array) => number} assignElements
 * @property {(self: number) => Uint8Array} whole
 */

/**
 * @typedef {Object} StreamsContext
 * @property {Record<string, any>} crt  msvcrt's table: new and delete, malloc and free,
 *           and the FILE functions a filebuf reads and writes through.
 * @property {import('./msvcp60.js').Msvcp60Host} host
 * @property {(argBytes: number, handler: (args: number[]) => any) => any} thiscall
 * @property {(argBytes: number, handler: (args: number[]) => any) => any} cdecl
 * @property {(name: string, message: string) => never} raise
 * @property {Record<number, StringMembers>} strings  By element size.
 * @property {(size: number) => number} allocate
 * @property {(block: number) => void} free
 * @property {(address: number) => number} u32
 * @property {(address: number, value: number) => void} setU32
 */

/**
 * @param {StreamsContext} context
 * @returns {Record<string, any>}
 */
export function createStreams(context){
    const { crt, host, thiscall, cdecl, raise, strings, allocate, free, u32, setU32 } = context;

    /** @param {number} address */
    const i32 = address=>u32(address) | 0;
    /** @param {number} address */
    const u16 = address=>{
        const bytes = host.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const setU16 = (address, value)=>host.writeMemory(address >>> 0,
        Uint8Array.of(value & 0xff, value >>> 8 & 0xff));
    /** @param {number} address @param {number} count */
    const zero = (address, count)=>host.writeMemory(address >>> 0, new Uint8Array(count));

    /** A C string of the guest's. @param {number} address */
    const cString = address=>{
        let text = '';
        for (let at = address >>> 0; ; at++)
        {
            const byte = host.readMemory(at, 1)[0];
            if (byte === 0)
            {
                return text;
            }
            text += String.fromCharCode(byte);
        }
    };

    /** Bytes of a C string, its terminator after them, on the runtime's heap. @param {string} text */
    const heapString = text=>{
        const at = crt.malloc.handler([text.length + 1]) >>> 0;
        host.writeMemory(at, Uint8Array.from([...text, '\0'], c=>c.charCodeAt(0) & 0xff));
        return at;
    };

    /** What is said once. @type {Set<string>} */
    const said = new Set();
    /** @param {string} api @param {string} detail */
    const loss = (api, detail)=>{
        if (!said.has(`${api}\n${detail}`))
        {
            said.add(`${api}\n${detail}`);
            host.divergence?.(api, detail, 'loss');
        }
    };

    /** A double from the two dwords it was passed in. @param {number} low @param {number} high */
    const doubleOf = (low, high)=>{
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, low >>> 0, true);
        view.setUint32(4, high >>> 0, true);
        return view.getFloat64(0, true);
    };
    /** @param {number} bits */
    const floatOf = bits=>{
        const view = new DataView(new ArrayBuffer(4));
        view.setUint32(0, bits >>> 0, true);
        return view.getFloat32(0, true);
    };

    // ---- locales ------------------------------------------------------------

    /**
     * The global locale's implementation, what a default-made locale is: the
     * classic one until locale::global names another (its pointer, which the
     * library exports, kept beside it).
     */
    let global = 0;

    /**
     * A locale's implementation on the runtime's heap: its facet vtable, one
     * reference, its LCID, decimal point and thousands separator, its name.
     *
     * @param {number} lcid @param {number} decimal @param {number} thousands @param {string} name
     */
    const makeLocimp = (lcid, decimal, thousands, name)=>{
        const at = crt.malloc.handler([LOCIMP.SIZE]) >>> 0;
        setU32(at + LOCIMP.VTABLE, host.addressOf('??_7facet@locale@std@@6B@'));
        setU32(at + LOCIMP.REFS, 1);
        setU32(at + LOCIMP.LCID, lcid);
        setU16(at + LOCIMP.DECIMAL, decimal);
        setU16(at + LOCIMP.THOUSANDS, thousands);
        setU32(at + LOCIMP.NAME, heapString(name));
        return at;
    };
    /** The classic ("C") locale's implementation: static, so the std streams point at it. */
    const classicImp = ()=>host.addressOf(CLASSIC_LOCIMP);
    const globalImp = ()=>(global === 0 ? classicImp() : global);
    /** @param {number} imp */
    const incref = imp=>{
        if (imp !== 0)
        {
            setU32(imp + LOCIMP.REFS, u32(imp + LOCIMP.REFS) + 1);
        }
        return imp;
    };
    /** @param {number} imp */
    const decref = imp=>{
        if (imp === 0)
        {
            return;
        }
        const refs = u32(imp + LOCIMP.REFS) - 1;
        setU32(imp + LOCIMP.REFS, refs);
        if (refs === 0 && imp !== classicImp())
        {
            crt.free.handler([u32(imp + LOCIMP.NAME)]);
            crt.free.handler([imp]);
        }
    };

    /**
     * The Windows locale a setlocale name stands for: a language as English
     * names it or abbreviates it, a country after an underscore, a code page
     * after a point (which numbers do not depend on); the language's first
     * locale when no country is named.
     *
     * @param {string} name
     */
    const windowsLocale = name=>{
        const [place] = name.split('.');
        const [language, country] = place.split('_').map(part=>part.trim().toLowerCase());
        return LOCALES.find(locale=>{
            if (locale.neutral)
            {
                return false;
            }
            const values = localeValues(locale).strings;
            const named = [values.get(LCTYPE.SENGLANGUAGE), values.get(LCTYPE.SABBREVLANGNAME)]
                .some(text=>String(text ?? '').toLowerCase() === language)
                || locale.name.toLowerCase() === place.toLowerCase();
            return named && (country === undefined || [values.get(LCTYPE.SENGCOUNTRY),
                values.get(LCTYPE.SABBREVCTRYNAME)].some(text=>
                String(text ?? '').toLowerCase() === country));
        }) ?? null;
    };

    /**
     * A locale's implementation for a name: the classic one for "C", the
     * user's (English, United States, as the machine is) for "", and for
     * another name the Windows locale it stands for; a name that is none is
     * the library's runtime_error.
     *
     * @param {string} name
     */
    const locimpNamed = name=>{
        if (name === 'C')
        {
            return incref(classicImp());
        }
        const locale = windowsLocale(name === '' ? 'English_United States' : name);
        if (!locale)
        {
            return raise('runtime_error', 'bad locale name');
        }
        const values = localeValues(locale).strings;
        const char = (/** @type {number} */ type)=>String(values.get(type) ?? '').charCodeAt(0) || 0;
        return makeLocimp(locale.lcid, char(LCTYPE.SDECIMAL), char(LCTYPE.STHOUSAND),
            `${values.get(LCTYPE.SENGLANGUAGE)}_${values.get(LCTYPE.SENGCOUNTRY)}.${locale.ansi}`);
    };

    /** The decimal point of a locale's implementation. @param {number} imp */
    const decimalOf = imp=>(imp === 0 ? 0x2e : u16(imp + LOCIMP.DECIMAL));

    // ---- elements -----------------------------------------------------------

    /**
     * The members that depend on the element: its size, how one is read and
     * written, and its traits' end-of-file value.
     *
     * @param {1 | 2} unit
     */
    const elements = unit=>{
        const eof = unit === 1 ? -1 : 0xffff;
        return {
            unit,
            eof,
            /** @param {number} c */
            isEof: c=>(unit === 1 ? (c | 0) === -1 : (c & 0xffff) === 0xffff),
            /** to_int_type: a char is read unsigned. @param {number} at */
            get: at=>(unit === 1 ? host.readMemory(at >>> 0, 1)[0] : u16(at)),
            /** @param {number} at @param {number} c */
            put: (at, c)=>(unit === 1 ? host.writeMemory(at >>> 0, Uint8Array.of(c & 0xff))
                : setU16(at, c)),
            /** The element value of an int_type or char argument. @param {number} c */
            of: c=>(unit === 1 ? c & 0xff : c & 0xffff),
        };
    };

    // ---- stream buffers -----------------------------------------------------

    /**
     * The functions of basic_streambuf of one element, which the buffers and
     * the streams use: the areas through their indirect pointers, the public
     * members, and virtual calls through the vtable.
     *
     * @param {ReturnType<typeof elements>} e
     */
    const buffers = e=>{
        const { unit } = e;
        const eback = (/** @type {number} */ b)=>u32(u32(b + SB.PRBUF));
        const gptr = (/** @type {number} */ b)=>u32(u32(b + SB.PRPOS));
        const gcount = (/** @type {number} */ b)=>i32(u32(b + SB.PRSIZE));
        const egptr = (/** @type {number} */ b)=>(gptr(b) + gcount(b) * unit) >>> 0;
        const pbase = (/** @type {number} */ b)=>u32(u32(b + SB.PWBUF));
        const pptr = (/** @type {number} */ b)=>u32(u32(b + SB.PWPOS));
        const pcount = (/** @type {number} */ b)=>i32(u32(b + SB.PWSIZE));
        const epptr = (/** @type {number} */ b)=>(pptr(b) + pcount(b) * unit) >>> 0;
        /** setg: the read area's start, next and end. */
        /** @param {number} b @param {number} first @param {number} next @param {number} last */
        const setg = (b, first, next, last)=>{
            setU32(u32(b + SB.PRBUF), first);
            setU32(u32(b + SB.PRPOS), next);
            setU32(u32(b + SB.PRSIZE), ((last >>> 0) - (next >>> 0)) / unit);
        };
        /** setp with a next: the write area's start, next and end. */
        /** @param {number} b @param {number} first @param {number} next @param {number} last */
        const setp = (b, first, next, last)=>{
            setU32(u32(b + SB.PWBUF), first);
            setU32(u32(b + SB.PWPOS), next);
            setU32(u32(b + SB.PWSIZE), ((last >>> 0) - (next >>> 0)) / unit);
        };
        const gbump = (/** @type {number} */ b, /** @type {number} */ n)=>{
            setU32(u32(b + SB.PRPOS), gptr(b) + n * unit);
            setU32(u32(b + SB.PRSIZE), gcount(b) - n);
        };
        const pbump = (/** @type {number} */ b, /** @type {number} */ n)=>{
            setU32(u32(b + SB.PWPOS), pptr(b) + n * unit);
            setU32(u32(b + SB.PWSIZE), pcount(b) - n);
        };

        /** The buffer's own pointers pointing at its own fields, both areas empty. */
        const init = (/** @type {number} */ b)=>{
            zero(b + SB.RBUF, SB.LOC - SB.RBUF);
            setU32(b + SB.PRBUF, b + SB.RBUF);
            setU32(b + SB.PWBUF, b + SB.WBUF);
            setU32(b + SB.PRPOS, b + SB.RPOS);
            setU32(b + SB.PWPOS, b + SB.WPOS);
            setU32(b + SB.PRSIZE, b + SB.RSIZE);
            setU32(b + SB.PWSIZE, b + SB.WSIZE);
        };

        /** @type {Map<number, (b: number, ...args: number[]) => number> | null} */
        let own = null;
        /**
         * Calls a virtual function of a buffer: the library's own answer
         * here; one of the program's class cannot be run from here.
         *
         * @param {number} b @param {string} name @param {number[]} args
         * @param {number} otherwise  What the call reads as when it cannot be made.
         */
        const virt = (b, name, args, otherwise)=>{
            const target = u32(u32(b) + slotOf(name));
            const handler = (own ??= virtualsByAddress(unit)).get(target);
            if (handler)
            {
                return handler(b, ...args);
            }
            loss(`basic_streambuf::${name}`, 'a stream buffer of the program\'s own class: its '
                + 'virtual function is not run, the call reads as end of stream');
            return otherwise;
        };

        const underflow = (/** @type {number} */ b)=>virt(b, 'underflow', [], e.eof);
        const uflow = (/** @type {number} */ b)=>virt(b, 'uflow', [], e.eof);
        const overflow = (/** @type {number} */ b, /** @type {number} */ c)=>
            virt(b, 'overflow', [c], e.eof);

        const sgetc = (/** @type {number} */ b)=>(gptr(b) !== 0 && gcount(b) > 0
            ? e.get(gptr(b)) : underflow(b));
        const sbumpc = (/** @type {number} */ b)=>{
            if (gptr(b) !== 0 && gcount(b) > 0)
            {
                const c = e.get(gptr(b));
                gbump(b, 1);
                return c;
            }
            return uflow(b);
        };
        const snextc = (/** @type {number} */ b)=>(e.isEof(sbumpc(b)) ? e.eof : sgetc(b));
        const sputc = (/** @type {number} */ b, /** @type {number} */ c)=>{
            if (pptr(b) !== 0 && pcount(b) > 0)
            {
                e.put(pptr(b), c);
                pbump(b, 1);
                return e.of(c);
            }
            return overflow(b, e.of(c));
        };
        const sputbackc = (/** @type {number} */ b, /** @type {number} */ c)=>{
            if (gptr(b) !== 0 && eback(b) < gptr(b) && e.get(gptr(b) - unit) === e.of(c))
            {
                gbump(b, -1);
                return e.of(c);
            }
            return virt(b, 'pbackfail', [e.of(c)], e.eof);
        };
        const sungetc = (/** @type {number} */ b)=>{
            if (gptr(b) !== 0 && eback(b) < gptr(b))
            {
                gbump(b, -1);
                return e.get(gptr(b));
            }
            return virt(b, 'pbackfail', [e.eof], e.eof);
        };
        /** Elements read into memory, as many as there are up to `count`. */
        /** @param {number} b @param {number} to @param {number} count */
        const sgetn = (b, to, count)=>{
            let n = 0;
            for (; n < count; n++)
            {
                const c = sbumpc(b);
                if (e.isEof(c))
                {
                    break;
                }
                e.put(to + n * unit, c);
            }
            return n;
        };
        /** @param {number} b @param {number} from @param {number} count */
        const sputn = (b, from, count)=>{
            let n = 0;
            for (; n < count; n++)
            {
                if (e.isEof(sputc(b, e.get(from + n * unit))))
                {
                    break;
                }
            }
            return n;
        };
        const pubsync = (/** @type {number} */ b)=>virt(b, 'sync', [], -1);

        /**
         * A seek through the virtual: its position as offset and file position.
         *
         * @param {number} b @param {'seekoff' | 'seekpos'} name @param {number[]} args
         * @returns {{ off: number, pos: bigint }}
         */
        const seek = (b, name, args)=>{
            const out = allocate(FPOS.SIZE);
            try
            {
                const target = u32(u32(b) + slotOf(name));
                const handler = (own ??= virtualsByAddress(unit)).get(target);
                if (!handler)
                {
                    loss(`basic_streambuf::${name}`, 'a stream buffer of the program\'s own '
                        + 'class: its virtual function is not run, the seek fails');
                    return { off: BADOFF, pos: 0n };
                }
                handler(b, out, ...args);
                return readFpos(out);
            }
            finally
            {
                free(out);
            }
        };
        const pubseekoff = (/** @type {number} */ b, /** @type {number} */ off,
            /** @type {number} */ way, /** @type {number} */ which)=>
            seek(b, 'seekoff', [off, way, which]);
        /** @param {number} b @param {{ off: number, pos: bigint }} at @param {number} which */
        const pubseekpos = (b, at, which)=>seek(b, 'seekpos', [...fposWords(at), which]);

        return { eback, gptr, egptr, gcount, pbase, pptr, epptr, pcount, setg, setp, gbump,
            pbump, init, virt, sgetc, sbumpc, snextc, sputc, sputbackc, sungetc, sgetn,
            sputn, pubsync, pubseekoff, pubseekpos, underflow, uflow, overflow };
    };

    /** An fpos read from memory. @param {number} at */
    const readFpos = at=>({ off: i32(at + FPOS.OFF),
        pos: new DataView(host.readMemory(at + FPOS.POS, 8).slice().buffer).getBigInt64(0, true) });
    /** An fpos written: offset, file position, no conversion state. */
    /** @param {number} at @param {number} off @param {bigint} pos */
    const writeFpos = (at, off, pos)=>{
        zero(at, FPOS.SIZE);
        setU32(at + FPOS.OFF, off);
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigInt64(0, pos, true);
        host.writeMemory(at + FPOS.POS, bytes);
        return at;
    };
    /** An fpos as the six dwords it is passed by value in. @param {{ off: number, pos: bigint }} at */
    const fposWords = at=>{
        const pos = BigInt.asUintN(64, at.pos);
        return [at.off >>> 0, 0, Number(pos & 0xffffffffn), Number(pos >> 32n), 0, 0];
    };
    /** An fpos from the six dwords it was passed in. @param {number[]} words */
    const fposOf = words=>({ off: words[0] | 0,
        pos: BigInt.asIntN(64, BigInt(words[2] >>> 0) | BigInt(words[3] >>> 0) << 32n) });
    /** streamoff of a position: its offset and its file position together. */
    const offsetOf = (/** @type {{ off: number, pos: bigint }} */ at)=>at.off + Number(at.pos);

    const narrow = elements(1);
    const wide = elements(2);
    const bufferOf = { 1: buffers(narrow), 2: buffers(wide) };

    /** @type {Record<number, Map<number, (b: number, ...args: number[]) => number>>} */
    const byAddress = {};
    /** The library's own virtual functions of each element's buffers, by where they are placed. */
    /** @type {Record<number, { name: string, handler: (b: number, ...args: number[]) => number }[]>} */
    const virtualExports = { 1: [], 2: [] };
    /** @param {number} unit */
    const virtualsByAddress = unit=>(byAddress[unit] ??= new Map(virtualExports[unit]
        .map(({ name, handler })=>[host.addressOf(name), handler])));

    // ---- the classes, by element ---------------------------------------------

    /** @type {Record<string, any>} */
    const table = {};

    /** @param {'D' | 'G'} E */
    const traitsOf = E=>`${E}U?$char_traits@${E}@std@@`;
    /** A class's decorated name. @param {string} name @param {'D' | 'G'} E @param {boolean} allocator */
    const classOf = (name, E, allocator)=>(allocator
        ? `?$${name}@${traitsOf(E)}V?$allocator@${E}@2@@std@@`
        : `?$${name}@${traitsOf(E)}@std@@`);

    // ios_base: members that do not depend on the element.
    const iosBase = 'ios_base@std@@';
    /** setstate/clear: the state, which an exception mask asks to throw. */
    const setState = (/** @type {number} */ ios, /** @type {number} */ state)=>{
        setU32(ios + IOS.STATE, state & 0x17);
        if ((u32(ios + IOS.STATE) & u32(ios + IOS.EXCEPT)) !== 0)
        {
            loss('ios_base::clear', 'a state the exception mask names: ios_base::failure '
                + 'is not thrown');
        }
    };
    const addState = (/** @type {number} */ ios, /** @type {number} */ bits)=>
        setState(ios, u32(ios + IOS.STATE) | bits);
    const good = (/** @type {number} */ ios)=>u32(ios + IOS.STATE) === 0;

    /** ios_base's own fields, as its _Init sets them. @param {number} ios */
    const initIosBase = ios=>{
        setU32(ios + IOS.STATE, BADBIT);
        setU32(ios + IOS.EXCEPT, 0);
        setU32(ios + IOS.FMTFL, F.skipws | F.dec);
        setU32(ios + IOS.PREC, 6);
        setU32(ios + IOS.WIDE, 0);
        setU32(ios + IOS.ARR, 0);
        setU32(ios + IOS.CALLS, 0);
        setU32(ios + IOS.LOC, incref(globalImp()));
        setU32(ios + IOS.STDSTR, 0);
    };
    /** The arrays iword/pword and the callbacks keep, given back. @param {number} ios */
    const tidyIosBase = ios=>{
        for (const field of [IOS.ARR, IOS.CALLS])
        {
            for (let at = u32(ios + field); at !== 0;)
            {
                const next = u32(at);
                free(at);
                at = next;
            }
            setU32(ios + field, 0);
        }
    };
    /**
     * iword/pword: the cell of an index in the list the stream keeps, made
     * when first asked for.
     *
     * @param {number} ios @param {number} index
     */
    const cellOf = (ios, index)=>{
        for (let at = u32(ios + IOS.ARR); at !== 0; at = u32(at))
        {
            if (i32(at + 4) === index)
            {
                return at;
            }
        }
        const at = allocate(16);
        zero(at, 16);
        setU32(at, u32(ios + IOS.ARR));
        setU32(at + 4, index);
        setU32(ios + IOS.ARR, at);
        return at;
    };
    let nextIndex = 0;

    Object.assign(table, {
        [`?rdstate@${iosBase}QBEHXZ`]: thiscall(4, ([ios])=>u32(ios + IOS.STATE)),
        [`?good@${iosBase}QBE_NXZ`]: thiscall(4, ([ios])=>(good(ios) ? 1 : 0)),
        [`?eof@${iosBase}QBE_NXZ`]: thiscall(4, ([ios])=>(u32(ios + IOS.STATE) & EOFBIT ? 1 : 0)),
        [`?fail@${iosBase}QBE_NXZ`]: thiscall(4, ([ios])=>
            ((u32(ios + IOS.STATE) & (FAILBIT | BADBIT)) !== 0 ? 1 : 0)),
        [`?bad@${iosBase}QBE_NXZ`]: thiscall(4, ([ios])=>(u32(ios + IOS.STATE) & BADBIT ? 1 : 0)),
        [`??7${iosBase}QBE_NXZ`]: thiscall(4, ([ios])=>
            ((u32(ios + IOS.STATE) & (FAILBIT | BADBIT)) !== 0 ? 1 : 0)),
        [`??B${iosBase}QBEPAXXZ`]: thiscall(4, ([ios])=>
            ((u32(ios + IOS.STATE) & (FAILBIT | BADBIT)) !== 0 ? 0 : ios)),
        [`?clear@${iosBase}QAEXH_N@Z`]: thiscall(12, ([ios, state])=>(setState(ios, state), 0)),
        [`?clear@${iosBase}QAEXF@Z`]: thiscall(8, ([ios, state])=>
            (setState(ios, state & 0xffff), 0)),
        [`?setstate@${iosBase}QAEXH_N@Z`]: thiscall(12, ([ios, bits])=>(addState(ios, bits), 0)),
        [`?setstate@${iosBase}QAEXF@Z`]: thiscall(8, ([ios, bits])=>
            (addState(ios, bits & 0xffff), 0)),
        [`?exceptions@${iosBase}QBEHXZ`]: thiscall(4, ([ios])=>u32(ios + IOS.EXCEPT)),
        [`?exceptions@${iosBase}QAEXH@Z`]: thiscall(8, ([ios, mask])=>{
            setU32(ios + IOS.EXCEPT, mask & 0x17);
            setState(ios, u32(ios + IOS.STATE));
            return 0;
        }),
        [`?exceptions@${iosBase}QAEXF@Z`]: thiscall(8, ([ios, mask])=>{
            setU32(ios + IOS.EXCEPT, mask & 0x17);
            setState(ios, u32(ios + IOS.STATE));
            return 0;
        }),
        [`?flags@${iosBase}QBEHXZ`]: thiscall(4, ([ios])=>u32(ios + IOS.FMTFL)),
        [`?flags@${iosBase}QAEHH@Z`]: thiscall(8, ([ios, flags])=>{
            const old = u32(ios + IOS.FMTFL);
            setU32(ios + IOS.FMTFL, flags & 0xffff);
            return old;
        }),
        [`?setf@${iosBase}QAEHH@Z`]: thiscall(8, ([ios, flags])=>{
            const old = u32(ios + IOS.FMTFL);
            setU32(ios + IOS.FMTFL, (old | flags) & 0xffff);
            return old;
        }),
        [`?setf@${iosBase}QAEHHH@Z`]: thiscall(12, ([ios, flags, mask])=>{
            const old = u32(ios + IOS.FMTFL);
            setU32(ios + IOS.FMTFL, (old & ~mask | flags & mask) & 0xffff);
            return old;
        }),
        [`?unsetf@${iosBase}QAEXH@Z`]: thiscall(8, ([ios, mask])=>{
            setU32(ios + IOS.FMTFL, u32(ios + IOS.FMTFL) & ~mask);
            return 0;
        }),
        [`?precision@${iosBase}QBEHXZ`]: thiscall(4, ([ios])=>u32(ios + IOS.PREC)),
        [`?precision@${iosBase}QAEHH@Z`]: thiscall(8, ([ios, prec])=>{
            const old = u32(ios + IOS.PREC);
            setU32(ios + IOS.PREC, prec);
            return old;
        }),
        [`?width@${iosBase}QBEHXZ`]: thiscall(4, ([ios])=>u32(ios + IOS.WIDE)),
        [`?width@${iosBase}QAEHH@Z`]: thiscall(8, ([ios, width])=>{
            const old = u32(ios + IOS.WIDE);
            setU32(ios + IOS.WIDE, width);
            return old;
        }),
        [`?getloc@${iosBase}QBE?AVlocale@2@XZ`]: thiscall(8, ([ios, out])=>{
            setU32(out, incref(u32(ios + IOS.LOC)));
            return out;
        }),
        [`?imbue@${iosBase}QAE?AVlocale@2@ABV32@@Z`]: thiscall(12, ([ios, out, locale])=>{
            setU32(out, u32(ios + IOS.LOC));
            setU32(ios + IOS.LOC, incref(u32(locale)));
            return out;
        }),
        [`?copyfmt@${iosBase}QAEAAV12@ABV12@@Z`]: thiscall(8, ([ios, other])=>{
            if (ios !== other)
            {
                for (const field of [IOS.EXCEPT, IOS.FMTFL, IOS.PREC, IOS.WIDE])
                {
                    setU32(ios + field, u32(other + field));
                }
                const locale = incref(u32(other + IOS.LOC));
                decref(u32(ios + IOS.LOC));
                setU32(ios + IOS.LOC, locale);
                setState(ios, u32(ios + IOS.STATE));
            }
            return ios;
        }),
        [`?iword@${iosBase}QAEAAJH@Z`]: thiscall(8, ([ios, index])=>cellOf(ios, index | 0) + 8),
        [`?pword@${iosBase}QAEAAPAXH@Z`]: thiscall(8, ([ios, index])=>cellOf(ios, index | 0) + 12),
        [`?xalloc@${iosBase}SAHXZ`]: cdecl(0, ()=>nextIndex++),
        [`?_Init@${iosBase}IAEXXZ`]: thiscall(4, ([ios])=>(initIosBase(ios), 0)),
        [`?_Tidy@${iosBase}AAEXXZ`]: thiscall(4, ([ios])=>(tidyIosBase(ios), 0)),
        [`??0${iosBase}IAE@XZ`]: thiscall(4, ([ios])=>{
            setU32(ios, host.addressOf(`??_7${iosBase}6B@`));
            return ios;
        }),
        [`??1${iosBase}UAE@XZ`]: thiscall(4, ([ios])=>{
            tidyIosBase(ios);
            decref(u32(ios + IOS.LOC));
            setU32(ios + IOS.LOC, 0);
            return 0;
        }),
        [`??_E${iosBase}UAEPAXI@Z`]: thiscall(8, ([ios, flags])=>{
            tidyIosBase(ios);
            decref(u32(ios + IOS.LOC));
            if (flags & 1)
            {
                free(ios);
            }
            return ios;
        }),
        [`??_7${iosBase}6B@`]: { data: ()=>new Uint8Array(4),
            pointers: [{ at: 0, to: `??_E${iosBase}UAEPAXI@Z` }] },
        [`?sync_with_stdio@${iosBase}SA_N_N@Z`]: cdecl(4, ()=>1),
    });

    // locale and facet.
    const LOCALE = 'locale@std@@';
    const facet = `facet@${LOCALE}`;
    Object.assign(table, {
        [`??0${LOCALE}QAE@XZ`]: thiscall(4, ([self])=>(setU32(self, incref(globalImp())), self)),
        [`??0${LOCALE}QAE@ABV01@@Z`]: thiscall(8, ([self, other])=>
            (setU32(self, incref(u32(other))), self)),
        [`??0${LOCALE}QAE@PBDH@Z`]: thiscall(12, ([self, name])=>
            (setU32(self, locimpNamed(cString(name))), self)),
        // A locale made of another and a name for some categories: what
        // numbers read of it is the named one's.
        [`??0${LOCALE}QAE@ABV01@PBDH@Z`]: thiscall(16, ([self, , name])=>
            (setU32(self, locimpNamed(cString(name))), self)),
        [`??0${LOCALE}QAE@ABV01@0H@Z`]: thiscall(16, ([self, , other])=>
            (setU32(self, incref(u32(other))), self)),
        [`??0${LOCALE}QAE@W4_Uninitialized@1@@Z`]: thiscall(8, ([self])=>self),
        [`??1${LOCALE}QAE@XZ`]: thiscall(4, ([self])=>{
            decref(u32(self));
            return 0;
        }),
        [`??4${LOCALE}QAEAAV01@ABV01@@Z`]: thiscall(8, ([self, other])=>{
            if (u32(self) !== u32(other))
            {
                const imp = incref(u32(other));
                decref(u32(self));
                setU32(self, imp);
            }
            return self;
        }),
        [`??8${LOCALE}QBE_NABV01@@Z`]: thiscall(8, ([self, other])=>
            (sameLocale(self, other) ? 1 : 0)),
        [`??9${LOCALE}QBE_NABV01@@Z`]: thiscall(8, ([self, other])=>
            (sameLocale(self, other) ? 0 : 1)),
        [`?name@${LOCALE}QBE?AV?$basic_string@DU?$char_traits@D@std@@V?$allocator@D@2@@2@XZ`]:
            thiscall(8, ([self, out])=>{
                const imp = u32(self);
                strings[1].tidy(out);
                strings[1].assignElements(out, new TextEncoder().encode(
                    imp === 0 ? '' : cString(u32(imp + LOCIMP.NAME))));
                return out;
            }),
        [`?classic@${LOCALE}SAABV12@XZ`]: cdecl(0, ()=>host.addressOf(CLASSIC_LOCALE)),
        [`?global@${LOCALE}SA?AV12@ABV12@@Z`]: cdecl(8, ([out, other])=>{
            setU32(out, globalImp());
            global = incref(u32(other));
            setU32(host.addressOf(`?_Global@_Locimp@${LOCALE}0PAV123@A`), global);
            return out;
        }),
        // The classic locale's implementation, a facet that is never freed
        // (its count far from zero), named "C"; the locale object of it and
        // the two pointers the library exports at it.
        [CLASSIC_LOCIMP]: { data: ()=>{
            const bytes = new Uint8Array(LOCIMP.SIZE + 2);
            const view = new DataView(bytes.buffer);
            view.setUint32(LOCIMP.REFS, 0x40000000, true);
            view.setUint16(LOCIMP.DECIMAL, 0x2e, true);
            bytes[LOCIMP.SIZE] = 0x43;
            return bytes;
        }, pointers: [{ at: LOCIMP.VTABLE, to: `??_7${facet}6B@` },
            { at: LOCIMP.NAME, to: CLASSIC_LOCIMP, offset: LOCIMP.SIZE }] },
        [CLASSIC_LOCALE]: { data: ()=>new Uint8Array(4),
            pointers: [{ at: 0, to: CLASSIC_LOCIMP }] },
        [`?_Clocptr@_Locimp@${LOCALE}0PAV123@A`]: { data: ()=>new Uint8Array(4),
            pointers: [{ at: 0, to: CLASSIC_LOCIMP }] },
        [`?_Global@_Locimp@${LOCALE}0PAV123@A`]: { data: ()=>new Uint8Array(4),
            pointers: [{ at: 0, to: CLASSIC_LOCIMP }] },
        [`?_Iscloc@${LOCALE}QBE_NXZ`]: thiscall(4, ([self])=>(u32(self) === classicImp() ? 1 : 0)),
        [`??0${facet}IAE@I@Z`]: thiscall(8, ([self, refs])=>{
            setU32(self, host.addressOf(`??_7${facet}6B@`));
            setU32(self + 4, refs);
            return self;
        }),
        [`??1${facet}UAE@XZ`]: thiscall(4, ()=>0),
        [`?_Incref@${facet}QAEXXZ`]: thiscall(4, ([self])=>
            (setU32(self + 4, u32(self + 4) + 1), 0)),
        [`?_Decref@${facet}QAEPAV123@XZ`]: thiscall(4, ([self])=>{
            const refs = u32(self + 4);
            if (refs > 0)
            {
                setU32(self + 4, refs - 1);
            }
            return refs <= 1 ? self : 0;
        }),
        [`?_Getcat@${facet}SAIXZ`]: cdecl(0, ()=>0xffffffff),
        // A facet's deleting destructor, its vtable's only slot: a locale's
        // implementation is one too, with its name to give back.
        [`??_E${facet}UAEPAXI@Z`]: thiscall(8, ([self, flags])=>{
            if (self === classicImp())
            {
                return self;
            }
            if (flags & 1)
            {
                const name = u32(self + LOCIMP.NAME);
                if (name !== 0)
                {
                    crt.free.handler([name]);
                }
                crt.free.handler([self]);
            }
            return self;
        }),
        [`??_7${facet}6B@`]: { data: ()=>new Uint8Array(4),
            pointers: [{ at: 0, to: `??_E${facet}UAEPAXI@Z` }] },
    });
    /** Two locales are equal when they are one, or say the same. */
    function sameLocale(/** @type {number} */ self, /** @type {number} */ other){
        const a = u32(self);
        const b = u32(other);
        return a === b || a !== 0 && b !== 0 && cString(u32(a + LOCIMP.NAME))
            === cString(u32(b + LOCIMP.NAME));
    }

    for (const [unit, E, I] of /** @type {[1 | 2, 'D' | 'G', 'H' | 'G'][]} */ ([[1, 'D', 'H'],
        [2, 'G', 'G']]))
    {
        Object.assign(table, classesOf(unit, E, I));
    }

    return table;

    /**
     * Every class of one element.
     *
     * @param {1 | 2} unit @param {'D' | 'G'} E @param {'H' | 'G'} I  The int_type's code.
     */
    function classesOf(unit, E, I){
        const e = unit === 1 ? narrow : wide;
        const b = bufferOf[unit];
        const T = traitsOf(E);
        const IOSC = classOf('basic_ios', E, false);
        const SBC = classOf('basic_streambuf', E, false);
        const STRBC = classOf('basic_stringbuf', E, true);
        const FBC = classOf('basic_filebuf', E, false);
        const ISC = classOf('basic_istream', E, false);
        const OSC = classOf('basic_ostream', E, false);
        const STRING = `?$basic_string@${T}V?$allocator@${E}@2@@`;
        const FPOSN = '?AV?$fpos@H@2@';
        /** @type {Record<string, any>} */
        const out = {};

        // ---- basic_ios --------------------------------------------------

        /** basic_ios::init: ios_base's fields, the buffer, no tie, a space to fill with. */
        const initIos = (/** @type {number} */ ios, /** @type {number} */ buffer)=>{
            initIosBase(ios);
            setU32(ios + IOS.BUF, buffer);
            setU32(ios + IOS.TIE, 0);
            setU32(ios + IOS.FILL, 0x20);
            setU32(ios + IOS.STATE, buffer === 0 ? BADBIT : GOODBIT);
        };
        const destroyIos = (/** @type {number} */ ios)=>{
            tidyIosBase(ios);
            decref(u32(ios + IOS.LOC));
            setU32(ios + IOS.LOC, 0);
        };
        const fill = (/** @type {number} */ ios)=>(unit === 1 ? u32(ios + IOS.FILL) & 0xff
            : u32(ios + IOS.FILL) & 0xffff);
        /** basic_ios::imbue: the stream's locale and its buffer's, the old one answered. */
        /** @param {number} ios @param {number} answer @param {number} locale */
        const imbue = (ios, answer, locale)=>{
            setU32(answer, u32(ios + IOS.LOC));
            setU32(ios + IOS.LOC, incref(u32(locale)));
            const buffer = u32(ios + IOS.BUF);
            if (buffer !== 0)
            {
                const old = u32(buffer + SB.LOC);
                setU32(buffer + SB.LOC, incref(u32(locale)));
                decref(old);
            }
            return answer;
        };
        Object.assign(out, {
            [`??0${IOSC}IAE@XZ`]: thiscall(4, ([ios])=>{
                setU32(ios, host.addressOf(`??_7${IOSC}6B@`));
                return ios;
            }),
            [`??0${IOSC}QAE@PAV?$basic_streambuf@${T}@1@@Z`]: thiscall(8, ([ios, buffer])=>{
                setU32(ios, host.addressOf(`??_7${IOSC}6B@`));
                initIos(ios, buffer);
                return ios;
            }),
            [`??1${IOSC}UAE@XZ`]: thiscall(4, ([ios])=>(destroyIos(ios), 0)),
            [`??_E${IOSC}UAEPAXI@Z`]: thiscall(8, ([ios, flags])=>{
                destroyIos(ios);
                if (flags & 1)
                {
                    free(ios);
                }
                return ios;
            }),
            [`??_7${IOSC}6B@`]: { data: ()=>new Uint8Array(4),
                pointers: [{ at: 0, to: `??_E${IOSC}UAEPAXI@Z` }] },
            [`?init@${IOSC}IAEXPAV?$basic_streambuf@${T}@2@_N@Z`]: thiscall(12, ([ios, buffer])=>
                (initIos(ios, buffer), 0)),
            [`?rdbuf@${IOSC}QBEPAV?$basic_streambuf@${T}@2@XZ`]: thiscall(4, ([ios])=>
                u32(ios + IOS.BUF)),
            [`?rdbuf@${IOSC}QAEPAV?$basic_streambuf@${T}@2@PAV32@@Z`]: thiscall(8,
                ([ios, buffer])=>{
                    const old = u32(ios + IOS.BUF);
                    setU32(ios + IOS.BUF, buffer);
                    setState(ios, buffer === 0 ? BADBIT : GOODBIT);
                    return old;
                }),
            [`?tie@${IOSC}QBEPAV?$basic_ostream@${T}@2@XZ`]: thiscall(4, ([ios])=>
                u32(ios + IOS.TIE)),
            [`?tie@${IOSC}QAEPAV?$basic_ostream@${T}@2@PAV32@@Z`]: thiscall(8, ([ios, stream])=>{
                const old = u32(ios + IOS.TIE);
                setU32(ios + IOS.TIE, stream);
                return old;
            }),
            [`?fill@${IOSC}QBE${E}XZ`]: thiscall(4, ([ios])=>fill(ios)),
            [`?fill@${IOSC}QAE${E}${E}@Z`]: thiscall(8, ([ios, c])=>{
                const old = fill(ios);
                setU32(ios + IOS.FILL, e.of(c));
                return old;
            }),
            [`?imbue@${IOSC}QAE?AVlocale@2@ABV32@@Z`]: thiscall(12, ([ios, answer, locale])=>
                imbue(ios, answer, locale)),
            [`?clear@${IOSC}QAEXH_N@Z`]: thiscall(12, ([ios, state])=>
                (setState(ios, u32(ios + IOS.BUF) === 0 ? state | BADBIT : state), 0)),
            [`?clear@${IOSC}QAEXF@Z`]: thiscall(8, ([ios, state])=>
                (setState(ios, u32(ios + IOS.BUF) === 0 ? state | BADBIT : state & 0xffff), 0)),
            [`?setstate@${IOSC}QAEXH_N@Z`]: thiscall(12, ([ios, bits])=>(addState(ios, bits), 0)),
            [`?setstate@${IOSC}QAEXF@Z`]: thiscall(8, ([ios, bits])=>
                (addState(ios, bits & 0xffff), 0)),
            [`?copyfmt@${IOSC}QAEAAV12@ABV12@@Z`]: thiscall(8, ([ios, other])=>{
                table[`?copyfmt@${iosBase}QAEAAV12@ABV12@@Z`].handler([ios, other]);
                setU32(ios + IOS.TIE, u32(other + IOS.TIE));
                setU32(ios + IOS.FILL, u32(other + IOS.FILL));
                return ios;
            }),
            [`?widen@${IOSC}QBE${E}D@Z`]: thiscall(8, ([, c])=>c & 0xff),
            [`?narrow@${IOSC}QBED${E}D@Z`]: thiscall(12, ([, c, otherwise])=>
                (e.of(c) > 0xff ? otherwise & 0xff : c & 0xff)),
        });

        // ---- basic_streambuf ------------------------------------------------

        /** The streambuf's own construction: its vtable, its areas empty, the global locale. */
        const constructBuffer = (/** @type {number} */ buffer, /** @type {string} */ vtable)=>{
            setU32(buffer, host.addressOf(vtable));
            b.init(buffer);
            setU32(buffer + SB.LOC, incref(globalImp()));
        };
        const destroyBuffer = (/** @type {number} */ buffer)=>{
            decref(u32(buffer + SB.LOC));
            setU32(buffer + SB.LOC, 0);
        };
        /** The base's virtual functions: an empty buffer that holds nothing. */
        const baseVirtuals = {
            overflow: (/** @type {number} */ _buffer, /** @type {number} */ c)=>
                (e.isEof(c) ? 0 : e.eof),
            pbackfail: ()=>e.eof,
            showmanyc: ()=>0,
            underflow: ()=>e.eof,
            uflow: (/** @type {number} */ buffer)=>{
                const c = b.virt(buffer, 'underflow', [], e.eof);
                if (e.isEof(c))
                {
                    return e.eof;
                }
                b.gbump(buffer, 1);
                return c;
            },
            xsgetn: (/** @type {number} */ buffer, /** @type {number} */ to,
                /** @type {number} */ count)=>b.sgetn(buffer, to, count | 0),
            xsputn: (/** @type {number} */ buffer, /** @type {number} */ from,
                /** @type {number} */ count)=>b.sputn(buffer, from, count | 0),
            seekoff: (/** @type {number} */ _buffer, /** @type {number} */ answer)=>
                writeFpos(answer, BADOFF, 0n),
            seekpos: (/** @type {number} */ _buffer, /** @type {number} */ answer)=>
                writeFpos(answer, BADOFF, 0n),
            setbuf: (/** @type {number} */ buffer)=>buffer,
            sync: ()=>0,
            imbue: ()=>0,
        };
        /** Each virtual's argument bytes, `this` and a result's address counted. */
        const VIRTUAL_BYTES = { overflow: 8, pbackfail: 8, showmanyc: 4, underflow: 4, uflow: 4,
            xsgetn: 12, xsputn: 12, seekoff: 20, seekpos: 36, setbuf: 12, sync: 4, imbue: 8 };
        /** Each virtual's decorated tail after the class. */
        const VIRTUAL_TAILS = {
            overflow: `MAE${I}${I}@Z`, pbackfail: `MAE${I}${I}@Z`, showmanyc: 'MAEHXZ',
            underflow: `MAE${I}XZ`, uflow: `MAE${I}XZ`, xsgetn: `MAEHPA${E}H@Z`,
            xsputn: `MAEHPB${E}H@Z`, seekoff: `MAE${FPOSN}JW4seekdir@ios_base@2@H@Z`,
            seekpos: `MAE${FPOSN}V32@H@Z`, setbuf: null, sync: 'MAEHXZ',
            imbue: 'MAEXABVlocale@2@@Z',
        };
        /**
         * A buffer class's virtual functions: exported under its name where
         * it has its own, laid in its vtable whichever class's they are.
         *
         * @param {string} cls @param {string} vtable @param {Record<string, Function>} own
         * @param {string} setbufTail @param {(buffer: number) => void} destroy
         */
        const bufferClass = (cls, vtable, own, setbufTail, destroy)=>{
            const names = [`??_E${cls}UAEPAXI@Z`];
            out[names[0]] = thiscall(8, ([buffer, flags])=>{
                destroy(buffer);
                if (flags & 1)
                {
                    free(buffer);
                }
                return buffer;
            });
            for (const name of VIRTUALS)
            {
                const handler = own[name] ?? null;
                const owner = handler ? cls : SBC;
                const tail = name === 'setbuf' ? (handler ? setbufTail
                    : `MAEPAV12@PA${E}H@Z`) : VIRTUAL_TAILS[/** @type {keyof typeof VIRTUAL_TAILS} */ (name)];
                const exported = `?${name}@${owner}${tail}`;
                names.push(exported);
                if (handler)
                {
                    const call = /** @type {(b: number, ...args: number[]) => number} */ (handler);
                    virtualExports[unit].push({ name: exported, handler: call });
                    out[exported] = thiscall(VIRTUAL_BYTES[/** @type {keyof typeof VIRTUAL_BYTES} */ (name)],
                        args=>call(args[0], ...args.slice(1)));
                }
            }
            out[vtable] = { data: ()=>new Uint8Array(4 * names.length),
                pointers: names.map((to, index)=>({ at: 4 * index, to })) };
        };
        bufferClass(SBC, `??_7${SBC}6B@`, baseVirtuals, `MAEPAV12@PA${E}H@Z`, destroyBuffer);

        const sbPublic = {
            sgetc: [4, `QAE${I}XZ`, (/** @type {number[]} */ [x])=>b.sgetc(x)],
            sbumpc: [4, `QAE${I}XZ`, (/** @type {number[]} */ [x])=>b.sbumpc(x)],
            snextc: [4, `QAE${I}XZ`, (/** @type {number[]} */ [x])=>b.snextc(x)],
            sputc: [8, `QAE${I}${E}@Z`, (/** @type {number[]} */ [x, c])=>b.sputc(x, c)],
            sputbackc: [8, `QAE${I}${E}@Z`, (/** @type {number[]} */ [x, c])=>b.sputbackc(x, c)],
            sungetc: [4, `QAE${I}XZ`, (/** @type {number[]} */ [x])=>b.sungetc(x)],
            stossc: [4, 'QAEXXZ', (/** @type {number[]} */ [x])=>(b.sbumpc(x), 0)],
            sgetn: [12, `QAEHPA${E}H@Z`, (/** @type {number[]} */ [x, to, n])=>
                b.virt(x, 'xsgetn', [to, n], 0)],
            sputn: [12, `QAEHPB${E}H@Z`, (/** @type {number[]} */ [x, from, n])=>
                b.virt(x, 'xsputn', [from, n], 0)],
            in_avail: [4, 'QAEHXZ', (/** @type {number[]} */ [x])=>(b.gptr(x) !== 0 && b.gcount(x) > 0
                ? b.gcount(x) : b.virt(x, 'showmanyc', [], 0))],
            pubsync: [4, 'QAEHXZ', (/** @type {number[]} */ [x])=>b.pubsync(x)],
            eback: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.eback(x)],
            gptr: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.gptr(x)],
            egptr: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.egptr(x)],
            pbase: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.pbase(x)],
            pptr: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.pptr(x)],
            epptr: [4, `IBEPA${E}XZ`, (/** @type {number[]} */ [x])=>b.epptr(x)],
            gbump: [8, 'IAEXH@Z', (/** @type {number[]} */ [x, n])=>(b.gbump(x, n | 0), 0)],
            pbump: [8, 'IAEXH@Z', (/** @type {number[]} */ [x, n])=>(b.pbump(x, n | 0), 0)],
            _Gninc: [4, `IAEPA${E}XZ`, (/** @type {number[]} */ [x])=>{
                const at = b.gptr(x);
                b.gbump(x, 1);
                return at;
            }],
            _Gndec: [4, `IAEPA${E}XZ`, (/** @type {number[]} */ [x])=>{
                b.gbump(x, -1);
                return b.gptr(x);
            }],
            _Pninc: [4, `IAEPA${E}XZ`, (/** @type {number[]} */ [x])=>{
                const at = b.pptr(x);
                b.pbump(x, 1);
                return at;
            }],
        };
        for (const [name, [bytes, tail, handler]] of Object.entries(sbPublic))
        {
            out[`?${name}@${SBC}${tail}`] = thiscall(/** @type {number} */ (bytes),
                /** @type {(args: number[]) => any} */ (handler));
        }
        Object.assign(out, {
            [`?setg@${SBC}IAEXPA${E}00@Z`]: thiscall(16, ([x, first, next, last])=>
                (b.setg(x, first, next, last), 0)),
            [`?setp@${SBC}IAEXPA${E}0@Z`]: thiscall(12, ([x, first, last])=>
                (b.setp(x, first, first, last), 0)),
            [`?setp@${SBC}IAEXPA${E}00@Z`]: thiscall(16, ([x, first, next, last])=>
                (b.setp(x, first, next, last), 0)),
            [`?_Init@${SBC}IAEXXZ`]: thiscall(4, ([x])=>(b.init(x), 0)),
            [`?_Init@${SBC}IAEXPAPA${E}0PAH001@Z`]: thiscall(28,
                ([x, gfirst, gnext, gcount, pfirst, pnext, pcount])=>{
                    setU32(x + SB.PRBUF, gfirst);
                    setU32(x + SB.PRPOS, gnext);
                    setU32(x + SB.PRSIZE, gcount);
                    setU32(x + SB.PWBUF, pfirst);
                    setU32(x + SB.PWPOS, pnext);
                    setU32(x + SB.PWSIZE, pcount);
                    return 0;
                }),
            [`??0${SBC}IAE@XZ`]: thiscall(4, ([x])=>(constructBuffer(x, `??_7${SBC}6B@`), x)),
            [`??0${SBC}IAE@W4_Uninitialized@1@@Z`]: thiscall(8, ([x])=>x),
            [`??1${SBC}UAE@XZ`]: thiscall(4, ([x])=>(destroyBuffer(x), 0)),
            [`?getloc@${SBC}QAE?AVlocale@2@XZ`]: thiscall(8, ([x, answer])=>
                (setU32(answer, incref(u32(x + SB.LOC))), answer)),
            [`?pubimbue@${SBC}QAE?AVlocale@2@ABV32@@Z`]: thiscall(12, ([x, answer, locale])=>{
                b.virt(x, 'imbue', [locale], 0);
                setU32(answer, u32(x + SB.LOC));
                setU32(x + SB.LOC, incref(u32(locale)));
                return answer;
            }),
            [`?pubseekoff@${SBC}QAE${FPOSN}JW4seekdir@ios_base@2@H@Z`]: thiscall(20,
                ([x, answer, off, way, which])=>{
                    const at = b.pubseekoff(x, off | 0, way, which);
                    return writeFpos(answer, at.off, at.pos);
                }),
            [`?pubseekoff@${SBC}QAE${FPOSN}JFF@Z`]: thiscall(20, ([x, answer, off, way, which])=>{
                const at = b.pubseekoff(x, off | 0, way & 0xffff, which & 0xffff);
                return writeFpos(answer, at.off, at.pos);
            }),
            [`?pubseekpos@${SBC}QAE${FPOSN}V32@H@Z`]: thiscall(36, ([x, answer, ...rest])=>{
                const at = b.pubseekpos(x, fposOf(rest), rest[6]);
                return writeFpos(answer, at.off, at.pos);
            }),
            [`?pubseekpos@${SBC}QAE${FPOSN}V32@F@Z`]: thiscall(36, ([x, answer, ...rest])=>{
                const at = b.pubseekpos(x, fposOf(rest), rest[6] & 0xffff);
                return writeFpos(answer, at.off, at.pos);
            }),
            [`?pubsetbuf@${SBC}QAEPAV12@PA${E}H@Z`]: thiscall(12, ([x, at, n])=>
                b.virt(x, 'setbuf', [at, n], 0)),
        });

        // ---- basic_stringbuf --------------------------------------------------

        /** _Getstate: what a mode says the buffer may not do. @param {number} mode */
        const stateOf = mode=>(mode & IN ? 0 : NOREAD) | (mode & OUT ? 0 : CONSTANT);
        /** The storage a stringbuf holds, the start of whichever area has it. */
        const storageOf = (/** @type {number} */ x)=>(b.eback(x) !== 0 ? b.eback(x) : b.pbase(x));
        /**
         * _Init: the text copied into storage of its own, readable unless the
         * mode forbids it, writable from its start unless it may not change.
         *
         * @param {number} x @param {Uint8Array} text @param {number} state
         */
        const initString = (x, text, state)=>{
            const count = text.length / unit;
            setU32(x + STRBUF.PENDSAVE, 0);
            setU32(x + STRBUF.SEEKHIGH, 0);
            setU32(x + STRBUF.ALSIZE, MINSIZE);
            setU32(x + STRBUF.STATE, state);
            if (count !== 0 && (state & (NOREAD | CONSTANT)) !== (NOREAD | CONSTANT))
            {
                const at = allocate(count * unit);
                host.writeMemory(at, text);
                const end = at + count * unit;
                setU32(x + STRBUF.SEEKHIGH, end);
                if (!(state & NOREAD))
                {
                    b.setg(x, at, at, end);
                }
                if (!(state & CONSTANT))
                {
                    b.setp(x, at, at, end);
                    if (b.gptr(x) === 0)
                    {
                        b.setg(x, at, at, at);
                    }
                }
                setU32(x + STRBUF.STATE, state | ALLOCATED);
            }
        };
        /** _Tidy: the storage given back, both areas empty. @param {number} x */
        const tidyString = x=>{
            if (u32(x + STRBUF.STATE) & ALLOCATED)
            {
                const at = storageOf(x);
                if (at !== 0)
                {
                    free(at);
                }
            }
            b.setg(x, 0, 0, 0);
            b.setp(x, 0, 0, 0);
            setU32(x + STRBUF.SEEKHIGH, 0);
            setU32(x + STRBUF.STATE, u32(x + STRBUF.STATE) & ~ALLOCATED);
        };
        /** The text a stringbuf holds: what was written, else what can be read. */
        const textOf = (/** @type {number} */ x)=>{
            const state = u32(x + STRBUF.STATE);
            if (!(state & CONSTANT) && b.pptr(x) !== 0)
            {
                const end = Math.max(b.pptr(x), u32(x + STRBUF.SEEKHIGH));
                return host.readMemory(b.pbase(x), end - b.pbase(x)).slice();
            }
            if (!(state & NOREAD) && b.gptr(x) !== 0)
            {
                return host.readMemory(b.eback(x), b.egptr(x) - b.eback(x)).slice();
            }
            return new Uint8Array(0);
        };
        const stringVirtuals = {
            overflow: (/** @type {number} */ x, /** @type {number} */ c)=>{
                if (e.isEof(c))
                {
                    return 0;
                }
                if (b.pptr(x) !== 0 && b.pcount(x) > 0)
                {
                    e.put(b.pptr(x), c);
                    b.pbump(x, 1);
                    return e.of(c);
                }
                const state = u32(x + STRBUF.STATE);
                if (state & CONSTANT)
                {
                    return e.eof;
                }
                const first = b.eback(x) !== 0 ? b.eback(x) : b.pbase(x);
                const old = b.pptr(x) === 0 ? 0 : (b.epptr(x) - first) / unit;
                const grown = old + Math.max(u32(x + STRBUF.ALSIZE), MINSIZE);
                const at = allocate(grown * unit);
                if (old !== 0)
                {
                    host.writeMemory(at, host.readMemory(first, old * unit).slice());
                }
                const moved = (/** @type {number} */ p)=>at + (p - first);
                if (old === 0)
                {
                    setU32(x + STRBUF.SEEKHIGH, at);
                    b.setp(x, at, at, at + grown * unit);
                    b.setg(x, at, at, at);
                }
                else
                {
                    setU32(x + STRBUF.SEEKHIGH, moved(u32(x + STRBUF.SEEKHIGH)));
                    const gnext = moved(b.gptr(x));
                    const pnext = moved(b.pptr(x));
                    b.setp(x, moved(b.pbase(x)), pnext, at + grown * unit);
                    b.setg(x, at, state & NOREAD ? at : gnext, state & NOREAD ? at : pnext + unit);
                }
                if (state & ALLOCATED && first !== 0)
                {
                    free(first);
                }
                setU32(x + STRBUF.STATE, state | ALLOCATED);
                e.put(b.pptr(x), c);
                b.pbump(x, 1);
                return e.of(c);
            },
            pbackfail: (/** @type {number} */ x, /** @type {number} */ c)=>{
                if (b.gptr(x) === 0 || b.gptr(x) <= b.eback(x) || !e.isEof(c)
                    && e.of(c) !== e.get(b.gptr(x) - unit) && u32(x + STRBUF.STATE) & CONSTANT)
                {
                    return e.eof;
                }
                b.gbump(x, -1);
                if (!e.isEof(c))
                {
                    e.put(b.gptr(x), c);
                }
                return e.isEof(c) ? 0 : e.of(c);
            },
            underflow: (/** @type {number} */ x)=>{
                if (b.gptr(x) === 0)
                {
                    return e.eof;
                }
                if (b.gcount(x) > 0)
                {
                    return e.get(b.gptr(x));
                }
                const seekhigh = u32(x + STRBUF.SEEKHIGH);
                if (u32(x + STRBUF.STATE) & NOREAD || b.pptr(x) === 0
                    || b.pptr(x) <= b.gptr(x) && seekhigh <= b.gptr(x))
                {
                    return e.eof;
                }
                const high = Math.max(seekhigh, b.pptr(x));
                setU32(x + STRBUF.SEEKHIGH, high);
                b.setg(x, b.eback(x), b.gptr(x), high);
                return e.get(b.gptr(x));
            },
            /**
             * @param {number} x
             * @param {number} answer
             * @param {number} offArg
             * @param {number} way
             * @param {number} which
             */
            seekoff: (x, answer, offArg, way, which)=>{
                let off = offArg | 0;
                if (b.pptr(x) !== 0 && u32(x + STRBUF.SEEKHIGH) < b.pptr(x))
                {
                    setU32(x + STRBUF.SEEKHIGH, b.pptr(x));
                }
                const high = u32(x + STRBUF.SEEKHIGH);
                if (which & IN && b.gptr(x) !== 0)
                {
                    const first = b.eback(x);
                    off = way === END ? off + (high - first) / unit
                        : way === CUR && !(which & OUT) ? off + (b.gptr(x) - first) / unit
                            : way === BEG ? off : BADOFF;
                    if (off !== BADOFF && off >= 0 && off <= (high - first) / unit)
                    {
                        b.gbump(x, (first - b.gptr(x)) / unit + off);
                        if (which & OUT && b.pptr(x) !== 0)
                        {
                            b.setp(x, b.pbase(x), b.gptr(x), b.epptr(x));
                        }
                    }
                    else
                    {
                        off = BADOFF;
                    }
                }
                else if (which & OUT && b.pptr(x) !== 0)
                {
                    const first = b.pbase(x);
                    off = way === END ? off + (high - first) / unit
                        : way === CUR ? off + (b.pptr(x) - first) / unit
                            : way === BEG ? off : BADOFF;
                    if (off !== BADOFF && off >= 0 && off <= (high - first) / unit)
                    {
                        b.pbump(x, (first - b.pptr(x)) / unit + off);
                    }
                    else
                    {
                        off = BADOFF;
                    }
                }
                else
                {
                    off = BADOFF;
                }
                return writeFpos(answer, off, 0n);
            },
            /** @param {number} x @param {number} answer @param {number[]} rest */
            seekpos: (x, answer, ...rest)=>{
                const off = offsetOf(fposOf(rest));
                return stringVirtuals.seekoff(x, answer, off, BEG, rest[6]);
            },
        };
        const destroyString = (/** @type {number} */ x)=>{
            tidyString(x);
            destroyBuffer(x);
        };
        bufferClass(STRBC, `??_7${STRBC}6B@`, stringVirtuals, '', destroyString);
        /** A stringbuf made with a mode and a text. */
        /** @param {number} x @param {Uint8Array} text @param {number} mode */
        const constructString = (x, text, mode)=>{
            constructBuffer(x, `??_7${STRBC}6B@`);
            initString(x, text, stateOf(mode));
            return x;
        };
        /** str(): a new string of the text, made in the caller's result. */
        const strOf = (/** @type {number} */ x, /** @type {number} */ answer)=>{
            strings[unit].tidy(answer);
            strings[unit].assignElements(answer, textOf(x));
            return answer;
        };
        /** str(s): the buffer's text replaced, its mode kept. */
        const setStr = (/** @type {number} */ x, /** @type {number} */ text)=>{
            const state = u32(x + STRBUF.STATE) & ~ALLOCATED;
            tidyString(x);
            initString(x, strings[unit].whole(text), state);
            return 0;
        };
        Object.assign(out, {
            [`??0${STRBC}QAE@H@Z`]: thiscall(8, ([x, mode])=>
                constructString(x, new Uint8Array(0), mode)),
            [`??0${STRBC}QAE@ABV${STRING}1@H@Z`]: thiscall(12, ([x, text, mode])=>
                constructString(x, strings[unit].whole(text), mode)),
            [`??1${STRBC}UAE@XZ`]: thiscall(4, ([x])=>(destroyString(x), 0)),
            [`?str@${STRBC}QBE?AV${STRING}2@XZ`]: thiscall(8, ([x, answer])=>strOf(x, answer)),
            [`?str@${STRBC}QAEXABV${STRING}2@@Z`]: thiscall(8, ([x, text])=>setStr(x, text)),
            [`?_Init@${STRBC}IAEXPB${E}IH@Z`]: thiscall(16, ([x, at, count, state])=>{
                initString(x, (count >>> 0) === 0 ? new Uint8Array(0)
                    : host.readMemory(at, (count >>> 0) * unit).slice(), state);
                return 0;
            }),
            [`?_Tidy@${STRBC}IAEXXZ`]: thiscall(4, ([x])=>(tidyString(x), 0)),
            [`?_Mode@${STRBC}AAEHH@Z`]: thiscall(8, ([, mode])=>stateOf(mode)),
        });

        // ---- basic_filebuf -----------------------------------------------------

        /** A FILE function of the runtime, which must answer at once. @param {string} name @param {number[]} args */
        const file = (name, args)=>{
            const answer = crt[name].handler(args);
            if (answer instanceof Promise)
            {
                loss(`basic_filebuf (${name})`,
                    'the file did not answer at once: read as an error');
                return -1;
            }
            return answer | 0;
        };
        /** @type {Map<number, number> | null} */
        let standardAt = null;
        /**
         * A filebuf's FILE. A standard stream's buffer is static, made before
         * the runtime's streams have a place: it takes stdin, stdout or
         * stderr at its first use.
         *
         * @param {number} x
         */
        const fileOf = x=>{
            const fp = u32(x + FILEBUF.FILE);
            if (fp !== 0)
            {
                return fp;
            }
            standardAt ??= new Map(STANDARD.map(({ name, file: index })=>
                [host.addressOf(standardBufferOf(name, E)), index]));
            const index = standardAt.get(x);
            if (index === undefined)
            {
                return 0;
            }
            const iob = crt.__iob_func.handler([]) >>> 0;
            if (iob === 0)
            {
                loss('basic_filebuf', 'a standard stream with no C runtime placed: its file is not '
                    + 'there, so it reads and writes nothing');
                return 0;
            }
            const at = iob + index * FILE_SIZE;
            setU32(x + FILEBUF.FILE, at);
            return at;
        };
        /** One element read from the file: a byte, a wide element of one byte. */
        const getFile = (/** @type {number} */ x)=>{
            const c = file('fgetc', [fileOf(x)]);
            return c === -1 ? e.eof : c & 0xff;
        };
        /** One element written: a wide one past a byte cannot be in the file. */
        const putFile = (/** @type {number} */ x, /** @type {number} */ c)=>{
            if (e.of(c) > 0xff)
            {
                loss('basic_filebuf<wchar_t>::overflow',
                    'a character past one byte: written as its low byte');
            }
            return file('fputc', [c & 0xff, fileOf(x)]) === -1 ? e.eof : e.of(c);
        };
        /** _Init: the file, nothing to convert, its own areas empty. */
        const initFile = (/** @type {number} */ x, /** @type {number} */ fp, /** @type {boolean} */ owned)=>{
            b.init(x);
            setU32(x + FILEBUF.CVT, 0);
            setU32(x + FILEBUF.STATE0, 0);
            setU32(x + FILEBUF.STATE, 0);
            setU32(x + FILEBUF.STR, 0);
            setU32(x + FILEBUF.CLOSE, owned ? 1 : 0);
            setU32(x + FILEBUF.LOC, 0);
            setU32(x + FILEBUF.FILE, fp);
        };
        /** close(): the file closed if the buffer opened it. */
        const closeFile = (/** @type {number} */ x)=>{
            const fp = fileOf(x);
            if (fp === 0)
            {
                return 0;
            }
            const owned = (u32(x + FILEBUF.CLOSE) & 0xff) !== 0;
            const closed = owned ? file('fclose', [fp]) === 0 : true;
            initFile(x, 0, false);
            return closed ? x : 0;
        };
        /** A position as a buffer answers it: no offset, the file's position. */
        const filePosition = (/** @type {number} */ x, /** @type {number} */ answer)=>{
            const at = allocate(8);
            try
            {
                if (file('fgetpos', [fileOf(x), at]) !== 0)
                {
                    return writeFpos(answer, BADOFF, 0n);
                }
                const pos = new DataView(host.readMemory(at, 8).slice().buffer)
                    .getBigInt64(0, true);
                return writeFpos(answer, 0, pos);
            }
            finally
            {
                free(at);
            }
        };
        const fileVirtuals = {
            overflow: (/** @type {number} */ x, /** @type {number} */ c)=>{
                if (e.isEof(c))
                {
                    return 0;
                }
                return fileOf(x) === 0 ? e.eof : putFile(x, c);
            },
            pbackfail: (/** @type {number} */ x, /** @type {number} */ c)=>{
                if (fileOf(x) === 0 || e.isEof(c))
                {
                    return e.eof;
                }
                return file('ungetc', [c & 0xff, fileOf(x)]) === -1 ? e.eof : e.of(c);
            },
            underflow: (/** @type {number} */ x)=>{
                if (fileOf(x) === 0)
                {
                    return e.eof;
                }
                const c = getFile(x);
                if (!e.isEof(c))
                {
                    file('ungetc', [c, fileOf(x)]);
                }
                return c;
            },
            uflow: (/** @type {number} */ x)=>(fileOf(x) === 0 ? e.eof : getFile(x)),
            /** @param {number} x @param {number} answer @param {number} off @param {number} way */
            seekoff: (x, answer, off, way)=>{
                if (fileOf(x) === 0 || file('fseek', [fileOf(x), off | 0, way]) !== 0)
                {
                    return writeFpos(answer, BADOFF, 0n);
                }
                return filePosition(x, answer);
            },
            /** @param {number} x @param {number} answer @param {number[]} rest */
            seekpos: (x, answer, ...rest)=>{
                const at = fposOf(rest);
                if (fileOf(x) === 0)
                {
                    return writeFpos(answer, BADOFF, 0n);
                }
                const scratch = allocate(8);
                try
                {
                    const bytes = new Uint8Array(8);
                    new DataView(bytes.buffer).setBigInt64(0, at.pos, true);
                    host.writeMemory(scratch, bytes);
                    if (file('fsetpos', [fileOf(x), scratch]) !== 0
                        || at.off !== 0 && file('fseek', [fileOf(x), at.off, CUR]) !== 0)
                    {
                        return writeFpos(answer, BADOFF, 0n);
                    }
                }
                finally
                {
                    free(scratch);
                }
                return filePosition(x, answer);
            },
            setbuf: (/** @type {number} */ x, /** @type {number} */ at, /** @type {number} */ n)=>{
                if (fileOf(x) === 0 || file('setvbuf', [fileOf(x), at, at === 0 && n === 0 ? 4 : 0,
                    n * unit]) !== 0)
                {
                    return 0;
                }
                return x;
            },
            sync: (/** @type {number} */ x)=>(fileOf(x) === 0 || file('fflush', [fileOf(x)]) === 0 ? 0 : -1),
        };
        const destroyFile = (/** @type {number} */ x)=>{
            closeFile(x);
            destroyBuffer(x);
        };
        bufferClass(FBC, `??_7${FBC}6B@`, fileVirtuals,
            `MAEPAV?$basic_streambuf@${T}@2@PA${E}H@Z`, destroyFile);
        /** open(name, mode): the C library's file for the mode, at its end for ate. */
        const openFile = (/** @type {number} */ x, /** @type {number} */ name, /** @type {number} */ modeArg)=>{
            const mode = modeArg & 0xff;
            const fopenMode = FOPEN_MODES.get(mode & ~(ATE | BINARY));
            if (fileOf(x) !== 0 || fopenMode === undefined)
            {
                return 0;
            }
            const modeText = heapString(mode & BINARY ? `${fopenMode}b` : fopenMode);
            const fp = file('fopen', [name, modeText]) >>> 0;
            crt.free.handler([modeText]);
            if (fp === 0)
            {
                return 0;
            }
            initFile(x, fp, true);
            if (mode & ATE && file('fseek', [fp, 0, END]) !== 0)
            {
                closeFile(x);
                return 0;
            }
            return x;
        };
        const constructFile = (/** @type {number} */ x, /** @type {number} */ fp)=>{
            constructBuffer(x, `??_7${FBC}6B@`);
            initFile(x, fp, false);
            return x;
        };
        Object.assign(out, {
            [`??0${FBC}QAE@PAU_iobuf@@@Z`]: thiscall(8, ([x, fp])=>constructFile(x, fp)),
            [`??0${FBC}QAE@W4_Uninitialized@1@@Z`]: thiscall(8, ([x])=>x),
            [`??1${FBC}UAE@XZ`]: thiscall(4, ([x])=>(destroyFile(x), 0)),
            [`?open@${FBC}QAEPAV12@PBDH@Z`]: thiscall(12, ([x, name, mode])=>
                openFile(x, name, mode)),
            [`?open@${FBC}QAEPAV12@PBDF@Z`]: thiscall(12, ([x, name, mode])=>
                openFile(x, name, mode)),
            [`?close@${FBC}QAEPAV12@XZ`]: thiscall(4, ([x])=>closeFile(x)),
            [`?is_open@${FBC}QBE_NXZ`]: thiscall(4, ([x])=>(fileOf(x) !== 0 ? 1 : 0)),
            [`?_Init@${FBC}IAEXPAU_iobuf@@W4_Initfl@12@@Z`]: thiscall(12, ([x, fp, how])=>
                (initFile(x, fp, how === 1), 0)),
            [`?_Initcvt@${FBC}IAEXXZ`]: thiscall(4, ()=>0),
        });

        // ---- istream and ostream ------------------------------------------------

        /** The basic_ios of a stream part, through the part's vbtable. @param {number} part */
        const iosOf = part=>(part + i32(u32(part) + 4)) >>> 0;
        const bufOf = (/** @type {number} */ ios)=>u32(ios + IOS.BUF);
        /** C's white space, which skipws skips. @param {number} c */
        const isSpace = c=>c === 0x20 || c >= 0x09 && c <= 0x0d;

        /**
         * ipfx: the stream good, its tie flushed, white space skipped unless
         * asked not to; at the end of the stream that skipping does not set
         * eofbit, as this library's does not.
         *
         * @param {number} part @param {boolean} noskip
         */
        const ipfx = (part, noskip)=>{
            const ios = iosOf(part);
            if (!good(ios))
            {
                addState(ios, FAILBIT);
                return false;
            }
            const tie = u32(ios + IOS.TIE);
            if (tie !== 0)
            {
                flush(tie);
            }
            if (!noskip && u32(ios + IOS.FMTFL) & F.skipws)
            {
                const buffer = bufOf(ios);
                for (let c = b.sgetc(buffer); !e.isEof(c) && isSpace(c); c = b.snextc(buffer))
                {
                    // Skipped.
                }
            }
            return true;
        };
        /** flush: the buffer synced, badbit when it fails. @param {number} part */
        function flush(part){
            const ios = iosOf(part);
            const buffer = bufOf(ios);
            if (buffer !== 0 && b.pubsync(buffer) === -1)
            {
                addState(ios, BADBIT);
            }
            return part;
        }
        /** opfx: the stream good and its tie flushed. @param {number} part */
        const opfx = part=>{
            const ios = iosOf(part);
            if (!good(ios))
            {
                addState(ios, FAILBIT);
                return false;
            }
            const tie = u32(ios + IOS.TIE);
            if (tie !== 0 && tie !== part)
            {
                flush(tie);
            }
            return true;
        };
        /** osfx: unitbuf flushes after each output. @param {number} part */
        const osfx = part=>{
            const ios = iosOf(part);
            if (good(ios) && u32(ios + IOS.FMTFL) & F.unitbuf)
            {
                flush(part);
            }
        };
        const setCount = (/** @type {number} */ part, /** @type {number} */ n)=>setU32(part + 4, n);

        /**
         * The characters of a number as the facet reads them: a sign, the
         * digits, a decimal point (the locale's) and more digits, an exponent
         * letter, its sign and digits; or for an integer a sign and the
         * digits of its base, after a 0x the base allows. What stops it stays
         * in the stream; reaching the end sets eofbit.
         *
         * @param {number} ios @param {boolean} floating
         * @returns {{ text: string, state: number, valid: boolean, base: number }}
         */
        const collect = (ios, floating)=>{
            const buffer = bufOf(ios);
            const flags = u32(ios + IOS.FMTFL);
            const point = decimalOf(u32(ios + IOS.LOC));
            let state = 0;
            let text = '';
            let c = b.sgetc(buffer);
            const next = ()=>{
                c = b.snextc(buffer);
            };
            const take = (/** @type {string} */ ch)=>{
                text += ch;
                next();
            };
            const at = ()=>(e.isEof(c) ? '' : String.fromCharCode(c));
            if (at() === '+' || at() === '-')
            {
                take(at());
            }
            let base = 10;
            let digits = 0;
            let valid = true;
            if (floating)
            {
                while (/[0-9]/.test(at()))
                {
                    take(at());
                    digits++;
                }
                if (!e.isEof(c) && c === point)
                {
                    take('.');
                    while (/[0-9]/.test(at()))
                    {
                        take(at());
                        digits++;
                    }
                }
                if (digits > 0 && (at() === 'e' || at() === 'E'))
                {
                    take('e');
                    if (at() === '+' || at() === '-')
                    {
                        take(at());
                    }
                    let exponent = 0;
                    while (/[0-9]/.test(at()))
                    {
                        take(at());
                        exponent++;
                    }
                    valid = exponent > 0;
                }
                valid &&= digits > 0;
            }
            else
            {
                const field = flags & F.basefield;
                base = field === F.oct ? 8 : field === F.hex ? 16 : field === 0 ? 0 : 10;
                if ((base === 16 || base === 0) && at() === '0')
                {
                    take('0');
                    digits++;
                    if (at() === 'x' || at() === 'X')
                    {
                        text = text.slice(0, -1);
                        digits--;
                        take('');
                        base = 16;
                    }
                    else if (base === 0)
                    {
                        base = 8;
                    }
                }
                if (base === 0)
                {
                    base = 10;
                }
                const pattern = base === 16 ? /[0-9a-fA-F]/ : base === 8 ? /[0-7]/ : /[0-9]/;
                while (pattern.test(at()))
                {
                    take(at());
                    digits++;
                }
                valid = digits > 0;
            }
            if (e.isEof(c))
            {
                state |= EOFBIT;
            }
            return { text, state, valid, base };
        };

        /**
         * operator>> of a number: read, checked against its type's range,
         * stored only when it is one.
         *
         * @param {number} part @param {number} to
         * @param {'short' | 'ushort' | 'int' | 'uint' | 'float' | 'double' | 'int64' | 'uint64'
         *     | 'bool' | 'pointer'} type
         */
        const readNumber = (part, to, type)=>{
            const ios = iosOf(part);
            if (!ipfx(part, false))
            {
                return part;
            }
            const floating = type === 'float' || type === 'double';
            if (type === 'bool' && u32(ios + IOS.FMTFL) & F.boolalpha)
            {
                return readBoolName(part, to);
            }
            const saved = u32(ios + IOS.FMTFL);
            if (type === 'pointer')
            {
                setU32(ios + IOS.FMTFL, saved & ~F.basefield | F.hex);
            }
            const { text, state: found, valid, base } = collect(ios, floating);
            setU32(ios + IOS.FMTFL, saved);
            let state = found;
            if (!valid)
            {
                addState(ios, state | FAILBIT);
                return part;
            }
            if (floating)
            {
                const value = Number(text);
                const mantissa = text.replace(/e.*$/, '');
                const underflow = value === 0 && /[1-9]/.test(mantissa);
                const range = type === 'float' ? Math.abs(Math.fround(value)) === Infinity
                    : !Number.isFinite(value);
                if (range || underflow)
                {
                    addState(ios, state | FAILBIT);
                    return part;
                }
                if (type === 'float')
                {
                    const view = new DataView(new ArrayBuffer(4));
                    view.setFloat32(0, value, true);
                    host.writeMemory(to, new Uint8Array(view.buffer));
                }
                else
                {
                    const view = new DataView(new ArrayBuffer(8));
                    view.setFloat64(0, value, true);
                    host.writeMemory(to, new Uint8Array(view.buffer));
                }
                addState(ios, state);
                return part;
            }
            const negative = text.startsWith('-');
            const magnitude = BigInt(`${base === 16 ? '0x' : base === 8 ? '0o' : ''}${text.replace(/^[+-]/, '') || '0'}`);
            const value = negative ? -magnitude : magnitude;
            const [low, high, bytes] = RANGES[type];
            if (value < low || value > high)
            {
                state |= FAILBIT;
            }
            else
            {
                const bits = BigInt.asUintN(64, value);
                const out8 = new Uint8Array(8);
                new DataView(out8.buffer).setBigUint64(0, bits, true);
                host.writeMemory(to, out8.subarray(0, bytes));
            }
            addState(ios, state);
            return part;
        };
        /** A bool as its name, with boolalpha: "true" or "false" whole. */
        const readBoolName = (/** @type {number} */ part, /** @type {number} */ to)=>{
            const ios = iosOf(part);
            const buffer = bufOf(ios);
            let text = '';
            let c = b.sgetc(buffer);
            while (!e.isEof(c) && ('true'.startsWith(text + String.fromCharCode(c))
                || 'false'.startsWith(text + String.fromCharCode(c))))
            {
                text += String.fromCharCode(c);
                c = b.snextc(buffer);
                if (text === 'true' || text === 'false')
                {
                    break;
                }
            }
            let state = e.isEof(c) ? EOFBIT : 0;
            if (text === 'true' || text === 'false')
            {
                host.writeMemory(to, Uint8Array.of(text === 'true' ? 1 : 0));
            }
            else
            {
                state |= FAILBIT;
            }
            addState(ios, state);
            return part;
        };

        /**
         * Text put through the stream's buffer, padded to the width with the
         * fill where adjustfield says, the width then zero; badbit when the
         * buffer refuses.
         *
         * @param {number} part @param {string} text @param {number} [split]
         *        Where internal padding goes: after a sign or a base's prefix.
         */
        const putText = (part, text, split = 0)=>{
            const ios = iosOf(part);
            if (!opfx(part))
            {
                return part;
            }
            const buffer = bufOf(ios);
            const width = i32(ios + IOS.WIDE);
            const pad = Math.max(0, width - text.length);
            const adjust = u32(ios + IOS.FMTFL) & F.adjustfield;
            const filler = fill(ios);
            /** @type {number[]} */
            const units = [];
            const chars = (/** @type {string} */ s)=>{
                for (let i = 0; i < s.length; i++)
                {
                    units.push(s.charCodeAt(i));
                }
            };
            const padding = ()=>{
                for (let i = 0; i < pad; i++)
                {
                    units.push(filler);
                }
            };
            if (adjust === F.left)
            {
                chars(text);
                padding();
            }
            else if (adjust === F.internal)
            {
                chars(text.slice(0, split));
                padding();
                chars(text.slice(split));
            }
            else
            {
                padding();
                chars(text);
            }
            setU32(ios + IOS.WIDE, 0);
            for (const c of units)
            {
                if (e.isEof(b.sputc(buffer, c)))
                {
                    addState(ios, BADBIT);
                    break;
                }
            }
            osfx(part);
            return part;
        };

        /**
         * A floating number as the facet writes it: printf's %g, %e or %f of
         * the precision (0 meaning 6 except for fixed), the exponent of at
         * least three digits as this runtime prints it, the locale's point.
         *
         * @param {number} ios @param {number} value
         */
        const formatFloating = (ios, value)=>{
            const flags = u32(ios + IOS.FMTFL);
            const field = flags & F.floatfield;
            let prec = i32(ios + IOS.PREC);
            if (prec <= 0 && field !== F.fixed)
            {
                prec = 6;
            }
            prec = Math.min(Math.max(prec, 0), 100);
            const sign = value < 0 || Object.is(value, -0) ? '-' : flags & F.showpos ? '+' : '';
            const abs = Math.abs(value);
            const exponential = (/** @type {number} */ digits)=>{
                const [mantissa, exponent] = abs.toExponential(digits).split('e');
                const power = Number(exponent);
                const places = String(Math.abs(power)).padStart(3, '0');
                return `${mantissa}e${power < 0 ? '-' : '+'}${places}`;
            };
            let text;
            if (!Number.isFinite(abs))
            {
                text = Number.isNaN(abs) ? '1.#QNAN' : '1.#INF';
            }
            else if (field === F.fixed)
            {
                text = abs.toFixed(prec);
                if (flags & F.showpoint && prec === 0)
                {
                    text += '.';
                }
            }
            else if (field === F.scientific)
            {
                text = exponential(prec);
            }
            else
            {
                const p = prec === 0 ? 1 : prec;
                const power = abs === 0 ? 0 : Number(abs.toExponential(p - 1).split('e')[1]);
                if (power < -4 || power >= p)
                {
                    text = exponential(p - 1);
                    if (!(flags & F.showpoint))
                    {
                        text = text.replace(/\.?0+e/, 'e');
                    }
                }
                else
                {
                    text = abs.toFixed(Math.max(0, p - 1 - power));
                    if (!(flags & F.showpoint) && text.includes('.'))
                    {
                        text = text.replace(/\.?0+$/, '');
                    }
                }
            }
            if (flags & F.uppercase)
            {
                text = text.toUpperCase();
            }
            const point = String.fromCharCode(decimalOf(u32(ios + IOS.LOC)));
            return { text: sign + text.replace('.', point), split: sign.length };
        };
        /**
         * An integer as the facet writes it: in its base, with the base's
         * prefix for showbase, '+' for showpos in decimal; octal and hex of a
         * signed one are of its bits.
         *
         * @param {number} ios @param {bigint} value @param {number} bits
         */
        const formatInteger = (ios, value, bits)=>{
            const flags = u32(ios + IOS.FMTFL);
            const field = flags & F.basefield;
            let text;
            let prefix = '';
            if (field === F.oct || field === F.hex)
            {
                const raw = BigInt.asUintN(bits, value);
                text = raw.toString(field === F.hex ? 16 : 8);
                if (flags & F.showbase && raw !== 0n)
                {
                    prefix = field === F.hex ? '0x' : '0';
                }
                if (flags & F.uppercase)
                {
                    text = text.toUpperCase();
                    prefix = prefix.toUpperCase();
                }
            }
            else
            {
                text = (value < 0n ? -value : value).toString();
                prefix = value < 0n ? '-' : flags & F.showpos ? '+' : '';
            }
            return { text: prefix + text, split: prefix.length };
        };
        /** operator<< of an integer. @param {number} part @param {bigint} value @param {number} bits */
        const writeInteger = (part, value, bits)=>{
            const { text, split } = formatInteger(iosOf(part), value, bits);
            return putText(part, text, split);
        };
        /** operator<< of a floating number. @param {number} part @param {number} value */
        const writeFloating = (part, value)=>{
            const { text, split } = formatFloating(iosOf(part), value);
            return putText(part, text, split);
        };

        /** get(): one element, eof and fail at the end. @param {number} part */
        const getOne = part=>{
            const ios = iosOf(part);
            setCount(part, 0);
            if (!ipfx(part, true))
            {
                return e.eof;
            }
            const c = b.sbumpc(bufOf(ios));
            if (e.isEof(c))
            {
                addState(ios, EOFBIT | FAILBIT);
                return e.eof;
            }
            setCount(part, 1);
            return c;
        };
        /**
         * get / getline into an array: up to count-1 elements before the
         * delimiter, which getline takes out and get leaves; a terminator
         * after them.
         *
         * @param {number} part @param {number} to @param {number} count @param {number} delim
         * @param {boolean} extract
         */
        const getInto = (part, to, count, delim, extract)=>{
            const ios = iosOf(part);
            const buffer = bufOf(ios);
            let taken = 0;
            let stored = 0;
            let state = 0;
            if (ipfx(part, true) && count > 0)
            {
                for (let c = b.sgetc(buffer); ; c = b.snextc(buffer))
                {
                    if (e.isEof(c))
                    {
                        state |= EOFBIT;
                        break;
                    }
                    if (e.of(c) === e.of(delim))
                    {
                        if (extract)
                        {
                            b.sbumpc(buffer);
                            taken++;
                        }
                        break;
                    }
                    if (stored + 1 >= count)
                    {
                        // getline fails on a line longer than the array; get stops.
                        if (extract)
                        {
                            state |= FAILBIT;
                        }
                        break;
                    }
                    e.put(to + stored * unit, c);
                    stored++;
                    taken++;
                }
            }
            if (count > 0)
            {
                e.put(to + stored * unit, 0);
            }
            setCount(part, taken);
            addState(ios, taken === 0 ? state | FAILBIT : state);
            return part;
        };

        const istream = {
            ipfx: [8, '_N_N@Z', (/** @type {number[]} */ [p, noskip])=>
                (ipfx(p, (noskip & 0xff) !== 0) ? 1 : 0), 'QAE'],
            isfx: [4, 'XXZ', ()=>0, 'QAE'],
            gcount: [4, 'HXZ', (/** @type {number[]} */ [p])=>u32(p + 4), 'QBE'],
            get: [4, `${I}XZ`, (/** @type {number[]} */ [p])=>getOne(p), 'QAE'],
            peek: [4, `${I}XZ`, (/** @type {number[]} */ [p])=>{
                const ios = iosOf(p);
                setCount(p, 0);
                if (!ipfx(p, true))
                {
                    return e.eof;
                }
                const c = b.sgetc(bufOf(ios));
                if (e.isEof(c))
                {
                    addState(ios, EOFBIT);
                }
                return c;
            }, 'QAE'],
            sync: [4, 'HXZ', (/** @type {number[]} */ [p])=>{
                const ios = iosOf(p);
                const buffer = bufOf(ios);
                if (buffer === 0)
                {
                    return -1;
                }
                if (b.pubsync(buffer) === -1)
                {
                    addState(ios, BADBIT);
                    return -1;
                }
                return 0;
            }, 'QAE'],
        };
        for (const [name, [bytes, tail, handler, access]] of Object.entries(istream))
        {
            out[`?${name}@${ISC}${access}${tail}`] = thiscall(/** @type {number} */ (bytes),
                /** @type {(args: number[]) => any} */ (handler));
        }

        /**
         * ignore(count, delim): up to count elements taken out, the
         * delimiter the last of them; INT_MAX means no count.
         *
         * @param {number} p @param {number} countArg @param {number} delim
         */
        const ignore = (p, countArg, delim)=>{
            const ios = iosOf(p);
            setCount(p, 0);
            let count = countArg | 0;
            let state = 0;
            if (ipfx(p, true))
            {
                for (;;)
                {
                    if (count !== INT_MAX && --count < 0)
                    {
                        break;
                    }
                    const c = b.sbumpc(bufOf(ios));
                    if (e.isEof(c))
                    {
                        state |= EOFBIT;
                        break;
                    }
                    setCount(p, u32(p + 4) + 1);
                    if (e.of(c) === e.of(delim))
                    {
                        break;
                    }
                }
            }
            addState(ios, state);
            return p;
        };
        /** read(to, count): count elements, eof and fail when fewer. */
        const readInto = (/** @type {number} */ p, /** @type {number} */ to, /** @type {number} */ count)=>{
            const ios = iosOf(p);
            setCount(p, 0);
            if (ipfx(p, true))
            {
                const n = b.virt(bufOf(ios), 'xsgetn', [to, count], 0);
                setCount(p, n);
                if (n !== count)
                {
                    addState(ios, EOFBIT | FAILBIT);
                }
            }
            return p;
        };
        /** seekg / seekp of an offset or a position: the buffer moved if the stream is not failed. */
        const seekStream = (/** @type {number} */ p, /** @type {(buffer: number) => void} */ move)=>{
            const ios = iosOf(p);
            if ((u32(ios + IOS.STATE) & (FAILBIT | BADBIT)) === 0)
            {
                move(bufOf(ios));
            }
            return p;
        };
        /** tellg / tellp: where the buffer is, or a failed position. */
        const tell = (/** @type {number} */ p, /** @type {number} */ answer, /** @type {number} */ which)=>{
            const ios = iosOf(p);
            if ((u32(ios + IOS.STATE) & (FAILBIT | BADBIT)) !== 0)
            {
                return writeFpos(answer, BADOFF, 0n);
            }
            const at = b.pubseekoff(bufOf(ios), 0, CUR, which);
            return writeFpos(answer, at.off, at.pos);
        };

        Object.assign(out, {
            [`?ignore@${ISC}QAEAAV12@H${I}@Z`]: thiscall(12, ([p, count, delim])=>
                ignore(p, count, delim)),
            [`?get@${ISC}QAEAAV12@AA${E}@Z`]: thiscall(8, ([p, to])=>{
                const c = getOne(p);
                if (!e.isEof(c))
                {
                    e.put(to, c);
                }
                return p;
            }),
            [`?get@${ISC}QAEAAV12@PA${E}H@Z`]: thiscall(12, ([p, to, count])=>
                getInto(p, to, count | 0, 0x0a, false)),
            [`?get@${ISC}QAEAAV12@PA${E}H${E}@Z`]: thiscall(16, ([p, to, count, delim])=>
                getInto(p, to, count | 0, delim, false)),
            [`?getline@${ISC}QAEAAV12@PA${E}H@Z`]: thiscall(12, ([p, to, count])=>
                getInto(p, to, count | 0, 0x0a, true)),
            [`?getline@${ISC}QAEAAV12@PA${E}H${E}@Z`]: thiscall(16, ([p, to, count, delim])=>
                getInto(p, to, count | 0, delim, true)),
            [`?read@${ISC}QAEAAV12@PA${E}H@Z`]: thiscall(12, ([p, to, count])=>
                readInto(p, to, count | 0)),
            [`?readsome@${ISC}QAEHPA${E}H@Z`]: thiscall(12, ([p, to, count])=>{
                const ios = iosOf(p);
                const buffer = bufOf(ios);
                const available = buffer === 0 ? -1 : b.gptr(buffer) !== 0 && b.gcount(buffer) > 0
                    ? b.gcount(buffer) : b.virt(buffer, 'showmanyc', [], 0);
                if (available < 0)
                {
                    addState(ios, EOFBIT);
                    return 0;
                }
                readInto(p, to, Math.min(available, count | 0));
                return u32(p + 4);
            }),
            [`?putback@${ISC}QAEAAV12@${E}@Z`]: thiscall(8, ([p, c])=>{
                const ios = iosOf(p);
                setCount(p, 0);
                if (ipfx(p, true) && e.isEof(b.sputbackc(bufOf(ios), c)))
                {
                    addState(ios, BADBIT);
                }
                return p;
            }),
            [`?unget@${ISC}QAEAAV12@XZ`]: thiscall(4, ([p])=>{
                const ios = iosOf(p);
                setCount(p, 0);
                if (ipfx(p, true) && e.isEof(b.sungetc(bufOf(ios))))
                {
                    addState(ios, BADBIT);
                }
                return p;
            }),
            [`?seekg@${ISC}QAEAAV12@JW4seekdir@ios_base@2@@Z`]: thiscall(12, ([p, off, way])=>
                seekStream(p, buffer=>b.pubseekoff(buffer, off | 0, way, IN))),
            [`?seekg@${ISC}QAEAAV12@V?$fpos@H@2@@Z`]: thiscall(28, ([p, ...rest])=>
                seekStream(p, buffer=>b.pubseekpos(buffer, fposOf(rest), IN))),
            [`?tellg@${ISC}QAE${FPOSN}XZ`]: thiscall(8, ([p, answer])=>tell(p, answer, IN)),
            [`??5${ISC}QAEAAV01@PAV?$basic_streambuf@${T}@1@@Z`]: thiscall(8, ([p, to])=>{
                const ios = iosOf(p);
                let n = 0;
                if (ipfx(p, false) && to !== 0)
                {
                    const from = bufOf(ios);
                    for (let c = b.sgetc(from); !e.isEof(c); c = b.snextc(from))
                    {
                        if (e.isEof(b.sputc(to, c)))
                        {
                            break;
                        }
                        n++;
                    }
                }
                addState(ios, n === 0 ? FAILBIT : 0);
                return p;
            }),
        });
        /** @type {[string, Parameters<typeof readNumber>[2]][]} */
        const readers = [['F', 'short'], ['G', 'ushort'], ['H', 'int'], ['I', 'uint'],
            ['J', 'int'], ['K', 'uint'], ['M', 'float'], ['N', 'double'], ['O', 'double'],
            ['PAX', 'pointer'], ['_J', 'int64'], ['_K', 'uint64'], ['_N', 'bool']];
        for (const [code, type] of readers)
        {
            out[`??5${ISC}QAEAAV01@AA${code}@Z`] = thiscall(8, ([p, to])=>readNumber(p, to, type));
        }

        const ostream = {
            opfx: [4, 'QAE_NXZ', (/** @type {number[]} */ [p])=>(opfx(p) ? 1 : 0)],
            osfx: [4, 'QAEXXZ', (/** @type {number[]} */ [p])=>(osfx(p), 0)],
            flush: [4, 'QAEAAV12@XZ', (/** @type {number[]} */ [p])=>flush(p)],
            put: [8, `QAEAAV12@${E}@Z`, (/** @type {number[]} */ [p, c])=>{
                const ios = iosOf(p);
                if (opfx(p) && e.isEof(b.sputc(bufOf(ios), c)))
                {
                    addState(ios, BADBIT);
                }
                osfx(p);
                return p;
            }],
            write: [12, `QAEAAV12@PB${E}H@Z`, (/** @type {number[]} */ [p, from, count])=>{
                const ios = iosOf(p);
                if (opfx(p) && b.virt(bufOf(ios), 'xsputn', [from, count], 0) !== (count | 0))
                {
                    addState(ios, BADBIT);
                }
                osfx(p);
                return p;
            }],
            tellp: [8, `QAE${FPOSN}XZ`, (/** @type {number[]} */ [p, answer])=>tell(p, answer, OUT)],
        };
        for (const [name, [bytes, tail, handler]] of Object.entries(ostream))
        {
            out[`?${name}@${OSC}${tail}`] = thiscall(/** @type {number} */ (bytes),
                /** @type {(args: number[]) => any} */ (handler));
        }
        Object.assign(out, {
            [`?seekp@${OSC}QAEAAV12@JW4seekdir@ios_base@2@@Z`]: thiscall(12, ([p, off, way])=>
                seekStream(p, buffer=>{
                    if (b.pubseekoff(buffer, off | 0, way, OUT).off === BADOFF)
                    {
                        addState(iosOf(p), FAILBIT);
                    }
                })),
            [`?seekp@${OSC}QAEAAV12@V?$fpos@H@2@@Z`]: thiscall(28, ([p, ...rest])=>
                seekStream(p, buffer=>{
                    if (b.pubseekpos(buffer, fposOf(rest), OUT).off === BADOFF)
                    {
                        addState(iosOf(p), FAILBIT);
                    }
                })),
            [`??6${OSC}QAEAAV01@F@Z`]: thiscall(8, ([p, v])=>{
                const flags = u32(iosOf(p) + IOS.FMTFL) & F.basefield;
                const value = flags === F.oct || flags === F.hex ? v & 0xffff : v << 16 >> 16;
                return writeInteger(p, BigInt(value), 32);
            }),
            [`??6${OSC}QAEAAV01@G@Z`]: thiscall(8, ([p, v])=>
                writeInteger(p, BigInt(v & 0xffff), 32)),
            [`??6${OSC}QAEAAV01@H@Z`]: thiscall(8, ([p, v])=>writeInteger(p, BigInt(v | 0), 32)),
            [`??6${OSC}QAEAAV01@I@Z`]: thiscall(8, ([p, v])=>writeInteger(p, BigInt(v >>> 0), 32)),
            [`??6${OSC}QAEAAV01@J@Z`]: thiscall(8, ([p, v])=>writeInteger(p, BigInt(v | 0), 32)),
            [`??6${OSC}QAEAAV01@K@Z`]: thiscall(8, ([p, v])=>writeInteger(p, BigInt(v >>> 0), 32)),
            [`??6${OSC}QAEAAV01@_J@Z`]: thiscall(12, ([p, low, high])=>writeInteger(p,
                BigInt.asIntN(64, BigInt(low >>> 0) | BigInt(high >>> 0) << 32n), 64)),
            [`??6${OSC}QAEAAV01@_K@Z`]: thiscall(12, ([p, low, high])=>writeInteger(p,
                BigInt(low >>> 0) | BigInt(high >>> 0) << 32n, 64)),
            [`??6${OSC}QAEAAV01@M@Z`]: thiscall(8, ([p, bits])=>writeFloating(p, floatOf(bits))),
            [`??6${OSC}QAEAAV01@N@Z`]: thiscall(12, ([p, low, high])=>
                writeFloating(p, doubleOf(low, high))),
            [`??6${OSC}QAEAAV01@O@Z`]: thiscall(12, ([p, low, high])=>
                writeFloating(p, doubleOf(low, high))),
            [`??6${OSC}QAEAAV01@_N@Z`]: thiscall(8, ([p, v])=>
                (u32(iosOf(p) + IOS.FMTFL) & F.boolalpha
                    ? putText(p, v & 0xff ? 'true' : 'false')
                    : writeInteger(p, BigInt(v & 0xff ? 1 : 0), 32))),
            [`??6${OSC}QAEAAV01@PBX@Z`]: thiscall(8, ([p, v])=>
                putText(p, (v >>> 0).toString(16).toUpperCase().padStart(8, '0'))),
            [`??6${OSC}QAEAAV01@PAV?$basic_streambuf@${T}@1@@Z`]: thiscall(8, ([p, from])=>{
                const ios = iosOf(p);
                let n = 0;
                if (opfx(p) && from !== 0)
                {
                    const to = bufOf(ios);
                    for (let c = b.sgetc(from); !e.isEof(c); c = b.snextc(from))
                    {
                        if (e.isEof(b.sputc(to, c)))
                        {
                            break;
                        }
                        n++;
                    }
                }
                addState(ios, n === 0 ? FAILBIT : 0);
                osfx(p);
                return p;
            }),
        });

        // The free functions of a stream: endl, ends, flush, ws, getline.
        const ISTREAM_ARG = `?$basic_istream@${T}@1@`;
        const OSTREAM_ARG = `?$basic_ostream@${T}@1@`;
        /** @type {Record<string, (p: number) => number>} */
        const manipulators = {
            [`?endl@std@@YAAAV${OSTREAM_ARG}AAV21@@Z`]: p=>{
                table2[`?put@${OSC}QAEAAV12@${E}@Z`].handler([p, 0x0a]);
                return flush(p);
            },
            [`?ends@std@@YAAAV${OSTREAM_ARG}AAV21@@Z`]: p=>
                table2[`?put@${OSC}QAEAAV12@${E}@Z`].handler([p, 0]),
            [`?flush@std@@YAAAV${OSTREAM_ARG}AAV21@@Z`]: p=>flush(p),
            [`?ws@std@@YAAAV${ISTREAM_ARG}AAV21@@Z`]: p=>{
                const ios = iosOf(p);
                if (!good(ios))
                {
                    addState(ios, FAILBIT);
                    return p;
                }
                const buffer = bufOf(ios);
                let c = b.sgetc(buffer);
                while (!e.isEof(c) && isSpace(c))
                {
                    c = b.snextc(buffer);
                }
                if (e.isEof(c))
                {
                    addState(ios, EOFBIT);
                }
                return p;
            },
        };
        const table2 = out;
        for (const [name, handler] of Object.entries(manipulators))
        {
            out[name] = cdecl(4, ([p])=>handler(p));
        }
        /** @type {Map<number, (p: number) => number> | null} */
        let manipulatorAt = null;
        /**
         * operator<< / >> of a manipulator: one of this library's (endl, ends,
         * flush, ws) run here; one of the program's own - the ios_base ones
         * (hex, fixed, ...) are inline in its headers, so they are too -
         * cannot be run from here.
         *
         * @param {number} p @param {number} fn @param {(stream: number) => number} toArgument
         */
        const manipulate = (p, fn, toArgument)=>{
            manipulatorAt ??= new Map(Object.entries(manipulators)
                .map(([name, handler])=>[host.addressOf(name), handler]));
            const handler = manipulatorAt.get(fn >>> 0);
            if (handler)
            {
                handler(toArgument(p));
            }
            else
            {
                loss('basic_ostream::operator<<', 'a manipulator of the program\'s own: not run');
            }
            return p;
        };
        const IOS_ARG = `?$basic_ios@${T}@1@`;
        for (const [cls, op] of /** @type {[string, string][]} */ ([[ISC, '5'], [OSC, '6']]))
        {
            out[`??${op}${cls}QAEAAV01@P6AAAV01@AAV01@@Z@Z`] = thiscall(8, ([p, fn])=>
                manipulate(p, fn, stream=>stream));
            out[`??${op}${cls}QAEAAV01@P6AAAV${IOS_ARG}AAV21@@Z@Z`] = thiscall(8, ([p, fn])=>
                manipulate(p, fn, stream=>iosOf(stream)));
            out[`??${op}${cls}QAEAAV01@P6AAAVios_base@1@AAV21@@Z@Z`] = thiscall(8, ([p, fn])=>
                manipulate(p, fn, stream=>iosOf(stream)));
        }

        /**
         * getline(stream, string, delim): the string emptied, then filled up to
         * the delimiter, which is taken out; fail when nothing was taken.
         *
         * @param {number} p @param {number} text @param {number} delim
         */
        const getline = (p, text, delim)=>{
            const ios = iosOf(p);
            /** @type {number[]} */
            const taken = [];
            let changed = false;
            let state = 0;
            if (ipfx(p, true))
            {
                const buffer = bufOf(ios);
                for (let c = b.sgetc(buffer); ; c = b.snextc(buffer))
                {
                    if (e.isEof(c))
                    {
                        state |= EOFBIT;
                        break;
                    }
                    if (e.of(c) === e.of(delim))
                    {
                        changed = true;
                        b.sbumpc(buffer);
                        break;
                    }
                    taken.push(c);
                    changed = true;
                }
            }
            const bytes = new Uint8Array(taken.length * unit);
            taken.forEach((c, index)=>{
                bytes[index * unit] = c & 0xff;
                if (unit === 2)
                {
                    bytes[index * 2 + 1] = c >>> 8 & 0xff;
                }
            });
            strings[unit].assignElements(text, bytes);
            addState(ios, changed ? state : state | FAILBIT);
            return p;
        };
        const GETLINE = `??$getline@${T}V?$allocator@${E}@2@@std@@YAAAV?$basic_istream@${T}@0@`
            + `AAV10@AAV?$basic_string@${T}V?$allocator@${E}@2@@0@`;
        out[`${GETLINE}@Z`] = cdecl(8, ([p, text])=>getline(p, text, 0x0a));
        out[`${GETLINE}${E}@Z`] = cdecl(12, ([p, text, delim])=>getline(p, text, delim));

        // ---- the standard streams ----------------------------------------------------

        // cin, cout, cerr and clog (wcin and the rest for wchar_t): objects of
        // the library's, each over a static filebuf of stdin, stdout or
        // stderr, laid out whole so that inline code can read them before
        // any call: the vbtable, the basic_ios with the classic locale, cin
        // and cerr tied to cout, cerr flushed after each output.
        const prefix = unit === 1 ? '' : 'w';
        for (const standard of STANDARD)
        {
            const name = standardBufferOf(standard.name, E);
            out[name] = { data: ()=>new Uint8Array(FILEBUF.SIZE), pointers: [
                { at: SB.VTABLE, to: `??_7${FBC}6B@` },
                ...[[SB.PRBUF, SB.RBUF], [SB.PWBUF, SB.WBUF], [SB.PRPOS, SB.RPOS],
                    [SB.PWPOS, SB.WPOS], [SB.PRSIZE, SB.RSIZE], [SB.PWSIZE, SB.WSIZE]]
                    .map(([at, offset])=>({ at, to: name, offset })),
                { at: SB.LOC, to: CLASSIC_LOCIMP }] };
            const reading = standard.kind === 'istream';
            const iosAt = reading ? 8 : 4;
            const kindClass = classOf(`basic_${standard.kind}`, E, false);
            out[`?${prefix}${standard.name}@std@@3V?$basic_${standard.kind}@${T}@1@A`] = {
                data: ()=>{
                    const bytes = new Uint8Array(iosAt + IOS.SIZE);
                    const view = new DataView(bytes.buffer);
                    view.setUint32(iosAt + IOS.FMTFL, F.skipws | F.dec
                        | (standard.name === 'cerr' ? F.unitbuf : 0), true);
                    view.setUint32(iosAt + IOS.PREC, 6, true);
                    view.setUint32(iosAt + IOS.STDSTR, standard.index, true);
                    view.setUint32(iosAt + IOS.FILL, 0x20, true);
                    return bytes;
                },
                pointers: [
                    { at: 0, to: `??_8${kindClass}7B@` },
                    { at: iosAt + IOS.VTABLE, to: `??_7${kindClass}6B@` },
                    { at: iosAt + IOS.LOC, to: CLASSIC_LOCIMP },
                    { at: iosAt + IOS.BUF, to: name },
                    ...standard.tied ? [{ at: iosAt + IOS.TIE,
                        to: `?${prefix}cout@std@@3V?$basic_ostream@${T}@1@A` }] : [],
                ],
            };
        }

        // The free operators of characters and strings: a character, a
        // C string or a string written, padded to the width; a character, a
        // word into an array (no longer than the width) or into a string read.
        /** The code units of a C string of the element. @param {number} at */
        const unitsAt = at=>{
            let text = '';
            for (let p = at >>> 0; ; p += unit)
            {
                const c = e.get(p);
                if (c === 0)
                {
                    return text;
                }
                text += String.fromCharCode(c);
            }
        };
        /** @param {Uint8Array} bytes */
        const unitsOf = bytes=>{
            let text = '';
            for (let i = 0; i < bytes.length; i += unit)
            {
                text += String.fromCharCode(unit === 1 ? bytes[i] : bytes[i] | bytes[i + 1] << 8);
            }
            return text;
        };
        /** @param {number[]} word */
        const bytesOf = word=>{
            const bytes = new Uint8Array(word.length * unit);
            word.forEach((c, index)=>{
                bytes[index * unit] = c & 0xff;
                if (unit === 2)
                {
                    bytes[index * 2 + 1] = c >>> 8 & 0xff;
                }
            });
            return bytes;
        };
        /**
         * A word: white space skipped, then what is not white space, up to
         * the width less `room` where one is set; the width then zero.
         *
         * @param {number} p @param {number} room
         * @returns {number[] | null} null when the stream was not good
         */
        const readWord = (p, room)=>{
            const ios = iosOf(p);
            if (!ipfx(p, false))
            {
                return null;
            }
            const width = i32(ios + IOS.WIDE);
            const limit = width > 0 ? width - room : INT_MAX;
            const buffer = bufOf(ios);
            /** @type {number[]} */
            const word = [];
            let state = 0;
            for (let c = b.sgetc(buffer); ; c = b.snextc(buffer))
            {
                if (e.isEof(c))
                {
                    state |= EOFBIT;
                    break;
                }
                if (isSpace(c) || word.length >= limit)
                {
                    break;
                }
                word.push(c);
            }
            setU32(ios + IOS.WIDE, 0);
            addState(ios, word.length === 0 ? state | FAILBIT : state);
            return word;
        };
        /**
         * Both names a free operator has: the template's and the plain one.
         *
         * @param {string} op @param {string} tail @param {boolean} [string]
         */
        const both = (op, tail, string = false)=>[
            `??$?${op}${T}${string ? `V?$allocator@${E}@1@` : ''}@std@@${tail}`,
            `??${op}std@@${tail}`];
        const OSTREAM_RESULT = `YAAAV?$basic_ostream@${T}@0@AAV10@`;
        const ISTREAM_RESULT = `YAAAV?$basic_istream@${T}@0@AAV10@`;
        const STRING_ARG = `V?$basic_string@${T}V?$allocator@${E}@2@@0@`;
        /** @param {number} p @param {number} to */
        const readChar = (p, to)=>{
            const ios = iosOf(p);
            if (ipfx(p, false))
            {
                const c = b.sbumpc(bufOf(ios));
                if (e.isEof(c))
                {
                    addState(ios, EOFBIT | FAILBIT);
                }
                else
                {
                    e.put(to, c);
                }
            }
            return p;
        };
        for (const code of unit === 1 ? ['C', 'D', 'E'] : ['G'])
        {
            for (const name of both('6', `${OSTREAM_RESULT}${code}@Z`))
            {
                out[name] = cdecl(8, ([p, c])=>putText(p, String.fromCharCode(e.of(c))));
            }
            for (const name of both('5', `${ISTREAM_RESULT}AA${code}@Z`))
            {
                out[name] = cdecl(8, ([p, to])=>readChar(p, to));
            }
        }
        for (const code of unit === 1 ? ['C', 'D', 'E'] : ['F', 'G'])
        {
            for (const name of both('6', `${OSTREAM_RESULT}PB${code}@Z`))
            {
                out[name] = cdecl(8, ([p, at])=>putText(p, unitsAt(at)));
            }
            for (const name of both('5', `${ISTREAM_RESULT}PA${code}@Z`))
            {
                out[name] = cdecl(8, ([p, to])=>{
                    const word = readWord(p, 1);
                    if (word)
                    {
                        host.writeMemory(to, bytesOf([...word, 0]));
                    }
                    return p;
                });
            }
        }
        for (const name of both('6', `${OSTREAM_RESULT}AB${STRING_ARG}@Z`, true))
        {
            out[name] = cdecl(8, ([p, text])=>putText(p, unitsOf(strings[unit].whole(text))));
        }
        for (const name of both('5', `${ISTREAM_RESULT}AA${STRING_ARG}@Z`, true))
        {
            out[name] = cdecl(8, ([p, text])=>{
                const word = readWord(p, 0);
                if (word)
                {
                    strings[unit].assignElements(text, bytesOf(word));
                }
                return p;
            });
        }

        // ---- the stream classes ----------------------------------------------------

        for (const cls of STREAMS)
        {
            Object.assign(out, streamClass(cls));
        }
        return out;

        /**
         * The members of one stream class: its vbtables, the vtable its
         * basic_ios holds, its constructors with the argument that says it is
         * the most derived, its destructors, and what it holds a buffer for.
         *
         * @param {StreamClass} cls
         */
        function streamClass(cls){
            const C = classOf(cls.name, E, cls.allocator);
            /** @type {Record<string, any>} */
            const members = {};
            const two = cls.parts.length === 2;
            const vbtableOf = (/** @type {'istream' | 'ostream'} */ kind)=>(two
                ? `??_8${C}7B?$basic_${kind}@${T}@1@@` : `??_8${C}7B@`);
            for (const part of cls.parts)
            {
                members[vbtableOf(part.kind)] = { data: ()=>{
                    const bytes = new Uint8Array(8);
                    new DataView(bytes.buffer).setInt32(4, cls.iosAt - part.at, true);
                    return bytes;
                } };
            }
            /** Each part's vbtable at its place: the class is the most derived. */
            const laid = (/** @type {number} */ self)=>{
                for (const part of cls.parts)
                {
                    setU32(self + part.at, host.addressOf(vbtableOf(part.kind)));
                }
            };
            const bufferAt = (/** @type {number} */ self)=>self + cls.bufferAt;
            /** The istream part's count, the ostream's nothing: zeroed. */
            const parts = (/** @type {number} */ self)=>{
                for (const part of cls.parts)
                {
                    if (part.kind === 'istream')
                    {
                        setU32(self + part.at + 4, 0);
                    }
                }
            };
            /**
             * A constructor's common part: the virtual base built when the
             * class is the most derived, the buffer made, the stream bound to it.
             *
             * @param {number} self @param {number} most @param {(buffer: number) => void} make
             * @param {number} [given]  A buffer of the caller's, for the classes that hold none.
             */
            const construct = (self, most, make, given = 0)=>{
                const ios = self + cls.iosAt;
                if (most)
                {
                    laid(self);
                    setU32(ios, host.addressOf(`??_7${C}6B@`));
                }
                else
                {
                    setU32(iosOfPart(self), host.addressOf(`??_7${C}6B@`));
                }
                parts(self);
                const target = cls.buffer ? bufferAt(self) : given;
                if (cls.buffer)
                {
                    make(target);
                }
                initIos(most ? ios : iosOfPart(self), target);
                return self;
            };
            const iosOfPart = (/** @type {number} */ self)=>iosOf(self + cls.parts[0].at);
            /** The class's own destruction, its buffer's, then the virtual base's if asked. */
            const destroy = (/** @type {number} */ self, /** @type {boolean} */ whole)=>{
                if (cls.buffer === 'string')
                {
                    destroyString(bufferAt(self));
                }
                else if (cls.buffer === 'file')
                {
                    destroyFile(bufferAt(self));
                }
                if (whole)
                {
                    destroyIos(iosOfPart(self));
                }
            };
            const stringArg = `ABV?$basic_string@${T}V?$allocator@${E}@2@@1@`;
            members[`??1${C}UAE@XZ`] = thiscall(4, ([self])=>(destroy(self, false), 0));
            members[`??_D${C}QAEXXZ`] = thiscall(4, ([self])=>(destroy(self, true), 0));
            // The deleting destructor the vtable in the virtual base holds:
            // called on the basic_ios, it finds the object before it.
            members[`??_E${C}UAEPAXI@Z`] = thiscall(8, ([ios, flags])=>{
                const self = ios - cls.iosAt;
                destroy(self, true);
                if (flags & 1)
                {
                    free(self);
                }
                return self;
            });
            members[`??_7${C}6B@`] = { data: ()=>new Uint8Array(4),
                pointers: [{ at: 0, to: `??_E${C}UAEPAXI@Z` }] };
            if (cls.buffer === null)
            {
                const sb = `PAV?$basic_streambuf@${T}@1@`;
                if (cls.name === 'basic_ostream')
                {
                    members[`??0${C}QAE@${sb}_N1@Z`] = thiscall(20, ([self, buffer, , , most])=>
                        construct(self, most, ()=>{}, buffer));
                }
                else if (cls.name === 'basic_istream')
                {
                    members[`??0${C}QAE@${sb}_N@Z`] = thiscall(16, ([self, buffer, , most])=>
                        construct(self, most, ()=>{}, buffer));
                }
                else
                {
                    members[`??0${C}QAE@${sb}@Z`] = thiscall(12, ([self, buffer, most])=>
                        construct(self, most, ()=>{}, buffer));
                }
                if (cls.name !== 'basic_iostream')
                {
                    members[`??0${C}QAE@W4_Uninitialized@1@@Z`] = thiscall(12, ([self])=>self);
                }
                return members;
            }
            // What a one-way class's buffer always does besides what it is asked.
            const extra = cls.parts.length === 2 ? 0 : cls.parts[0].kind === 'istream' ? IN : OUT;
            const RDBUF = cls.buffer === 'string' ? `PAV${STRBC.replace(/@std@@$/, '@2@')}` : `PAV${FBC.replace(/@std@@$/, '@2@')}`;
            members[`?rdbuf@${C}QBE${RDBUF}XZ`] = thiscall(4, ([self])=>bufferAt(self));
            if (cls.buffer === 'string')
            {
                members[`??0${C}QAE@H@Z`] = thiscall(12, ([self, mode, most])=>
                    construct(self, most, x=>constructString(x, new Uint8Array(0), mode | extra)));
                members[`??0${C}QAE@${stringArg}H@Z`] = thiscall(16, ([self, text, mode, most])=>
                    construct(self, most, x=>
                        constructString(x, strings[unit].whole(text), mode | extra)));
                members[`?str@${C}QBE?AV${STRING}2@XZ`] = thiscall(8, ([self, answer])=>
                    strOf(bufferAt(self), answer));
                members[`?str@${C}QAEXABV${STRING}2@@Z`] = thiscall(8, ([self, text])=>
                    setStr(bufferAt(self), text));
                return members;
            }
            /** open(name, mode): failbit when the file is not opened. */
            const open = (/** @type {number} */ self, /** @type {number} */ name, /** @type {number} */ mode)=>{
                if (openFile(bufferAt(self), name, mode | extra) === 0)
                {
                    addState(iosOfPart(self), FAILBIT);
                }
                return 0;
            };
            members[`??0${C}QAE@XZ`] = thiscall(8, ([self, most])=>
                construct(self, most, x=>constructFile(x, 0)));
            members[`??0${C}QAE@PBDH@Z`] = thiscall(16, ([self, name, mode, most])=>{
                construct(self, most, x=>constructFile(x, 0));
                open(self, name, mode);
                return self;
            });
            members[`?open@${C}QAEXPBDH@Z`] = thiscall(12, ([self, name, mode])=>
                open(self, name, mode));
            members[`?open@${C}QAEXPBDF@Z`] = thiscall(12, ([self, name, mode])=>
                open(self, name, mode & 0xffff));
            members[`?close@${C}QAEXXZ`] = thiscall(4, ([self])=>{
                if (closeFile(bufferAt(self)) === 0)
                {
                    addState(iosOfPart(self), FAILBIT);
                }
                return 0;
            });
            members[`?is_open@${C}QBE_NXZ`] = thiscall(4, ([self])=>
                (fileOf(bufferAt(self)) !== 0 ? 1 : 0));
            return members;
        }
    }
}

/** The openmode bits, for tests. */
export const OPENMODE = Object.freeze({ IN, OUT, ATE, APP, TRUNC, BINARY });
/** The layouts, for tests. */
export const LAYOUT = Object.freeze({ IOS, SB, STRBUF, FILEBUF, FPOS, STREAMS });
