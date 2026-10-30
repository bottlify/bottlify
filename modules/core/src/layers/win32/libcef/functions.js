/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * libcef -- the Chromium Embedded Framework's C API, answered by this engine
 * rather than by the framework a program ships beside itself.
 *
 * A program that embeds Chromium brings the whole browser as libcef.dll: a
 * rendering engine, a JavaScript engine, a network stack, a font system and a
 * GPU process. This engine already runs inside such a browser, so running a
 * second one as translated x86 under it buys nothing and costs everything --
 * the page it would show is shown by the host instead. What is answered here
 * is the framework's contract with the program: its start (the API hash, the
 * process role, initialisation and the browser process handler's callbacks),
 * its message loop and the tasks posted to it, and the reference-counted
 * objects it hands across.
 *
 * Written against CEF 126's C headers (`include/capi`, branch 6478): every
 * export is cdecl (CEF_EXPORT), every callback through a structure stdcall
 * (CEF_CALLBACK) with the structure itself as its first argument. An export
 * not yet answered says so once and answers zero.
 */

import { BASE_SIZE, createCefObjects } from './objects.js';
import { createCefStrings } from './strings.js';
import { commandLineMethods, emptyCommandLine, parseCommandLine, splitCommandLine }
    from './command-line.js';

/** cef_app_t's methods after its base. */
const APP = Object.freeze({ getBrowserProcessHandler: BASE_SIZE + 12 });

/** cef_browser_process_handler_t's methods after its base. */
const BROWSER_PROCESS_HANDLER = Object.freeze({ onContextInitialized: BASE_SIZE + 4 });

/** cef_task_t: its one method after its base. */
const TASK_EXECUTE = BASE_SIZE;

/** cef_thread_id_t: the browser process's UI thread, the one every task runs on here. */
const TID_UI = 0;

/**
 * cef_api_hash(entry): the platform hash this framework's headers were built
 * with (0), the universal one (1) and the commit (2). A program compares the
 * first with its own and refuses to start on a mismatch; these are CEF 126's
 * for Windows, as its libcef.dll answers them.
 */
const API_HASHES = ['8e4d334971e43b4e56c93030410b02d735d99c8b',
    '13586d84cb6038b38bf769db815e59d3d152d474', '2e81dea53f5ecdc1c057e4c70ecd66151987296a'];

/** Every export of CEF 126's libcef.dll a program may import. */
const EXPORTS = Object.freeze([
    'cef_api_hash', 'cef_execute_process', 'cef_initialize', 'cef_shutdown',
    'cef_do_message_loop_work', 'cef_run_message_loop', 'cef_quit_message_loop',
    'cef_currently_on', 'cef_post_task', 'cef_post_delayed_task',
    'cef_set_force_device_scale_factor', 'cef_get_device_scale_factor_for_screen_rect',
    'cef_is_hardware_acceleration_enabled', 'cef_is_gpu_compositing_disabled',
    'cef_generate_gpu_report', 'cef_set_reduced_motion_enabled', 'cef_set_preferred_contrast',
    'cef_set_minimum_font_size', 'cef_crash_reporting_enabled', 'cef_set_crash_key_value',
    'cef_v8value_create_string', 'cef_v8value_create_object', 'cef_v8value_create_array',
    'cef_v8value_create_array_buffer', 'cef_v8value_create_function',
    'cef_v8value_create_promise', 'cef_v8value_create_double', 'cef_v8value_create_uint',
    'cef_v8value_create_int', 'cef_v8value_create_bool', 'cef_v8value_create_null',
    'cef_v8value_create_undefined', 'cef_v8context_get_current_context',
    'cef_dictionary_value_create', 'cef_list_value_create', 'cef_binary_value_create',
    'cef_value_create', 'cef_stream_reader_create_for_file', 'cef_stream_reader_create_for_data',
    'cef_request_create', 'cef_urlrequest_create', 'cef_post_data_create',
    'cef_post_data_element_create', 'cef_parse_url', 'cef_cookie_manager_get_global_manager',
    'cef_preference_manager_get_global', 'cef_request_context_get_global_context',
    'cef_browser_host_create_browser', 'cef_command_line_create', 'cef_command_line_get_global',
    'cef_process_message_create', 'cef_log',
    'cef_string_list_alloc', 'cef_string_list_free', 'cef_string_list_size',
    'cef_string_list_value', 'cef_string_list_append',
    'cef_string_map_alloc', 'cef_string_map_free', 'cef_string_map_size', 'cef_string_map_key',
    'cef_string_map_value', 'cef_string_map_append',
    'cef_string_multimap_alloc', 'cef_string_multimap_free', 'cef_string_multimap_size',
    'cef_string_multimap_key', 'cef_string_multimap_value', 'cef_string_multimap_append',
    'cef_string_userfree_utf8_free', 'cef_string_utf8_set', 'cef_string_utf8_clear',
    'cef_string_utf8_cmp', 'cef_string_wide_to_utf8', 'cef_string_utf16_clear',
    'cef_string_utf8_to_utf16', 'cef_string_userfree_utf16_free',
]);

/**
 * @typedef {Object} CefHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate
 * @property {(address: number) => void} free
 * @property {(name: string, fn: any) => number} register  A handler placed in guest code.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {() => string} commandLine  The process's, as GetCommandLineW answers it.
 * @property {(text: string) => void} [log]  Where the framework's own log lines go.
 * @property {(api: string, detail: string) => void} [divergence]
 */

/**
 * @param {CefHost} host
 */
export function createLibcefFunctions(host){
    /** @param {number} address */
    const dword = address=>new DataView(host.readMemory(address >>> 0, 4).slice().buffer)
        .getUint32(0, true);

    const objects = createCefObjects(host);
    // ponytail: UTF-8 strings, as the one framework build measured (CEF 126 as
    // Steam ships it) has them; a stock UTF-16 build needs this read from
    // which cef_string_*_set the program imports.
    const strings = createCefStrings(host, { utf8: true });

    /** @type {number} the process's command line, one object for every caller */
    let globalLine = 0;
    /** @param {import('./command-line.js').CommandLine} line */
    const newLine = line=>objects.make('cef_command_line', { line });
    objects.define('cef_command_line', commandLineMethods({
        read: strings.read,
        userfree: strings.userfree,
        fillList: strings.fillList,
        fillMap: strings.fillMap,
        copy: newLine,
        // argv as main received it: char* each, the system's code page.
        argv: (count, at)=>Array.from({ length: count }, (_, i)=>new TextDecoder()
            .decode(strings.bytesAt(dword(at + i * 4), -1))),
    }));

    /** The hash strings, written once where the program may keep pointing at them. */
    const hashes = new Map();
    /** @param {number} entry */
    const hashAt = entry=>{
        if (!hashes.has(entry))
        {
            const text = API_HASHES[entry] ?? '';
            const at = host.allocate(text.length + 1);
            host.writeMemory(at, new TextEncoder().encode(`${text}\0`));
            hashes.set(entry, at);
        }
        return hashes.get(entry);
    };

    /**
     * The UI thread's queue: the tasks posted to it, in order, each a
     * cef_task_t whose execute runs on the thread in the message loop.
     *
     * @type {number[]}
     */
    const queue = [];
    /** @type {(() => void) | null} */
    let wake = null;
    /** Set by cef_quit_message_loop; a loop ends when it sees it. */
    const loop = { quit: false };
    /** @type {any} The thread that called cef_initialize: CEF's UI thread. */
    let uiThread = null;
    /** @type {number} The cef_app_t the program initialised with. */
    let app = 0;

    /** @param {number} task */
    const post = task=>{
        queue.push(task >>> 0);
        wake?.();
        wake = null;
    };

    /**
     * The framework's start, as the UI thread's first task would run it: the
     * browser process handler told the context is ready.
     *
     * @param {any} thread
     */
    const contextInitialized = async thread=>{
        const getHandler = app === 0 ? 0 : dword(app + APP.getBrowserProcessHandler);
        const handler = getHandler === 0 ? 0
            : await host.callGuest(getHandler, [app], thread) >>> 0;
        const ready = handler === 0 ? 0
            : dword(handler + BROWSER_PROCESS_HANDLER.onContextInitialized);
        host.log?.(`context initialized: browser process handler 0x${handler.toString(16)},`
            + ` on_context_initialized 0x${ready.toString(16)}`);
        if (ready !== 0)
        {
            await host.callGuest(ready, [handler], thread);
        }
    };

    /** Runs what is queued, in order, on the thread pumping. @param {any} thread */
    const drain = async thread=>{
        while (queue.length > 0 && !loop.quit)
        {
            const task = /** @type {number} */ (queue.shift());
            const execute = dword(task + TASK_EXECUTE);
            if (execute !== 0)
            {
                await host.callGuest(execute, [task], thread);
            }
        }
    };

    /** @type {Set<string>} */
    const said = new Set();
    /** @param {string} name */
    const notYet = name=>({
        convention: 'cdecl',
        argBytes: 0,
        handler: ()=>{
            if (!said.has(name))
            {
                said.add(name);
                host.divergence?.(name, 'not answered yet: zero');
            }
            return 0;
        },
    });

    /** @type {Record<string, { convention: 'cdecl', argBytes: number, handler: Function }>} */
    const answered = {
        /** const char* cef_api_hash(int entry) */
        cef_api_hash: { convention: 'cdecl', argBytes: 4,
            handler: (/** @type {number[]} */ [entry])=>hashAt(entry | 0) },

        /**
         * int cef_execute_process(const cef_main_args_t*, cef_app_t*, void* sandbox)
         *
         * -1: this is the browser process. Here every process is: a
         * subprocess this framework would start (a renderer, a GPU process)
         * is the host's own.
         */
        cef_execute_process: { convention: 'cdecl', argBytes: 12, handler: ()=>-1 },

        /**
         * int cef_initialize(const cef_main_args_t*, const cef_settings_t*,
         *     cef_app_t* application, void* sandbox)
         *
         * The context is ready at once; the browser process handler hears so
         * as the UI thread's first task, as CEF tells it.
         */
        cef_initialize: { convention: 'cdecl', argBytes: 16,
            handler: (/** @type {number[]} */ [, , application])=>{
                app = application >>> 0;
                uiThread = host.currentThread();
                loop.quit = false;
                return 1;
            } },

        /** cef_command_line_t* cef_command_line_create(void) */
        cef_command_line_create: { convention: 'cdecl', argBytes: 0,
            handler: ()=>newLine(emptyCommandLine()) },

        /** cef_command_line_t* cef_command_line_get_global(void): the process's own. */
        cef_command_line_get_global: { convention: 'cdecl', argBytes: 0,
            handler: ()=>{
                if (globalLine === 0)
                {
                    globalLine = newLine(parseCommandLine(splitCommandLine(host.commandLine())));
                }
                return globalLine;
            } },

        /** void cef_log(const char* file, int line, int severity, const char* message) */
        cef_log: { convention: 'cdecl', argBytes: 16,
            handler: (/** @type {number[]} */ [file, line, severity, message])=>{
                const text = (/** @type {number} */ at)=>new TextDecoder()
                    .decode(strings.bytesAt(at, -1));
                host.log?.(`[${severity | 0}] ${text(file)}(${line | 0}): ${text(message)}`);
                return 0;
            } },

        ...strings.exports,

        /** void cef_shutdown(void) */
        cef_shutdown: { convention: 'cdecl', argBytes: 0, handler: ()=>0 },

        /**
         * void cef_run_message_loop(void)
         *
         * The UI thread runs what is posted to it until cef_quit_message_loop.
         */
        cef_run_message_loop: { convention: 'cdecl', argBytes: 0,
            handler: async()=>{
                const thread = host.currentThread();
                await contextInitialized(thread);
                while (!loop.quit)
                {
                    await drain(thread);
                    if (!loop.quit && queue.length === 0)
                    {
                        await new Promise(resolve=>{
                            wake = /** @type {() => void} */ (resolve);
                        });
                    }
                }
                return 0;
            } },

        /** void cef_do_message_loop_work(void): what is queued now, run once. */
        cef_do_message_loop_work: { convention: 'cdecl', argBytes: 0,
            handler: async()=>{
                await drain(host.currentThread());
                return 0;
            } },

        /** void cef_quit_message_loop(void) */
        cef_quit_message_loop: { convention: 'cdecl', argBytes: 0,
            handler: ()=>{
                loop.quit = true;
                wake?.();
                wake = null;
                return 0;
            } },

        /** int cef_currently_on(cef_thread_id_t): only the UI thread is one of CEF's. */
        cef_currently_on: { convention: 'cdecl', argBytes: 4,
            handler: (/** @type {number[]} */ [id])=>((id | 0) === TID_UI
                && host.currentThread() === uiThread ? 1 : 0) },

        /** int cef_post_task(cef_thread_id_t, cef_task_t*): every thread's work on the UI thread. */
        cef_post_task: { convention: 'cdecl', argBytes: 8,
            handler: (/** @type {number[]} */ [, task])=>{
                post(task);
                return 1;
            } },

        /** int cef_post_delayed_task(cef_thread_id_t, cef_task_t*, int64 delay_ms) */
        cef_post_delayed_task: { convention: 'cdecl', argBytes: 16,
            handler: (/** @type {number[]} */ [, task, delay])=>{
                setTimeout(()=>post(task), Math.max(0, delay | 0));
                return 1;
            } },
    };

    return Object.fromEntries(EXPORTS.map(name=>[name, answered[name] ?? notYet(name)]));
}
