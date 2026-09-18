/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Sidecar hooks: whether one entry of a bundle's `hooks.json` may be bound
 * against the image actually loaded here.
 *
 * A pure decision over plain data -- no guest memory, no bridge -- so it is
 * testable on a stub machine the way `pe.js`'s parsing is: what changes
 * between a run that binds a hook and one that refuses it is answered here,
 * once, rather than reasoned about at the two real call sites (`module.js`
 * for real, and a test's stand-in for the rest).
 */

/**
 * @typedef {Object} HookEntry
 * @property {string} image                                   e.g. `"program.exe"`.
 * @property {{ timeDateStamp: number | string, sizeOfImage: number | string }} check
 * @property {{ rva: number | string }} slot    The vftable (or other) word to overwrite.
 * @property {{ rva: number | string }} target  What the slot currently points at.
 * @property {string} kernel                    Name of the function in `hooks.mjs`'s `kernels`.
 * @property {{ registers: string[], stackArgs: number, cleanup?: number }} convention
 *     `cleanup` is the sidecar's own record of what `registers.length` and
 *     `stackArgs` already say; this layer recomputes it rather than trusting
 *     a second copy of the same fact to stay consistent with the first.
 * @property {'replace' | 'oracle'} mode
 */

/**
 * @typedef {Object} LoadedImage
 * @property {string} name          As the sidecar names it, e.g. `"program.exe"`.
 * @property {number} base
 * @property {number} sizeOfImage
 * @property {number} timeDateStamp
 */

/**
 * @param {HookEntry} entry
 * @param {LoadedImage} image
 * @param {number} slotValue  What is currently at `slot.rva + base`.
 * @returns {{ ok: true, slotAddress: number, targetAddress: number, argBytes: number }
 *         | { ok: false, reason: string }}
 */
export function planHook(entry, image, slotValue){
    if (entry.image.toLowerCase() !== image.name.toLowerCase())
    {
        return { ok: false, reason: `${entry.kernel}: for ${entry.image}, not ${image.name}` };
    }

    const wantStamp = Number(entry.check.timeDateStamp);
    const wantSize = Number(entry.check.sizeOfImage);
    if (wantStamp !== image.timeDateStamp || wantSize !== image.sizeOfImage)
    {
        return {
            ok: false,
            reason: `${entry.kernel}: image check failed (loaded timeDateStamp `
                + `0x${image.timeDateStamp.toString(16)} sizeOfImage `
                + `0x${image.sizeOfImage.toString(16)}, hooks.json wants `
                + `0x${wantStamp.toString(16)}/0x${wantSize.toString(16)})`,
        };
    }

    const targetAddress = (image.base + Number(entry.target.rva)) >>> 0;
    if (slotValue !== targetAddress)
    {
        return {
            ok: false,
            reason: `${entry.kernel}: slot holds 0x${(slotValue >>> 0).toString(16)}, `
                + `expected the target 0x${targetAddress.toString(16)}`,
        };
    }

    // FASTCALL with `this` -- ECX and EDX -- is the one convention a slot
    // hook supports today: the trap sequence has to save every register
    // before it can trap at all, which a stack-only convention does not need
    // and this layer has not been asked to build.
    if (!Array.isArray(entry.convention?.registers) || entry.convention.registers.length !== 2)
    {
        return { ok: false, reason: `${entry.kernel}: only a two-register (FASTCALL) `
            + 'convention is supported' };
    }

    return {
        ok: true,
        slotAddress: (image.base + Number(entry.slot.rva)) >>> 0,
        targetAddress,
        argBytes: (2 + Number(entry.convention.stackArgs)) * 4,
    };
}
