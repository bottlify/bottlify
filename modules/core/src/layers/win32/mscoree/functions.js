/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mscoree -- the .NET runtime's shim. Every managed executable imports it for
 * its one entry, `_CorExeMain`, and native programs host the runtime through
 * it (`hosting.js`). A bottle the .NET Framework 4 was installed into has
 * Microsoft's own shim, `mscoreei.dll`, beside the runtime; `_CorExeMain`
 * hands the program to it, as Windows' mscoree.dll does, and the program runs
 * on the real CLR. Otherwise both reach the bottle's Mono runtime
 * (`runtime.js`), started once for the process by whichever comes first.
 * Either runtime is the program's guest code, so its JIT, its threads and its
 * exceptions are cork's and Win32's like a game's.
 *
 * A bottle without the runtime is told so as Windows tells a machine without
 * .NET: the program does not run, and the loss is said.
 */

import { createHostingFunctions } from './hosting.js';
import { createRuntimeHosts } from './corhost.js';
import { MONO_DIRECTORY, MONO_LIBRARY, createMonoRuntime } from './runtime.js';

export { MONO_DIRECTORY };

/** Where the .NET Framework 4 installs its shim, under the Windows directory. */
export const FRAMEWORK_SHIM = 'Microsoft.NET\\Framework\\v4.0.30319\\mscoreei.dll';

/** What ends a process whose runtime is missing: STATUS_DLL_NOT_FOUND. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

/**
 * @typedef {Object} MscoreeHost
 * @property {(path: string) => Promise<number>} loadLibrary  a module, or 0
 * @property {(module: number, name: string) => Promise<number>} procAddress  or 0
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {() => string} imagePath  the process's executable, as Windows names it
 * @property {() => string[]} arguments  its command line split as CommandLineToArgvW splits it
 * @property {(path: string) => boolean} exists
 * @property {(name: string) => Promise<string | null>} getEnvironment
 * @property {(name: string, value: string) => Promise<any>} setEnvironment
 * @property {(code: number) => Promise<any> | any} exitProcess
 * @property {() => string} [windowsDirectory]
 * @property {(path: string) => Promise<Uint8Array | null>} [readFile]
 * @property {(object: any, iid: string) => number} [publish]
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/**
 * @param {MscoreeHost} host
 */
export function createMscoreeFunctions(host){
    const readMemory = host.readMemory ?? (()=>new Uint8Array(4));
    const runtime = createMonoRuntime({ ...host, readMemory });

    /**
     * The process ended for want of the runtime: said as a loss, and the code
     * a missing library ends a process with.
     *
     * @param {string} detail
     */
    const lost = async detail=>{
        host.divergence?.('_CorExeMain', `the managed program does not run: ${detail}`, 'loss');
        await host.exitProcess(STATUS_DLL_NOT_FOUND);
        return STATUS_DLL_NOT_FOUND;
    };

    const runtimeInterface = createRuntimeHosts({
        runtime,
        publish: (object, iid)=>host.publish?.(object, iid) ?? 0,
        writeMemory: host.writeMemory,
        readWideString: host.readWideString ?? (()=>''),
        imagePath: host.imagePath,
        divergence: host.divergence,
    });

    /**
     * The installed Framework's shim's own export, or 0 when the bottle has
     * no Framework (or its shim lacks the name): the shim is loaded from the
     * Framework's directory, where it finds the runtime the program asks for.
     *
     * @param {string} name
     */
    const frameworkShim = async name=>{
        const windows = (host.windowsDirectory?.() ?? 'C:\\WINDOWS').replace(/\\$/, '');
        const path = `${windows}\\${FRAMEWORK_SHIM}`;
        if (!host.exists(path))
        {
            return 0;
        }
        const module = await host.loadLibrary(path);
        return module === 0 ? 0 : host.procAddress(module, name);
    };

    /** Where the shim's own two callback routines are, once looked up. */
    /** @type {{ set: number, unset: number } | null} */
    let callbacks = null;

    const hosting = createHostingFunctions({
        readMemory,
        writeMemory: host.writeMemory,
        readWideString: host.readWideString ?? (()=>''),
        windowsDirectory: host.windowsDirectory ?? (()=>'C:\\WINDOWS'),
        installed: ()=>host.exists(MONO_LIBRARY),
        exists: host.exists,
        readFile: host.readFile ?? (async()=>null),
        loadLibrary: host.loadLibrary,
        publish: (object, iid)=>host.publish?.(object, iid) ?? 0,
        exitProcess: host.exitProcess,
        runtimeInterface: (_version, clsid, iid)=>runtimeInterface(clsid, iid),
        // A runtime just loaded is told to the callback a host registered,
        // on the thread that loaded it, with the shim's two routines for
        // marking that thread as the callback's.
        notifyLoaded: async(callback, info)=>{
            const thread = host.currentThread();
            if (!callbacks)
            {
                const module = await host.loadLibrary('mscoree.dll');
                callbacks = { set: await host.procAddress(module, 'CallbackThreadSet'),
                    unset: await host.procAddress(module, 'CallbackThreadUnset') };
            }
            await host.callGuest({ entry: callback, args: [info, callbacks.set, callbacks.unset],
                thread });
        },
        divergence: host.divergence,
    });

    return {
        ...hosting,

        /**
         * HRESULT CallbackThreadSet(void), HRESULT CallbackThreadUnset(void)
         *
         * What a runtime-loaded callback is handed to mark its thread as the
         * callback's and to let it go; nothing depends on the mark here, so
         * both answer S_OK. Exported so the pointers handed out are routines
         * of this library, as on Windows they are the shim's own.
         */
        CallbackThreadSet: { argBytes: 0, handler: ()=>0 },
        CallbackThreadUnset: { argBytes: 0, handler: ()=>0 },

        /**
         * BOOL _CorDllMain(HINSTANCE hInst, DWORD dwReason, LPVOID lpReserved)
         *
         * The entry of a managed library, which Mono maps through the system's
         * loader to read its metadata: the library is the runtime's to use, and
         * there is nothing of its own to start or stop, so every notification
         * is answered TRUE.
         */
        _CorDllMain: {
            argBytes: 12,
            handler: ()=>1,
        },

        /**
         * __int32 _CorExeMain(void)
         *
         * The process's assembly run to its end and the process ended with
         * what Main returned: the runtime started (Mono told to check for null
         * references itself, its directories set to the bottle's runtime, its
         * configuration read, a domain made for the 4.0 runtime), the
         * executable opened as an assembly and executed with the command
         * line's arguments, the executable's own path first.
         */
        _CorExeMain: {
            argBytes: 0,
            handler: async()=>{
                const thread = host.currentThread();
                const shim = await frameworkShim('_CorExeMain');
                if (shim !== 0)
                {
                    const code = await host.callGuest({ entry: shim, args: [], thread });
                    await host.exitProcess(code >>> 0);
                    return code;
                }
                const image = host.imagePath();
                const started = await runtime.start(image);
                if ('failed' in started)
                {
                    return lost(started.failed);
                }
                const ran = await runtime.execute(image,
                    [image, ...host.arguments().slice(1)]);
                if ('failed' in ran)
                {
                    return lost(ran.failed);
                }
                await host.exitProcess(ran.code >>> 0);
                return ran.code;
            },
        },
    };
}
