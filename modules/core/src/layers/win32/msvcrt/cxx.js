/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Runtime type information, as the compiler laid it out.
 *
 * `dynamic_cast` is a library call rather than an instruction, and the data it
 * reads is a graph the compiler emitted into the image: the object's vtable is
 * preceded by a pointer to a "complete object locator", which names the type
 * and points at a hierarchy descriptor, which points at an array of base-class
 * descriptors, each of which carries the offset from the complete object to
 * that base. The cast is a search of that array for the requested type,
 * followed by an offset adjustment -- and the adjustment is the part that
 * matters, because a cast to the wrong offset returns a pointer that is not
 * null, passes every check the program makes, and is a different object.
 *
 * Nothing here is guessed: the layouts below are what the compiler writes, and
 * the field offsets are as fixed as an instruction encoding.
 */

/** Offsets in the structures dynamic_cast walks, all 32-bit fields. */
const LOCATOR = { OFFSET: 4, TYPE: 12, HIERARCHY: 16 };
const HIERARCHY = { COUNT: 8, BASES: 12 };
const BASE = { TYPE: 0, MDISP: 8, PDISP: 12, VDISP: 16 };

/** A type descriptor's decorated name begins here, after two reserved words. */
const TYPE_NAME = 8;

/**
 * @typedef {Object} CxxHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(message: string) => void} [abort]  How the runtime stops a
 *           program that has already lost: a pure virtual call has no
 *           continuation that means anything.
 */

/**
 * `_EH_prolog`'s body, as the runtime's: with S the caller's ESP before its
 * call, it leaves -1 at S-8 (no try level yet) and EAX, the handler, at S-12,
 * links a registration record at S-16 into fs:[0], puts the caller's EBP where
 * the return address was and points EBP at it, then returns with ESP at S-16.
 *
 *   push -1; push eax; mov eax, fs:[0]; push eax; mov eax, [esp+12];
 *   mov fs:[0], esp; mov [esp+12], ebp; lea ebp, [esp+12]; push eax; ret
 */
export const EH_PROLOG_CODE = Uint8Array.of(
    0x6a, 0xff, 0x50, 0x64, 0xa1, 0, 0, 0, 0, 0x50, 0x8b, 0x44, 0x24, 0x0c,
    0x64, 0x89, 0x25, 0, 0, 0, 0, 0x89, 0x6c, 0x24, 0x0c, 0x8d, 0x6c, 0x24, 0x0c,
    0x50, 0xc3);

/**
 * @param {CxxHost} host
 */
export function createCxxFunctions(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };

    /** @param {number} address */
    const readI32 = address=>readU32(address) | 0;

    /** The locator sits at vtable[-1], one slot below what the object points at. */
    const locatorOf = (/** @type {number} */ object)=>readU32(readU32(object) - 4);

    /**
     * Two type descriptors are the same type when they are the same address,
     * and also when they carry the same decorated name: a type used in two
     * images has a descriptor in each, and a cast across that boundary is the
     * case a pointer comparison alone gets wrong.
     *
     * @param {number} left @param {number} right
     */
    const sameType = (left, right)=>left === right
        || host.readCString(left + TYPE_NAME, 512) === host.readCString(right + TYPE_NAME, 512);

    /**
     * Where a base class sits inside the complete object.
     *
     * A non-virtual base is a constant offset. A virtual one is reached through
     * the object's own virtual-base table, so the offset is not known until
     * there is an object to read it from.
     *
     * @param {number} complete  Address of the complete object.
     * @param {number} descriptor
     */
    const offsetOf = (complete, descriptor)=>{
        const mdisp = readI32(descriptor + BASE.MDISP);
        const pdisp = readI32(descriptor + BASE.PDISP);
        if (pdisp < 0)
        {
            return mdisp;
        }
        const vbTable = readU32(complete + pdisp);
        return mdisp + pdisp + readI32(vbTable + readI32(descriptor + BASE.VDISP));
    };

    return {
        /**
         * _EH_prolog: the frame setup a function with C++ unwinding calls
         * instead of writing it out, with its handler in EAX. It builds the
         * frame on the caller's own stack and in its EBP, so it runs in the
         * guest (`EH_PROLOG_CODE`): a host handler returns to a stack it
         * left as it found it, and the caller then unwinds through a frame
         * that is not there. It is code of its own, in the module's
         * read-only .text beside the compiled functions, not a variable.
         */
        _EH_prolog: { code: ()=>EH_PROLOG_CODE },

        /**
         * void *__RTDynamicCast(void *object, LONG delta, void *from,
         *                       void *to, BOOL isReference)
         *
         * The `delta` argument is the offset from the pointer the caller holds
         * to the start of its own subobject; the locator's offset then reaches
         * the complete object from there. Ignoring either one casts from the
         * wrong place and finds the wrong base.
         */
        __RTDynamicCast: {
            convention: 'cdecl',
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([object, delta, from, to])=>{
                if ((object >>> 0) === 0)
                {
                    return 0;
                }
                void from;
                const subobject = object - (delta | 0);
                const locator = locatorOf(subobject);
                const complete = subobject - readI32(locator + LOCATOR.OFFSET);

                const hierarchy = readU32(locator + LOCATOR.HIERARCHY);
                const count = readU32(hierarchy + HIERARCHY.COUNT);
                const bases = readU32(hierarchy + HIERARCHY.BASES);
                for (let index = 0; index < count; index++)
                {
                    const descriptor = readU32(bases + index * 4);
                    if (sameType(readU32(descriptor + BASE.TYPE), to >>> 0))
                    {
                        return complete + offsetOf(complete, descriptor);
                    }
                }
                // Not a base of this object: the cast fails, and for a pointer
                // that is a null result rather than an exception.
                return 0;
            },
        },

        /**
         * void *__RTCastToVoid(void *object)
         *
         * `dynamic_cast<void*>` yields the complete object, which is the only
         * way a program can compare two pointers into the same object for
         * identity.
         */
        __RTCastToVoid: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>((object >>> 0) === 0
                ? 0
                : object - readI32(locatorOf(object) + LOCATOR.OFFSET)),
        },

        /** void *__RTtypeid(void *object) */
        __RTtypeid: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([object])=>((object >>> 0) === 0
                ? 0
                : readU32(locatorOf(object) + LOCATOR.TYPE)),
        },

        /**
         * void _purecall(void)
         *
         * A call through a vtable slot that was never overridden, which happens
         * when a constructor or destructor calls a virtual function on a
         * half-built object. There is no return that means anything: the caller
         * would carry on as though the call had succeeded.
         */
        _purecall: {
            convention: 'cdecl',
            argBytes: 0,
            handler: ()=>{
                host.abort?.('pure virtual function call');
                return 0;
            },
        },

        /**
         * const char *type_info::raw_name() const
         *
         * The decorated name, which lives inside the descriptor itself: a
         * program compares two types by this string, and `typeid(x) == typeid(y)`
         * is a `strcmp` of it. Undecorating is `name()`'s job, not this one's.
         */
        '?raw_name@type_info@@QBEPBDXZ': {
            convention: 'thiscall',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([self])=>(self >>> 0) + TYPE_NAME,
        },

        /**
         * type_info::~type_info()
         *
         * Frees the undecorated name `name()` would have cached. Nothing here
         * caches one, so there is nothing to free.
         */
        '??1type_info@@UAE@XZ': {
            convention: 'thiscall',
            argBytes: 4,
            handler: ()=>0,
        },
    };
}
