/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * mscoree -- the .NET runtime's shim, which every managed executable imports
 * for its one entry, `_CorExeMain`, and which here hands the program to Mono:
 * the bottle's Mono runtime (`MONO_DIRECTORY`, Mono's own Windows build) is
 * loaded as a library like any other, and its embedding API runs the process's
 * assembly on the calling thread. The runtime is the program's guest code, so
 * its JIT, its threads and its exceptions are cork's and Win32's like a game's.
 *
 * A bottle without the runtime is told so as Windows tells a machine without
 * .NET: the program does not run, and the loss is said.
 */

/** Where a bottle keeps the Mono runtime: `bin`, `lib\mono\4.5`, `etc\mono`. */
export const MONO_DIRECTORY = 'C:\\Windows\\Mono';

/** The runtime library under it, and the version every assembly is run under. */
const MONO_LIBRARY = `${MONO_DIRECTORY}\\bin\\libmono-2.0-x86.dll`;
const RUNTIME_VERSION = 'v4.0.30319';

/** What ends a process whose runtime is missing: STATUS_DLL_NOT_FOUND. */
const STATUS_DLL_NOT_FOUND = 0xc0000135;

/**
 * What Mono is told before it starts, in MONO_DEBUG: a read through a null
 * pointer finds zeros here rather than faulting (decision A79), and Mono's
 * JIT finds a null reference by that fault unless it checks for one itself.
 */
const NULL_CHECKS = 'explicit-null-checks';

/** The embedding calls `_CorExeMain` makes, in order. */
const MONO_CALLS = ['mono_set_dirs', 'mono_config_parse', 'mono_jit_init_version',
    'mono_domain_assembly_open', 'mono_jit_exec'];

/**
 * @typedef {Object} MscoreeHost
 * @property {(path: string) => Promise<number>} loadLibrary  a module, or 0
 * @property {(module: number, name: string) => Promise<number>} procAddress  or 0
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => string} imagePath  the process's executable, as Windows names it
 * @property {() => string[]} arguments  its command line split as CommandLineToArgvW splits it
 * @property {(path: string) => boolean} exists
 * @property {(name: string) => Promise<string | null>} getEnvironment
 * @property {(name: string, value: string) => Promise<any>} setEnvironment
 * @property {(code: number) => Promise<any> | any} exitProcess
 * @property {(api: string, detail: string, kind?: 'loss') => void} [divergence]
 */

/** @param {string} text */
const utf8z = text=>new TextEncoder().encode(`${text}\0`);

/**
 * @param {MscoreeHost} host
 */
export function createMscoreeFunctions(host){
    /**
     * Strings and pointer arrays in the process's heap, freed together.
     */
    const arena = ()=>{
        /** @type {number[]} */
        const held = [];
        return {
            /** @param {string} text */
            string(text){
                const bytes = utf8z(text);
                const at = host.heap.allocate(bytes.length);
                host.writeMemory(at, bytes);
                held.push(at);
                return at;
            },
            /** @param {number[]} words */
            words(words){
                const at = host.heap.allocate(Math.max(4, words.length * 4));
                host.writeMemory(at, new Uint8Array(new Uint32Array(words).buffer));
                held.push(at);
                return at;
            },
            free(){
                held.forEach(at=>host.heap.free(at));
            },
        };
    };

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

    return {
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
         * what Main returned: Mono told to check for null references itself,
         * its directories set to the bottle's runtime,
         * its configuration read, a domain made for the 4.0 runtime, the
         * executable opened as an assembly in it and executed with the
         * command line's arguments, the executable's own path first.
         */
        _CorExeMain: {
            argBytes: 0,
            handler: async()=>{
                const thread = host.currentThread();
                if (!host.exists(MONO_LIBRARY))
                {
                    return lost(`no .NET runtime in this bottle (${MONO_LIBRARY})`);
                }
                const module = await host.loadLibrary(MONO_LIBRARY);
                if (module === 0)
                {
                    return lost(`${MONO_LIBRARY} did not load`);
                }
                /** @type {Record<string, number>} */
                const entry = {};
                for (const name of MONO_CALLS)
                {
                    entry[name] = await host.procAddress(module, name);
                    if (entry[name] === 0)
                    {
                        return lost(`${MONO_LIBRARY} exports no ${name}`);
                    }
                }
                const debug = await host.getEnvironment('MONO_DEBUG');
                if (!(debug ?? '').split(',').includes(NULL_CHECKS))
                {
                    await host.setEnvironment('MONO_DEBUG', debug ? `${debug},${NULL_CHECKS}`
                        : NULL_CHECKS);
                }
                const strings = arena();
                /** @param {string} name @param {number[]} args */
                const call = (name, args)=>host.callGuest({ entry: entry[name], args, thread });
                try
                {
                    await call('mono_set_dirs', [strings.string(`${MONO_DIRECTORY}\\lib`),
                        strings.string(`${MONO_DIRECTORY}\\etc`)]);
                    await call('mono_config_parse', [0]);
                    const image = host.imagePath();
                    const domain = (await call('mono_jit_init_version',
                        [strings.string(image), strings.string(RUNTIME_VERSION)])) >>> 0;
                    if (domain === 0)
                    {
                        return lost(`Mono made no domain for ${RUNTIME_VERSION}`);
                    }
                    const assembly = (await call('mono_domain_assembly_open',
                        [domain, strings.string(image)])) >>> 0;
                    if (assembly === 0)
                    {
                        return lost(`Mono did not open ${image} as an assembly`);
                    }
                    const args = [image, ...host.arguments().slice(1)];
                    const argv = strings.words([...args.map(arg=>strings.string(arg)), 0]);
                    const code = await call('mono_jit_exec', [domain, assembly, args.length, argv]);
                    await host.exitProcess(code >>> 0);
                    return code;
                }
                finally
                {
                    strings.free();
                }
            },
        },
    };
}
