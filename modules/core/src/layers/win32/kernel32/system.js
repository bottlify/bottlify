/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * What a program asks about the machine it is running on, the calendar, and the
 * handles it holds: the processor and page size, the two time formats Windows
 * keeps and the conversions between them, whether a pointer can be touched, and
 * what kind of thing a handle names.
 *
 * These sit together because none of them is large enough to be its own subject
 * and all of them are answered from the same three things -- the clock, the
 * handle table, and a decision about what machine to claim to be.
 *
 * The claim is deliberate: one processor, a 4 KiB page, a 64 KiB allocation
 * granularity, and a Pentium-class x86. A program branches on all four -- a
 * thread pool sizes itself from the processor count, an allocator rounds to the
 * granularity -- so the answer has to be one a program of this era knows what
 * to do with rather than one that flatters the host.
 */

import { lstrcpyCode, lstrlenCode } from './lstr.js';
import { assemble } from '../msvcrt/guest-code.js';
import {
    PROCESSOR, PROCESSOR_FEATURES, PROCESSOR_LEVEL, PROCESSOR_REVISION,
} from './processor.js';

/** Error codes this file can produce. */
const ERROR_CALL_NOT_IMPLEMENTED = 120;
const ERROR_INVALID_HANDLE = 6;
/** TerminateProcess on a process that has already ended. */
const ERROR_ACCESS_DENIED = 5;

/** sizeof(SYSTEM_INFO) and sizeof(SYSTEMTIME). */
const SYSTEM_INFO_SIZE = 36;
const SYSTEMTIME_SIZE = 16;

/** The machine claimed. See the note above. */
const PROCESSOR_ARCHITECTURE_INTEL = 0;
const PROCESSOR_INTEL_PENTIUM = 586;
const PAGE_SIZE = 0x1000;
const ALLOCATION_GRANULARITY = 0x10000;
const MINIMUM_APPLICATION_ADDRESS = 0x00010000;
const MAXIMUM_APPLICATION_ADDRESS = 0x7ffeffff;

/** What GetFileType answers. */
const FILE_TYPE_UNKNOWN = 0x0000;
const FILE_TYPE_DISK = 0x0001;
const FILE_TYPE_CHAR = 0x0002;
const FILE_TYPE_PIPE = 0x0003;

/** Reported for a process that has not exited. */
const STILL_ACTIVE = 259;

/** The pseudo-handle for the running process; -1 on every Windows. */
const CURRENT_PROCESS = 0xffffffff;

/** 100ns units between the FILETIME epoch (1601-01-01) and the Unix one. */
const FILETIME_AT_UNIX_EPOCH = 116_444_736_000_000_000n;

/**
 * The relative thread priorities a process of the normal class may set: idle,
 * lowest, below normal, normal, above normal, highest, time-critical. The gaps
 * belong to the realtime class and are refused as a parameter, as they are on
 * Windows.
 */
const THREAD_PRIORITIES = new Set([-15, -2, -1, 0, 1, 2, 15]);
const THREAD_PRIORITY_ERROR_RETURN = 0x7fffffff;

/**
 * MulDiv's code, stdcall: the product in EDX:EAX from `imul`, its magnitude
 * and the divisor's taken with the quotient's sign kept in ESI, half the
 * divisor added, then `div` -- after the check that the quotient fits a word,
 * so it cannot fault -- and -1 for a divisor of 0 or a magnitude past
 * 2^31 - 1.
 */
export const MULDIV_CODE = assemble([
    [0x53, 0x56],                                   // push ebx; push esi
    [0x8b, 0x4c, 0x24, 0x14],                       // mov ecx, [esp+20]: the divisor
    [0x85, 0xc9],                                   // test ecx, ecx
    { jump: [0x74], to: 'fail', short: true },      // jz
    [0x8b, 0x44, 0x24, 0x0c],                       // mov eax, [esp+12]
    [0xf7, 0x6c, 0x24, 0x10],                       // imul dword [esp+16]
    [0x89, 0xd6, 0x31, 0xce],                       // mov esi, edx; xor esi, ecx: the sign
    [0x85, 0xd2],                                   // test edx, edx
    { jump: [0x79], to: 'product', short: true },   // jns
    [0xf7, 0xda, 0xf7, 0xd8, 0x83, 0xda, 0x00],     // neg edx; neg eax; sbb edx, 0
    'product',
    [0x85, 0xc9],                                   // test ecx, ecx
    { jump: [0x79], to: 'divisor', short: true },   // jns
    [0xf7, 0xd9],                                   // neg ecx
    'divisor',
    [0x89, 0xcb, 0xd1, 0xeb],                       // mov ebx, ecx; shr ebx, 1: the half
    [0x01, 0xd8, 0x83, 0xd2, 0x00],                 // add eax, ebx; adc edx, 0
    [0x39, 0xca],                                   // cmp edx, ecx
    { jump: [0x73], to: 'fail', short: true },      // jae: no word holds the quotient
    [0xf7, 0xf1],                                   // div ecx
    [0x85, 0xc0],                                   // test eax, eax
    { jump: [0x78], to: 'fail', short: true },      // js: past 2^31 - 1
    [0x85, 0xf6],                                   // test esi, esi
    { jump: [0x79], to: 'done', short: true },      // jns
    [0xf7, 0xd8],                                   // neg eax
    'done',
    [0x5e, 0x5b, 0xc2, 0x0c, 0x00],                 // pop esi; pop ebx; ret 12
    'fail',
    [0x83, 0xc8, 0xff],                             // or eax, -1
    [0x5e, 0x5b, 0xc2, 0x0c, 0x00],
]);

/**
 * MulDiv's answer, as its code computes it.
 *
 * @param {number} number @param {number} numerator @param {number} denominator
 */
export function mulDiv(number, numerator, denominator){
    const divisor = BigInt(denominator | 0);
    if (divisor === 0n)
    {
        return -1 >>> 0;
    }
    const product = BigInt(number | 0) * BigInt(numerator | 0);
    const magnitude = ((product < 0n ? -product : product) + (divisor < 0n ? -divisor
        : divisor) / 2n) / (divisor < 0n ? -divisor : divisor);
    if (magnitude > 0x7fffffffn)
    {
        return -1 >>> 0;
    }
    return Number(BigInt.asUintN(32, product < 0n !== divisor < 0n ? -magnitude : magnitude));
}

/** GetCurrentThread hands out this, and it is -2 on every Windows. */
const CURRENT_THREAD = 0xfffffffe;

/** The FormatMessage flags that change what it does. */
const FORMAT_MESSAGE_ALLOCATE_BUFFER = 0x00000100;
const FORMAT_MESSAGE_IGNORE_INSERTS = 0x00000200;
const FORMAT_MESSAGE_FROM_STRING = 0x00000400;
const FORMAT_MESSAGE_FROM_SYSTEM = 0x00001000;
const FORMAT_MESSAGE_ARGUMENT_ARRAY = 0x00002000;

/**
 * How far a string argument is read before it is taken for a pointer that is
 * not one. Nothing in the lstr family bounds a string -- a program hands
 * lstrcpy a whole script it just read from its archive -- so the bound is a
 * whole address space away, and an unterminated buffer ends at the fault the
 * family already survives.
 */
const MAX_STRING = 0x7fffffff;

/** Codes this surface can also report. */
const ERROR_INVALID_PARAMETER = 87;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** What DeactivateActCtx answers for a cookie that is not the innermost. */
const ERROR_SXS_INVALID_DEACTIVATION = 14065;
/** What CreateActCtx sets when it cannot build a context from a manifest. */
const ERROR_SXS_CANT_GEN_ACTCTX = 14001;
const INVALID_HANDLE_VALUE = 0xffffffff;
/** No activation context has this section: what a process without a manifest is told. */


/**
 * What FormatMessage says about a code, for the codes this build produces.
 *
 * A program shows or logs these, so they are the real Windows wordings rather
 * than paraphrases: a person searching for the text of an error they saw should
 * find the same results they would from a real machine.
 */
const SYSTEM_MESSAGES = Object.freeze({
    0: 'The operation completed successfully.',
    2: 'The system cannot find the file specified.',
    3: 'The system cannot find the path specified.',
    5: 'Access is denied.',
    6: 'The handle is invalid.',
    8: 'Not enough memory resources are available to process this command.',
    18: 'There are no more files.',
    50: 'The request is not supported.',
    80: 'The file exists.',
    87: 'The parameter is incorrect.',
    111: 'The file name is too long.',
    120: 'This function is not supported on this system.',
    122: 'The data area passed to a system call is too small.',
    126: 'The specified module could not be found.',
    127: 'The specified procedure could not be found.',
    145: 'The directory is not empty.',
    183: 'Cannot create a file when that file already exists.',
    259: 'No more data is available.',
    267: 'The directory name is invalid.',
});

/**
 * The sign of a comparison, which is all lstrcmp promises. A caller may test
 * it against zero and nothing else, so returning a difference of bytes would
 * be inventing a guarantee.
 *
 * @param {string} left @param {string} right
 */
const compare = (left, right)=>(left < right ? -1 : (left > right ? 1 : 0));

/**
 * @typedef {Object} SystemHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} systemTimeMs   Guest wall clock, milliseconds since 1970.
 * @property {(code: number) => void} setLastError
 * @property {(handle: number, type?: string) => any} resolveHandle
 * @property {() => any} currentThread
 * @property {(code: number) => void} exit
 * @property {() => any} park
 * @property {(bytes: number) => number} [allocate]
 *           Guest memory, for the one caller that asks for it:
 *           FormatMessage with FORMAT_MESSAGE_ALLOCATE_BUFFER. Without
 *           it that one flag is refused and everything else works.
 * @property {number} [ramTop]  Where guest RAM ends. With it lstrlen and lstrcpy in
 *           both widths are guest code (`lstr.js`), for the pointers it can read
 *           without a fault.
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(thread: any, result: number) => void} [wake]
 *           Ends a thread's wait with its answer: how a thread waiting on a
 *           child another one terminates goes on. Without it that thread
 *           stays waiting.
 */

/**
 * @param {SystemHost} host
 */
export function createSystemFunctions(host){
    /**
     * What SetErrorMode last recorded. Nothing reads it but the next call, and
     * that is enough: the save-and-restore pattern a caller uses depends only on
     * getting back what it put in.
     */
    let errorMode = 0;

    /**
     * The lstr family catches the fault a bad pointer raises and answers NULL:
     * Windows wraps each of them in an exception handler, and programs of the
     * era lean on it -- a pointer that is -1 or garbage is handed to lstrcpy
     * and the NULL is what they test for. Raised through to the machine, the
     * same call stops the program with a fault it was written to survive.
     *
     * @template {number[]} A
     * @param {(args: A) => number} handler
     * @returns {(args: A) => number}
     */
    const survivesFault = handler=>args=>{
        try
        {
            return handler(args);
        }
        catch (e){
            void e;
            host.setLastError(ERROR_INVALID_PARAMETER);
            return 0;
        }
    };

    /**
     * An lstr export as guest code, handing to its handler what the code
     * does not read.
     *
     * @param {(at: number, trap: number, top: number) => Uint8Array} make
     */
    const lstrCode = make=>(host.ramTop
        ? {
            /**
             * @this {{ argBytes: number, handler: Function }}
             * @param {import('../msvcrt/guest-code.js').CodeBuilder} builder
             */
            code(builder){
                const trap = builder.register({
                    convention: 'stdcall', argBytes: this.argBytes, handler: this.handler,
                });
                const code = make(0, 0, /** @type {number} */ (host.ramTop));
                builder.jump(code.length - 4, trap);
                return code;
            },
        }
        : {});

    /**
     * A terminated string of `width`-byte units, read a span at a time -- up to
     * 64 bytes and never across a page -- rather than a unit at a time: a
     * read per character was an allocation and a region check per character,
     * most of what an lstrlen cost. A span that cannot be read whole is read a
     * unit at a time, so a string ending just short of unmapped memory reads
     * as it always did, and one running into it throws where it always did.
     *
     * @param {number} address @param {number} maxLength @param {1 | 2} width
     */
    const readUnits = (address, maxLength, width)=>{
        let text = '';
        let at = address;
        let left = maxLength;
        while (left > 0)
        {
            const units = Math.min(left, 64 / width,
                Math.max(1, (PAGE_SIZE - (at & (PAGE_SIZE - 1))) / width | 0));
            /** @type {Uint8Array | null} */
            let bytes = null;
            try
            {
                bytes = host.readMemory(at, units * width);
            }
            catch (e){
                void e;
            }
            for (let i = 0; i < units; i++)
            {
                const pair = bytes ?? host.readMemory(at + i * width, width);
                const from = bytes ? i * width : 0;
                const unit = width === 1 ? pair[from] : pair[from] | pair[from + 1] << 8;
                if (unit === 0)
                {
                    return text;
                }
                text += String.fromCharCode(unit);
            }
            at += units * width;
            left -= units;
        }
        return text;
    };

    /** @param {number} address @param {number} maxLength */
    const readAnsi = (address, maxLength)=>readUnits(address, maxLength, 1);

    /** @param {number} address @param {number} maxLength */
    const readWide = (address, maxLength)=>readUnits(address, maxLength, 2);

    /** @param {number} address @param {string} text  Written with a terminator. */
    const writeAnsi = (address, text)=>{
        const bytes = new Uint8Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            bytes[at] = text.charCodeAt(at) & 0xff;
        }
        host.writeMemory(address, bytes);
    };

    /**
     * The buffer protocol these two share: nothing written and the length
     * reported when there is no room, the length written otherwise -- in both
     * cases without the terminator, which is what FormatMessage and
     * GetProfileString both document.
     *
     * @param {number} buffer @param {number} size @param {string} text
     */
    const writeAnsiTo = (buffer, size, text)=>{
        if (buffer === 0 || text.length + 1 > size)
        {
            return 0;
        }
        writeAnsi(buffer, text);
        return text.length;
    };

    /** @param {number} address @param {number} value */
    const writeDword = (address, value)=>{
        host.writeMemory(address, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };

    /** @param {number} address */
    const readDword = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @type {number[]} What ActivateActCtx put on the stack, innermost last. */
    const activations = [];

    /**
     * CreateActCtxA and CreateActCtxW, which differ only in the strings
     * this build never reads.
     *
     * @param {string} name
     * @returns {(args: number[]) => number}
     */
    const createActCtx = name=>([actCtx])=>{
        // cbSize, dwFlags and lpSource are the least any version carries.
        if ((actCtx >>> 0) === 0 || readDword(actCtx >>> 0) < 12)
        {
            host.setLastError(ERROR_INVALID_PARAMETER);
            return INVALID_HANDLE_VALUE;
        }
        host.divergence?.(name, 'manifests are not read; no activation context is built');
        host.setLastError(ERROR_SXS_CANT_GEN_ACTCTX);
        return INVALID_HANDLE_VALUE;
    };

    /**
     * One insert's text. The conversion is the printf spelling a message
     * carries between the exclamation marks, and it decides how the
     * argument's slot reads: `s` a string pointer, `d`/`i` a signed decimal,
     * `u` an unsigned one, `x`/`X` hexadecimal, `o` octal, `c` a character.
     * There is no insert without a conversion in a message table, but a
     * caller's own format string may write a bare `%1`; a string is the
     * default, which is the reading that makes `%1 = %2` expand two text
     * arguments.
     *
     * `w` asks for a wide argument and `h` for a narrow one, and a capital
     * `S` or `C` is the other width to the family, as it is in printf. A
     * conversion this surface does not format produces nothing rather than a
     * reading of the slot that would be a different type's. The family's own
     * width is the caller's: FormatMessageW reads a bare `s` as wide and `S`
     * as narrow.
     *
     * @param {number} value @param {string} conversion @param {boolean} wideCaller
     * @returns {string}
     */
    const insertValue = (value, conversion, wideCaller)=>{
        const shape = conversion.toLowerCase();
        const last = conversion === '' ? 's' : conversion[conversion.length - 1];
        const other = last === 'S' || last === 'C';
        const wide = shape.includes('w') || (!shape.includes('h') && wideCaller !== other);
        switch (last.toLowerCase())
        {
            case 's':
                return (value >>> 0) === 0 ? ''
                    : (wide ? readWide(value >>> 0, MAX_STRING)
                        : readAnsi(value >>> 0, MAX_STRING));
            case 'c':
                return wide ? String.fromCharCode(value & 0xffff)
                    : String.fromCharCode(value & 0xff);
            case 'd':
            case 'i':
                return String(value | 0);
            case 'u':
                return String(value >>> 0);
            case 'x': {
                const hex = (value >>> 0).toString(16);
                return last === 'X' ? hex.toUpperCase() : hex;
            }
            case 'o':
                return (value >>> 0).toString(8);
            default:
                return '';
        }
    };

    /**
     * FormatMessage's insert pass over a caller's own format string: `%1`
     * through `%9` take the n-th argument, `%%` is a literal percent, and
     * everything else is copied through.
     *
     * The arguments are a va_list, not an array: `argumentsPtr` points at the
     * pointer to the first value, so it is dereferenced once before indexing.
     * Reading the pointer as the array itself is what makes the first value a
     * stack address, and answering ERROR_INVALID_PARAMETER when that address
     * is then read as a string -- which is the error Windows answers for a
     * malformed call. With FORMAT_MESSAGE_ARGUMENT_ARRAY the caller says the
     * pointer *is* the array, and then it is indexed directly.
     *
     * @param {string} text @param {number} argumentsPtr @param {boolean} array
     * @param {boolean} [wideCaller]
     * @returns {string}
     */
    const insertArguments = (text, argumentsPtr, array, wideCaller = false)=>{
        const base = array ? argumentsPtr : readDword(argumentsPtr);
        /** @param {number} index */
        const valueAt = index=>readDword(base + index * 4);
        let out = '';
        for (let at = 0; at < text.length; at++)
        {
            const ch = text[at];
            if (ch !== '%')
            {
                out += ch;
                continue;
            }
            const next = text[at + 1];
            if (next === '%')
            {
                out += '%';
                at++;
                continue;
            }
            if (next === undefined || next < '1' || next > '9')
            {
                out += ch;
                continue;
            }
            const index = next.charCodeAt(0) - 0x31;
            at++;
            let conversion = 's';
            if (text[at + 1] === '!')
            {
                const close = text.indexOf('!', at + 2);
                if (close > at)
                {
                    conversion = text.slice(at + 2, close);
                    at = close;
                }
            }
            out += insertValue(valueAt(index), conversion, wideCaller);
        }
        return out;
    };

    /** @param {number} address @param {string} text  UTF-16, written with a terminator. */
    const writeWide = (address, text)=>{
        const units = new Uint16Array(text.length + 1);
        for (let at = 0; at < text.length; at++)
        {
            units[at] = text.charCodeAt(at);
        }
        host.writeMemory(address, new Uint8Array(units.buffer));
    };

    /**
     * FormatMessageA and FormatMessageW: one body, the width of the source,
     * the inserts and the buffer the only difference.
     *
     * @param {boolean} wide
     */
    const formatMessage = wide=>({
        argBytes: 28,
        /** @param {number[]} args */
        handler: survivesFault(([flags, source, messageId, , buffer, size,
            argumentsPtr])=>{
            const asked = flags >>> 0;
            /** @type {string} */
            let text;
            if ((asked & FORMAT_MESSAGE_FROM_STRING) !== 0)
            {
                text = (wide ? readWide : readAnsi)(source >>> 0, MAX_STRING);
                if ((asked & FORMAT_MESSAGE_IGNORE_INSERTS) === 0
                    && (argumentsPtr >>> 0) !== 0)
                {
                    text = insertArguments(text, argumentsPtr >>> 0,
                        (asked & FORMAT_MESSAGE_ARGUMENT_ARRAY) !== 0, wide);
                }
            }
            else if ((asked & FORMAT_MESSAGE_FROM_SYSTEM) !== 0)
            {
                const code = messageId >>> 0;
                text = /** @type {Record<number, string>} */ (SYSTEM_MESSAGES)[code]
                    ?? `Error ${code}.`;
            }
            else
            {
                // FROM_HMODULE needs a message table in a module, which no
                // caller in this build asks this surface for.
                host.setLastError(ERROR_CALL_NOT_IMPLEMENTED);
                return 0;
            }

            const unit = wide ? 2 : 1;
            const write = wide ? writeWide : writeAnsi;
            if ((asked & FORMAT_MESSAGE_ALLOCATE_BUFFER) !== 0)
            {
                if (!host.allocate || buffer === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                const address = host.allocate((text.length + 1) * unit);
                if (address === 0)
                {
                    host.setLastError(ERROR_NOT_ENOUGH_MEMORY);
                    return 0;
                }
                write(address, text);
                writeDword(buffer >>> 0, address);
                return text.length;
            }
            if (buffer === 0 || text.length + 1 > (size >>> 0))
            {
                return 0;
            }
            write(buffer >>> 0, text);
            return text.length;
        }),
    });

    /** @param {number} address @param {number} length */
    const readable = (address, length)=>{
        try
        {
            host.readMemory(address, Math.max(length, 1));
            return true;
        }
        catch (e){
            void e;
            return false;
        }
    };

    /**
     * Whether a string can be read to its terminator, or to a count of
     * characters, without leaving mapped memory. Probed a page at a time
     * rather than a character at a time: the count is usually unlimited and
     * the terminator is what stops the walk.
     *
     * @param {number} address @param {number} count @param {1 | 2} width
     */
    const stringReadable = (address, count, width)=>{
        if (address === 0)
        {
            return false;
        }
        let at = address;
        let left = count;
        while (left > 0)
        {
            const span = Math.min(left * width, PAGE_SIZE - (at & (PAGE_SIZE - 1)));
            /** @type {Uint8Array} */
            let bytes;
            try
            {
                bytes = host.readMemory(at, span);
            }
            catch (e){
                void e;
                return false;
            }
            for (let i = 0; i + width <= bytes.length; i += width)
            {
                if (bytes[i] === 0 && (width === 1 || bytes[i + 1] === 0))
                {
                    return true;
                }
            }
            at += span;
            left -= span / width;
        }
        return true;
    };

    /** @param {number} handle @param {string} [type] */
    const object = (handle, type)=>{
        try
        {
            return host.resolveHandle(handle >>> 0, type);
        }
        catch (e){
            void e;
            return null;
        }
    };

    /**
     * The thread a handle names, which is most often the caller's own through
     * the pseudo-handle: a program sets its priority on itself far more
     * often than on a thread it holds a real handle to.
     *
     * @param {number} handle
     */
    const thread = handle=>((handle >>> 0) === CURRENT_THREAD
        ? host.currentThread()
        : object(handle, 'thread'));

    /** @param {bigint} filetime @returns {Uint8Array} SYSTEMTIME */
    const systemTimeFrom = filetime=>{
        const milliseconds = Number((filetime - FILETIME_AT_UNIX_EPOCH) / 10_000n);
        const when = new Date(milliseconds);
        const bytes = new Uint8Array(SYSTEMTIME_SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(0, when.getUTCFullYear(), true);
        view.setUint16(2, when.getUTCMonth() + 1, true);
        view.setUint16(4, when.getUTCDay(), true);
        view.setUint16(6, when.getUTCDate(), true);
        view.setUint16(8, when.getUTCHours(), true);
        view.setUint16(10, when.getUTCMinutes(), true);
        view.setUint16(12, when.getUTCSeconds(), true);
        view.setUint16(14, when.getUTCMilliseconds(), true);
        return bytes;
    };

    /** @param {number} address @returns {bigint} */
    const readFileTime = address=>{
        const bytes = host.readMemory(address, 8);
        return new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true);
    };

    /** @param {number} address @param {bigint} value */
    const writeFileTime = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, value, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address The SYSTEMTIME to read. */
    const filetimeFrom = address=>{
        const bytes = host.readMemory(address, SYSTEMTIME_SIZE);
        const view = new DataView(bytes.buffer, bytes.byteOffset, SYSTEMTIME_SIZE);
        const milliseconds = Date.UTC(
            view.getUint16(0, true), view.getUint16(2, true) - 1, view.getUint16(6, true),
            view.getUint16(8, true), view.getUint16(10, true), view.getUint16(12, true),
            view.getUint16(14, true));
        return BigInt(milliseconds) * 10_000n + FILETIME_AT_UNIX_EPOCH;
    };

    /** GetSystemInfo, and GetNativeSystemInfo, which on a 32-bit system is the same. */
    const systemInfo = {
        argBytes: 4,
        /** @param {number[]} args */
        handler: ([info])=>{
            const bytes = new Uint8Array(SYSTEM_INFO_SIZE);
            const view = new DataView(bytes.buffer);
            view.setUint16(0, PROCESSOR_ARCHITECTURE_INTEL, true);
            view.setUint32(4, PAGE_SIZE, true);
            view.setUint32(8, MINIMUM_APPLICATION_ADDRESS, true);
            view.setUint32(12, MAXIMUM_APPLICATION_ADDRESS, true);
            view.setUint32(16, (1 << PROCESSOR.count) - 1, true); // the mask
            view.setUint32(20, PROCESSOR.count, true);
            view.setUint32(24, PROCESSOR_INTEL_PENTIUM, true);
            view.setUint32(28, ALLOCATION_GRANULARITY, true);
            // The family and the model and stepping, as CPUID gives them.
            view.setUint16(32, PROCESSOR_LEVEL, true);
            view.setUint16(34, PROCESSOR_REVISION, true);
            host.writeMemory(info >>> 0, bytes);
            return 0;
        },
    };

    /** Both time queries answer the same thing; see GetLocalTime. */
    const nowAsSystemTime = ()=>systemTimeFrom(
        BigInt(Math.trunc(host.systemTimeMs())) * 10_000n + FILETIME_AT_UNIX_EPOCH);

    return {
        /**
         * BOOL IsProcessorFeaturePresent(DWORD ProcessorFeature)
         *
         * A runtime picks its memcpy and its floating-point paths from these,
         * so a yes for an instruction the emulated processor lacks is a fault
         * later at an address that means nothing.
         */
        IsProcessorFeaturePresent: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([feature])=>PROCESSOR_FEATURES.get(feature >>> 0) === true ? 1 : 0,
        },

        /** VOID GetSystemInfo(LPSYSTEM_INFO lpSystemInfo) */
        GetSystemInfo: systemInfo,

        /**
         * VOID GetNativeSystemInfo(LPSYSTEM_INFO lpSystemInfo)
         *
         * What the machine is beneath WOW64; with no WOW64 on a 32-bit
         * system, the same machine GetSystemInfo reports.
         */
        GetNativeSystemInfo: systemInfo,

        /**
         * BOOL IsWow64Process(HANDLE hProcess, PBOOL Wow64Process)
         *
         * FALSE for every process: this is a 32-bit system, and a process
         * runs under WOW64 only on a 64-bit one.
         */
        IsWow64Process: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, answer])=>{
                if ((handle >>> 0) !== CURRENT_PROCESS && !object(handle, 'process'))
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                host.writeMemory(answer >>> 0, new Uint8Array(4));
                return 1;
            },
        },

        /**
         * int MulDiv(int nNumber, int nNumerator, int nDenominator)
         *
         * Rounded rather than truncated, and computed at full width: the whole
         * point of the call is that the product does not fit in 32 bits, so a
         * caller doing it itself would have lost the answer already. The
         * magnitudes' quotient with half the divisor's added, truncated, the
         * sign put back: a half rounds away from zero. -1 for a divisor of 0
         * and for a magnitude past 2^31 - 1, INT_MIN's among them (Wine's
         * kernelbase answers so). Code in the guest (`MULDIV_CODE`): one
         * `imul`, one `div`.
         */
        MulDiv: {
            argBytes: 12,
            code: ()=>MULDIV_CODE,
            /** @param {number[]} args */
            handler: ([number, numerator, denominator])=>mulDiv(number, numerator, denominator),
        },

        /**
         * VOID GetSystemTime(LPSYSTEMTIME lpSystemTime)
         */
        GetSystemTime: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([time])=>{
                host.writeMemory(time >>> 0, nowAsSystemTime());
                return 0;
            },
        },

        /**
         * VOID GetLocalTime(LPSYSTEMTIME lpSystemTime)
         *
         * The same answer as GetSystemTime. There is no time zone here, and
         * inventing an offset would make the two disagree about a clock that has
         * only one source -- a program that computes a duration from one and a
         * timestamp from the other would see time move sideways.
         */
        GetLocalTime: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([time])=>{
                host.writeMemory(time >>> 0, nowAsSystemTime());
                return 0;
            },
        },

        /** BOOL SystemTimeToFileTime(const SYSTEMTIME *lpSystemTime, LPFILETIME lpFileTime) */
        SystemTimeToFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([systemTime, fileTime])=>{
                writeFileTime(fileTime >>> 0, filetimeFrom(systemTime >>> 0));
                return 1;
            },
        },

        /** BOOL FileTimeToSystemTime(const FILETIME *lpFileTime, LPSYSTEMTIME lpSystemTime) */
        FileTimeToSystemTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([fileTime, systemTime])=>{
                host.writeMemory(systemTime >>> 0, systemTimeFrom(readFileTime(fileTime >>> 0)));
                return 1;
            },
        },

        /** LONG CompareFileTime(const FILETIME *lpFileTime1, const FILETIME *lpFileTime2) */
        CompareFileTime: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                const left = readFileTime(first >>> 0);
                const right = readFileTime(second >>> 0);
                if (left < right)
                {
                    return -1 >>> 0;
                }
                return left > right ? 1 : 0;
            },
        },

        /**
         * DWORD GetFileType(HANDLE hFile)
         *
         * A C runtime asks this of each standard handle before it decides how to
         * buffer it: a console is line buffered, a file is not. Answering DISK
         * for a console makes a program's output appear all at once at exit, or
         * not at all.
         */
        GetFileType: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const target = object(handle);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return FILE_TYPE_UNKNOWN;
                }
                switch (target.kind ?? target.type)
                {
                    case 'console':
                        return FILE_TYPE_CHAR;
                    case 'pipe':
                        return FILE_TYPE_PIPE;
                    default:
                        return FILE_TYPE_DISK;
                }
            },
        },

        /**
         * UINT SetHandleCount(UINT uNumber)
         *
         * A request for a bigger handle table, which stopped meaning anything
         * when Win32 stopped having a fixed one. Windows returns the number it
         * was given, and so does this.
         */
        SetHandleCount: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([count])=>count >>> 0,
        },

        /** BOOL IsBadReadPtr(const VOID *lp, UINT_PTR ucb) */
        IsBadReadPtr: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, length])=>
                (pointer >>> 0) === 0 || !readable(pointer >>> 0, length >>> 0) ? 1 : 0,
        },

        /**
         * BOOL IsBadWritePtr(LPVOID lp, UINT_PTR ucb)
         *
         * Answered by whether the range is mapped, not by whether it is writable.
         * Distinguishing the two would mean probing with a write, and a probe
         * that succeeds has changed the guest's memory to find out.
         */
        IsBadWritePtr: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, length])=>
                (pointer >>> 0) === 0 || !readable(pointer >>> 0, length >>> 0) ? 1 : 0,
        },

        /** BOOL IsBadCodePtr(FARPROC lpfn) */
        IsBadCodePtr: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pointer])=>(pointer >>> 0) === 0 || !readable(pointer >>> 0, 1) ? 1 : 0,
        },

        /**
         * BOOL IsBadStringPtrA(LPCSTR lpsz, UINT_PTR ucchMax)
         *
         * Readable up to its terminator or to the count, whichever comes
         * first; the count is usually -1, meaning the terminator decides.
         */
        IsBadStringPtrA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, count])=>stringReadable(pointer >>> 0, count >>> 0, 1) ? 0 : 1,
        },

        /** BOOL IsBadStringPtrW(LPCWSTR lpsz, UINT_PTR ucchMax) */
        IsBadStringPtrW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pointer, count])=>stringReadable(pointer >>> 0, count >>> 0, 2) ? 0 : 1,
        },

        /**
         * BOOL GetExitCodeProcess(HANDLE hProcess, LPDWORD lpExitCode)
         *
         * STILL_ACTIVE for the running process and for a child that takes this
         * process's place, which never reports anything else while its parent
         * can look. A child the engine itself answered for -- a redistributable
         * installer, already run and exited 0 -- reports its own code, because
         * saying it is still running would make a caller that waits on it wait
         * for ever.
         */
        GetExitCodeProcess: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                const child = (handle >>> 0) === CURRENT_PROCESS
                    ? null
                    : object(handle, 'process');
                if ((handle >>> 0) !== CURRENT_PROCESS && !child)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(
                    0, child ? child.exitCode : STILL_ACTIVE, true);
                host.writeMemory(code >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL GetExitCodeThread(HANDLE hThread, LPDWORD lpExitCode)
         *
         * A thread that has not finished is STILL_ACTIVE, and one that has
         * reports the code it left with -- which is why the handle has to stay
         * valid after the thread is gone.
         */
        GetExitCodeThread: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                const target = thread(handle);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(
                    0, target.exitCode ?? STILL_ACTIVE, true);
                host.writeMemory(code >>> 0, bytes);
                return 1;
            },
        },

        /**
         * BOOL TerminateProcess(HANDLE hProcess, UINT uExitCode)
         *
         * Terminating the running process does not return -- so, like
         * ExitProcess, the stub's own return is redirected into the park loop
         * rather than answered. A child has not run while its parent can call
         * this: it ends with the code before it starts, is no longer one to
         * hand the machine to, and whoever waits on it is answered. One that
         * has ended already is refused, as Windows refuses it.
         */
        TerminateProcess: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, code])=>{
                if ((handle >>> 0) !== CURRENT_PROCESS)
                {
                    const child = object(handle, 'process');
                    if (!child)
                    {
                        host.setLastError(ERROR_INVALID_HANDLE);
                        return 0;
                    }
                    if (child.completed || child.exitCode !== STILL_ACTIVE)
                    {
                        host.setLastError(ERROR_ACCESS_DENIED);
                        return 0;
                    }
                    child.exitCode = code >>> 0;
                    child.completed = true;
                    const waiters = child.waiters ?? [];
                    child.waiters = [];
                    for (const waiter of waiters)
                    {
                        host.wake?.(waiter.thread, waiter.settle ? waiter.settle() : waiter.result);
                    }
                    return 1;
                }
                host.exit(code >>> 0);
                return host.park();
            },
        },

        /**
         * BOOL Beep(DWORD dwFreq, DWORD dwDuration)
         *
         * Succeeds and makes no sound. The PC speaker it drives is not something
         * this build has, and blocking for the duration -- which is what a real
         * Beep does -- would stall the guest for a tone nobody hears.
         */
        Beep: {
            argBytes: 8,
            handler: ()=>1,
        },

        /**
         * HANDLE CreateActCtxA(PCACTCTXA pActCtx)
         * HANDLE CreateActCtxW(PCACTCTXW pActCtx)
         *
         * Manifests are not read in this build, so no context can be built:
         * the call fails as it does for a manifest Windows cannot use, and a
         * caller takes its no-context path rather than activating a handle
         * that resolves to nothing. Real Windows would answer a handle, so the
         * refusal is reported. A missing or truncated ACTCTX is an invalid
         * parameter, as it is there.
         */
        CreateActCtxA: { argBytes: 4, handler: createActCtx('CreateActCtxA') },
        CreateActCtxW: { argBytes: 4, handler: createActCtx('CreateActCtxW') },

        /**
         * BOOL ActivateActCtx(HANDLE hActCtx, ULONG_PTR *lpCookie)
         * BOOL DeactivateActCtx(DWORD dwFlags, ULONG_PTR ulCookie)
         * BOOL GetCurrentActCtx(HANDLE *lphActCtx)
         *
         * A stack of what was activated, the cookie naming its place. No
         * context can have been built, so the stack only ever holds what a
         * caller handed back from a refused CreateActCtx, and the current
         * context is always none.
         */
        ActivateActCtx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, cookie])=>{
                if ((cookie >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                activations.push(handle >>> 0);
                writeDword(cookie >>> 0, activations.length);
                return 1;
            },
        },
        DeactivateActCtx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([, cookie])=>{
                if ((cookie >>> 0) !== activations.length || activations.length === 0)
                {
                    host.setLastError(ERROR_SXS_INVALID_DEACTIVATION);
                    return 0;
                }
                activations.pop();
                return 1;
            },
        },
        GetCurrentActCtx: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                writeDword(out >>> 0, 0);
                return 1;
            },
        },
        /** void AddRefActCtx(HANDLE) and ReleaseActCtx(HANDLE): there is nothing to count. */
        AddRefActCtx: { argBytes: 4, handler: ()=>0 },
        ReleaseActCtx: { argBytes: 4, handler: ()=>0 },

        /**
         * UINT SetErrorMode(UINT uMode)
         *
         * Remembered and reported back, because the value is the return of the
         * next call: a caller sets a mode, does its work, and puts the previous
         * one back from what this returned. Nothing acts on it -- there are no
         * system error dialogs here to suppress -- but the save-and-restore
         * pattern has to work or a caller restores a mode it never had.
         */
        SetErrorMode: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([mode])=>{
                const previous = errorMode;
                errorMode = mode >>> 0;
                return previous;
            },
        },

        /**
         * int GetThreadPriority(HANDLE hThread)
         *
         * Read from the kernel's thread record, which is the one place the
         * priority lives: the scheduler composes the absolute priority from
         * this relative one at every turn.
         */
        GetThreadPriority: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                const target = thread(handle);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return THREAD_PRIORITY_ERROR_RETURN;
                }
                return target.priority;
            },
        },

        /**
         * BOOL SetThreadPriority(HANDLE hThread, int nPriority)
         *
         * The value is one of the seven a normal-class process may set; the
         * argument arrives as an unsigned register and is read back as the
         * signed int it was.
         */
        SetThreadPriority: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, priority])=>{
                const target = thread(handle);
                if (!target)
                {
                    host.setLastError(ERROR_INVALID_HANDLE);
                    return 0;
                }
                const relative = priority | 0;
                if (!THREAD_PRIORITIES.has(relative))
                {
                    host.setLastError(ERROR_INVALID_PARAMETER);
                    return 0;
                }
                target.priority = relative;
                return 1;
            },
        },

        /**
         * DWORD GetProfileStringA(LPCSTR lpAppName, LPCSTR lpKeyName,
         *   LPCSTR lpDefault, LPSTR lpReturnedString, DWORD nSize)
         *
         * Reads win.ini, which does not exist, so every key is absent and the
         * caller's own default is what comes back. That is the documented
         * behaviour for a missing key and is exactly what a caller passing a
         * default is prepared for -- inventing a value instead would override a
         * choice the program already made.
         */
        GetProfileStringA: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([, , fallback, buffer, size])=>{
                const text = fallback === 0 ? '' : readAnsi(fallback >>> 0, MAX_STRING);
                return writeAnsiTo(buffer >>> 0, size >>> 0, text);
            },
        },

        /**
         * DWORD FormatMessageA(DWORD dwFlags, LPCVOID lpSource, DWORD dwMessageId,
         *   DWORD dwLanguageId, LPSTR lpBuffer, DWORD nSize, va_list *Arguments)
         *
         * Both sources a program uses in practice. FROM_SYSTEM turns a code
         * from GetLastError into something to show or log, so the table below
         * covers the codes this build actually produces; anything else gets a
         * line naming the number, which is more use than an empty string and
         * cannot be mistaken for a real message.
         *
         * FROM_STRING takes the caller's own text, with `%1`..`%9` expanded
         * from the arguments when it is given any, through the `!s!`, `!d!`,
         * `!x!` and other conversions a message's inserts carry. It is as real
         * a source as the system table, and it is how a caller expands inserts
         * in a format string it already holds; refusing it hands back the empty
         * buffer the caller cleared first, which reads as a string that was
         * never there.
         *
         * FORMAT_MESSAGE_ALLOCATE_BUFFER changes what lpBuffer means: it is no
         * longer the buffer but a pointer to where the address of one goes, and
         * a caller that passes it will call LocalFree on what it finds there.
         */
        FormatMessageA: formatMessage(false),

        /**
         * DWORD FormatMessageW(DWORD dwFlags, LPCVOID lpSource, DWORD dwMessageId,
         *   DWORD dwLanguageId, LPWSTR lpBuffer, DWORD nSize, va_list *Arguments)
         *
         * The A form in UTF-16: the source string and a bare `%n` insert are
         * wide, nSize and the answer count characters, and an allocated
         * buffer is sized for them.
         */
        FormatMessageW: formatMessage(true),

        /**
         * LPSTR lstrcatA(LPSTR lpString1, LPCSTR lpString2)
         *
         * Appends in place, and cannot check the destination has room -- the
         * signature carries no size, which is why Windows deprecated it. What it
         * does check is that both pointers are readable, because the usual
         * failure is a null second argument and the usual result of not checking
         * is a fault inside kernel32 rather than a NULL return the caller
         * handles.
         */
        lstrcatA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>{
                if (first === 0 || second === 0)
                {
                    return 0;
                }
                const head = readAnsi(first >>> 0, MAX_STRING);
                const tail = readAnsi(second >>> 0, MAX_STRING);
                writeAnsi((first >>> 0) + head.length, tail);
                return first >>> 0;
            }),
        },

        /** LPWSTR lstrcatW(LPWSTR lpString1, LPCWSTR lpString2): lstrcatA's, in UTF-16. */
        lstrcatW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>{
                if (first === 0 || second === 0)
                {
                    return 0;
                }
                const head = readWide(first >>> 0, MAX_STRING);
                const tail = readWide(second >>> 0, MAX_STRING);
                const units = new Uint16Array(tail.length + 1);
                for (let at = 0; at < tail.length; at++)
                {
                    units[at] = tail.charCodeAt(at);
                }
                host.writeMemory((first >>> 0) + head.length * 2, new Uint8Array(units.buffer));
                return first >>> 0;
            }),
        },

        /**
         * LPSTR lstrcpynA(LPSTR lpString1, LPCSTR lpString2, int iMaxLength)
         *
         * Copies at most iMaxLength characters *including* the terminator, and
         * always terminates -- which is the difference from strncpy and the
         * whole reason a program reaches for it. Off by one here truncates every
         * copy or overruns every buffer.
         */
        lstrcpynA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: survivesFault(([destination, source, max])=>{
                const room = max | 0;
                if (destination === 0 || source === 0 || room <= 0)
                {
                    return 0;
                }
                const text = readAnsi(source >>> 0, MAX_STRING).slice(0, room - 1);
                writeAnsi(destination >>> 0, text);
                return destination >>> 0;
            }),
        },

        /**
         * LPWSTR lstrcpynW(LPWSTR lpString1, LPCWSTR lpString2, int iMaxLength)
         *
         * lstrcpynA's, in UTF-16: iMaxLength counts characters, the
         * terminator among them, and the copy always ends in one.
         */
        lstrcpynW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: survivesFault(([destination, source, max])=>{
                const room = max | 0;
                if (destination === 0 || source === 0 || room <= 0)
                {
                    return 0;
                }
                const text = readWide(source >>> 0, MAX_STRING).slice(0, room - 1);
                const units = new Uint16Array(text.length + 1);
                for (let at = 0; at < text.length; at++)
                {
                    units[at] = text.charCodeAt(at);
                }
                host.writeMemory(destination >>> 0, new Uint8Array(units.buffer));
                return destination >>> 0;
            }),
        },

        /**
         * int lstrlenA(LPCSTR lpString)
         *
         * Zero for a null pointer rather than a fault. That is the one thing
         * this adds over strlen and the reason programs use it on a pointer
         * they have not checked.
         */
        lstrlenA: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: survivesFault(([text])=>((text >>> 0) === 0
                ? 0
                : readAnsi(text >>> 0, MAX_STRING).length)),
            ...lstrCode((at, trap, top)=>lstrlenCode(1, at, trap, top)),
        },

        /** int lstrlenW(LPCWSTR lpString) */
        lstrlenW: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: survivesFault(([text])=>((text >>> 0) === 0
                ? 0
                : readWide(text >>> 0, MAX_STRING).length)),
            ...lstrCode((at, trap, top)=>lstrlenCode(2, at, trap, top)),
        },

        /**
         * LPSTR lstrcpyA(LPSTR lpString1, LPCSTR lpString2)
         *
         * No length anywhere, so nothing here can bound it; what it can do is
         * refuse a null on either side, which is the failure that would
         * otherwise happen inside kernel32 rather than at the caller.
         */
        lstrcpyA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([destination, source])=>{
                if (destination === 0 || source === 0)
                {
                    return 0;
                }
                writeAnsi(destination >>> 0, readAnsi(source >>> 0, MAX_STRING));
                return destination >>> 0;
            }),
            ...lstrCode((at, trap, top)=>lstrcpyCode(1, at, trap, top)),
        },

        /** LPWSTR lstrcpyW(LPWSTR lpString1, LPCWSTR lpString2): lstrcpyA's, in UTF-16. */
        lstrcpyW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([destination, source])=>{
                if (destination === 0 || source === 0)
                {
                    return 0;
                }
                const text = readWide(source >>> 0, MAX_STRING);
                const units = new Uint16Array(text.length + 1);
                for (let at = 0; at < text.length; at++)
                {
                    units[at] = text.charCodeAt(at);
                }
                host.writeMemory(destination >>> 0, new Uint8Array(units.buffer));
                return destination >>> 0;
            }),
            ...lstrCode((at, trap, top)=>lstrcpyCode(2, at, trap, top)),
        },

        /**
         * int lstrcmpA(LPCSTR, LPCSTR) and int lstrcmpiA(LPCSTR, LPCSTR)
         *
         * Both answer the sign of a comparison rather than a difference of
         * bytes, which is all a caller may rely on. The insensitive form folds
         * case the way the C library does here: without a code page there is
         * nothing better to fold by, and above ASCII the two disagree only for
         * text this build cannot decode anyway.
         */
        lstrcmpA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>compare(
                readAnsi(first >>> 0, MAX_STRING), readAnsi(second >>> 0, MAX_STRING))),
        },

        lstrcmpiA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>compare(
                readAnsi(first >>> 0, MAX_STRING).toLowerCase(),
                readAnsi(second >>> 0, MAX_STRING).toLowerCase())),
        },

        lstrcmpW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>compare(
                readWide(first >>> 0, MAX_STRING), readWide(second >>> 0, MAX_STRING))),
        },

        lstrcmpiW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: survivesFault(([first, second])=>compare(
                readWide(first >>> 0, MAX_STRING).toLowerCase(),
                readWide(second >>> 0, MAX_STRING).toLowerCase())),
        },
    };
}
