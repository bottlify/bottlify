/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * msvcirt -- the old iostream library, `<iostream.h>` rather than `<iostream>`,
 * which Windows keeps in its system directory for programs built with Visual
 * C++ 6 and earlier.
 *
 * Nothing about it can be a handle: a program built against the header inlines
 * `ios::good()`, `rdbuf()`, `gcount()` and the streambuf's `sgetc()`, reading
 * the fields of objects it allocated itself, and derives classes of its own
 * from `strstreambuf` whose virtual methods call back into the ones here. So
 * the objects are laid out as the library laid them out, and every virtual call
 * goes through the object's vtable: to the code here when the slot is one of
 * this library's, into the guest when the program overrode it.
 *
 * The streams derive from `ios` virtually. The complete object's constructor is
 * passed a hidden last argument saying whether it is the most derived, and so
 * whether it builds the `ios`; everything else finds the `ios` through the
 * object's vbtable. A virtual method -- the destructors -- is called with
 * `this` at the `ios`, the class that introduced it.
 *
 * The layouts and the behaviour are read off Wine's conformance tests and its
 * account of the native library; the code is this project's.
 */

const EOF = -1;

/** streambuf: the buffer pointers, and the lock the header's inline code takes. */
const SB = {
    VTABLE: 0, ALLOCATED: 4, UNBUFFERED: 8, STORED: 12, BASE: 16, EBUF: 20,
    PBASE: 24, PPTR: 28, EPPTR: 32, EBACK: 36, GPTR: 40, EGPTR: 44, DO_LOCK: 48, LOCK: 52,
    SIZE: 76,
};
/** strstreambuf, after its streambuf. */
const SSB = {
    DYNAMIC: 76, INCREASE: 80, UNKNOWN: 84, CONSTANT: 88, ALLOC: 92, FREE: 96, SIZE: 100,
};
/** filebuf, after its streambuf. */
const FB = { FD: 76, CLOSE: 80, SIZE: 84 };
/** ios, the virtual base every stream shares. */
const IOS = {
    VTABLE: 0, SB: 4, STATE: 8, SPECIAL: 12, DELBUF: 28, TIE: 32, FLAGS: 36, PRECISION: 40,
    FILL: 44, WIDTH: 48, DO_LOCK: 52, LOCK: 56, SIZE: 80,
};
/** istream's own fields, before the ios; ostream has only its vbtable and one word. */
const ISTREAM = { VBTABLE: 0, DELIM: 4, COUNT: 8, SIZE: 12 };
const OSTREAM = { VBTABLE: 0, SIZE: 8 };
/** An iostream is an istream and then an ostream, then the ios. */
const IOSTREAM_OSTREAM = ISTREAM.SIZE;
/** The exception class this library exports: vtable, message, whether it owns it. */
const EXCEPTION = { VTABLE: 0, NAME: 4, DO_FREE: 8, SIZE: 12 };

const STATE = { GOOD: 0, EOF: 1, FAIL: 2, BAD: 4 };
const FLAGS = {
    SKIPWS: 0x1, LEFT: 0x2, RIGHT: 0x4, INTERNAL: 0x8, DEC: 0x10, OCT: 0x20, HEX: 0x40,
    SHOWBASE: 0x80, SHOWPOINT: 0x100, UPPERCASE: 0x200, SHOWPOS: 0x400, SCIENTIFIC: 0x800,
    FIXED: 0x1000, UNITBUF: 0x2000,
};
const MODE = {
    IN: 1, OUT: 2, ATE: 4, APP: 8, TRUNC: 0x10, NOCREATE: 0x20, NOREPLACE: 0x40, BINARY: 0x80,
};
const SEEK = { BEG: 0, CUR: 1, END: 2 };

/** The low-level I/O flags filebuf opens with, as msvcrt's `_open` takes them. */
const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, APPEND: 8, CREAT: 0x100, TRUNC: 0x200, EXCL: 0x400,
    TEXT: 0x4000, BINARY: 0x8000 };

/** filebuf::openprot: read and write permission, `_S_IREAD | _S_IWRITE`. */
const OPENPROT = 0x180;

/** A streambuf's buffer when it makes its own. */
const DEFAULT_BUFFER = 512;

/** The virtual methods of streambuf, in the header's declaration order. */
const SLOT = {
    DELETE: 0, SYNC: 1, SETBUF: 2, SEEKOFF: 3, SEEKPOS: 4, XSPUTN: 5, XSGETN: 6,
    OVERFLOW: 7, UNDERFLOW: 8, PBACKFAIL: 9, DOALLOCATE: 10,
};

/**
 * @typedef {Object} IostreamHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(name: string) => number} addressOf  This library's own export.
 * @property {(bytes: number) => number} allocate   The C runtime's operator new.
 * @property {(address: number) => void} release    Its operator delete.
 * @property {{ init: (cs: number) => any, remove: (cs: number) => any,
 *     enter: (cs: number) => any, leave: (cs: number) => any }} locks
 *     The kernel's critical sections; any may answer with a promise.
 * @property {{ open: (path: number, flags: number, prot: number) => any,
 *     close: (fd: number) => any, read: (fd: number, buffer: number, count: number) => any,
 *     write: (fd: number, buffer: number, count: number) => any,
 *     seek: (fd: number, offset: number, origin: number) => any,
 *     setmode: (fd: number, mode: number) => any }} crt
 *     The C runtime's descriptors, a filebuf's file; any may answer with a promise.
 * @property {(call: { entry: number, args: number[], ecx: number, thread: any })
 *     => Promise<number>} call
 *     A method of the program's own, through its vtable: thiscall, on the
 *     thread whose call into this library it is part of.
 * @property {() => any} callerThread  The thread whose call is in flight.
 * @property {(format: string, words: number[]) => string} format  printf, for numbers.
 */

/**
 * Runs a generator whose yields are values or promises of them, synchronously
 * for as long as nothing it waits on is a promise. `onResume` is told before
 * every step, so what the steps call knows whose call they are answering.
 *
 * @param {Generator<any, any, any>} steps @param {() => void} onResume
 */
const drive = (steps, onResume)=>{
    /** @param {any} input @returns {any} */
    const step = input=>{
        for (;;)
        {
            onResume();
            const { value, done } = steps.next(input);
            if (done)
            {
                return value;
            }
            if (value instanceof Promise)
            {
                return value.then(step);
            }
            input = value;
        }
    };
    return step(undefined);
};

/**
 * A value or a promise of one, as a step of a generator `drive` runs.
 *
 * @param {any} value
 * @returns {Generator<any, any, any>}
 */
function* wait(value){
    return yield value;
}

/** @param {string} text */
const latin1 = text=>Uint8Array.from(text, character=>character.charCodeAt(0) & 0xff);

/**
 * @param {IostreamHost} host
 */
export function createIostreamFunctions(host){
    /** The thread whose call the running step answers. @type {any} */
    let thread = null;
    /** @param {{ entry: number, args: number[], ecx: number }} call */
    const callGuest = call=>host.call({ ...call, thread });

    /** @param {number} at */
    const u32 = at=>{
        const bytes = host.readMemory(at >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} at */
    const i32 = at=>u32(at) | 0;
    /** @param {number} at @param {number} value */
    const put = (at, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at */
    const byte = at=>host.readMemory(at >>> 0, 1)[0];
    /** @param {number} at @param {number} length */
    const zero = (at, length)=>host.writeMemory(at >>> 0, new Uint8Array(length));

    /** The ios of a stream whose vbtable is at `object`. @param {number} object */
    const iosOf = object=>(object + i32(u32(object) + 4)) >>> 0;

    // --- the tables, placed once, on the first object that needs them ---

    /**
     * The vtables and vbtables live in guest memory, because a program copies
     * them into objects of its own classes and calls through them. A word below
     * each vtable is where the compiler keeps its type information; nothing
     * here has any to offer, so it is zero.
     *
     * @type {Record<string, number> | null}
     */
    let tables = null;
    /** Code behind this library's own vtable slots, by address. @type {Map<number, Function>} */
    const own = new Map();

    const tableOf = (/** @type {string} */ name)=>{
        if (!tables)
        {
            tables = placeTables();
        }
        return tables[name];
    };

    // --- virtual calls ---

    /**
     * Calls slot `slot` of the vtable of the object at `object`, with `this` at
     * the object. What answers is a generator's result.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     * @returns {Generator<any, number, any>}
     */
    function* virtualCall(object, slot, args){
        const entry = u32(u32(object) + slot * 4);
        const body = own.get(entry);
        if (body)
        {
            return (yield* body(object, ...args)) | 0;
        }
        return (yield* wait(callGuest({ entry, args, ecx: object }))) | 0;
    }

    // --- streambuf ---

    /** @param {number} sb */
    function* streambufInit(sb){
        zero(sb, SB.SIZE);
        put(sb + SB.VTABLE, tableOf('streambuf'));
        put(sb + SB.STORED, EOF);
        put(sb + SB.DO_LOCK, EOF);
        yield* wait(host.locks.init(sb + SB.LOCK));
    }

    /** @param {number} sb */
    function* streambufFinish(sb){
        if (u32(sb + SB.ALLOCATED))
        {
            host.release(u32(sb + SB.BASE));
        }
        put(sb + SB.ALLOCATED, 0);
        yield* wait(host.locks.remove(sb + SB.LOCK));
    }

    /** @param {number} sb @param {number} base @param {number} end @param {number} owned */
    const setb = (sb, base, end, owned)=>{
        if (u32(sb + SB.ALLOCATED))
        {
            host.release(u32(sb + SB.BASE));
        }
        put(sb + SB.ALLOCATED, owned);
        put(sb + SB.BASE, base);
        put(sb + SB.EBUF, end);
    };

    /** @param {number} sb @param {number} eback @param {number} gptr @param {number} egptr */
    const setg = (sb, eback, gptr, egptr)=>{
        put(sb + SB.EBACK, eback);
        put(sb + SB.GPTR, gptr);
        put(sb + SB.EGPTR, egptr);
    };

    /** @param {number} sb @param {number} pbase @param {number} epptr */
    const setp = (sb, pbase, epptr)=>{
        put(sb + SB.PBASE, pbase);
        put(sb + SB.PPTR, pbase);
        put(sb + SB.EPPTR, epptr);
    };

    /** A buffer if the streambuf has none and is buffered. @param {number} sb */
    function* allocate(sb){
        if (u32(sb + SB.BASE) || u32(sb + SB.UNBUFFERED))
        {
            return 0;
        }
        return yield* virtualCall(sb, SLOT.DOALLOCATE, []);
    }

    /** The next character, taken. @param {number} sb */
    function* sbumpc(sb){
        if (u32(sb + SB.UNBUFFERED))
        {
            const stored = i32(sb + SB.STORED);
            put(sb + SB.STORED, EOF);
            return stored !== EOF ? stored : yield* virtualCall(sb, SLOT.UNDERFLOW, []);
        }
        const gptr = u32(sb + SB.GPTR);
        const c = gptr < u32(sb + SB.EGPTR) ? byte(gptr)
            : yield* virtualCall(sb, SLOT.UNDERFLOW, []);
        if (c !== EOF)
        {
            put(sb + SB.GPTR, u32(sb + SB.GPTR) + 1);
        }
        return c;
    }

    /** @param {number} sb @param {number} c */
    function* sputc(sb, c){
        const pptr = u32(sb + SB.PPTR);
        if (pptr < u32(sb + SB.EPPTR))
        {
            host.writeMemory(pptr, Uint8Array.of(c));
            put(sb + SB.PPTR, pptr + 1);
            return c & 0xff;
        }
        return yield* virtualCall(sb, SLOT.OVERFLOW, [c & 0xff]);
    }

    /**
     * Writes host bytes through the streambuf's xsputn: straight to the code
     * here when the slot is this library's, through a guest copy otherwise.
     *
     * @param {number} sb @param {Uint8Array} bytes
     */
    function* sputn(sb, bytes){
        const entry = u32(u32(sb) + SLOT.XSPUTN * 4);
        if (entry === tableSlot('streambuf', SLOT.XSPUTN))
        {
            return yield* xsputnBytes(sb, bytes);
        }
        const copy = host.allocate(Math.max(1, bytes.length));
        host.writeMemory(copy, bytes);
        const written = (yield* wait(
            callGuest({ entry, args: [copy, bytes.length], ecx: sb }))) | 0;
        host.release(copy);
        return written;
    }

    /** @param {string} table @param {number} slot */
    const tableSlot = (table, slot)=>u32(tableOf(table) + slot * 4);

    /** streambuf::xsputn over host bytes. @param {number} sb @param {Uint8Array} bytes */
    function* xsputnBytes(sb, bytes){
        let copied = 0;
        while (copied < bytes.length)
        {
            const pptr = u32(sb + SB.PPTR);
            const room = u32(sb + SB.EPPTR) - pptr;
            if (u32(sb + SB.UNBUFFERED) || room <= 0 || pptr === 0)
            {
                if ((yield* virtualCall(sb, SLOT.OVERFLOW, [bytes[copied]])) === EOF)
                {
                    break;
                }
                copied++;
                continue;
            }
            const chunk = Math.min(room, bytes.length - copied);
            host.writeMemory(pptr, bytes.subarray(copied, copied + chunk));
            put(sb + SB.PPTR, pptr + chunk);
            copied += chunk;
        }
        return copied;
    }

    /** streambuf::xsgetn. @param {number} sb @param {number} buffer @param {number} length */
    function* xsgetn(sb, buffer, length){
        let copied = 0;
        while (copied < length)
        {
            if (u32(sb + SB.UNBUFFERED))
            {
                const c = yield* sbumpc(sb);
                if (c === EOF)
                {
                    break;
                }
                host.writeMemory(buffer + copied, Uint8Array.of(c));
                copied++;
                continue;
            }
            const gptr = u32(sb + SB.GPTR);
            const available = u32(sb + SB.EGPTR) - gptr;
            if (gptr !== 0 && available > 0)
            {
                const chunk = Math.min(available, length - copied);
                host.writeMemory(buffer + copied, host.readMemory(gptr, chunk));
                put(sb + SB.GPTR, gptr + chunk);
                copied += chunk;
            }
            else if ((yield* virtualCall(sb, SLOT.UNDERFLOW, [])) === EOF)
            {
                break;
            }
        }
        return copied;
    }

    /** streambuf's own virtual methods, the defaults a derived class falls back to. */
    const streambufVirtual = {
        /** @param {number} sb @param {number} flags */
        *delete(sb, flags){
            yield* streambufFinish(sb);
            if (flags & 1)
            {
                host.release(sb);
            }
            return sb;
        },
        /** @param {number} sb */
        *sync(sb){
            yield 0;
            return u32(sb + SB.GPTR) >= u32(sb + SB.EGPTR)
                && u32(sb + SB.PBASE) >= u32(sb + SB.PPTR)
                ? 0 : EOF;
        },
        /** @param {number} sb @param {number} buffer @param {number} length */
        *setbuf(sb, buffer, length){
            yield 0;
            if (u32(sb + SB.BASE))
            {
                return 0;
            }
            const unbuffered = buffer === 0 || length === 0;
            put(sb + SB.UNBUFFERED, unbuffered ? 1 : 0);
            put(sb + SB.BASE, unbuffered ? 0 : buffer);
            put(sb + SB.EBUF, unbuffered ? 0 : buffer + length);
            return sb;
        },
        *seekoff(){
            yield 0;
            return EOF;
        },
        /** @param {number} sb @param {number} position @param {number} mode */
        *seekpos(sb, position, mode){
            return yield* virtualCall(sb, SLOT.SEEKOFF, [position, SEEK.BEG, mode]);
        },
        /** @param {number} sb @param {number} data @param {number} length */
        *xsputn(sb, data, length){
            return yield* xsputnBytes(sb,
                length > 0 ? host.readMemory(data, length) : new Uint8Array(0));
        },
        xsgetn,
        *overflow(){
            yield 0;
            return EOF;
        },
        *underflow(){
            yield 0;
            return EOF;
        },
        /** @param {number} sb @param {number} c */
        *pbackfail(sb, c){
            yield 0;
            const gptr = u32(sb + SB.GPTR);
            if (gptr > u32(sb + SB.EBACK))
            {
                host.writeMemory(gptr - 1, Uint8Array.of(c));
                put(sb + SB.GPTR, gptr - 1);
                return c & 0xff;
            }
            return EOF;
        },
        /** @param {number} sb */
        *doallocate(sb){
            yield 0;
            const buffer = host.allocate(DEFAULT_BUFFER);
            if (!buffer)
            {
                return EOF;
            }
            setb(sb, buffer, buffer + DEFAULT_BUFFER, 1);
            return 1;
        },
    };

    // --- strstreambuf ---

    /** @param {number} ssb @param {number} increase */
    function* strstreambufDynamic(ssb, increase){
        yield* streambufInit(ssb);
        put(ssb + SB.VTABLE, tableOf('strstreambuf'));
        put(ssb + SSB.DYNAMIC, 1);
        put(ssb + SSB.INCREASE, increase);
        put(ssb + SSB.UNKNOWN, 0);
        put(ssb + SSB.CONSTANT, 0);
        put(ssb + SSB.ALLOC, 0);
        put(ssb + SSB.FREE, 0);
        return ssb;
    }

    /**
     * Over a buffer of the caller's: its length when positive, up to its
     * terminator when zero, and unbounded when negative. With `put`, the get
     * area runs to it and the put area from it.
     *
     * @param {number} ssb @param {number} buffer @param {number} length @param {number} putAt
     */
    function* strstreambufBuffer(ssb, buffer, length, putAt){
        yield* streambufInit(ssb);
        const end = length > 0 ? buffer + length
            : length === 0 ? buffer + host.readCString(buffer, 0x7fffffff).length
                : 0xffffffff;
        setb(ssb, buffer, end, 0);
        if (putAt === 0)
        {
            setg(ssb, buffer, buffer, end);
        }
        else
        {
            setg(ssb, buffer, buffer, putAt);
            setp(ssb, putAt, end);
        }
        put(ssb + SB.VTABLE, tableOf('strstreambuf'));
        put(ssb + SSB.DYNAMIC, 0);
        put(ssb + SSB.INCREASE, 0);
        put(ssb + SSB.UNKNOWN, 0);
        put(ssb + SSB.CONSTANT, 1);
        put(ssb + SSB.ALLOC, 0);
        put(ssb + SSB.FREE, 0);
        return ssb;
    }

    /** A block from the strstreambuf's own allocator, or the runtime's. @param {number} ssb @param {number} bytes */
    function* ssbAllocate(ssb, bytes){
        const alloc = u32(ssb + SSB.ALLOC);
        if (!alloc)
        {
            return host.allocate(bytes);
        }
        return (yield* wait(callGuest({ entry: alloc, args: [bytes], ecx: ssb }))) >>> 0;
    }

    /** @param {number} ssb @param {number} address */
    function* ssbFree(ssb, address){
        const free = u32(ssb + SSB.FREE);
        if (!free)
        {
            host.release(address);
            return 0;
        }
        return yield* wait(callGuest({ entry: free, args: [address], ecx: ssb }));
    }

    /** @param {number} ssb */
    function* strstreambufFinish(ssb){
        const base = u32(ssb + SB.BASE);
        if (u32(ssb + SSB.DYNAMIC) && base)
        {
            yield* ssbFree(ssb, base);
            put(ssb + SB.BASE, 0);
        }
        yield* streambufFinish(ssb);
    }

    const strstreambufVirtual = {
        /** @param {number} ssb @param {number} flags */
        *delete(ssb, flags){
            yield* strstreambufFinish(ssb);
            if (flags & 1)
            {
                host.release(ssb);
            }
            return ssb;
        },
        *sync(){
            yield 0;
            return 0;
        },
        /** @param {number} ssb @param {number} _buffer @param {number} length */
        *setbuf(ssb, _buffer, length){
            yield 0;
            if (length)
            {
                put(ssb + SSB.INCREASE, length);
            }
            return ssb;
        },
        /** @param {number} ssb */
        *doallocate(ssb){
            const previous = u32(ssb + SB.BASE);
            const previousSize = u32(ssb + SB.EBUF) - previous;
            const increase = i32(ssb + SSB.INCREASE);
            const size = (previousSize > 0 ? previousSize : 0) + (increase > 0 ? increase : 1);
            const buffer = yield* ssbAllocate(ssb, size);
            if (!buffer)
            {
                return EOF;
            }
            if (u32(ssb + SB.EBUF))
            {
                host.writeMemory(buffer, host.readMemory(previous, previousSize));
                const moved = buffer - previous;
                if (u32(ssb + SB.EGPTR))
                {
                    for (const field of [SB.EBACK, SB.GPTR, SB.EGPTR])
                    {
                        put(ssb + field, u32(ssb + field) + moved);
                    }
                }
                if (u32(ssb + SB.EPPTR))
                {
                    for (const field of [SB.PBASE, SB.PPTR, SB.EPPTR])
                    {
                        put(ssb + field, u32(ssb + field) + moved);
                    }
                }
                yield* ssbFree(ssb, previous);
            }
            put(ssb + SB.ALLOCATED, 0);
            setb(ssb, buffer, buffer + size, 0);
            return 1;
        },
        /** @param {number} ssb @param {number} c */
        *overflow(ssb, c){
            if (u32(ssb + SB.PPTR) >= u32(ssb + SB.EPPTR))
            {
                if (!u32(ssb + SSB.DYNAMIC)
                    || (yield* virtualCall(ssb, SLOT.DOALLOCATE, [])) === EOF)
                {
                    return EOF;
                }
                if (!u32(ssb + SB.EPPTR))
                {
                    const start = u32(ssb + SB.EGPTR) || u32(ssb + SB.BASE);
                    put(ssb + SB.PBASE, start);
                    put(ssb + SB.PPTR, start);
                }
                put(ssb + SB.EPPTR, u32(ssb + SB.EBUF));
                if (u32(ssb + SB.EBACK))
                {
                    put(ssb + SB.EGPTR, u32(ssb + SB.PBASE));
                }
            }
            if (c !== EOF && !u32(ssb + SSB.CONSTANT))
            {
                return yield* sputc(ssb, c);
            }
            return c & 0xff;
        },
        /** @param {number} ssb */
        *underflow(ssb){
            yield 0;
            if (u32(ssb + SB.GPTR) < u32(ssb + SB.EGPTR))
            {
                return byte(u32(ssb + SB.GPTR));
            }
            // What was written since becomes readable: the get area grows to
            // the put pointer.
            if (u32(ssb + SB.EGPTR) < u32(ssb + SB.PPTR))
            {
                const base = u32(ssb + SB.BASE);
                const eback = u32(ssb + SB.EBACK);
                put(ssb + SB.GPTR, base + (u32(ssb + SB.GPTR) - eback));
                put(ssb + SB.EBACK, base);
                put(ssb + SB.EGPTR, u32(ssb + SB.PPTR));
            }
            return u32(ssb + SB.GPTR) < u32(ssb + SB.EGPTR) ? byte(u32(ssb + SB.GPTR)) : EOF;
        },
        /** @param {number} ssb @param {number} offset @param {number} dir @param {number} mode */
        *seekoff(ssb, offset, dir, mode){
            if ((dir >>> 0) > SEEK.END || !(mode & (MODE.IN | MODE.OUT)))
            {
                return EOF;
            }
            let answer = 0;
            if (mode & MODE.IN)
            {
                yield* virtualCall(ssb, SLOT.UNDERFLOW, []);
                const origins = [u32(ssb + SB.EBACK), u32(ssb + SB.GPTR), u32(ssb + SB.EGPTR)];
                const to = origins[dir] + offset;
                if (to < origins[0] || to > origins[2])
                {
                    return EOF;
                }
                put(ssb + SB.GPTR, to);
                answer = to - origins[0];
            }
            if (mode & MODE.OUT)
            {
                if (!u32(ssb + SB.EPPTR)
                    && (yield* virtualCall(ssb, SLOT.OVERFLOW, [EOF])) === EOF)
                {
                    return EOF;
                }
                const origin = ()=>[u32(ssb + SB.PBASE), u32(ssb + SB.PPTR), u32(ssb + SB.EPPTR)];
                let to = origin()[dir] + offset;
                if (to < origin()[0])
                {
                    return EOF;
                }
                if (to > origin()[2])
                {
                    if (!u32(ssb + SSB.DYNAMIC))
                    {
                        return EOF;
                    }
                    const from = to - origin()[dir];
                    put(ssb + SSB.INCREASE, offset);
                    if ((yield* virtualCall(ssb, SLOT.DOALLOCATE, [])) === EOF)
                    {
                        return EOF;
                    }
                    put(ssb + SB.EPPTR, u32(ssb + SB.EBUF));
                    to = origin()[dir] + from;
                }
                put(ssb + SB.PPTR, to);
                answer = to - u32(ssb + SB.PBASE);
            }
            return answer;
        },
    };

    // --- filebuf ---

    /** @param {number} fb */
    function* filebufInit(fb){
        yield* streambufInit(fb);
        put(fb + SB.VTABLE, tableOf('filebuf'));
        put(fb + FB.FD, EOF);
        put(fb + FB.CLOSE, 0);
        return fb;
    }

    /** @param {number} fb */
    function* filebufClose(fb){
        const fd = i32(fb + FB.FD);
        if (fd === EOF)
        {
            return 0;
        }
        const synced = yield* virtualCall(fb, SLOT.SYNC, []);
        const closed = (yield* wait(host.crt.close(fd))) | 0;
        put(fb + FB.FD, EOF);
        return synced === EOF || closed < 0 ? 0 : fb;
    }

    /** @param {number} fb @param {number} name @param {number} mode @param {number} prot */
    function* filebufOpen(fb, name, mode, prot){
        if (i32(fb + FB.FD) !== EOF)
        {
            return 0;
        }
        if (mode & (MODE.APP | MODE.TRUNC))
        {
            mode |= MODE.OUT;
        }
        let flags = mode & MODE.BINARY ? O.BINARY : O.TEXT;
        if (mode & MODE.APP)
        {
            flags |= O.APPEND;
        }
        if ((mode & MODE.TRUNC)
            || ((mode & MODE.OUT) && !(mode & (MODE.IN | MODE.APP | MODE.ATE))))
        {
            flags |= O.TRUNC;
        }
        if (!(mode & MODE.NOCREATE) && (mode & MODE.OUT))
        {
            flags |= O.CREAT;
        }
        if (mode & MODE.NOREPLACE)
        {
            flags |= O.EXCL;
        }
        flags |= (mode & MODE.IN) && (mode & MODE.OUT) ? O.RDWR
            : mode & MODE.OUT ? O.WRONLY : O.RDONLY;
        const fd = (yield* wait(host.crt.open(name, flags, prot))) | 0;
        if (fd < 0)
        {
            return 0;
        }
        put(fb + FB.FD, fd);
        put(fb + FB.CLOSE, 1);
        if ((mode & MODE.ATE) && (yield* virtualCall(fb, SLOT.SEEKOFF,
            [0, SEEK.END, mode & (MODE.IN | MODE.OUT)])) === EOF)
        {
            yield* wait(host.crt.close(fd));
            put(fb + FB.FD, EOF);
            return 0;
        }
        return fb;
    }

    const filebufVirtual = {
        /** @param {number} fb @param {number} flags */
        *delete(fb, flags){
            if (u32(fb + FB.CLOSE))
            {
                yield* filebufClose(fb);
            }
            yield* streambufFinish(fb);
            if (flags & 1)
            {
                host.release(fb);
            }
            return fb;
        },
        /** @param {number} fb */
        *sync(fb){
            const fd = i32(fb + FB.FD);
            if (fd === EOF)
            {
                return EOF;
            }
            if (u32(fb + SB.UNBUFFERED))
            {
                return 0;
            }
            const pbase = u32(fb + SB.PBASE);
            const pending = u32(fb + SB.PPTR) - pbase;
            const unread = u32(fb + SB.EGPTR) - u32(fb + SB.GPTR);
            if (pending > 0)
            {
                if (((yield* wait(host.crt.write(fd, pbase, pending))) | 0) !== pending)
                {
                    return EOF;
                }
            }
            else if (unread > 0)
            {
                // What was read ahead and not taken is given back to the file;
                // in text mode each newline stood for two bytes on the disk.
                let back = unread;
                const text = ((yield* wait(host.crt.setmode(fd, O.TEXT))) | 0) === O.TEXT;
                if (!text)
                {
                    yield* wait(host.crt.setmode(fd, O.BINARY));
                }
                else
                {
                    back += host.readMemory(u32(fb + SB.GPTR), unread)
                        .reduce((count, c)=>count + (c === 0x0a ? 1 : 0), 0);
                }
                if (((yield* wait(host.crt.seek(fd, -back, SEEK.CUR))) | 0) < 0)
                {
                    return EOF;
                }
            }
            setp(fb, 0, 0);
            setg(fb, 0, 0, 0);
            return 0;
        },
        /** @param {number} fb @param {number} buffer @param {number} length */
        *setbuf(fb, buffer, length){
            if (i32(fb + FB.FD) !== EOF && u32(fb + SB.BASE))
            {
                return 0;
            }
            return yield* streambufVirtual.setbuf(fb, buffer, length);
        },
        /** @param {number} fb @param {number} offset @param {number} dir */
        *seekoff(fb, offset, dir){
            if ((dir >>> 0) > SEEK.END || (yield* virtualCall(fb, SLOT.SYNC, [])) === EOF)
            {
                return EOF;
            }
            return (yield* wait(host.crt.seek(i32(fb + FB.FD), offset, dir))) | 0;
        },
        /** @param {number} fb @param {number} c */
        *overflow(fb, c){
            if ((yield* virtualCall(fb, SLOT.SYNC, [])) === EOF)
            {
                return EOF;
            }
            if (u32(fb + SB.UNBUFFERED))
            {
                if (c === EOF)
                {
                    return 1;
                }
                const one = host.allocate(1);
                host.writeMemory(one, Uint8Array.of(c));
                const written = (yield* wait(host.crt.write(i32(fb + FB.FD), one, 1))) | 0;
                host.release(one);
                return written === 1 ? c & 0xff : EOF;
            }
            if ((yield* allocate(fb)) === EOF)
            {
                return EOF;
            }
            setp(fb, u32(fb + SB.BASE), u32(fb + SB.EBUF));
            if (c !== EOF)
            {
                host.writeMemory(u32(fb + SB.PPTR), Uint8Array.of(c));
                put(fb + SB.PPTR, u32(fb + SB.PPTR) + 1);
            }
            return 1;
        },
        /** @param {number} fb */
        *underflow(fb){
            if (u32(fb + SB.GPTR) < u32(fb + SB.EGPTR))
            {
                return byte(u32(fb + SB.GPTR));
            }
            if ((yield* virtualCall(fb, SLOT.SYNC, [])) === EOF
                || (yield* allocate(fb)) === EOF)
            {
                return EOF;
            }
            const base = u32(fb + SB.BASE);
            const size = u32(fb + SB.EBUF) - base;
            const read = (yield* wait(host.crt.read(i32(fb + FB.FD), base, size))) | 0;
            if (read <= 0)
            {
                return EOF;
            }
            setg(fb, base, base, base + read);
            return byte(base);
        },
    };

    // --- ios ---

    /** @param {number} ios */
    function* iosInit(ios){
        zero(ios, IOS.SIZE);
        put(ios + IOS.VTABLE, tableOf('ios'));
        put(ios + IOS.STATE, STATE.BAD);
        put(ios + IOS.PRECISION, 6);
        host.writeMemory(ios + IOS.FILL, Uint8Array.of(0x20));
        put(ios + IOS.DO_LOCK, EOF);
        yield* wait(host.locks.init(ios + IOS.LOCK));
    }

    /** Hands the ios a streambuf, deleting the one it owned. @param {number} ios @param {number} sb */
    function* iosAttach(ios, sb){
        const previous = u32(ios + IOS.SB);
        if (u32(ios + IOS.DELBUF) && previous)
        {
            yield* virtualCall(previous, SLOT.DELETE, [1]);
        }
        put(ios + IOS.SB, sb);
        const state = u32(ios + IOS.STATE);
        put(ios + IOS.STATE, sb ? state & ~STATE.BAD : state | STATE.BAD);
    }

    /** @param {number} ios */
    function* iosFinish(ios){
        const sb = u32(ios + IOS.SB);
        if (u32(ios + IOS.DELBUF) && sb)
        {
            yield* virtualCall(sb, SLOT.DELETE, [1]);
        }
        put(ios + IOS.SB, 0);
        put(ios + IOS.STATE, STATE.BAD);
        yield* wait(host.locks.remove(ios + IOS.LOCK));
    }

    /** @param {number} ios @param {number} bits */
    const setstate = (ios, bits)=>put(ios + IOS.STATE, u32(ios + IOS.STATE) | bits);

    // --- istream, ostream, iostream ---

    /**
     * @param {number} object @param {number} virtInit
     * @param {string} vbtable  The table naming where this class's ios is.
     */
    function* istreamInit(object, virtInit, vbtable = 'istream-vb'){
        if (virtInit)
        {
            put(object + ISTREAM.VBTABLE, tableOf(vbtable));
            yield* iosInit(iosOf(object));
        }
        const ios = iosOf(object);
        put(ios + IOS.VTABLE, tableOf('istream'));
        put(ios + IOS.FLAGS, u32(ios + IOS.FLAGS) | FLAGS.SKIPWS);
        put(object + ISTREAM.DELIM, 0);
        put(object + ISTREAM.COUNT, 0);
        return ios;
    }

    /** @param {number} object @param {number} virtInit @param {string} vbtable */
    function* ostreamInit(object, virtInit, vbtable = 'ostream-vb'){
        if (virtInit)
        {
            put(object + OSTREAM.VBTABLE, tableOf(vbtable));
            yield* iosInit(iosOf(object));
        }
        const ios = iosOf(object);
        put(ios + IOS.VTABLE, tableOf('ostream'));
        put(object + 4, 0);
        return ios;
    }

    /** @param {number} object @param {number} virtInit */
    function* iostreamInit(object, virtInit){
        if (virtInit)
        {
            put(object, tableOf('iostream-vb-istream'));
            put(object + IOSTREAM_OSTREAM, tableOf('iostream-vb-ostream'));
            yield* iosInit(iosOf(object));
        }
        yield* istreamInit(object, 0);
        yield* ostreamInit(object + IOSTREAM_OSTREAM, 0);
        const ios = iosOf(object);
        put(ios + IOS.VTABLE, tableOf('iostream'));
        return ios;
    }

    /** @param {number} object */
    function* ostreamFlush(object){
        const ios = iosOf(object);
        if ((yield* virtualCall(u32(ios + IOS.SB), SLOT.SYNC, [])) === EOF)
        {
            setstate(ios, STATE.BAD | STATE.FAIL);
        }
        return object;
    }

    /** istream::ipfx: good, and the tied stream flushed. @param {number} object */
    function* ipfx(object){
        const ios = iosOf(object);
        put(object + ISTREAM.COUNT, 0);
        if (u32(ios + IOS.STATE) !== STATE.GOOD)
        {
            setstate(ios, STATE.FAIL);
            return false;
        }
        const tie = u32(ios + IOS.TIE);
        if (tie)
        {
            yield* ostreamFlush(tie);
        }
        return true;
    }

    /** @param {number} object */
    function* opfx(object){
        const ios = iosOf(object);
        if (u32(ios + IOS.STATE) !== STATE.GOOD)
        {
            setstate(ios, STATE.FAIL);
            return false;
        }
        const tie = u32(ios + IOS.TIE);
        if (tie)
        {
            yield* ostreamFlush(tie);
        }
        return true;
    }

    /** @param {number} object */
    function* osfx(object){
        const ios = iosOf(object);
        put(ios + IOS.WIDTH, 0);
        if (u32(ios + IOS.FLAGS) & FLAGS.UNITBUF)
        {
            yield* ostreamFlush(object);
        }
    }

    /**
     * A formatted value, padded to the width with the fill on the side the
     * flags say: `internal` pads between the sign or base and the digits.
     *
     * @param {number} object @param {string} prefix @param {string} body
     */
    function* writePadded(object, prefix, body){
        const ios = iosOf(object);
        const flags = u32(ios + IOS.FLAGS);
        const padding = String.fromCharCode(byte(ios + IOS.FILL))
            .repeat(Math.max(0, i32(ios + IOS.WIDTH) - prefix.length - body.length));
        const text = flags & FLAGS.LEFT ? prefix + body + padding
            : flags & FLAGS.INTERNAL ? prefix + padding + body
                : padding + prefix + body;
        const bytes = latin1(text);
        if ((yield* sputn(u32(ios + IOS.SB), bytes)) !== bytes.length)
        {
            setstate(ios, STATE.BAD | STATE.FAIL);
        }
    }

    /** @param {number} object @param {number} value @param {boolean} unsigned */
    function* printInteger(object, value, unsigned){
        if (!(yield* opfx(object)))
        {
            return object;
        }
        const flags = u32(iosOf(object) + IOS.FLAGS);
        const upper = (flags & FLAGS.UPPERCASE) !== 0;
        let prefix;
        let body;
        if (flags & FLAGS.HEX)
        {
            body = (value >>> 0).toString(16);
            body = upper ? body.toUpperCase() : body;
            prefix = flags & FLAGS.SHOWBASE ? (upper ? '0X' : '0x') : '';
        }
        else if (flags & FLAGS.OCT)
        {
            body = (value >>> 0).toString(8);
            prefix = flags & FLAGS.SHOWBASE ? '0' : '';
        }
        else
        {
            const number = unsigned ? value >>> 0 : value | 0;
            body = String(Math.abs(number));
            prefix = number < 0 ? '-'
                : (!unsigned && flags & FLAGS.SHOWPOS && number > 0 ? '+' : '');
        }
        yield* writePadded(object, prefix, body);
        yield* osfx(object);
        return object;
    }

    /** @param {number} object @param {number} low @param {number} high */
    function* printDouble(object, low, high){
        if (!(yield* opfx(object)))
        {
            return object;
        }
        const ios = iosOf(object);
        const flags = u32(ios + IOS.FLAGS);
        const view = new DataView(new ArrayBuffer(8));
        view.setUint32(0, low >>> 0, true);
        view.setUint32(4, high >>> 0, true);
        const value = view.getFloat64(0, true);
        const upper = (flags & FLAGS.UPPERCASE) !== 0;
        const kind = (flags & (FLAGS.SCIENTIFIC | FLAGS.FIXED)) === FLAGS.SCIENTIFIC ? 'e'
            : (flags & (FLAGS.SCIENTIFIC | FLAGS.FIXED)) === FLAGS.FIXED ? 'f' : 'g';
        const precision = i32(ios + IOS.PRECISION);
        const digits = precision > 0 || kind !== 'g' ? Math.max(0, precision) : 6;
        const format = `%${flags & FLAGS.SHOWPOINT ? '#' : ''}.${digits}`
            + (kind === 'f' ? 'f' : upper ? kind.toUpperCase() : kind);
        const text = host.format(format, [low >>> 0, high >>> 0]);
        const negative = text.startsWith('-');
        yield* writePadded(object, negative ? '-' : (flags & FLAGS.SHOWPOS && value > 0 ? '+' : ''),
            negative ? text.slice(1) : text);
        yield* osfx(object);
        return object;
    }

    /** ostream::put. @param {number} object @param {number} c */
    function* ostreamPut(object, c){
        if (yield* opfx(object))
        {
            const ios = iosOf(object);
            if ((yield* sputc(u32(ios + IOS.SB), c & 0xff)) === EOF)
            {
                setstate(ios, STATE.BAD | STATE.FAIL);
            }
            yield* osfx(object);
        }
        return object;
    }

    // --- the stream classes ---

    /**
     * Where each class keeps its ios and its own vtable, and which part of it
     * is an istream and which an ostream.
     *
     * @type {Record<string, { ios: number, istream?: number, ostream?: number }>}
     */
    const CLASSES = {
        ios: { ios: 0 },
        istream: { ios: ISTREAM.SIZE, istream: 0 },
        ostream: { ios: OSTREAM.SIZE, ostream: 0 },
        iostream: { ios: ISTREAM.SIZE + OSTREAM.SIZE, istream: 0, ostream: IOSTREAM_OSTREAM },
        istrstream: { ios: ISTREAM.SIZE, istream: 0 },
        ostrstream: { ios: OSTREAM.SIZE, ostream: 0 },
        strstream: { ios: ISTREAM.SIZE + OSTREAM.SIZE, istream: 0, ostream: IOSTREAM_OSTREAM },
        ifstream: { ios: ISTREAM.SIZE, istream: 0 },
        ofstream: { ios: OSTREAM.SIZE, ostream: 0 },
        fstream: { ios: ISTREAM.SIZE + OSTREAM.SIZE, istream: 0, ostream: IOSTREAM_OSTREAM },
    };

    /** A class's own destructor, `this` at the ios: nothing of theirs outlives the ios. */
    function* streamFinish(){
        yield 0;
    }

    /**
     * The vector deleting destructor every stream class's ios vtable holds.
     *
     * @param {string} name
     */
    const deleting = name=>/** @param {number} ios @param {number} flags */ function* (ios, flags){
        yield* streamFinish();
        yield* iosFinish(ios);
        const start = ios - CLASSES[name].ios;
        if (flags & 1)
        {
            host.release(start);
        }
        return start;
    };

    /**
     * The vbase destructor: `this` at the complete object; the class and then
     * the ios it shares are torn down.
     *
     * @param {string} name
     */
    const vbaseDestructor = name=>thiscall(4, function* (object){
        yield* streamFinish();
        yield* iosFinish(object + CLASSES[name].ios);
        return 0;
    });

    /**
     * A stream's own new strstreambuf, set as its ios's buffer to delete with it.
     *
     * @param {number} buffer @param {number} length @param {number} putAt
     */
    function* newStrstreambuf(buffer, length, putAt){
        const ssb = host.allocate(SSB.SIZE);
        if (!ssb)
        {
            return 0;
        }
        return buffer || length
            ? yield* strstreambufBuffer(ssb, buffer, length, putAt)
            : yield* strstreambufDynamic(ssb, 1);
    }

    /** @param {number} ios @param {number} sb @param {string} vtable */
    function* adopt(ios, sb, vtable){
        yield* iosAttach(ios, sb);
        put(ios + IOS.VTABLE, tableOf(vtable));
        put(ios + IOS.DELBUF, 1);
    }

    /** @param {number} buffer @param {number} mode */
    const putStart = (buffer, mode)=>(mode & (MODE.APP | MODE.ATE)
        ? buffer + host.readCString(buffer, 0x7fffffff).length : buffer);

    /**
     * @param {string} name @param {number} object @param {number} virtInit
     * @param {number} path @param {number} mode @param {number} prot @param {number} add
     */
    function* fileStream(name, object, virtInit, path, mode, prot, add){
        const ios = name === 'ifstream' ? yield* istreamInit(object, virtInit)
            : name === 'ofstream' ? yield* ostreamInit(object, virtInit)
                : yield* iostreamInit(object, virtInit);
        const fb = host.allocate(FB.SIZE);
        yield* filebufInit(fb);
        yield* adopt(ios, fb, name);
        if (!(yield* filebufOpen(fb, path, mode | add, prot)))
        {
            setstate(ios, STATE.FAIL);
        }
        return object;
    }

    // --- exports ---

    /**
     * @param {number} argBytes  Counting `this`.
     * @param {(...args: number[]) => Generator<any, any, any>} body
     */
    function thiscall(argBytes, body){
        return {
            convention: /** @type {'thiscall'} */ ('thiscall'),
            argBytes,
            /** @param {number[]} args */
            handler: args=>run(body(...args.map((value, index)=>
                (index === 0 ? value >>> 0 : value | 0)))),
        };
    }

    /** @param {number} argBytes @param {(...args: number[]) => Generator<any, any, any>} body */
    const cdecl = (argBytes, body)=>({
        convention: /** @type {'cdecl'} */ ('cdecl'),
        argBytes,
        /** @param {number[]} args */
        handler: args=>run(body(...args.map(value=>value | 0))),
    });

    /** @param {Generator<any, any, any>} steps */
    const run = steps=>{
        const caller = host.callerThread();
        return drive(steps, ()=>{
            thread = caller;
        });
    };

    /**
     * The vtables, each preceded by an empty type-information word, and the
     * vbtables: `[0, offset of the ios from the vbtable]`.
     */
    const placeTables = ()=>{
        /** @type {Record<string, string[]>} */
        const vtables = {
            streambuf: [
                '??_Estreambuf@@UAEPAXI@Z', '?sync@streambuf@@UAEHXZ',
                '?setbuf@streambuf@@UAEPAV1@PADH@Z', '?seekoff@streambuf@@UAEJJW4seek_dir@ios@@H@Z',
                '?seekpos@streambuf@@UAEJJH@Z', '?xsputn@streambuf@@UAEHPBDH@Z',
                '?xsgetn@streambuf@@UAEHPADH@Z', '?overflow@streambuf@@UAEHH@Z',
                '?underflow@streambuf@@UAEHXZ', '?pbackfail@streambuf@@UAEHH@Z',
                '?doallocate@streambuf@@MAEHXZ',
            ],
            strstreambuf: [
                '??_Estrstreambuf@@UAEPAXI@Z', '?sync@strstreambuf@@UAEHXZ',
                '?setbuf@strstreambuf@@UAEPAVstreambuf@@PADH@Z',
                '?seekoff@strstreambuf@@UAEJJW4seek_dir@ios@@H@Z',
                '?seekpos@streambuf@@UAEJJH@Z', '?xsputn@streambuf@@UAEHPBDH@Z',
                '?xsgetn@streambuf@@UAEHPADH@Z', '?overflow@strstreambuf@@UAEHH@Z',
                '?underflow@strstreambuf@@UAEHXZ', '?pbackfail@streambuf@@UAEHH@Z',
                '?doallocate@strstreambuf@@MAEHXZ',
            ],
            filebuf: [
                '??_Efilebuf@@UAEPAXI@Z', '?sync@filebuf@@UAEHXZ',
                '?setbuf@filebuf@@UAEPAVstreambuf@@PADH@Z',
                '?seekoff@filebuf@@UAEJJW4seek_dir@ios@@H@Z',
                '?seekpos@streambuf@@UAEJJH@Z', '?xsputn@streambuf@@UAEHPBDH@Z',
                '?xsgetn@streambuf@@UAEHPADH@Z', '?overflow@filebuf@@UAEHH@Z',
                '?underflow@filebuf@@UAEHXZ', '?pbackfail@streambuf@@UAEHH@Z',
                '?doallocate@streambuf@@MAEHXZ',
            ],
            exception: ['??_Eexception@@UAEPAXI@Z', '?what@exception@@UBEPBDXZ'],
            ...Object.fromEntries(Object.keys(CLASSES)
                .map(name=>[name, [`??_E${name}@@UAEPAXI@Z`]])),
        };
        /** @type {Record<string, number[]>} */
        const vbtables = {
            'istream-vb': [0, ISTREAM.SIZE],
            'ostream-vb': [0, OSTREAM.SIZE],
            'iostream-vb-istream': [0, ISTREAM.SIZE + OSTREAM.SIZE],
            'iostream-vb-ostream': [0, OSTREAM.SIZE],
        };
        const words = Object.values(vtables).reduce((sum, slots)=>sum + slots.length + 1, 0)
            + Object.values(vbtables).reduce((sum, entries)=>sum + entries.length, 0);
        let at = host.allocate(words * 4);
        /** @type {Record<string, number>} */
        const placed = {};
        for (const [name, slots] of Object.entries(vtables))
        {
            put(at, 0);
            at += 4;
            placed[name] = at;
            for (const slot of slots)
            {
                const address = host.addressOf(slot);
                put(at, address);
                const body = bodies[slot];
                if (address && body)
                {
                    own.set(address, body);
                }
                at += 4;
            }
        }
        for (const [name, entries] of Object.entries(vbtables))
        {
            placed[name] = at;
            for (const entry of entries)
            {
                put(at, entry);
                at += 4;
            }
        }
        return placed;
    };

    /** What each of this library's own vtable slots runs, by the export it is. */
    /** @type {Record<string, (...args: number[]) => Generator<any, any, any>>} */
    const bodies = {
        '??_Estreambuf@@UAEPAXI@Z': streambufVirtual.delete,
        '?sync@streambuf@@UAEHXZ': streambufVirtual.sync,
        '?setbuf@streambuf@@UAEPAV1@PADH@Z': streambufVirtual.setbuf,
        '?seekoff@streambuf@@UAEJJW4seek_dir@ios@@H@Z': streambufVirtual.seekoff,
        '?seekpos@streambuf@@UAEJJH@Z': streambufVirtual.seekpos,
        '?xsputn@streambuf@@UAEHPBDH@Z': streambufVirtual.xsputn,
        '?xsgetn@streambuf@@UAEHPADH@Z': streambufVirtual.xsgetn,
        '?overflow@streambuf@@UAEHH@Z': streambufVirtual.overflow,
        '?underflow@streambuf@@UAEHXZ': streambufVirtual.underflow,
        '?pbackfail@streambuf@@UAEHH@Z': streambufVirtual.pbackfail,
        '?doallocate@streambuf@@MAEHXZ': streambufVirtual.doallocate,
        '??_Estrstreambuf@@UAEPAXI@Z': strstreambufVirtual.delete,
        '?sync@strstreambuf@@UAEHXZ': strstreambufVirtual.sync,
        '?setbuf@strstreambuf@@UAEPAVstreambuf@@PADH@Z': strstreambufVirtual.setbuf,
        '?seekoff@strstreambuf@@UAEJJW4seek_dir@ios@@H@Z': strstreambufVirtual.seekoff,
        '?overflow@strstreambuf@@UAEHH@Z': strstreambufVirtual.overflow,
        '?underflow@strstreambuf@@UAEHXZ': strstreambufVirtual.underflow,
        '?doallocate@strstreambuf@@MAEHXZ': strstreambufVirtual.doallocate,
        '??_Efilebuf@@UAEPAXI@Z': filebufVirtual.delete,
        '?sync@filebuf@@UAEHXZ': filebufVirtual.sync,
        '?setbuf@filebuf@@UAEPAVstreambuf@@PADH@Z': filebufVirtual.setbuf,
        '?seekoff@filebuf@@UAEJJW4seek_dir@ios@@H@Z': filebufVirtual.seekoff,
        '?overflow@filebuf@@UAEHH@Z': filebufVirtual.overflow,
        '?underflow@filebuf@@UAEHXZ': filebufVirtual.underflow,
        /** @param {number} self @param {number} flags */
        '??_Eexception@@UAEPAXI@Z': function* (self, flags){
            yield* exceptionFinish(self);
            if (flags & 1)
            {
                host.release(self);
            }
            return self;
        },
        /** @param {number} self */
        '?what@exception@@UBEPBDXZ': function* (self){
            yield 0;
            return u32(self + EXCEPTION.NAME) || unknownException();
        },
        ...Object.fromEntries(Object.keys(CLASSES)
            .map(name=>[`??_E${name}@@UAEPAXI@Z`, deleting(name)])),
    };

    /** The text `what()` answers for an exception made with none. */
    let unknown = 0;
    const unknownException = ()=>{
        if (!unknown)
        {
            const text = latin1('Unknown exception\0');
            unknown = host.allocate(text.length);
            host.writeMemory(unknown, text);
        }
        return unknown;
    };

    /** @param {number} self */
    function* exceptionFinish(self){
        yield 0;
        if (u32(self + EXCEPTION.DO_FREE))
        {
            host.release(u32(self + EXCEPTION.NAME));
        }
    }

    /** @type {Record<string, any>} */
    const table = {};
    // Each slot's code is also an export of its own, which is what a derived
    // class's vtable points at, and what a derived method calls for its base.
    /** The bytes each virtual method's caller pushes, by what the method is. */
    const STACK_BYTES = {
        _E: 4, sync: 0, setbuf: 8, seekoff: 12, seekpos: 8, xsputn: 8, xsgetn: 8,
        overflow: 4, underflow: 0, pbackfail: 4, doallocate: 0, what: 0,
    };
    for (const [name, body] of Object.entries(bodies))
    {
        const method = /** @type {keyof typeof STACK_BYTES} */ (name.startsWith('??_E')
            ? '_E' : name.slice(1, name.indexOf('@')));
        table[name] = thiscall(4 + STACK_BYTES[method], body);
    }

    Object.assign(table, {
        // --- exception ---
        '??0exception@@QAE@XZ': thiscall(4, function* (self){
            yield 0;
            put(self + EXCEPTION.VTABLE, tableOf('exception'));
            put(self + EXCEPTION.NAME, 0);
            put(self + EXCEPTION.DO_FREE, 0);
            return self;
        }),
        '??0exception@@QAE@ABV0@@Z': thiscall(8, function* (self, other){
            yield 0;
            put(self + EXCEPTION.VTABLE, tableOf('exception'));
            const name = u32(other + EXCEPTION.NAME);
            const owned = u32(other + EXCEPTION.DO_FREE) !== 0 && name !== 0;
            let copy = name;
            if (owned)
            {
                const text = latin1(`${host.readCString(name, 0x10000)}\0`);
                copy = host.allocate(text.length);
                host.writeMemory(copy, text);
            }
            put(self + EXCEPTION.NAME, copy);
            put(self + EXCEPTION.DO_FREE, owned ? 1 : 0);
            return self;
        }),
        '??1exception@@UAE@XZ': thiscall(4, function* (self){
            yield* exceptionFinish(self);
            return 0;
        }),

        // --- the runtime's lock, and ios's ---
        _mtlock: cdecl(4, function* (cs){
            return yield* wait(host.locks.enter(cs >>> 0));
        }),
        _mtunlock: cdecl(4, function* (cs){
            return yield* wait(host.locks.leave(cs >>> 0));
        }),
        '?lock@ios@@QAAXXZ': cdecl(4, function* (ios){
            if (i32(ios + IOS.DO_LOCK) < 0)
            {
                yield* wait(host.locks.enter((ios + IOS.LOCK) >>> 0));
            }
            return 0;
        }),
        '?unlock@ios@@QAAXXZ': cdecl(4, function* (ios){
            if (i32(ios + IOS.DO_LOCK) < 0)
            {
                yield* wait(host.locks.leave((ios + IOS.LOCK) >>> 0));
            }
            return 0;
        }),

        // --- ios ---
        '??1ios@@UAE@XZ': thiscall(4, function* (ios){
            yield* iosFinish(ios);
            return 0;
        }),
        '?clear@ios@@QAEXH@Z': thiscall(8, function* (ios, state){
            yield 0;
            put(ios + IOS.STATE, state);
            return 0;
        }),
        '?openprot@filebuf@@2HB': {
            data: ()=>{
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setInt32(0, OPENPROT, true);
                return bytes;
            },
        },

        // --- strstreambuf ---
        '??0strstreambuf@@QAE@H@Z': thiscall(8, function* (self, increase){
            return yield* strstreambufDynamic(self, increase);
        }),
        '??1strstreambuf@@UAE@XZ': thiscall(4, function* (self){
            yield* strstreambufFinish(self);
            return 0;
        }),
        '?str@strstreambuf@@QAEPADXZ': thiscall(4, function* (self){
            yield 0;
            if (!u32(self + SSB.CONSTANT))
            {
                put(self + SSB.DYNAMIC, 0);
            }
            return u32(self + SB.BASE);
        }),
        '?freeze@strstreambuf@@QAEXH@Z': thiscall(8, function* (self, frozen){
            yield 0;
            if (!u32(self + SSB.CONSTANT))
            {
                put(self + SSB.DYNAMIC, frozen ? 0 : 1);
            }
            return 0;
        }),

        // --- the streams' constructors: `this` at the object, the last word
        // saying whether it is the most derived and builds the ios ---
        '??0iostream@@QAE@PAVstreambuf@@@Z': thiscall(12, function* (self, sb, virtInit){
            const ios = yield* iostreamInit(self, virtInit);
            yield* iosAttach(ios, sb >>> 0);
            return self;
        }),
        '??0istrstream@@QAE@PADH@Z': thiscall(16, function* (self, buffer, length, virtInit){
            const ios = yield* istreamInit(self, virtInit);
            yield* adopt(ios, yield* newStrstreambuf(buffer >>> 0, length, 0), 'istrstream');
            return self;
        }),
        '??0ostrstream@@QAE@XZ': thiscall(8, function* (self, virtInit){
            const ios = yield* ostreamInit(self, virtInit);
            yield* adopt(ios, yield* newStrstreambuf(0, 0, 0), 'ostrstream');
            return self;
        }),
        '??0ostrstream@@QAE@PADHH@Z': thiscall(20, function* (self, buffer, length, mode, virtInit){
            const ios = yield* ostreamInit(self, virtInit);
            yield* adopt(ios, yield* newStrstreambuf(buffer >>> 0, length,
                putStart(buffer >>> 0, mode)), 'ostrstream');
            return self;
        }),
        '??0strstream@@QAE@PADHH@Z': thiscall(20, function* (self, buffer, length, mode, virtInit){
            const ios = yield* iostreamInit(self, virtInit);
            yield* adopt(ios, yield* newStrstreambuf(buffer >>> 0, length,
                putStart(buffer >>> 0, mode)), 'strstream');
            return self;
        }),
        '??0ifstream@@QAE@PBDHH@Z': thiscall(20, function* (self, name, mode, prot, virtInit){
            return yield* fileStream('ifstream', self, virtInit, name >>> 0, mode, prot, MODE.IN);
        }),
        '??0ofstream@@QAE@PBDHH@Z': thiscall(20, function* (self, name, mode, prot, virtInit){
            return yield* fileStream('ofstream', self, virtInit, name >>> 0, mode, prot, MODE.OUT);
        }),
        '??0fstream@@QAE@PBDHH@Z': thiscall(20, function* (self, name, mode, prot, virtInit){
            return yield* fileStream('fstream', self, virtInit, name >>> 0, mode, prot, 0);
        }),
        '?close@ifstream@@QAEXXZ': thiscall(4, function* (self){
            const ios = iosOf(self);
            if (yield* filebufClose(u32(ios + IOS.SB)))
            {
                put(ios + IOS.STATE, STATE.GOOD);
            }
            else
            {
                setstate(ios, STATE.FAIL);
            }
            return 0;
        }),

        // --- istream ---
        '?get@istream@@QAEHXZ': thiscall(4, function* (self){
            if (!(yield* ipfx(self)))
            {
                return EOF;
            }
            const ios = iosOf(self);
            const c = yield* sbumpc(u32(ios + IOS.SB));
            if (c === EOF)
            {
                setstate(ios, STATE.EOF | STATE.FAIL);
            }
            else
            {
                put(self + ISTREAM.COUNT, 1);
            }
            return c;
        }),
        '?read@istream@@QAEAAV1@PADH@Z': thiscall(12, function* (self, buffer, count){
            if (yield* ipfx(self))
            {
                const ios = iosOf(self);
                const got = yield* virtualCall(u32(ios + IOS.SB), SLOT.XSGETN,
                    [buffer >>> 0, count]);
                put(self + ISTREAM.COUNT, got);
                if (got !== count)
                {
                    setstate(ios, STATE.EOF | STATE.FAIL);
                }
            }
            return self;
        }),
        '?seekg@istream@@QAEAAV1@J@Z': thiscall(8, function* (self, position){
            const ios = iosOf(self);
            if ((yield* virtualCall(u32(ios + IOS.SB), SLOT.SEEKPOS, [position, MODE.IN])) === EOF)
            {
                setstate(ios, STATE.FAIL);
            }
            return self;
        }),
        '?seekg@istream@@QAEAAV1@JW4seek_dir@ios@@@Z': thiscall(12, function* (self, offset, dir){
            const ios = iosOf(self);
            const at = yield* virtualCall(u32(ios + IOS.SB), SLOT.SEEKOFF, [offset, dir, MODE.IN]);
            if (at === EOF)
            {
                setstate(ios, STATE.FAIL);
            }
            return self;
        }),
        '?tellg@istream@@QAEJXZ': thiscall(4, function* (self){
            const ios = iosOf(self);
            const at = yield* virtualCall(u32(ios + IOS.SB), SLOT.SEEKOFF, [0, SEEK.CUR, MODE.IN]);
            if (at === EOF)
            {
                setstate(ios, STATE.FAIL);
            }
            return at;
        }),

        // --- ostream ---
        '??6ostream@@QAEAAV0@E@Z': thiscall(8, function* (self, c){
            if (yield* opfx(self))
            {
                yield* writePadded(self, '', String.fromCharCode(c & 0xff));
                yield* osfx(self);
            }
            return self;
        }),
        '??6ostream@@QAEAAV0@H@Z': thiscall(8, function* (self, value){
            return yield* printInteger(self, value, false);
        }),
        '??6ostream@@QAEAAV0@J@Z': thiscall(8, function* (self, value){
            return yield* printInteger(self, value, false);
        }),
        '??6ostream@@QAEAAV0@I@Z': thiscall(8, function* (self, value){
            return yield* printInteger(self, value, true);
        }),
        '??6ostream@@QAEAAV0@K@Z': thiscall(8, function* (self, value){
            return yield* printInteger(self, value, true);
        }),
        '??6ostream@@QAEAAV0@N@Z': thiscall(12, function* (self, low, high){
            return yield* printDouble(self, low, high);
        }),
        '??6ostream@@QAEAAV0@PBD@Z': thiscall(8, function* (self, text){
            if (yield* opfx(self))
            {
                yield* writePadded(self, '', text ? host.readCString(text >>> 0, 0x7fffffff) : '');
                yield* osfx(self);
            }
            return self;
        }),
        '??6ostream@@QAEAAV0@PBX@Z': thiscall(8, function* (self, pointer){
            if (yield* opfx(self))
            {
                const upper = (u32(iosOf(self) + IOS.FLAGS) & FLAGS.UPPERCASE) !== 0;
                yield* writePadded(self, upper ? '0X' : '0x',
                    (pointer >>> 0).toString(16).toUpperCase().padStart(8, '0'));
                yield* osfx(self);
            }
            return self;
        }),
        '?put@ostream@@QAEAAV1@E@Z': thiscall(8, function* (self, c){
            return yield* ostreamPut(self, c);
        }),
        '?write@ostream@@QAEAAV1@PBDH@Z': thiscall(12, function* (self, data, count){
            if (yield* opfx(self))
            {
                const ios = iosOf(self);
                const sb = u32(ios + IOS.SB);
                const written = count > 0
                    ? yield* virtualCall(sb, SLOT.XSPUTN, [data >>> 0, count]) : 0;
                if (written !== Math.max(0, count))
                {
                    setstate(ios, STATE.BAD | STATE.FAIL);
                }
                yield* osfx(self);
            }
            return self;
        }),
        '?ends@@YAAAVostream@@AAV1@@Z': cdecl(4, function* (stream){
            return yield* ostreamPut(stream >>> 0, 0);
        }),
    });

    // --- destructors: `this` at the ios for the class's own, at the object
    // for the vbase one that also ends the ios ---
    for (const name of Object.keys(CLASSES).filter(each=>each !== 'ios'))
    {
        table[`??1${name}@@UAE@XZ`] = thiscall(4, function* (){
            yield* streamFinish();
            return 0;
        });
        table[`??_D${name}@@QAEXXZ`] = vbaseDestructor(name);
    }
    return table;
}
