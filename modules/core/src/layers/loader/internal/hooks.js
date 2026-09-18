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
 * @property {undefined} [site]  Absent; the discriminant against `SiteHookEntry`.
 */

/**
 * @typedef {Object} LoadedImage
 * @property {string} name          As the sidecar names it, e.g. `"program.exe"`.
 * @property {number} base
 * @property {number} sizeOfImage
 * @property {number} timeDateStamp
 */

/**
 * @typedef {Object} SiteHookEntry
 * @property {string} image
 * @property {{ timeDateStamp: number | string, sizeOfImage: number | string }} check
 * @property {{ rva: number | string, bytes: string, lengths: number[] }} site
 *     `bytes` are the instructions currently at the site, space-separated hex,
 *     the patch's own pin against the build; `lengths` is each instruction's
 *     length, in order, summing to `bytes`' own length.
 * @property {{ rva: number | string, bytes: string, stackAdjust: number }} resume
 *     Where the handled path's EIP goes; `bytes` pins what is there so a
 *     handled site does not resume into a build that moved it.
 * @property {{ rva: number | string, bytes: string }} function
 *     The start of the function the site sits inside of -- a third pin, since
 *     a site is mid-function and depends on the compiler's own register
 *     allocation there, which a slot's `target` never has to.
 * @property {string} kernel
 * @property {'replace'} mode
 */

/**
 * Parses a space-separated hex byte string (`"8b 57 04"`) into plain numbers.
 *
 * @param {string} text
 * @returns {number[]}
 */
export function parseHexBytes(text){
    return text.trim().split(/\s+/).map(byte=>Number.parseInt(byte, 16));
}

/**
 * Whether the first `lengths.reduce(...)` bytes of `bytes` can be moved to a
 * trampoline: whole instructions with no relative branch among them (a near
 * call or jump, a short jump, or a two-byte conditional jump) and at least
 * five of them -- a near jump's own width, which is what pastes the moved
 * bytes back into the flow. Shared between a diagnostic watch's own
 * displaced prologue (`app.js`'s `debug.hook`, which imports this) and a
 * `site` hook's displaced instructions (`planSiteHook` below), the same
 * shape either way; kept here rather than in the assembler because this
 * module -- a pure decision over plain data -- is what both callers already
 * depend on or may.
 *
 * @param {number[] | Uint8Array} bytes
 * @param {number[]} lengths
 */
export function relocatablePrefix(bytes, lengths){
    if (bytes.length < 5 || lengths.reduce((sum, n)=>sum + n, 0) !== bytes.length)
    {
        return false;
    }
    let at = 0;
    for (const length of lengths)
    {
        const op = bytes[at];
        if (op === 0xe8 || op === 0xe9 || op === 0xeb || (op >= 0x70 && op <= 0x7f)
            || (op === 0x0f && bytes[at + 1] >= 0x80 && bytes[at + 1] <= 0x8f))
        {
            return false;
        }
        at += length;
    }
    return true;
}

/**
 * A near jump from `from` to `to`, as the five bytes of it. Shared between a
 * diagnostic watch's trampoline tail (`app.js`'s `debug.hook`) and a `site`
 * hook's trampoline and patch (`module.js`'s `bindSiteHook`) -- the same five
 * bytes either way.
 *
 * @param {number} from  The address the jump instruction itself sits at.
 * @param {number} to
 */
export function jumpBytes(from, to){
    const rel = (to - (from + 5)) >>> 0;
    return Uint8Array.of(0xe9, rel & 0xff, (rel >>> 8) & 0xff, (rel >>> 16) & 0xff,
        (rel >>> 24) & 0xff);
}

/**
 * @param {number[]} bytes
 * @returns {string}
 */
const hexOf = bytes=>bytes.map(byte=>byte.toString(16).padStart(2, '0')).join(' ');

/**
 * @param {number[]} left
 * @param {number[]} right
 */
const bytesEqual = (left, right)=>left.length === right.length
    && left.every((byte, i)=>byte === right[i]);

/**
 * The image and build check every hook entry shares, slot or site.
 *
 * @param {{ image: string, check: { timeDateStamp: number | string, sizeOfImage: number | string },
 *     kernel: string }} entry
 * @param {LoadedImage} image
 * @returns {string | null}  A refusal reason, or null when both checks pass.
 */
function checkImage(entry, image){
    if (entry.image.toLowerCase() !== image.name.toLowerCase())
    {
        return `${entry.kernel}: for ${entry.image}, not ${image.name}`;
    }
    const wantStamp = Number(entry.check.timeDateStamp);
    const wantSize = Number(entry.check.sizeOfImage);
    if (wantStamp !== image.timeDateStamp || wantSize !== image.sizeOfImage)
    {
        return `${entry.kernel}: image check failed (loaded timeDateStamp `
            + `0x${image.timeDateStamp.toString(16)} sizeOfImage `
            + `0x${image.sizeOfImage.toString(16)}, hooks.json wants `
            + `0x${wantStamp.toString(16)}/0x${wantSize.toString(16)})`;
    }
    return null;
}

/**
 * Whether one `site` entry of a bundle's `hooks.json` may be bound: the same
 * image and build check a slot entry gets, plus three byte pins (the site is
 * mid-function, so its bytes depend on the compiler's own register
 * allocation there, unlike a slot's data word) and a check that the
 * displaced instructions can be moved to a trampoline.
 *
 * @param {SiteHookEntry} entry
 * @param {LoadedImage} image
 * @param {{ siteBytes: number[], resumeBytes: number[], functionBytes: number[] }} reads
 *     What is currently at each of the three RVAs, read by the caller.
 * @returns {{ ok: true, siteAddress: number, resumeAddress: number,
 *     displacedLength: number, stackAdjust: number }
 *         | { ok: false, reason: string }}
 */
export function planSiteHook(entry, image, reads){
    const imageReason = checkImage(entry, image);
    if (imageReason !== null)
    {
        return { ok: false, reason: imageReason };
    }

    const siteWant = parseHexBytes(entry.site.bytes);
    if (!bytesEqual(reads.siteBytes, siteWant))
    {
        return { ok: false, reason: `${entry.kernel}: site holds ${hexOf(reads.siteBytes)}, `
            + `expected ${hexOf(siteWant)}` };
    }
    const resumeWant = parseHexBytes(entry.resume.bytes);
    if (!bytesEqual(reads.resumeBytes, resumeWant))
    {
        return { ok: false, reason: `${entry.kernel}: resume point holds `
            + `${hexOf(reads.resumeBytes)}, expected ${hexOf(resumeWant)}` };
    }
    const functionWant = parseHexBytes(entry.function.bytes);
    if (!bytesEqual(reads.functionBytes, functionWant))
    {
        return { ok: false, reason: `${entry.kernel}: function start holds `
            + `${hexOf(reads.functionBytes)}, expected ${hexOf(functionWant)}` };
    }

    const lengths = entry.site.lengths;
    const displacedLength = lengths.reduce((sum, n)=>sum + n, 0);
    if (displacedLength !== siteWant.length || displacedLength < 5)
    {
        return { ok: false, reason: `${entry.kernel}: site.lengths sums to `
            + `${displacedLength}, must equal the ${siteWant.length} site bytes `
            + 'and be at least 5' };
    }
    // The length check above already holds, so only the branch scan in
    // `relocatablePrefix` can still refuse; its own length check re-runs
    // harmlessly on bytes already known to pass it.
    if (!relocatablePrefix(siteWant, lengths))
    {
        return { ok: false, reason: `${entry.kernel}: a displaced instruction at the site `
            + 'is a relative branch, which cannot be moved to a trampoline' };
    }

    return {
        ok: true,
        siteAddress: (image.base + Number(entry.site.rva)) >>> 0,
        resumeAddress: (image.base + Number(entry.resume.rva)) >>> 0,
        displacedLength,
        stackAdjust: Number(entry.resume.stackAdjust ?? 0),
    };
}

/**
 * @param {HookEntry} entry
 * @param {LoadedImage} image
 * @param {number} slotValue  What is currently at `slot.rva + base`.
 * @returns {{ ok: true, slotAddress: number, targetAddress: number, argBytes: number }
 *         | { ok: false, reason: string }}
 */
export function planHook(entry, image, slotValue){
    const imageReason = checkImage(entry, image);
    if (imageReason !== null)
    {
        return { ok: false, reason: imageReason };
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
