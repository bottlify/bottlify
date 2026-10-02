/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The C++ classes the runtime exports -- `exception`, `bad_typeid`, `bad_cast`
 * and `__non_rtti_object` -- with the vtables a program's own classes derive
 * from and the runtime type information those vtables point at, and the
 * members of `type_info`.
 *
 * A library built against the runtime -- the C++ library a program ships
 * beside itself -- constructs its exceptions through these constructors and
 * points its own vtables' parents at these, so each is data and code a
 * program binds to by name. An object is three words: the vtable, the
 * message, and whether the message is the object's to free. A vtable's first
 * slot is the class's deleting destructor and its second `what()`; the word
 * before it points at the class's complete object locator, which `typeid`
 * and `dynamic_cast` read as they read a compiler's.
 */

import { undecorateType } from './undname.js';

/** Where an exception keeps its message, and whether it owns it. */
const NAME = 4;
const DO_FREE = 8;
const EXCEPTION_SIZE = 12;

/** type_info: the vtable, the undecorated name once asked for, the decorated one. */
const UNDECORATED = 4;
const DECORATED = 8;

/** A deleting destructor's flags: free the storage; it is an array, its count before it. */
const DELETE = 1;
const ARRAY = 2;

/**
 * Each class and its bases, nearest first. `__non_rtti_object` is a
 * `bad_typeid`, and every one of them an `exception`.
 *
 * @type {Record<string, string[]>}
 */
const HIERARCHY = {
    exception: [],
    bad_typeid: ['exception'],
    bad_cast: ['exception'],
    __non_rtti_object: ['bad_typeid', 'exception'],
    type_info: [],
};

/**
 * The runtime type information of one class, under the names the compiler
 * gives each piece, every pointer in it filled in where the module is placed.
 *
 * @param {string} name
 * @returns {Record<string, { data: () => Uint8Array, pointers: { at: number, to: string }[],
 *     entry?: number }>}
 */
function rttiOf(name){
    const bases = [name, ...HIERARCHY[name]];
    const decorated = `.?AV${name}@@`;
    /** @param {string} of */
    const descriptor = of=>`??_R0?AV${of}@@@8`;
    /** @param {string} of */
    const baseDescriptor = of=>`??_R1A@?0A@EA@${of}@@8`;
    /** @param {number} count @param {Record<number, number>} [values] */
    const words = (count, values = {})=>()=>{
        const bytes = new Uint8Array(count * 4);
        const view = new DataView(bytes.buffer);
        for (const [at, value] of Object.entries(values))
        {
            view.setUint32(Number(at) * 4, value >>> 0, true);
        }
        return bytes;
    };
    return {
        // The type descriptor: type_info's vtable, a spare word, the name.
        [descriptor(name)]: {
            data: ()=>{
                const bytes = new Uint8Array(DECORATED + decorated.length + 1);
                bytes.set([...decorated].map(character=>character.charCodeAt(0)), DECORATED);
                return bytes;
            },
            pointers: [{ at: 0, to: '??_7type_info@@6B@' }],
        },
        // As a base of itself and of whatever derives from it: at offset 0,
        // not a virtual base (pdisp -1), with its own bases counted.
        [baseDescriptor(name)]: {
            data: words(6, { 1: bases.length - 1, 3: -1 }),
            pointers: [{ at: 0, to: descriptor(name) }],
        },
        [`??_R2${name}@@8`]: {
            data: words(bases.length),
            pointers: bases.map((base, index)=>({ at: index * 4, to: baseDescriptor(base) })),
        },
        [`??_R3${name}@@8`]: {
            data: words(4, { 2: bases.length }),
            pointers: [{ at: 12, to: `??_R2${name}@@8` }],
        },
        [`??_R4${name}@@6B@`]: {
            data: words(5),
            pointers: [{ at: 12, to: descriptor(name) }, { at: 16, to: `??_R3${name}@@8` }],
        },
        // The vtable, exported at its first slot with the locator before it.
        [`??_7${name}@@6B@`]: {
            data: words(name === 'type_info' ? 2 : 3),
            entry: 4,
            pointers: [
                { at: 0, to: `??_R4${name}@@6B@` },
                { at: 4, to: `??_E${name}@@UAEPAXI@Z` },
                ...name === 'type_info' ? [] : [{ at: 8, to: '?what@exception@@UBEPBDXZ' }],
            ],
        },
    };
}

/**
 * @typedef {Object} ClassesHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(bytes: number) => number} allocate  The runtime's malloc.
 * @property {(address: number) => boolean} free   And its free.
 * @property {(name: string) => number | null} [addressOf]
 *           Where an export of the runtime was placed: a constructor writes
 *           its class's vtable into the object it builds.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 */

/**
 * @param {ClassesHost} host
 */
export function createClassFunctions(host){
    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };

    /** A copy of a C string on the runtime's heap, or 0. @param {string} text */
    const copyString = text=>{
        const bytes = new Uint8Array(text.length + 1);
        bytes.set([...text].map(character=>character.charCodeAt(0) & 0xff));
        const at = host.allocate(bytes.length);
        if (at !== 0)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /** @param {number} address */
    const readString = address=>host.readCString(address, 0x10000);

    /** What `what()` says of an exception with no message. */
    let unknown = 0;

    /** @param {string} name */
    const vtable = name=>host.addressOf?.(`??_7${name}@@6B@`) ?? 0;

    /**
     * Builds an exception around a message: copied when given, the copy the
     * object's to free; none when not.
     *
     * @param {number} self @param {number} message @param {string} name
     */
    const construct = (self, message, name)=>{
        writeU32(self, vtable(name));
        const copy = message === 0 ? 0 : copyString(readString(message));
        writeU32(self + NAME, copy);
        writeU32(self + DO_FREE, copy === 0 ? 0 : 1);
        return self;
    };

    /**
     * A copy of another: a message the other owns is copied, one it only
     * points at is pointed at.
     *
     * @param {number} self @param {number} other
     */
    const copyFields = (self, other)=>{
        const message = readU32(other + NAME);
        if (readU32(other + DO_FREE) !== 0 && message !== 0)
        {
            const copy = copyString(readString(message));
            writeU32(self + NAME, copy);
            writeU32(self + DO_FREE, copy === 0 ? 0 : 1);
        }
        else
        {
            writeU32(self + NAME, message);
            writeU32(self + DO_FREE, 0);
        }
    };

    /** @param {number} self */
    const destroy = self=>{
        if (readU32(self + DO_FREE) !== 0)
        {
            const message = readU32(self + NAME);
            if (message !== 0)
            {
                host.free(message);
            }
            writeU32(self + DO_FREE, 0);
        }
        return 0;
    };

    /**
     * A deleting destructor: one object, or an array whose count is the word
     * before it, destroyed last to first, then its storage freed if asked.
     *
     * @param {number} self @param {number} flags @param {number} size
     * @param {(object: number) => void} each
     */
    const deleting = (self, flags, size, each)=>{
        if ((flags & ARRAY) !== 0)
        {
            const count = readU32(self - 4);
            for (let index = count - 1; index >= 0; index--)
            {
                each(self + index * size);
            }
            if ((flags & DELETE) !== 0)
            {
                host.free(self - 4);
            }
            return self;
        }
        each(self);
        if ((flags & DELETE) !== 0)
        {
            host.free(self);
        }
        return self;
    };

    /**
     * @param {number} argBytes  Counting `this`, as a thiscall stub does.
     * @param {(args: number[]) => any} handler
     */
    const thiscall = (argBytes, handler)=>({ convention: 'thiscall', argBytes, handler });

    /** @type {Record<string, any>} */
    const table = {};

    /**
     * The members every exception class has, under its own name.
     *
     * @param {string} name
     */
    const members = name=>{
        table[`??0${name}@@QAE@ABV0@@Z`] = thiscall(8, ([self, other])=>{
            writeU32(self, vtable(name));
            copyFields(self, other);
            return self;
        });
        table[`??1${name}@@UAE@XZ`] = thiscall(4, ([self])=>destroy(self));
        // Assignment keeps the object what it was: the vtable stays.
        table[`??4${name}@@QAEAAV0@ABV0@@Z`] = thiscall(8, ([self, other])=>{
            if (self !== other)
            {
                destroy(self);
                copyFields(self, other);
            }
            return self;
        });
        table[`??_E${name}@@UAEPAXI@Z`] = thiscall(8, ([self, flags])=>
            deleting(self, flags, EXCEPTION_SIZE, destroy));
        table[`??_G${name}@@UAEPAXI@Z`] = thiscall(8, ([self, flags])=>
            deleting(self, flags & DELETE, EXCEPTION_SIZE, destroy));
        Object.assign(table, rttiOf(name));
    };

    members('exception');
    members('bad_typeid');
    members('bad_cast');
    members('__non_rtti_object');

    Object.assign(table, {
        /** exception::exception(const char * const &message) */
        '??0exception@@QAE@ABQBD@Z': thiscall(8, ([self, message])=>
            construct(self, readU32(message), 'exception')),

        /** exception::exception(const char * const &message, int) -- the message only pointed at */
        '??0exception@@QAE@ABQBDH@Z': thiscall(12, ([self, message])=>{
            writeU32(self, vtable('exception'));
            writeU32(self + NAME, readU32(message));
            writeU32(self + DO_FREE, 0);
            return self;
        }),

        /** exception::exception() */
        '??0exception@@QAE@XZ': thiscall(4, ([self])=>construct(self, 0, 'exception')),

        /** const char *exception::what() const */
        '?what@exception@@UBEPBDXZ': thiscall(4, ([self])=>{
            const message = readU32(self + NAME);
            if (message !== 0)
            {
                return message;
            }
            unknown ||= copyString('Unknown exception');
            return unknown;
        }),

        /** bad_typeid::bad_typeid(const char *message) */
        '??0bad_typeid@@QAE@PBD@Z': thiscall(8, ([self, message])=>
            construct(self, message, 'bad_typeid')),

        /** The default constructor's closure: the message "bad typeid". */
        '??_Fbad_typeid@@QAEXXZ': thiscall(4, ([self])=>{
            construct(self, 0, 'bad_typeid');
            const copy = copyString('bad typeid');
            writeU32(self + NAME, copy);
            writeU32(self + DO_FREE, copy === 0 ? 0 : 1);
            return self;
        }),

        /** bad_cast::bad_cast(const char * const &message) */
        '??0bad_cast@@QAE@ABQBD@Z': thiscall(8, ([self, message])=>
            construct(self, readU32(message), 'bad_cast')),

        /** bad_cast::bad_cast(const char * const *message), the older spelling */
        '??0bad_cast@@AAE@PBQBD@Z': thiscall(8, ([self, message])=>
            construct(self, readU32(message), 'bad_cast')),

        /** bad_cast::bad_cast(const char *message) */
        '??0bad_cast@@QAE@PBD@Z': thiscall(8, ([self, message])=>
            construct(self, message, 'bad_cast')),

        /** The default constructor's closure: the message "bad cast". */
        '??_Fbad_cast@@QAEXXZ': thiscall(4, ([self])=>{
            construct(self, 0, 'bad_cast');
            const copy = copyString('bad cast');
            writeU32(self + NAME, copy);
            writeU32(self + DO_FREE, copy === 0 ? 0 : 1);
            return self;
        }),

        /** __non_rtti_object::__non_rtti_object(const char *message) */
        '??0__non_rtti_object@@QAE@PBD@Z': thiscall(8, ([self, message])=>
            construct(self, message, '__non_rtti_object')),

        /** type_info::~type_info() -- frees the name name() made */
        '??1type_info@@UAE@XZ': thiscall(4, ([self])=>{
            const undecorated = readU32(self + UNDECORATED);
            if (undecorated !== 0)
            {
                host.free(undecorated);
                writeU32(self + UNDECORATED, 0);
            }
            return 0;
        }),

        /** type_info's deleting destructor, its vtable's one slot. */
        '??_Etype_info@@UAEPAXI@Z': thiscall(8, ([self, flags])=>
            deleting(self, flags, DECORATED + 8, object=>{
                const undecorated = readU32(object + UNDECORATED);
                if (undecorated !== 0)
                {
                    host.free(undecorated);
                }
            })),

        /**
         * const char *type_info::name() const
         *
         * The decorated name undecorated, made once and kept in the object,
         * where the destructor frees it.
         */
        '?name@type_info@@QBEPBDXZ': thiscall(4, ([self])=>{
            const kept = readU32(self + UNDECORATED);
            if (kept !== 0)
            {
                return kept;
            }
            const decorated = readString(self + DECORATED);
            const made = copyString(undecorateType(decorated.slice(1)) ?? decorated);
            writeU32(self + UNDECORATED, made);
            return made;
        }),

        /** int type_info::before(const type_info &other) const -- the names' order, past their first character */
        '?before@type_info@@QBEHABV1@@Z': thiscall(8, ([self, other])=>
            (readString(self + DECORATED + 1) < readString(other + DECORATED + 1) ? 1 : 0)),

        /** int type_info::operator==(const type_info &other) const */
        '??8type_info@@QBEHABV0@@Z': thiscall(8, ([self, other])=>
            (readString(self + DECORATED + 1) === readString(other + DECORATED + 1) ? 1 : 0)),

        /** int type_info::operator!=(const type_info &other) const */
        '??9type_info@@QBEHABV0@@Z': thiscall(8, ([self, other])=>
            (readString(self + DECORATED + 1) === readString(other + DECORATED + 1) ? 0 : 1)),

        /** type_info &type_info::operator=(const type_info &) -- private, and does nothing */
        '??4type_info@@AAEAAV0@ABV0@@Z': thiscall(8, ([self])=>self),

        /**
         * char *__unDName(char *buffer, const char *mangled, int length,
         *                 void *(*alloc)(size_t), void (*free)(void *), unsigned short flags)
         *
         * Into the caller's buffer when it gives one, else into memory from
         * its allocator; null for a name this runtime cannot undecorate.
         */
        __unDName: {
            convention: 'cdecl',
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([buffer, mangled, length, allocate])=>{
                if ((mangled >>> 0) === 0)
                {
                    return 0;
                }
                const text = readString(mangled);
                const undecorated = text.startsWith('?') && !text.startsWith('?A')
                    ? null : undecorateType(text);
                if (undecorated === null)
                {
                    return 0;
                }
                const bytes = new Uint8Array(undecorated.length + 1);
                bytes.set([...undecorated].map(character=>character.charCodeAt(0) & 0xff));
                if ((buffer >>> 0) !== 0)
                {
                    const room = Math.max(0, length | 0);
                    if (room === 0)
                    {
                        return 0;
                    }
                    const kept = bytes.slice(0, room);
                    kept[kept.length - 1] = 0;
                    host.writeMemory(buffer >>> 0, kept);
                    return buffer >>> 0;
                }
                if ((allocate >>> 0) === 0)
                {
                    return 0;
                }
                const at = await host.callGuest(allocate >>> 0, [bytes.length],
                    host.currentThread?.()) >>> 0;
                if (at !== 0)
                {
                    host.writeMemory(at, bytes);
                }
                return at;
            },
        },
    });
    Object.assign(table, rttiOf('type_info'));
    return table;
}
