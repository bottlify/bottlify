/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * UCRTBASE.DLL, the Universal CRT every Visual C++ from 2015 on links against
 * -- and that Windows 10 answers the `api-ms-win-crt-*` API sets with, so a
 * program importing `api-ms-win-crt-stdio-l1-1-0.dll` binds here too
 * (`moduleKeyOf`). Its functions are msvcrt's and the 2005 runtime's under the
 * same names, so their entries rather than a second copy of each; what is new
 * is how a program reaches some of them:
 *
 * - **stdio through common entries.** The headers make `printf` and the rest
 *   inline wrappers over `__stdio_common_vfprintf` and its siblings, which take
 *   a 64-bit options word first (two stack slots on x86), the stream or
 *   buffer, the format, a locale and the `va_list`. The streams are reached by
 *   `__acrt_iob_func(index)`, the records msvcrt's `_iob` holds.
 * - **start-up by steps.** The start-up code asks for the argument vector and
 *   the environment to be made (`_configure_narrow_argv`,
 *   `_initialize_narrow_environment`) before it reads `__p___argv`, registers
 *   `atexit` handlers through `_crt_atexit`, and a DLL keeps its own exit table
 *   (`_initialize_onexit_table`, `_register_onexit_function`,
 *   `_execute_onexit_table`).
 */

import { scanDecimal } from './convert.js';
import { SYSTEM_ERRORS } from './errors.js';
import { setSingle } from './float.js';
import { VARIADIC_SLOTS } from './scan.js';
import { fileLayout } from './stdio.js';
import { createUcrtMathFunctions } from './ucrt-math.js';

const EINVAL = 22;
const ERANGE = 34;
/** `_TRUNCATE`: a count that asks for as much as fits. */
const TRUNCATE = 0xffffffff;
/**
 * The options bit of `__stdio_common_vsprintf` and its wide twin that asks for
 * C99's snprintf: the text cut to fit and always terminated, the answer the
 * length it would have had. Without it the legacy `_vsnprintf`: -1 when the
 * text does not fit, and no terminator then.
 */
const STANDARD_SNPRINTF_BEHAVIOR = 0x2;
/** The legacy behaviour's other bit: a cut text is terminated after all. */
const LEGACY_VSPRINTF_NULL_TERMINATION = 0x1;
/** The bit of `__stdio_common_vsscanf` and its kin that makes `%s` and `%c` take a size after each pointer. */
const SECURE_SCANF = 0x1;
/** DLL_PROCESS_DETACH: what a thread-local exit callback is told at exit. */
const PROCESS_DETACH = 0;

/**
 * @typedef {Object} UcrtHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(entry: number, args: number[], thread?: any) => any} callGuest
 * @property {() => any} [currentThread]
 * @property {number} [pointerSize]  8 in a 64-bit process; absent, 4.
 * @property {(address: number, maxLength: number) => string} [readCString]
 * @property {{ narrow: () => number, wide: () => number }} [commandLine]  Where
 *     GetCommandLineA and GetCommandLineW keep the process's command line.
 * @property {import('./float.js').FloatHost} [fpu]  Absent, nothing that
 *     answers a float or a double is added.
 * @property {(index: number) => Uint32Array} [readXmm]
 * @property {(index: number, words: Uint32Array) => void} [writeXmm]
 */

/**
 * @param {Record<string, any>} crt  The 2005 runtime's table, itself msvcrt's
 *     and that runtime's additions (`createMsvcr80Functions`).
 * @param {UcrtHost} host
 * @returns {Record<string, any>}
 */
export function createUcrtbaseFunctions(crt, host){
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** A pointer's bytes: four, or eight in a 64-bit process, every address below 4 GiB. */
    const pointer = host.pointerSize ?? 4;
    /** @param {number} address */
    const readPointer = readU32;
    /** @param {number} address @param {number} value */
    const writePointer = (address, value)=>{
        const bytes = new Uint8Array(pointer);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address >>> 0, bytes);
    };
    /** The calling thread's errno, set. @param {number} code */
    const fail = code=>{
        writeU32(crt._errno.handler([]), code);
        return code;
    };
    /** @param {number} handler @param {number[]} args */
    const call = (handler, args)=>host.callGuest(handler >>> 0, args, host.currentThread?.());

    /** What `_set_invalid_parameter_handler` was last given. */
    let invalidParameterHandler = 0;
    /** What `_set_app_type` was given: unknown until the start-up says. */
    let appType = 0;
    /** What `at_quick_exit` registered, run backwards by `quick_exit`. @type {number[]} */
    const quickExit = [];

    /**
     * A format that failed, or a call with no buffer: the length the text
     * needs when no buffer and no count is how the caller asked for it, and
     * otherwise -1 with EINVAL.
     *
     * @param {number} length @param {number} buffer @param {number} count
     */
    const refused = (length, buffer, count)=>{
        if (length >= 0 && (buffer >>> 0) === 0 && (count >>> 0) === 0)
        {
            return length;
        }
        fail(EINVAL);
        return -1;
    };

    /**
     * A narrow `_vsnprintf`-family answer under either behaviour the options
     * word picks.
     *
     * @param {number} options @param {number} buffer @param {number} count
     * @param {number} format @param {number} list
     */
    const narrowCounted = (options, buffer, count, format, list)=>{
        const length = crt._vscprintf.handler([format, list]) | 0;
        if (length < 0 || (buffer >>> 0) === 0)
        {
            // No buffer is how a caller asks how much room the text needs.
            return refused(length, buffer, count);
        }
        if (options & STANDARD_SNPRINTF_BEHAVIOR)
        {
            if ((count >>> 0) === 0)
            {
                return length;
            }
            const room = (count >>> 0) - 1;
            crt._vsnprintf.handler([buffer, room, format, list]);
            host.writeMemory((buffer >>> 0) + Math.min(length, room), Uint8Array.of(0));
            return length;
        }
        const written = crt._vsnprintf.handler([buffer, count, format, list]) | 0;
        if (written < 0 && (options & LEGACY_VSPRINTF_NULL_TERMINATION) && (count >>> 0) > 0)
        {
            host.writeMemory((buffer >>> 0) + (count >>> 0) - 1, Uint8Array.of(0));
        }
        return written;
    };

    /**
     * The same in wide characters.
     *
     * @param {number} options @param {number} buffer @param {number} count
     * @param {number} format @param {number} list
     */
    const wideCounted = (options, buffer, count, format, list)=>{
        const length = crt._vsnwprintf.handler([0, 0, format, list]) | 0;
        if (length < 0 || (buffer >>> 0) === 0)
        {
            return refused(length, buffer, count);
        }
        if (options & STANDARD_SNPRINTF_BEHAVIOR)
        {
            if ((count >>> 0) === 0)
            {
                return length;
            }
            const room = (count >>> 0) - 1;
            crt._vsnwprintf.handler([buffer, room, format, list]);
            host.writeMemory((buffer >>> 0) + Math.min(length, room) * 2, Uint8Array.of(0, 0));
            return length;
        }
        const written = crt._vsnwprintf.handler([buffer, count, format, list]) | 0;
        if (written < 0 && (options & LEGACY_VSPRINTF_NULL_TERMINATION) && (count >>> 0) > 0)
        {
            host.writeMemory((buffer >>> 0) + ((count >>> 0) - 1) * 2, Uint8Array.of(0, 0));
        }
        return written;
    };

    /**
     * The pointers a scanf's `va_list` holds, as many as the variadic entry
     * takes: each conversion reads the next.
     *
     * @param {number} list
     */
    const pointersAt = list=>Array.from({ length: VARIADIC_SLOTS },
        (_, index)=>readPointer((list >>> 0) + index * pointer));

    /** What `_register_thread_local_exe_atexit_callback` was given, until exit calls it. */
    let threadLocalExit = 0;
    /** `___lc_locale_name_func`'s array and `__sys_nerr`'s variable, made when first asked for. */
    let localeNames = 0;
    let errorCount = 0;

    /**
     * The command line WinMain is handed: past the program's name -- quoted or
     * not, a quote anywhere in it opening or closing a quoted span -- and the
     * blanks after it, every unit at or below a space one.
     *
     * @param {number} line  The command line. @param {number} unit  1 or 2 bytes.
     */
    const pastProgramName = (line, unit)=>{
        if ((line >>> 0) === 0)
        {
            return 0;
        }
        /** @param {number} at */
        const read = at=>{
            const bytes = host.readMemory(at, unit);
            return unit === 1 ? bytes[0] : bytes[0] | bytes[1] << 8;
        };
        let at = line >>> 0;
        let quoted = false;
        for (let code = read(at); code > 0x20 || code !== 0 && quoted; code = read(at))
        {
            quoted = code === 0x22 ? !quoted : quoted;
            at += unit;
        }
        while (read(at) !== 0 && read(at) <= 0x20)
        {
            at += unit;
        }
        return at;
    };

    /**
     * What exit and _cexit do before atexit's handlers: the exe's
     * thread-local destructors, through the callback it registered, told the
     * process is detaching -- once.
     *
     * @param {() => any} then
     */
    const exitingThreadLocals = then=>{
        const callback = threadLocalExit;
        threadLocalExit = 0;
        return callback === 0 ? then()
            : Promise.resolve(call(callback, [0, PROCESS_DETACH, 0])).then(then);
    };

    /**
     * `_W_Getdays` and `_W_Getmonths`: the narrow list the runtime makes,
     * as a wide string of its own from the heap, the narrow one freed.
     *
     * @param {Record<string, any>} narrow
     */
    const widened = narrow=>({
        convention: 'cdecl',
        argBytes: 0,
        handler: ()=>{
            const text = narrow.handler([]) >>> 0;
            if (text === 0 || !host.readCString)
            {
                return text;
            }
            const read = host.readCString(text, 4096);
            crt.free.handler([text]);
            const bytes = new Uint8Array((read.length + 1) * 2);
            for (let at = 0; at < read.length; at++)
            {
                bytes[at * 2] = read.charCodeAt(at) & 0xff;
            }
            const wide = crt.malloc.handler([bytes.length]) >>> 0;
            if (wide !== 0)
            {
                host.writeMemory(wide, bytes);
            }
            return wide;
        },
    });

    return {
        ...crt,
        ...host.fpu ? createUcrtMathFunctions({ fpu: host.fpu, errno: code=>{
            fail(code);
        }, readMemory: host.readMemory, writeMemory: host.writeMemory, pointerSize: pointer,
        ...host.readXmm && host.writeXmm ? { readXmm: host.readXmm, writeXmm: host.writeXmm }
            : {} }) : {},

        /** FILE *__acrt_iob_func(unsigned index): stdin, stdout and stderr are 0, 1 and 2. */
        __acrt_iob_func: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([index])=>((crt.__iob_func.handler([]) >>> 0)
                + (index >>> 0) * fileLayout(host.pointerSize).size) >>> 0,
        },

        /**
         * int __stdio_common_vfprintf(unsigned __int64 options, FILE *stream,
         *     const char *format, _locale_t locale, va_list args)
         */
        __stdio_common_vfprintf: {
            convention: 'cdecl',
            argBytes: 24,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , stream, format, , list])=>crt.vfprintf.handler([stream, format, list]),
        },

        /** The same with a wide format, to a stream. */
        __stdio_common_vfwprintf: {
            convention: 'cdecl',
            argBytes: 24,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , stream, format, , list])=>crt.vfwprintf.handler([stream, format, list]),
        },

        /**
         * int __stdio_common_vsprintf(unsigned __int64 options, char *buffer,
         *     size_t count, const char *format, _locale_t locale, va_list args)
         *
         * `sprintf`, `snprintf` and `_vsnprintf` all come here; the options
         * word says which of them the caller is.
         */
        __stdio_common_vsprintf: {
            convention: 'cdecl',
            argBytes: 28,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([options, , buffer, count, format, , list])=>
                narrowCounted(options, buffer, count, format, list),
        },

        /** The same in wide characters. */
        __stdio_common_vswprintf: {
            convention: 'cdecl',
            argBytes: 28,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([options, , buffer, count, format, , list])=>
                wideCounted(options, buffer, count, format, list),
        },

        /**
         * int __stdio_common_vsprintf_s(unsigned __int64 options, char *buffer,
         *     size_t size, const char *format, _locale_t locale, va_list args)
         */
        __stdio_common_vsprintf_s: {
            convention: 'cdecl',
            argBytes: 28,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , buffer, size, format, , list])=>
                crt.vsprintf_s.handler([buffer, size, format, list]),
        },

        /**
         * int __stdio_common_vsnprintf_s(unsigned __int64 options, char *buffer,
         *     size_t size, size_t count, const char *format, _locale_t locale,
         *     va_list args)
         */
        __stdio_common_vsnprintf_s: {
            convention: 'cdecl',
            argBytes: 32,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , buffer, size, count, format, , list])=>
                crt._vsnprintf_s.handler([buffer, size, count, format, list]),
        },

        /**
         * int __stdio_common_vsscanf(unsigned __int64 options, const char *buffer,
         *     size_t count, const char *format, _locale_t locale, va_list args)
         *
         * The secure variant (`sscanf_s`) takes a size after each `%s` and `%c`
         * pointer; the count bounds the input, all of it when it is -1.
         */
        __stdio_common_vsscanf: {
            convention: 'cdecl',
            argBytes: 28,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([options, , buffer, count, format, , list])=>{
                const pointers = pointersAt(list);
                if ((count >>> 0) !== TRUNCATE)
                {
                    return crt._snscanf.handler([buffer, count, format, ...pointers]);
                }
                return (options & SECURE_SCANF ? crt.sscanf_s : crt.sscanf)
                    .handler([buffer, format, ...pointers]);
            },
        },

        /**
         * int __stdio_common_vfscanf(unsigned __int64 options, FILE *stream,
         *     const char *format, _locale_t locale, va_list args)
         */
        __stdio_common_vfscanf: {
            convention: 'cdecl',
            argBytes: 24,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , stream, format, , list])=>
                crt.fscanf.handler([stream, format, ...pointersAt(list)]),
        },

        /** int _set_app_type(_crt_app_type type): what kind of program this is, for its error messages. */
        _set_app_type: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([type])=>{
                appType = type >>> 0;
                return crt.__set_app_type.handler([type]);
            },
        },

        /** _crt_app_type _query_app_type(void) */
        _query_app_type: { convention: 'cdecl', argBytes: 0, handler: ()=>appType },

        /**
         * errno_t _configure_narrow_argv(_crt_argv_mode mode) and its wide twin
         *
         * The vector is made the first time anything asks for it
         * (`__p___argv`), whichever mode: Windows expands no wildcards for a
         * program, and the runtime does only when it was linked to.
         */
        _configure_narrow_argv: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },
        _configure_wide_argv: { convention: 'cdecl', argBytes: 4, handler: ()=>0 },

        /** int _initialize_narrow_environment(void) and its wide twin: made when first read. */
        _initialize_narrow_environment: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },
        _initialize_wide_environment: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /** char **_get_initial_narrow_environment(void): the environment main is handed. */
        _get_initial_narrow_environment: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>readU32(crt.__p__environ.handler([])),
        },

        /** wchar_t **_get_initial_wide_environment(void) */
        _get_initial_wide_environment: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>readU32(crt.__p__wenviron.handler([])),
        },

        /** int _crt_atexit(_PVFV function): `atexit` as the start-up registers it. */
        _crt_atexit: crt.atexit,

        /** int at_quick_exit(void (*function)(void)) and the start-up's `_crt_at_quick_exit` */
        at_quick_exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([fn])=>{
                quickExit.push(fn >>> 0);
                return 0;
            },
        },
        _crt_at_quick_exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([fn])=>{
                quickExit.push(fn >>> 0);
                return 0;
            },
        },

        /**
         * void quick_exit(int status)
         *
         * What `at_quick_exit` registered, last first, and the process ends
         * as `_exit` ends it -- none of `atexit`'s handlers, no flush.
         */
        quick_exit: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([status])=>quickExit.splice(0).reverse()
                .reduce((waiting, fn)=>waiting.then(()=>call(fn, [])), Promise.resolve(0))
                .then(()=>crt._exit.handler([status])),
        },

        /**
         * int _initialize_onexit_table(_onexit_table_t *table)
         *
         * A table of exit functions a DLL keeps in its own variables: three
         * pointers, the array's first entry, one past its last and one past
         * its room. Empty, until something is registered.
         */
        _initialize_onexit_table: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([table])=>{
                if ((table >>> 0) === 0)
                {
                    return -1;
                }
                host.writeMemory(table >>> 0, new Uint8Array(3 * pointer));
                return 0;
            },
        },

        /**
         * int _register_onexit_function(_onexit_table_t *table, _onexit_t function)
         *
         * Appended at the end, the array grown from the runtime's heap when it
         * is full -- `_execute_onexit_table` frees it.
         */
        _register_onexit_function: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, fn])=>{
                if ((table >>> 0) === 0)
                {
                    return -1;
                }
                const at = table >>> 0;
                let first = readPointer(at);
                let last = readPointer(at + pointer);
                let end = readPointer(at + 2 * pointer);
                if (last === end)
                {
                    const used = first === 0 ? 0 : (last - first) / pointer;
                    const room = Math.max(8, used * 2);
                    const grown = crt.realloc.handler([first, room * pointer]) >>> 0;
                    if (grown === 0)
                    {
                        return -1;
                    }
                    first = grown;
                    last = grown + used * pointer;
                    end = grown + room * pointer;
                }
                writePointer(last, fn);
                writePointer(at, first);
                writePointer(at + pointer, last + pointer);
                writePointer(at + 2 * pointer, end);
                return 0;
            },
        },

        /**
         * int _execute_onexit_table(_onexit_table_t *table)
         *
         * Each function, last registered first, and the table emptied and its
         * array freed before they run, so a handler that registers another
         * starts a new table rather than walking the old one.
         */
        _execute_onexit_table: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([table])=>{
                if ((table >>> 0) === 0)
                {
                    return -1;
                }
                const at = table >>> 0;
                const first = readPointer(at);
                const last = readPointer(at + pointer);
                const functions = first === 0 ? [] : Array.from(
                    { length: (last - first) / pointer },
                    (_, index)=>readPointer(first + index * pointer));
                host.writeMemory(at, new Uint8Array(3 * pointer));
                if (first !== 0)
                {
                    crt.free.handler([first]);
                }
                return functions.reverse().filter(fn=>fn !== 0)
                    .reduce((waiting, fn)=>waiting.then(()=>call(fn, [])), Promise.resolve(0))
                    .then(()=>0);
            },
        },

        /**
         * _invalid_parameter_handler _set_invalid_parameter_handler(
         *     _invalid_parameter_handler handler)
         *
         * The one installed before. The runtime calls it, where it is told an
         * argument is invalid without the details (`_invalid_parameter_noinfo`),
         * instead of ending the process.
         */
        _set_invalid_parameter_handler: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handler])=>{
                const before = invalidParameterHandler;
                invalidParameterHandler = handler >>> 0;
                return before;
            },
        },

        /** _invalid_parameter_handler _get_invalid_parameter_handler(void) */
        _get_invalid_parameter_handler: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>invalidParameterHandler,
        },

        /**
         * void _invalid_parameter_noinfo(void)
         *
         * With a handler installed it is called with nothing known and the
         * caller goes on (and fails with EINVAL); without one the process ends,
         * as the 2005 runtime ends it.
         */
        _invalid_parameter_noinfo: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>(invalidParameterHandler === 0
                ? crt._invalid_parameter_noinfo.handler([])
                : Promise.resolve(call(invalidParameterHandler, [0, 0, 0, 0, 0])).then(()=>0)),
        },

        /** void _invalid_parameter_noinfo_noreturn(void): the handler, then the end regardless. */
        _invalid_parameter_noinfo_noreturn: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>Promise.resolve(invalidParameterHandler === 0 ? 0
                : call(invalidParameterHandler, [0, 0, 0, 0, 0]))
                .then(()=>crt._invalid_parameter_noinfo.handler([])),
        },

        /**
         * int _seh_filter_exe(unsigned long code, struct _EXCEPTION_POINTERS *pointers)
         * and the DLL's `_seh_filter_dll`: the start-up's filter around main,
         * which is msvcrt's `_XcptFilter` under the name the new runtime gave it.
         */
        _seh_filter_exe: crt._XcptFilter,
        _seh_filter_dll: crt._XcptFilter,

        /** int _set_new_mode(int mode) and int _query_new_mode(void): msvcrt's under C names. */
        _set_new_mode: crt['?_set_new_mode@@YAHH@Z'],
        _query_new_mode: crt['?_query_new_mode@@YAHXZ'],

        /** void terminate(void): std::terminate under the name C callers link. */
        terminate: crt['?terminate@@YAXXZ'] ?? crt.abort,

        /**
         * errno_t _set_fmode(int mode) and errno_t _get_fmode(int *mode): the
         * default text or binary mode, the variable `__p__fmode` points at.
         */
        _set_fmode: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([mode])=>{
                // _O_TEXT, _O_BINARY and _O_WTEXT are the modes there are.
                if (![0x4000, 0x8000, 0x10000].includes(mode >>> 0))
                {
                    return fail(EINVAL);
                }
                writeU32(crt.__p__fmode.handler([]), mode);
                return 0;
            },
        },
        _get_fmode: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return fail(EINVAL);
                }
                writeU32(out, readU32(crt.__p__fmode.handler([])));
                return 0;
            },
        },

        /**
         * float strtof(const char *str, char **end): strtod's reading, rounded
         * to a float, ERANGE for one past a float's range.
         */
        ...host.fpu && host.readCString ? {
            strtof: {
                convention: 'cdecl',
                argBytes: 8,
                /** @param {number[]} args */
                handler: ([text, end])=>{
                    const scanned = (text >>> 0) === 0 ? null
                        : scanDecimal(/** @type {NonNullable<typeof host.readCString>} */ (
                            host.readCString)(text >>> 0, 1024));
                    if ((end >>> 0) !== 0)
                    {
                        writePointer(end, scanned ? text + scanned.end : text);
                    }
                    const value = Math.fround(scanned?.value ?? 0);
                    if (scanned && (scanned.range || !Number.isFinite(value)
                        || value === 0 && scanned.value !== 0))
                    {
                        fail(ERANGE);
                    }
                    setSingle(/** @type {import('./float.js').FloatHost} */ (host.fpu), value);
                    return 0;
                },
            },
        } : {},

        /** long long strtoll(...) and unsigned long long strtoull(...): C99's names for them. */
        strtoll: crt._strtoi64,
        strtoull: crt._strtoui64,

        /** void _lock_locales(void), void _unlock_locales(void): the locale never changes here. */
        _lock_locales: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },
        _unlock_locales: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /**
         * wchar_t **___lc_locale_name_func(void)
         *
         * The names of the locale's categories, LC_ALL to LC_TIME: none, for
         * the C locale, which a caller reads as "C".
         */
        ___lc_locale_name_func: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                localeNames ||= crt.calloc.handler([6, pointer]) >>> 0;
                return localeNames;
            },
        },

        /** int *__sys_nerr(void): how many messages `_sys_errlist` holds. */
        __sys_nerr: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                if (errorCount === 0)
                {
                    errorCount = crt.malloc.handler([4]) >>> 0;
                    if (errorCount !== 0)
                    {
                        writeU32(errorCount, SYSTEM_ERRORS);
                    }
                }
                return errorCount;
            },
        },

        /** char **__tzname(void): `_tzname`, the zone's two names. */
        __tzname: crt.__p__tzname,

        /** _PNH _set_new_handler(_PNH handler): msvcrt's under its C name. */
        _set_new_handler: crt['?_set_new_handler@@YAP6AHI@ZP6AHI@Z@Z'],

        ...host.commandLine ? {
            /** char *_get_narrow_winmain_command_line(void): the line past the program's name. */
            _get_narrow_winmain_command_line: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>pastProgramName(
                    /** @type {NonNullable<typeof host.commandLine>} */ (host.commandLine).narrow(),
                    1),
            },
            /** wchar_t *_get_wide_winmain_command_line(void) */
            _get_wide_winmain_command_line: {
                convention: 'cdecl',
                argBytes: 0,
                handler: ()=>pastProgramName(
                    /** @type {NonNullable<typeof host.commandLine>} */ (host.commandLine).wide(),
                    2),
            },
        } : {},

        /**
         * void _register_thread_local_exe_atexit_callback(_tls_callback_type callback)
         *
         * The exe's callback for its thread-local destructors, which exit and
         * _cexit call first, as a TLS callback is called, with the process
         * detaching.
         */
        _register_thread_local_exe_atexit_callback: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([callback])=>{
                threadLocalExit = callback >>> 0;
                return 0;
            },
        },
        exit: { ...crt.exit,
            handler: (/** @type {number[]} */ args)=>exitingThreadLocals(()=>
                crt.exit.handler(args)) },
        _cexit: { ...crt._cexit,
            handler: (/** @type {number[]} */ args)=>exitingThreadLocals(()=>
                crt._cexit.handler(args)) },

        /**
         * int __stdio_common_vfprintf_s(unsigned __int64 options, FILE *stream,
         *     const char *format, _locale_t locale, va_list args)
         */
        __stdio_common_vfprintf_s: {
            convention: 'cdecl',
            argBytes: 24,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , stream, format, , list])=>{
                if ((format >>> 0) === 0)
                {
                    fail(EINVAL);
                    return -1;
                }
                return crt.vfprintf.handler([stream, format, list]);
            },
        },

        /**
         * int __stdio_common_vswprintf_s(unsigned __int64 options, wchar_t *buffer,
         *     size_t size, const wchar_t *format, _locale_t locale, va_list args)
         */
        __stdio_common_vswprintf_s: {
            convention: 'cdecl',
            argBytes: 28,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , buffer, size, format, , list])=>
                crt.vswprintf_s.handler([buffer, size, format, list]),
        },

        /**
         * int __stdio_common_vsnwprintf_s(unsigned __int64 options, wchar_t *buffer,
         *     size_t size, size_t count, const wchar_t *format, _locale_t locale,
         *     va_list args)
         */
        __stdio_common_vsnwprintf_s: {
            convention: 'cdecl',
            argBytes: 32,
            quadwords: [0],
            /** @param {number[]} args */
            handler: ([, , buffer, size, count, format, , list])=>
                crt._vsnwprintf_s.handler([buffer, size, count, format, list]),
        },

        /**
         * errno_t _get_stream_buffer_pointers(FILE *stream, char ***base,
         *     char ***ptr, int **count)
         *
         * Where the stream keeps its buffer's start, its place in it and what
         * is left: the record's own fields, which say it holds nothing, so a
         * C++ stream on it reads and writes through the calls.
         */
        _get_stream_buffer_pointers: {
            convention: 'cdecl',
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([stream, base, place, count])=>{
                if ((stream >>> 0) === 0)
                {
                    return fail(EINVAL);
                }
                const at = stream >>> 0;
                [[base, at + 2 * pointer], [place, at], [count, at + fileLayout(pointer).cnt]]
                    .forEach(([out, field])=>{
                        if ((out >>> 0) !== 0)
                        {
                            writePointer(out, field);
                        }
                    });
                return 0;
            },
        },

        /**
         * size_t fread_s(void *buffer, size_t size, size_t elementSize,
         *     size_t count, FILE *stream)
         *
         * fread, refused with EINVAL for no buffer or no stream, and with
         * ERANGE, the buffer cleared, when it asks for more than the buffer
         * holds.
         */
        fread_s: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([buffer, size, elementSize, count, stream])=>{
                const wanted = (elementSize >>> 0) * (count >>> 0);
                if (wanted === 0)
                {
                    return 0;
                }
                if ((buffer >>> 0) === 0 || (stream >>> 0) === 0)
                {
                    fail(EINVAL);
                    return 0;
                }
                if (wanted > (size >>> 0))
                {
                    host.writeMemory(buffer >>> 0, new Uint8Array(size >>> 0));
                    fail(ERANGE);
                    return 0;
                }
                return crt.fread.handler([buffer, elementSize, count, stream]);
            },
        },

        /**
         * wchar_t *_W_Getdays(void), wchar_t *_W_Getmonths(void): the day and
         * month names `_Getdays` and `_Getmonths` list, wide.
         */
        _W_Getdays: widened(crt._Getdays),
        _W_Getmonths: widened(crt._Getmonths),

        /** void *_W_Gettnames(void): `_Gettnames`'s table, handed back to `_Wcsftime`. */
        _W_Gettnames: crt._Gettnames,

        /**
         * size_t _Wcsftime(wchar_t *buffer, size_t size, const wchar_t *format,
         *     const struct tm *time, void *names): wcsftime, the names the C
         *     locale's.
         */
        _Wcsftime: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([buffer, size, format, time])=>
                crt.wcsftime.handler([buffer, size, format, time]),
        },
    };
}
