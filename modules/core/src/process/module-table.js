/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * module-table - a process's modules, the program's image, the libraries it
 * mapped from files and the engine's own, by base and by the bare name a load
 * finds first, and the one lookup every caller makes: a name, a path or none
 * (the program itself). What a module is (its record) is the caller's; the
 * table only says which one a name or an address means, in the order the
 * modules came, as Windows walks them.
 */

/**
 * A module record as the table needs it: the rest is the caller's.
 *
 * @typedef {{ name: string, base: number, size?: number, path?: string,
 *     fromFile?: boolean, loaded?: boolean }} ModuleRecord
 */

/**
 * A path as the loader compares two: one separator, any case.
 *
 * @param {string} path
 */
export const pathKey = path=>path.replace(/\//g, '\\').replace(/\\{2,}/g, '\\').toLowerCase();

/**
 * @template {ModuleRecord} M
 * @param {{
 *     keyOf: (name: string) => string,
 *     placesNamed: (path: string, only?: string[]) => string[],
 *     importsOf?: (module: M) => string[],
 *     onLoaded?: (module: M) => void,
 * }} options
 *     `keyOf`: a name's key (`moduleKeyOf`); `placesNamed`: every file a path
 *     given to LoadLibrary can name, as `pathKey`s; `importsOf`: the keys of
 *     the modules a module brings in as it is loaded (an engine library's
 *     own imports); `onLoaded`: told of each module as it is marked loaded.
 */
export function createModuleTable({ keyOf, placesNamed, importsOf, onLoaded }){
    /** The module a bare name finds: the first loaded of that name. @type {Map<string, M>} */
    const byName = new Map();
    /** Every module, in the order it came. @type {Map<number, M>} */
    const byBase = new Map();
    /** @type {M | null} */
    let main = null;

    /**
     * The module loaded from a file at this path, whichever name it has: a
     * path names a file, and two files of one name are two modules.
     *
     * @param {string} path
     */
    const atPath = path=>{
        const wanted = placesNamed(path);
        for (const module of byBase.values())
        {
            if (module.fromFile && module.path && wanted.includes(pathKey(module.path)))
            {
                return module;
            }
        }
        return null;
    };

    /**
     * Takes a module's name off the bare-name index when it is the one there,
     * and puts in its place another module of that name, the next a bare
     * name finds.
     *
     * @param {M} held
     */
    const forgetName = held=>{
        const key = keyOf(held.name);
        if (byName.get(key) !== held)
        {
            return;
        }
        byName.delete(key);
        for (const other of byBase.values())
        {
            if (other !== held && keyOf(other.name) === key)
            {
                byName.set(key, other);
                return;
            }
        }
    };

    const table = {
        /**
         * Adds a module at its base. `name`: the key a bare name finds it by,
         * `replace` taking the key from a module that held it, `first` only
         * where none does (a second file of a loaded module's name), `none`
         * for a module no bare name finds (an assembly's face).
         *
         * @param {M} module @param {string | null} key
         * @param {'replace' | 'first'} [mode]
         */
        add(module, key, mode = 'replace'){
            if (key !== null && (mode === 'replace' || !byName.has(key)))
            {
                byName.set(key, module);
            }
            byBase.set(module.base, module);
        },
        /**
         * The program's own image: what a null name finds, and known by its
         * file name as well.
         *
         * @param {M} module @param {string} key
         */
        setMain(module, key){
            main = module;
            table.add(module, key);
        },
        /** Takes a module out, its name passing to the next of that name. @param {M} module */
        remove(module){
            byBase.delete(module.base);
            forgetName(module);
        },
        /** @param {string} key */
        named: key=>byName.get(key) ?? null,
        /** @param {string} key */
        hasName: key=>byName.has(key),
        /** @param {number} base */
        atBase: base=>byBase.get(base >>> 0) ?? null,
        /** Every module, in the order it came. */
        all: ()=>byBase.values(),
        /** Every module a bare name finds, each once. */
        nameHolders: ()=>new Set(byName.values()),
        /** Every module the process has loaded, in the order it came. */
        loaded: ()=>[...byBase.values()].filter(module=>module.loaded !== false),
        /**
         * The module an address lies in, or null.
         *
         * @param {number} address
         */
        containing(address){
            const at = address >>> 0;
            for (const module of byBase.values())
            {
                if (at >= module.base && at < module.base + (module.size ?? 0))
                {
                    return module;
                }
            }
            return null;
        },
        atPath,
        /**
         * The module a name means: the program for none, a path's file for a
         * path, else the first module of the bare name.
         *
         * @param {string | null} name
         */
        find(name){
            if (name === null || name === '')
            {
                return main;
            }
            return (/[\\/]/.test(name) ? atPath(name) : null) ?? byName.get(keyOf(name)) ?? null;
        },
        /**
         * Whether a load by this name is answered by `module`: a bare name by
         * the first module of that name, a path only by the module read from
         * that file. Windows looks a path up among the loaded modules by the
         * whole of it, so a second file of a loaded module's name -- the .NET
         * Framework's native image of a mixed assembly, beside the assembly
         * itself -- is loaded as a module of its own.
         *
         * @param {string} name @param {M | null | undefined} module
         * @param {string[]} [only]  A LoadLibraryEx search's places.
         */
        answersPath: (name, module, only = undefined)=>!/[\\/]/.test(name)
            || !module?.fromFile || !module.path
            || placesNamed(name, only).includes(pathKey(module.path)),
        /**
         * Marks a module the process has loaded, with what it brings in, for
         * everything that answers only about loaded modules: GetModuleHandle
         * and PEB->Ldr. A module synthesised at the start is there to be
         * bound to whenever it is asked for, but it is loaded only once
         * something imports it or loads it.
         *
         * @param {M | null} module
         */
        markLoaded(module){
            if (!module || module.loaded !== false)
            {
                return;
            }
            module.loaded = true;
            onLoaded?.(module);
            for (const imported of importsOf?.(module) ?? [])
            {
                table.markLoaded(byName.get(imported) ?? null);
            }
        },
    };
    return table;
}
