/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * system-modules - the engine's own libraries made modules in a process: each
 * table the layers export (win32's, the drawing APIs', sound's, input's)
 * synthesised by the loader at the next slot of the modules' window, its
 * exports code of their own, guest code placed at bind time, or traps into
 * the host. What the process does with a module once it has it - finding it,
 * loading it, letting it go - is the module table's and the loader's.
 */

import { imagePlacementOf, installedHeaders } from '../layers/loader/internal/synth.js';

/**
 * @typedef {Object} SystemModulesHost
 * @property {any} loader          the loader layer's api (`synthesise`)
 * @property {any} bridge          the bridge layer's api (`register`, `labelSpan`)
 * @property {any} cpu             the cpu layer's api (`stubAt`)
 * @property {(address: number, length: number) => void} atomicCode
 *     the kernel's: code that runs unbroken
 * @property {boolean} long        a 64-bit process
 * @property {Record<string, Record<number, string>>} ordinalsOf
 *     the numbers each library's exports are imported by
 * @property {number} start        where the first module goes
 * @property {number} end          where the modules' window ends (`LIBRARIES_END`)
 * @property {number} align        every image's granularity (`LIBRARY_ALIGN`)
 * @property {any} librarySpace    where a library may go (`placeLibrary`'s bounds)
 * @property {(image: any, space: any) => any} placeLibrary
 * @property {Record<string, Uint8Array>} [clientFiles]  the Steam client's files, by name
 * @property {(api: string, detail: string) => void} reportDivergence
 * @property {(record: any) => number | Promise<number>} release  a module let go of
 * @property {boolean} [later]  each module's bytes written when it is first loaded
 *     (`place`), its span and addresses fixed now; else at once
 * @property {<T>(place: () => T) => T} [placing]  runs a module's exports made, what
 *     they allocate for themselves taken from the engine's span
 * @property {{ at: () => number, skipTo: (to: number) => void,
 *     within: <T>(from: number, to: number, place: () => T) => T }} [engine]
 *     the engine's span (`app.js` `engineCode`): where it is taken up to, and a
 *     module's own part of it, where its routines go in every process
 * @property {{ laidOut: () => TrapLayout, follow: (layout: TrapLayout) => void }} [traps]
 *     the stub table's slots by name (`cpu` `trapLayout`): the stubs a
 *     module's routines fall back to at the same addresses in every process
 * @property {string} [fingerprint]  what the tables are, for a layout kept for the
 *     runtime's next process (`LAYOUTS`); none keeps none
 */

/**
 * One module as a machine lays it out: where it lies, its exports' addresses
 * and numbers, and the exports a 64-bit process leaves out.
 *
 * @typedef {{ base: number, size: number, entryPoint: number,
 *     addresses: Map<string, number>, ordinals: Map<number, number>,
 *     leftOut: string[], engine: [number, number], shape: string }} ModuleLayout
 *     `engine`: the part of the engine's span its exports took for themselves;
 *     `shape`: its table's names and kinds (`shapeOf`)
 * @typedef {{ names: Map<string, number[]>, end: number }} TrapLayout
 * @typedef {{ modules: Map<string, ModuleLayout>, end: number, engineEnd: number,
 *     traps: TrapLayout | null }}
 *     MachineLayout
 */

/**
 * The machine's layout of the engine's libraries, kept by this runtime for
 * its next processes, by what it was laid out from (`fingerprint`): the same
 * tables, in the same order, lay out the same - a later process takes it and
 * builds a module only where it places one. What a module's exports allocate
 * for themselves is in the engine's span in every process (`placing`), so a
 * program's own memory does not hang on which process of the runtime it is.
 * Shared, never written after it is kept.
 *
 * @type {Map<string, MachineLayout>}
 */
const LAYOUTS = new Map();

/**
 * A table's names and what each is - code, data, a handler, guest code, its
 * arguments' bytes - hashed: two tables of one shape make the same module.
 *
 * @param {Record<string, any>} table
 * @returns {string}
 */
export function shapeOf(table){
    let hash = 0x811c9dc5;
    for (const [exported, fn] of Object.entries(table))
    {
        const text = `;${exported}:${fn.code ? 'c' : ''}${fn.long ? 'l' : ''}${fn.data ? 'd' : ''}`
            + `${fn.handler ? 'h' : ''}${fn.guest ? 'g' : ''}${fn.guestLong ? 'G' : ''}`
            + `${fn.argBytes ?? ''}`;
        for (let index = 0; index < text.length; index++)
        {
            hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
        }
    }
    return (hash >>> 0).toString(16);
}

/**
 * @param {SystemModulesHost} host
 */
export function createSystemModules(host){
    const { loader, bridge, cpu, long, ordinalsOf, librarySpace } = host;
    /**
     * The machine's layout an earlier process of this runtime laid out, where
     * there is one; none where none may be kept (the Steam client's own file
     * puts a module where the file says).
     */
    const layout = host.fingerprint === undefined || host.clientFiles
        ? null : LAYOUTS.get(host.fingerprint) ?? null;
    /**
     * The layout this process lays out, kept for the next (`done`) where it
     * found none.
     *
     * @type {MachineLayout | null}
     */
    const recording = layout === null && host.fingerprint !== undefined && !host.clientFiles
        ? { modules: new Map(), end: 0, engineEnd: 0, traps: null } : null;
    // What the engine's span holds for every module's routines lies before
    // anything else this process takes of it.
    if (layout)
    {
        host.engine?.skipTo(layout.engineEnd);
        if (layout.traps)
        {
            host.traps?.follow(layout.traps);
        }
    }
    // Each system module where the one before it ends, at the granularity
    // every image is placed at: the window they share is the room left for
    // the libraries a program brings, and a module is a few pages -- a
    // megabyte apart, sixty of them left a third of the window to those.
    let next = host.start;
    /**
     * The exports a 64-bit process's modules leave out: i386 alone -- guest
     * code with neither x86-64 (`long`) nor a host handler to trap into, as
     * `_chkesp` and the __fastcall entries are. Bound, its i386 would run as
     * x86-64; left out, a program that imports one is refused at load, by
     * name. Most have no x64 export on Windows either.
     *
     * @type {string[]}
     */
    const leftOutAt64 = [];

    /** An export's x86-64 as its code, with the pointers laid out in it. @param {any} fn */
    const longOf = fn=>({ ...fn, code: fn.long, pointers: fn.longPointers ?? fn.pointers });
    /**
     * An export that is code of its own, with the traps it jumps to registered
     * and the jumps to them for the loader to fill in.
     *
     * @param {any} fn @param {string} qualified  `DLL!Name`.
     */
    const codeExport = (fn, qualified)=>{
        /** @type {{ at: number, target: number }[]} */
        const jumps = [];
        const code = fn.code({
            /** @param {any} trap */
            register: trap=>bridge.register(qualified, trap),
            /** @param {number} at @param {number} target */
            jump: (at, target)=>void jumps.push({ at, target }),
        });
        return { code, jumps, pointers: fn.pointers };
    };
    /**
     * An export the host answers: a trampoline jumping to its trap, or guest
     * code placed at bind time where the function has any (`guest`; in a
     * 64-bit process only where it places its x86-64 there, `guestLong`, and
     * its host handler where the machine had no room for it).
     *
     * ntdll's system calls (Nt*, Zw*) are the trap's own bytes instead. On
     * Windows each is a few position-independent instructions that enter the
     * kernel, and a program may copy one elsewhere and call the copy - a
     * protection does, to call the kernel past a hook on the original; a
     * trampoline's relative jump, copied, lands nowhere. The trap's bytes
     * carry its id and run wherever they are.
     *
     * @param {string} library @param {string} exported @param {any} fn
     */
    const trapExport = (library, exported, fn)=>{
        const systemCall = !long && !fn.guest && library.toLowerCase() === 'ntdll.dll'
            && /^(Nt|Zw)[A-Z]/.test(exported);
        const target = (fn.guest && (!long || fn.guestLong)
            ? fn.guest({
                /** @param {string} label @param {any} trap */
                register: (label, trap)=>bridge.register(label, trap),
            }) : 0)
            || bridge.register(`${library}!${exported}`, fn);
        const own = systemCall ? cpu.stubAt(target) : null;
        return own ? { code: own } : { target };
    };

    /**
     * A table's exports as the loader takes them, their traps registered.
     * The names a 64-bit process leaves out are told to `left`. What they
     * allocate for themselves is the engine's (`placing`).
     *
     * @param {string} name @param {Record<string, any>} table
     * @param {(qualified: string) => void} left
     */
    const exportsOf = (name, table, left)=>{
        const made = ()=>exportsMade(name, table, left);
        return host.placing ? host.placing(made) : made();
    };
    /**
     * @param {string} name @param {Record<string, any>} table
     * @param {(qualified: string) => void} left
     */
    const exportsMade = (name, table, left)=>{
        // A library imported by number has to be synthesised with the numbers
        // the program compiled against; one we assigned ourselves would bind to
        // a different function, silently.
        /** @type {Record<number, string>} */
        const byOrdinal = ordinalsOf[name] ?? {};
        const declared = new Map(Object.entries(byOrdinal)
            .map(([ordinal, exported])=>[exported, Number(ordinal)]));
        return Object.entries(table).filter(([exported, fn])=>{
            const runs = !long || fn.long || fn.handler || fn.data;
            if (!runs)
            {
                left(`${name}!${exported}`);
            }
            return runs;
        }).map(([exported, fn])=>({
            name: exported,
            ordinal: declared.get(exported),
            // An export is a function that is code of its own, a variable the
            // program reads through its address, a trap into the host, or
            // guest code that decides for itself when to trap: the builder
            // hands such an entry the means to register the traps it falls
            // back to. Code of its own that hands a call to the host jumps to
            // a trap answering as the export, and named as it; the jump's
            // displacement is the loader's, which places the code.
            // A variable may hold other exports' addresses: a vtable's slots.
            // A long-mode process runs no i386: an export that is guest code
            // runs its x86-64 there (`long`), where the build made any, and
            // is a trap into its host handler where it did not.
            // A long export's pointers are its own: its code lays them out apart.
            ...long && fn.long || fn.code && !(long && fn.handler)
                ? codeExport(long && fn.long ? longOf(fn) : fn, `${name}!${exported}`)
                : fn.data ? {
                    data: fn.data(), pointers: fn.pointers, entry: fn.entry,
                } : trapExport(name, exported, fn),
        }));
    };

    /**
     * What a module's exports do once its bytes are written: an export whose
     * code writes what another thread's entry into the host reads, and never
     * waits, runs unbroken (the kernel's atomicCode).
     *
     * @param {Record<string, any>} table @param {any[]} exports
     * @param {(exported: string) => number | null} addressOf
     */
    const unbroken = (table, exports, addressOf)=>{
        for (const entry of exports)
        {
            if (table[entry.name]?.unbroken && 'code' in entry)
            {
                host.atomicCode(Number(addressOf(entry.name)), entry.code.length);
            }
        }
    };

    /**
     * A table of ours made a module in guest memory, after the ones before it.
     * The table may be given as what makes it: where the machine's layout has
     * the module, nothing makes it until the module is placed.
     *
     * @param {string} name @param {Record<string, any> | (() => Record<string, any>)} tableOf
     * @param {string} [region]  Its region's name, for one beside a library of the same name.
     */
    const build = (name, tableOf, region = name)=>{
        const known = layout?.modules.get(region);
        if (known && known.base === next)
        {
            return follow(name, tableOf, region, known);
        }
        const table = typeof tableOf === 'function' ? tableOf() : tableOf;
        /** @type {string[]} */
        const left = [];
        const engineFrom = host.engine?.at() ?? 0;
        // A part of its own (`within` with no slice): its code starts a page.
        const made = ()=>exportsOf(name, table, qualified=>left.push(qualified));
        const exports = host.engine ? host.engine.within(0, 0, made) : made();
        const engineTo = host.engine?.at() ?? 0;
        leftOutAt64.push(...left);

        // A table with a DllMain is a module with an entry point, run when a
        // program first loads it -- which is how a library the program did not
        // import announces itself to the one that asked for it.
        // The Steam client's own file, where the embedder fetched Valve's: the
        // module carries its headers, as the file stands in Steam's folder
        // (the win32 layer's volume), and sits where the file says it belongs.
        // Windows loads a DLL at its preferred base when that base is free -
        // Valve's files are linked for ASLR, which allows a move and does not
        // ask for one (decision A259) - and a DRM wrapper reads the file and
        // compares its headers with the module's: placed elsewhere, the module answers with
        // the loader's base where the file names Valve's, and the wrapper
        // refuses it (Proton keeps Valve's own client DLL where it says it
        // belongs for the same reason). It is placed as a library that can only
        // live at its base is: in the window when free there, else cut from
        // the heap.
        const installed = host.clientFiles?.[name];
        const wanted = installed ? imagePlacementOf(installed) : null;
        let base = next;
        if (wanted)
        {
            const place = host.placeLibrary({ relocatable: false, imageBase: wanted.base,
                sizeOfImage: wanted.span }, { next, ...librarySpace });
            if ('base' in place)
            {
                base = place.base;
            }
            else
            {
                host.reportDivergence('image', `${name} is placed away from the image base `
                    + `0x${wanted.base.toString(16)} its file names, which is not free`);
            }
        }
        const placed = loader.synthesise({
            name, base, exports, entryPoint: 'DllMain' in table ? 'DllMain' : undefined, long,
            region, headers: installed ? installedHeaders(installed, base) ?? undefined : undefined,
            later: host.later ?? false,
        });
        advance(base, placed.size);
        unbroken(table, exports, placed.addressOf);
        /** @type {[string, number][]} */
        const entries = placed.entries();
        if (recording && !installed)
        {
            recording.modules.set(region, {
                base, size: placed.size, entryPoint: placed.entryPoint,
                addresses: new Map(entries),
                ordinals: new Map(entries.map(([exported, at])=>[
                    Number(placed.ordinalOf(exported)), at])),
                leftOut: left,
                engine: [engineFrom, engineTo],
                shape: shapeOf(table),
            });
        }
        return recordOf(name, base, placed.size, placed.entryPoint, new Map(entries),
            ordinal=>placed.addressOfOrdinal(ordinal), placed.place);
    };

    /**
     * A module where the machine's layout put it, nothing of it built: its
     * span held, its exports made and its traps registered at its first place.
     * Its exports' addresses are the layout's, so its trampolines land where
     * every process was told; where they jump - a stub, a guest routine - is
     * this process's own, written with them.
     *
     * @param {string} name @param {Record<string, any> | (() => Record<string, any>)} tableOf
     * @param {string} region @param {ModuleLayout} known
     */
    const follow = (name, tableOf, region, known)=>{
        leftOutAt64.push(...known.leftOut);
        const held = loader.hold({
            name, base: known.base, size: known.size, entryPoint: known.entryPoint, long, region,
            exportsAt: ()=>{
                const table = typeof tableOf === 'function' ? tableOf() : tableOf;
                // The layout was keyed by what can be known before a table is
                // made (`tablesFingerprint`); a table made otherwise here
                // would be written over addresses laid out for another.
                if (shapeOf(table) !== known.shape)
                {
                    throw new Error(`system modules: ${name} is not the table the machine's`
                        + ' layout was made of');
                }
                const made = ()=>exportsOf(name, table, ()=>{});
                const exports = host.engine
                    ? host.engine.within(known.engine[0], known.engine[1], made) : made();
                unbroken(table, exports, exported=>known.addresses.get(exported) ?? null);
                return { exports, entryPoint: 'DllMain' in table ? 'DllMain' : undefined };
            },
        });
        advance(known.base, known.size);
        return recordOf(name, known.base, known.size, known.entryPoint, known.addresses,
            ordinal=>known.ordinals.get(ordinal) ?? null, ()=>void held.place());
    };

    /**
     * Moves the next slot past a module laid out at `base`.
     *
     * @param {number} base @param {number} size
     */
    const advance = (base, size)=>{
        const end = base + Math.ceil(size / host.align) * host.align;
        if (base === next)
        {
            next = end;
        }
        else if (base < host.end)
        {
            // A module given its own base inside the window keeps that span from
            // the ones laid out after it.
            next = Math.max(next, end);
        }
    };

    /**
     * A module's record, as the process's table keeps it.
     *
     * @param {string} name @param {number} base @param {number} size @param {number} entryPoint
     * @param {Map<string, number>} addresses
     * @param {(ordinal: number) => number | null} byOrdinal
     * @param {() => void} place
     */
    const recordOf = (name, base, size, entryPoint, addresses, byOrdinal, place)=>{
        // An export's address is its trampoline inside the module, and that is
        // what both the import table and GetProcAddress hand out -- so a program
        // comparing the two finds them equal, as it does on Windows. Its name,
        // for a report, is made when one asks.
        /** @type {Map<number, string> | null} */
        let names = null;
        bridge.labelSpan(base, size, (/** @type {number} */ address)=>{
            names ??= new Map([...addresses].map(([exported, at])=>[at, `${name}!${exported}`]));
            return names.get(address) ?? null;
        });
        /** @param {number | null | undefined} address */
        const handOut = address=>{
            if (address == null)
            {
                return null;
            }
            place();
            return address;
        };
        const record = {
            name,
            base,
            size,
            // An address handed out is one the guest may run or read: the
            // module's bytes are there from the moment any is.
            /** @param {string} exported */
            addressOf: exported=>handOut(addresses.get(exported)),
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>handOut(byOrdinal(ordinal)),
            entryPoint,
            // Not until a program asks for it: a synthesised module exists
            // from the first instruction, but its entry point is a promise
            // to whoever loads it, and runs on that caller's thread.
            attached: false,
            loaded: false,
            /** Writes its bytes into guest memory, where its span is held; once. */
            place,
            /** @returns {number | Promise<number>} */
            release: ()=>host.release(record),
        };
        return record;
    };

    return {
        build,
        /** Where the modules laid out so far end: the first address nothing claimed after them. */
        end: ()=>next,
        leftOutAt64,
        /** Every module laid out: what this process laid out kept for the next of the runtime. */
        done(){
            if (recording && host.fingerprint !== undefined)
            {
                recording.end = next;
                recording.engineEnd = host.engine?.at() ?? 0;
                recording.traps = host.traps?.laidOut() ?? null;
                LAYOUTS.set(host.fingerprint, recording);
            }
        },
    };
}
