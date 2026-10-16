/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * MSVCR80.DLL, the Visual C++ 2005 runtime: msvcrt's functions, so msvcrt's
 * entries rather than a second copy of each, and the names that runtime
 * added -- pointer encoding, the per-thread locale switch, the secure
 * library's invalid-parameter path and its `_s` functions, `std::exception`
 * under its namespace. The engine answers it whoever's copy a program loads:
 * its own is code the guest can run at full speed, where a copy the program
 * brought is a second runtime for the translator to carry. What a program
 * calls per pointer or per character runs in the guest (`inguest.js`); the
 * rest crosses, as each is called once or on a failure.
 */

import { guestEntry } from './guest-code.js';
import * as inGuest from './inguest.js';
import { COMPILED } from './inguest.x86.js';
import * as inGuestPrint from './inguest-print.js';
import { COMPILED as PRINT_CODE } from './inguest-print.x86.js';

const EINVAL = 22;
const ERANGE = 34;
/** `_TRUNCATE`: a count that asks for as much as fits. */
const TRUNCATE = 0xffffffff;

/**
 * @typedef {Object} Msvcr80Host
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 */

/**
 * @param {Record<string, any>} crt  msvcrt.dll's table.
 * @param {Msvcr80Host} host
 * @returns {Record<string, any>}
 */
export function createMsvcr80Functions(crt, host){
    /** What `_set_purecall_handler` was last given. */
    let purecallHandler = 0;
    /** `_configthreadlocale`'s setting: per-thread locales off, as a fresh runtime has them. */
    let threadLocale = 2;

    const encode = guestEntry(inGuest.encodePointer, COMPILED.encodePointer, host);

    /** @param {number} address @param {number} value */
    const setU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };

    /** The calling thread's errno, set. @param {number} code */
    const fail = code=>{
        setU32(crt._errno.handler([]), code);
        return code;
    };

    /**
     * The secure library's end for a parameter it cannot live with, and a
     * failed assertion's: the process ends as abort ends it.
     */
    const invalidParameter = ()=>crt.abort.handler([]);

    return {
        ...crt,

        _encode_pointer: encode,
        _decode_pointer: encode,
        _encoded_null: guestEntry(inGuest.encodedNull, COMPILED.encodedNull, host),

        /**
         * int _configthreadlocale(int type)
         *
         * The previous setting: _ENABLE_PER_THREAD_LOCALE (1) or
         * _DISABLE_PER_THREAD_LOCALE (2); 0 only asks; -1 is the old global
         * behaviour, taken as disabling it. Anything else is refused with -1.
         */
        _configthreadlocale: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                const before = threadLocale;
                const asked = type | 0;
                if (asked === 1 || asked === 2)
                {
                    threadLocale = asked;
                }
                else if (asked === -1)
                {
                    threadLocale = 2;
                }
                else if (asked !== 0)
                {
                    return -1;
                }
                return before;
            },
        },

        /** _purecall_handler _set_purecall_handler(_purecall_handler): the one before. */
        _set_purecall_handler: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handler])=>{
                const before = purecallHandler;
                purecallHandler = handler >>> 0;
                return before;
            },
        },

        /**
         * int _vswprintf_c_l(wchar_t *buffer, size_t count, const wchar_t *format,
         *     _locale_t locale, va_list args)
         *
         * `_vsnwprintf` under a locale this runtime has one of.
         */
        _vswprintf_c_l: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([buffer, count, format, , list])=>
                crt._vsnwprintf.handler([buffer, count, format, list]),
        },

        /**
         * int _vsnprintf_s(char *buffer, size_t size, size_t count,
         *     const char *format, va_list args)
         *
         * At most `count` characters and a terminator, in a buffer of `size`.
         * Output cut short is -1: under _TRUNCATE with what fit kept; under a
         * count the buffer could not hold, with the buffer emptied and
         * ERANGE, as the invalid-parameter handler that returns leaves it.
         */
        _vsnprintf_s: guestEntry(inGuestPrint._vsnprintf_s, PRINT_CODE._vsnprintf_s, host, {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([buffer, size, count, format, list])=>{
                if ((buffer >>> 0) === 0 || (size >>> 0) === 0 || (format >>> 0) === 0)
                {
                    fail(EINVAL);
                    return -1;
                }
                const room = (size >>> 0) - 1;
                const limit = (count >>> 0) === TRUNCATE ? room : Math.min(count >>> 0, room);
                const written = crt._vsnprintf.handler([buffer, limit, format, list]) | 0;
                if (written >= 0)
                {
                    host.writeMemory((buffer >>> 0) + written, Uint8Array.of(0));
                    return written;
                }
                if ((count >>> 0) === TRUNCATE || (count >>> 0) <= room)
                {
                    host.writeMemory((buffer >>> 0) + limit, Uint8Array.of(0));
                    return -1;
                }
                host.writeMemory(buffer >>> 0, Uint8Array.of(0));
                fail(ERANGE);
                return -1;
            },
        }),

        /**
         * errno_t fopen_s(FILE **file, const char *name, const char *mode)
         *
         * fopen, the stream written through `file` (NULL on a failure) and
         * errno answered.
         */
        fopen_s: {
            convention: 'cdecl',
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([file, name, mode])=>{
                if ((file >>> 0) === 0)
                {
                    return fail(EINVAL);
                }
                const stream = crt.fopen.handler([name, mode]) >>> 0;
                setU32(file, stream);
                if (stream !== 0)
                {
                    return 0;
                }
                return new DataView(host.readMemory(crt._errno.handler([]), 4).slice().buffer)
                    .getInt32(0, true);
            },
        },

        /**
         * void _wassert(const wchar_t *message, const wchar_t *file, unsigned line)
         *
         * A failed assert() with wide text: the process ends, as abort ends it.
         */
        _wassert: {
            convention: 'cdecl',
            argBytes: 12,
            handler: ()=>invalidParameter(),
        },

        /**
         * void _invalid_parameter_noinfo(void)
         *
         * A secure function's argument it cannot live with, in a release
         * build: no handler is installed, so the process ends.
         */
        _invalid_parameter_noinfo: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>invalidParameter(),
        },

        /**
         * void _invoke_watson(const wchar_t *expression, const wchar_t *function,
         *     const wchar_t *file, unsigned int line, uintptr_t reserved)
         *
         * The secure library's end: the process goes, as abort takes it.
         */
        _invoke_watson: {
            convention: 'cdecl',
            argBytes: 20,
            handler: ()=>invalidParameter(),
        },

        /** void _crt_debugger_hook(int reserved): a debugger's breakpoint; none is attached. */
        _crt_debugger_hook: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /** void *_malloc_crt(size_t size): the runtime's own blocks, from its own heap. */
        _malloc_crt: crt.malloc,

        /**
         * int _set_sbh_threshold(size_t size)
         *
         * The small-block heap is the system heap's on every Windows this
         * runtime runs on: zero, nothing set.
         */
        _set_sbh_threshold: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /**
         * void __clean_type_info_names_internal(__type_info_node *list)
         *
         * A module's undecorated type names, freed at its unload. This
         * runtime frees each with its type_info, so there is nothing left.
         */
        __clean_type_info_names_internal: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /** void type_info::_type_info_dtor_internal_method(void) -- the destructor's body. */
        '?_type_info_dtor_internal_method@type_info@@QAEXXZ': crt['??1type_info@@UAE@XZ'],

        /**
         * int __CppXcptFilter(unsigned long code, struct _EXCEPTION_POINTERS *pointers)
         *
         * The filter a DLL's start-up wraps its initialisers in: msvcrt's.
         */
        __CppXcptFilter: crt._XcptFilter,

        // std::exception: msvcrt's exception class, which Visual C++ 2005
        // moved into the namespace without changing it.
        '??0exception@std@@QAE@ABQBD@Z': crt['??0exception@@QAE@ABQBD@Z'],
        '??0exception@std@@QAE@ABQBDH@Z': crt['??0exception@@QAE@ABQBDH@Z'],
        '??0exception@std@@QAE@ABV01@@Z': crt['??0exception@@QAE@ABV0@@Z'],
        '??0exception@std@@QAE@XZ': crt['??0exception@@QAE@XZ'],
        '??1exception@std@@UAE@XZ': crt['??1exception@@UAE@XZ'],
        '??4exception@std@@QAEAAV01@ABV01@@Z': crt['??4exception@@QAEAAV0@ABV0@@Z'],
        '?what@exception@std@@UBEPBDXZ': crt['?what@exception@@UBEPBDXZ'],
    };
}
