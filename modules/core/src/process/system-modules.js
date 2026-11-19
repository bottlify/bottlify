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
 */

/**
 * @param {SystemModulesHost} host
 */
export function createSystemModules(host){
    const { loader, bridge, cpu, long, ordinalsOf, librarySpace } = host;
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
        const target = (fn.guest && (!long || fn.guestLong)
            ? fn.guest({
                /** @param {string} label @param {any} trap */
                register: (label, trap)=>bridge.register(label, trap),
            }) : 0)
            || bridge.register(`${library}!${exported}`, fn);
        const systemCall = !long && !fn.guest && library.toLowerCase() === 'ntdll.dll'
            && /^(Nt|Zw)[A-Z]/.test(exported);
        const own = systemCall ? cpu.stubAt(target) : null;
        return own ? { code: own } : { target };
    };

    /**
     * A table of ours made a module in guest memory, after the ones before it.
     *
     * @param {string} name @param {Record<string, any>} table
     * @param {string} [region]  Its region's name, for one beside a library of the same name.
     */
    const build = (name, table, region = name)=>{
        // A library imported by number has to be synthesised with the numbers
        // the program compiled against; one we assigned ourselves would bind to
        // a different function, silently.
        /** @type {Record<number, string>} */
        const byOrdinal = ordinalsOf[name] ?? {};
        const declared = new Map(Object.entries(byOrdinal)
            .map(([ordinal, exported])=>[exported, Number(ordinal)]));

        const exports = Object.entries(table).filter(([exported, fn])=>{
            const runs = !long || fn.long || fn.handler || fn.data;
            if (!runs)
            {
                leftOutAt64.push(`${name}!${exported}`);
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
        const end = base + Math.ceil(placed.size / host.align) * host.align;
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

        // An export's address is its trampoline inside the module, and that is
        // what both the import table and GetProcAddress hand out -- so a program
        // comparing the two finds them equal, as it does on Windows.
        /** @type {Map<number, string> | null} */
        let names = null;
        bridge.labelSpan(base, placed.size, (/** @type {number} */ address)=>{
            names ??= new Map(/** @type {[string, number][]} */ (placed.entries())
                .map(([exported, at])=>[at, `${name}!${exported}`]));
            return names.get(address) ?? null;
        });
        // An export whose code writes what another thread's entry into the
        // host reads, and never waits, runs unbroken (the kernel's atomicCode).
        for (const entry of exports)
        {
            if (table[entry.name]?.unbroken && 'code' in entry)
            {
                host.atomicCode(Number(placed.addressOf(entry.name)), entry.code.length);
            }
        }

        /** @param {number | null | undefined} address */
        const handOut = address=>{
            if (address == null)
            {
                return null;
            }
            placed.place();
            return address;
        };
        const record = {
            name,
            base,
            size: placed.size,
            // An address handed out is one the guest may run or read: the
            // module's bytes are there from the moment any is.
            /** @param {string} exported */
            addressOf: exported=>handOut(placed.addressOf(exported)),
            /** @param {number} ordinal */
            addressOfOrdinal: ordinal=>handOut(placed.addressOfOrdinal(ordinal)),
            entryPoint: placed.entryPoint,
            // Not until a program asks for it: a synthesised module exists
            // from the first instruction, but its entry point is a promise
            // to whoever loads it, and runs on that caller's thread.
            attached: false,
            loaded: false,
            /** Writes its bytes into guest memory, where its span is held; once. */
            place: placed.place,
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
    };
}
