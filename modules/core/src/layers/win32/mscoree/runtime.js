/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The bottle's Mono runtime in a process: loaded and started once, by
 * whichever comes first -- a managed executable's `_CorExeMain` or a native
 * program hosting the runtime -- and driven through Mono's embedding API, its
 * own exports called as guest code on the calling thread.
 *
 * What a host asks of the runtime by COM (an AppDomain, an AppDomainSetup) is
 * a managed object handed out through Mono's own COM interop
 * (`Marshal.GetIUnknownForObject`): the interfaces it answers are the ones the
 * class library declares, as on .NET.
 */

/** Where a bottle keeps the Mono runtime: `bin`, `lib\mono\4.5`, `etc\mono`. */
export const MONO_DIRECTORY = 'C:\\Windows\\Mono';

/** The runtime library under it, and the version every assembly is run under. */
export const MONO_LIBRARY = `${MONO_DIRECTORY}\\bin\\libmono-2.0-x86.dll`;
const RUNTIME_VERSION = 'v4.0.30319';

/**
 * What Mono is told before it starts, in MONO_DEBUG: a read through a null
 * pointer finds zeros here rather than faulting (decision A79), and Mono's
 * JIT finds a null reference by that fault unless it checks for one itself.
 */
const NULL_CHECKS = 'explicit-null-checks';

/** The embedding calls used, all exported by the runtime library. */
const MONO_CALLS = ['mono_set_dirs', 'mono_config_parse', 'mono_jit_init_version',
    'mono_domain_assembly_open', 'mono_jit_exec', 'mono_thread_attach', 'mono_get_corlib',
    'mono_class_from_name', 'mono_class_get_method_from_name', 'mono_runtime_invoke',
    'mono_object_unbox', 'mono_string_new', 'mono_object_new', 'mono_runtime_object_init',
    'mono_assembly_get_image', 'mono_gchandle_new', 'mono_gchandle_free', 'mono_domain_get_by_id',
    'mono_domain_set', 'mono_object_get_virtual_method'];

/**
 * @typedef {Object} RuntimeHost
 * @property {(path: string) => boolean} exists
 * @property {(path: string) => Promise<number>} loadLibrary  a module, or 0
 * @property {(module: number, name: string) => Promise<number>} procAddress  or 0
 * @property {(call: { entry: number, args: number[], thread?: any }) => Promise<number>} callGuest
 * @property {() => any} currentThread
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} heap
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(name: string) => Promise<string | null>} getEnvironment
 * @property {(name: string, value: string) => Promise<any>} setEnvironment
 */

/** @param {string} text */
const utf8z = text=>new TextEncoder().encode(`${text}\0`);

/**
 * @param {RuntimeHost} host
 */
export function createMonoRuntime(host){
    /** @type {Record<string, number>} */
    const entry = {};
    /** The root domain once started; the failure that stopped it, else. */
    /** @type {{ domain: number } | { failed: string } | null} */
    let started = null;
    /** @type {Promise<{ domain: number } | { failed: string }> | null} */
    let starting = null;

    /** @param {number} at */
    const readU32 = at=>new DataView(host.readMemory(at >>> 0, 4).slice().buffer)
        .getUint32(0, true);

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

    /** @param {string} name @param {number[]} args */
    const call = async(name, args)=>(await host.callGuest({ entry: entry[name], args,
        thread: host.currentThread() })) >>> 0;

    /**
     * Loads and starts the runtime, once for the process; the domain is named
     * after the program, as `mono_jit_init_version` names its root domain.
     *
     * @param {string} name
     * @returns {Promise<{ domain: number } | { failed: string }>}
     */
    const start = name=>{
        if (started)
        {
            return Promise.resolve(started);
        }
        starting ??= (async()=>{
            if (!host.exists(MONO_LIBRARY))
            {
                return { failed: `no .NET runtime in this bottle (${MONO_LIBRARY})` };
            }
            const module = await host.loadLibrary(MONO_LIBRARY);
            if (module === 0)
            {
                return { failed: `${MONO_LIBRARY} did not load` };
            }
            for (const routine of MONO_CALLS)
            {
                entry[routine] = await host.procAddress(module, routine);
                if (entry[routine] === 0)
                {
                    return { failed: `${MONO_LIBRARY} exports no ${routine}` };
                }
            }
            const debug = await host.getEnvironment('MONO_DEBUG');
            if (!(debug ?? '').split(',').includes(NULL_CHECKS))
            {
                await host.setEnvironment('MONO_DEBUG', debug ? `${debug},${NULL_CHECKS}`
                    : NULL_CHECKS);
            }
            const strings = arena();
            try
            {
                await call('mono_set_dirs', [strings.string(`${MONO_DIRECTORY}\\lib`),
                    strings.string(`${MONO_DIRECTORY}\\etc`)]);
                await call('mono_config_parse', [0]);
                const domain = await call('mono_jit_init_version',
                    [strings.string(name), strings.string(RUNTIME_VERSION)]);
                return domain === 0 ? { failed: `Mono made no domain for ${RUNTIME_VERSION}` }
                    : { domain };
            }
            finally
            {
                strings.free();
            }
        })().then(result=>{
            started = result;
            return result;
        });
        return starting;
    };

    /**
     * The started runtime's root domain, with the calling thread attached to
     * it, as every thread that runs managed code must be; null before a start.
     */
    const attached = async()=>{
        if (!started || !('domain' in started))
        {
            return null;
        }
        await call('mono_thread_attach', [started.domain]);
        return started.domain;
    };

    /**
     * A managed method called through `mono_runtime_invoke`: a static one when
     * `self` is 0. The arguments are pointers to objects, as the embedding API
     * takes reference types. The result object, or the exception it threw.
     *
     * @param {string} namespace @param {string} className @param {string} method
     * @param {number} self @param {number[]} args
     * @returns {Promise<{ result: number } | { thrown: number } | { missing: string }>}
     */
    const invoke = async(namespace, className, method, self, args)=>{
        const scratch = arena();
        try
        {
            const corlib = await call('mono_get_corlib', []);
            const klass = await call('mono_class_from_name', [corlib, scratch.string(namespace),
                scratch.string(className)]);
            const declared = klass ? await call('mono_class_get_method_from_name',
                [klass, scratch.string(method), args.length]) : 0;
            if (!declared)
            {
                return { missing: `${namespace}.${className}.${method}` };
            }
            // On an object, the method the object's own class answers with --
            // for a proxy to an object of another domain, the call carried
            // there rather than run on the proxy's own fields.
            const found = self ? await call('mono_object_get_virtual_method', [self, declared])
                : declared;
            const thrown = scratch.words([0]);
            const result = await call('mono_runtime_invoke', [found, self,
                args.length ? scratch.words(args) : 0, thrown]);
            const exception = readU32(thrown);
            return exception ? { thrown: exception } : { result };
        }
        finally
        {
            scratch.free();
        }
    };

    /**
     * A managed object as a COM IUnknown, through the class library's own
     * `Marshal.GetIUnknownForObject`; 0 when it could not be made.
     *
     * @param {number} object
     */
    const unknownFor = async object=>{
        const made = await invoke('System.Runtime.InteropServices', 'Marshal',
            'GetIUnknownForObject', 0, [object]);
        if (!('result' in made) || made.result === 0)
        {
            return 0;
        }
        return readU32(await call('mono_object_unbox', [made.result]));
    };

    /**
     * An application domain a call made, as COM: the domain's own AppDomain
     * object, taken inside it, rather than the proxy the making domain holds,
     * whose COM face answers none of AppDomain's interfaces. 0 when it could
     * not be made.
     *
     * @param {number} proxy  the AppDomain the call returned
     */
    const unknownForDomain = async proxy=>{
        const id = await invoke('System', 'AppDomain', 'get_Id', proxy, []);
        if (!('result' in id) || !id.result || !started || !('domain' in started))
        {
            return 0;
        }
        const domain = await call('mono_domain_get_by_id',
            [readU32(await call('mono_object_unbox', [id.result]))]);
        if (!domain)
        {
            return 0;
        }
        await call('mono_domain_set', [domain, 0]);
        try
        {
            const own = await invoke('System', 'AppDomain', 'get_CurrentDomain', 0, []);
            return 'result' in own && own.result ? await unknownFor(own.result) : 0;
        }
        finally
        {
            await call('mono_domain_set', [started.domain, 0]);
        }
    };

    /**
     * The managed object a COM pointer stands for, through
     * `Marshal.GetObjectForIUnknown`; 0 for a null pointer or a failure.
     *
     * @param {number} unknown
     */
    const objectFor = async unknown=>{
        if (!unknown)
        {
            return 0;
        }
        const scratch = arena();
        try
        {
            // An IntPtr argument is passed by the address of its value.
            const made = await invoke('System.Runtime.InteropServices', 'Marshal',
                'GetObjectForIUnknown', 0, [scratch.words([unknown])]);
            return 'result' in made ? made.result : 0;
        }
        finally
        {
            scratch.free();
        }
    };

    /** The root domain the runtime started with. */
    const rootDomain = ()=>(started && 'domain' in started ? started.domain : 0);

    /** A managed string in the root domain. @param {string} text */
    const string = async text=>{
        const scratch = arena();
        try
        {
            return await call('mono_string_new', [rootDomain(), scratch.string(text)]);
        }
        finally
        {
            scratch.free();
        }
    };

    /**
     * A new object of a corlib class, made by its default constructor.
     *
     * @param {string} namespace @param {string} className
     */
    const construct = async(namespace, className)=>{
        const scratch = arena();
        try
        {
            const corlib = await call('mono_get_corlib', []);
            const klass = await call('mono_class_from_name', [corlib, scratch.string(namespace),
                scratch.string(className)]);
            if (!klass)
            {
                return 0;
            }
            const object = await call('mono_object_new', [rootDomain(), klass]);
            if (object)
            {
                await call('mono_runtime_object_init', [object]);
            }
            return object;
        }
        finally
        {
            scratch.free();
        }
    };

    /**
     * Runs an executable's assembly in the root domain: its entry point with
     * the arguments given, the executable's path first. Main's answer, or the
     * reason it did not run.
     *
     * @param {string} path @param {string[]} args
     * @returns {Promise<{ code: number } | { failed: string }>}
     */
    const execute = async(path, args)=>{
        const domain = await attached();
        if (domain === null)
        {
            return { failed: 'the runtime is not started' };
        }
        const scratch = arena();
        try
        {
            const assembly = await call('mono_domain_assembly_open', [domain,
                scratch.string(path)]);
            if (assembly === 0)
            {
                return { failed: `Mono did not open ${path} as an assembly` };
            }
            const argv = scratch.words([...args.map(arg=>scratch.string(arg)), 0]);
            return { code: await call('mono_jit_exec', [domain, assembly, args.length, argv]) };
        }
        finally
        {
            scratch.free();
        }
    };

    /**
     * A static method `int Method(string)` of a type in an assembly, run in the
     * root domain, as ICLRRuntimeHost::ExecuteInDefaultAppDomain runs one.
     *
     * @param {string} path @param {string} typeName @param {string} method @param {string} arg
     * @returns {Promise<{ value: number } | { failed: string } | { thrown: number }>}
     */
    const executeMethod = async(path, typeName, method, arg)=>{
        const domain = await attached();
        if (domain === null)
        {
            return { failed: 'the runtime is not started' };
        }
        const scratch = arena();
        try
        {
            const assembly = await call('mono_domain_assembly_open', [domain,
                scratch.string(path)]);
            if (!assembly)
            {
                return { failed: `Mono did not open ${path} as an assembly` };
            }
            const image = await call('mono_assembly_get_image', [assembly]);
            const cut = typeName.lastIndexOf('.');
            const klass = await call('mono_class_from_name', [image,
                scratch.string(cut < 0 ? '' : typeName.slice(0, cut)),
                scratch.string(typeName.slice(cut + 1))]);
            const found = klass ? await call('mono_class_get_method_from_name',
                [klass, scratch.string(method), 1]) : 0;
            if (!found)
            {
                return { failed: `${typeName}.${method}(string) is not in ${path}` };
            }
            const thrown = scratch.words([0]);
            const result = await call('mono_runtime_invoke', [found, 0,
                scratch.words([await string(arg)]), thrown]);
            if (readU32(thrown))
            {
                return { thrown: readU32(thrown) };
            }
            return { value: result ? readU32(await call('mono_object_unbox', [result])) : 0 };
        }
        finally
        {
            scratch.free();
        }
    };

    return { start, attached, invoke, unknownFor, unknownForDomain, objectFor, string, construct,
        execute, executeMethod, started: ()=>started !== null && 'domain' in started };
}
