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

import { undecorateName, undecorateType } from './undname.js';
import { wholeAddress } from '../common/pointers.js';

/**
 * A class's fields by the pointer's width. An exception: its vtable, where it
 * keeps its message, and whether it owns it. type_info: the vtable, the
 * undecorated name once asked for, the decorated one.
 *
 * @param {number} pointer
 */
const layoutOf = pointer=>({ NAME: pointer, DO_FREE: 2 * pointer,
    EXCEPTION_SIZE: pointer === 8 ? 24 : 12, UNDECORATED: pointer, DECORATED: 2 * pointer });

/**
 * A member's name as a 64-bit compiler decorates it: the member's access and
 * `this` (`QAE` to `QEAA`, `QBE` to `QEBA`, and the virtual and private ones
 * alike), then every pointer and reference after it with the `E` of `__ptr64`.
 * Only this file's own names go through it; `classes.test.js` holds the ones a
 * 64-bit program was seen to import.
 *
 * @param {string} name
 */
export function longName(name){
    const member = /@@([QUA])([AB])E/.exec(name);
    if (!member)
    {
        return name;
    }
    const rest = name.slice(member.index + member[0].length)
        .replace(/P([AB])Q([AB])/g, 'PE$1QE$2').replace(/A([AB])Q([AB])/g, 'AE$1QE$2')
        .replace(/(?<!E)([PA])([AB])([DXV])/g, '$1E$2$3');
    return `${name.slice(0, member.index)}@@${member[1]}E${member[2]}A${rest}`;
}

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
function rttiOf(name, pointer = 4){
    const { DECORATED } = layoutOf(pointer);
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
    const typeDescriptor = {
        // The type descriptor: type_info's vtable, a spare word, the name.
        [descriptor(name)]: {
            data: ()=>{
                const bytes = new Uint8Array(DECORATED + decorated.length + 1);
                bytes.set([...decorated].map(character=>character.charCodeAt(0)), DECORATED);
                return bytes;
            },
            pointers: [{ at: 0, to: '??_7type_info@@6B@' }],
        },
    };
    if (pointer === 8)
    {
        // A 64-bit image's locator, hierarchy and base descriptors name each
        // other by offsets from their image's base, which a library made of
        // handlers has none of: the vtable's slots are quadwords and the word
        // before them is null, so `typeid` and `dynamic_cast` of one of the
        // runtime's own objects find no type. A program's own classes are its own.
        return {
            ...typeDescriptor,
            [`??_7${name}@@6B@`]: {
                data: ()=>new Uint8Array(name === 'type_info' ? 16 : 24),
                entry: 8,
                pointers: [
                    { at: 8, to: longName(`??_E${name}@@UAEPAXI@Z`) },
                    ...name === 'type_info' ? []
                        : [{ at: 16, to: longName('?what@exception@@UBEPBDXZ') }],
                ],
            },
        };
    }
    return {
        ...typeDescriptor,
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
 * @property {import('../common/guest.js').Guest} guest  At the process's pointer width.
 * @property {(bytes: number) => number} allocate  The runtime's malloc.
 * @property {(address: number) => boolean} free   And its free.
 * @property {(name: string) => number | null} [addressOf]
 *           Where an export of the runtime was placed: a constructor writes
 *           its class's vtable into the object it builds.
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} callGuest
 * @property {() => any} [currentThread]
 */

/**
 * The key under which the table carries the C++ support of Visual C++ 2015
 * on - std::exception's message, typeid's names and hashes - which
 * vcruntime140 and ucrtbase export and msvcrt does not: a symbol, so it is
 * no export of msvcrt's.
 */
export const UNIVERSAL_CXX = Symbol('universal C++ support');

/** FNV-1a's offset basis and prime, 32 and 64 bits: `__std_type_info_hash`. */
const FNV32 = Object.freeze({ BASIS: 2166136261, PRIME: 16777619 });
const FNV64 = Object.freeze({ BASIS: 14695981039346656037n, PRIME: 1099511628211n });

/**
 * @param {ClassesHost} host
 */
export function createClassFunctions(host){
    /** A pointer's bytes, and where the second field of a two-pointer record is. */
    const { guest } = host;
    const pointer = guest.pointerSize;
    const { NAME, DO_FREE, EXCEPTION_SIZE, UNDECORATED, DECORATED } = layoutOf(pointer);
    // Every message, name and list entry is a pointer, read and written whole;
    // an object's do-free flag is an int.
    const { ptr, setPtr } = guest;

    /** A copy of a C string on the runtime's heap, or 0. @param {string} text */
    const copyString = text=>{
        const at = host.allocate(text.length + 1);
        if (at !== 0)
        {
            guest.writeAnsi(at, text);
        }
        return at;
    };

    /** @param {number} address */
    const cText = address=>guest.cstr(address, 0x10000);

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
        setPtr(self, vtable(name));
        const copy = message === 0 ? 0 : copyString(cText(message));
        setPtr(self + NAME, copy);
        guest.set32(self + DO_FREE, copy === 0 ? 0 : 1);
        return self;
    };

    /**
     * A copy of another: a message the other owns is copied, one it only
     * points at is pointed at.
     *
     * @param {number} self @param {number} other
     */
    const copyFields = (self, other)=>{
        const message = ptr(other + NAME);
        if (guest.u32(other + DO_FREE) !== 0 && message !== 0)
        {
            const copy = copyString(cText(message));
            setPtr(self + NAME, copy);
            guest.set32(self + DO_FREE, copy === 0 ? 0 : 1);
        }
        else
        {
            setPtr(self + NAME, message);
            guest.set32(self + DO_FREE, 0);
        }
    };

    /** @param {number} self */
    const destroy = self=>{
        if (guest.u32(self + DO_FREE) !== 0)
        {
            const message = ptr(self + NAME);
            if (message !== 0)
            {
                host.free(message);
            }
            guest.set32(self + DO_FREE, 0);
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
            // The count new[] kept before the first object, a size_t.
            const count = ptr(self - pointer);
            for (let index = count - 1; index >= 0; index--)
            {
                each(self + index * size);
            }
            if ((flags & DELETE) !== 0)
            {
                host.free(self - pointer);
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
            setPtr(self, vtable(name));
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
        Object.assign(table, rttiOf(name, pointer));
    };

    members('exception');
    members('bad_typeid');
    members('bad_cast');
    members('__non_rtti_object');

    Object.assign(table, {
        /** exception::exception(const char * const &message) */
        '??0exception@@QAE@ABQBD@Z': thiscall(8, ([self, message])=>
            construct(self, ptr(message), 'exception')),

        /** exception::exception(const char * const &message, int) -- the message only pointed at */
        '??0exception@@QAE@ABQBDH@Z': thiscall(12, ([self, message])=>{
            setPtr(self, vtable('exception'));
            setPtr(self + NAME, ptr(message));
            guest.set32(self + DO_FREE, 0);
            return self;
        }),

        /** exception::exception() */
        '??0exception@@QAE@XZ': thiscall(4, ([self])=>construct(self, 0, 'exception')),

        /** const char *exception::what() const */
        '?what@exception@@UBEPBDXZ': thiscall(4, ([self])=>{
            const message = ptr(self + NAME);
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

        /** The default constructor's closure, void: the message "bad typeid". */
        '??_Fbad_typeid@@QAEXXZ': thiscall(4, ([self])=>{
            construct(self, 0, 'bad_typeid');
            const copy = copyString('bad typeid');
            setPtr(self + NAME, copy);
            guest.set32(self + DO_FREE, copy === 0 ? 0 : 1);
            return 0;
        }),

        /** bad_cast::bad_cast(const char * const &message) */
        '??0bad_cast@@QAE@ABQBD@Z': thiscall(8, ([self, message])=>
            construct(self, ptr(message), 'bad_cast')),

        /** bad_cast::bad_cast(const char * const *message), the older spelling */
        '??0bad_cast@@AAE@PBQBD@Z': thiscall(8, ([self, message])=>
            construct(self, ptr(message), 'bad_cast')),

        /** bad_cast::bad_cast(const char *message) */
        '??0bad_cast@@QAE@PBD@Z': thiscall(8, ([self, message])=>
            construct(self, message, 'bad_cast')),

        /** The default constructor's closure, void: the message "bad cast". */
        '??_Fbad_cast@@QAEXXZ': thiscall(4, ([self])=>{
            construct(self, 0, 'bad_cast');
            const copy = copyString('bad cast');
            setPtr(self + NAME, copy);
            guest.set32(self + DO_FREE, copy === 0 ? 0 : 1);
            return 0;
        }),

        /** __non_rtti_object::__non_rtti_object(const char *message) */
        '??0__non_rtti_object@@QAE@PBD@Z': thiscall(8, ([self, message])=>
            construct(self, message, '__non_rtti_object')),

        /** type_info::~type_info() -- frees the name name() made */
        '??1type_info@@UAE@XZ': thiscall(4, ([self])=>{
            const undecorated = ptr(self + UNDECORATED);
            if (undecorated !== 0)
            {
                host.free(undecorated);
                setPtr(self + UNDECORATED, 0);
            }
            return 0;
        }),

        /** type_info's deleting destructor, its vtable's one slot. */
        '??_Etype_info@@UAEPAXI@Z': thiscall(8, ([self, flags])=>
            deleting(self, flags, DECORATED + 8, object=>{
                const undecorated = ptr(object + UNDECORATED);
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
            const kept = ptr(self + UNDECORATED);
            if (kept !== 0)
            {
                return kept;
            }
            const decorated = cText(self + DECORATED);
            const made = copyString(undecorateType(decorated.slice(1)) ?? decorated);
            setPtr(self + UNDECORATED, made);
            return made;
        }),

        /** int type_info::before(const type_info &other) const -- the names' order, past their first character */
        '?before@type_info@@QBEHABV1@@Z': thiscall(8, ([self, other])=>
            (cText(self + DECORATED + 1) < cText(other + DECORATED + 1) ? 1 : 0)),

        /** int type_info::operator==(const type_info &other) const */
        '??8type_info@@QBEHABV0@@Z': thiscall(8, ([self, other])=>
            (cText(self + DECORATED + 1) === cText(other + DECORATED + 1) ? 1 : 0)),

        /** int type_info::operator!=(const type_info &other) const */
        '??9type_info@@QBEHABV0@@Z': thiscall(8, ([self, other])=>
            (cText(self + DECORATED + 1) === cText(other + DECORATED + 1) ? 0 : 1)),

        /** type_info &type_info::operator=(const type_info &) -- private, and does nothing */
        '??4type_info@@AAEAAV0@ABV0@@Z': thiscall(8, ([self])=>self),

        /**
         * char *__unDName(char *buffer, const char *mangled, int length,
         *                 void *(*alloc)(size_t), void (*free)(void *), unsigned short flags)
         *
         * Into the caller's buffer when it gives one, else into memory from
         * its allocator. A name that cannot be read comes back as it is, as
         * the runtime answers one; a type descriptor's `?A` name reads as
         * the type, so a program asking about one sees type_info's answer.
         */
        __unDName: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 24,
            /** @param {number[]} args */
            handler: async([buffer, mangled, length, allocate, , flags])=>{
                const thread = host.currentThread?.();
                if (wholeAddress(mangled) === 0)
                {
                    return 0;
                }
                const text = cText(mangled);
                const undecorated = (text.startsWith('?A') ? undecorateType(text) : null)
                    ?? undecorateName(text, flags & 0xffff);
                const bytes = new Uint8Array(undecorated.length + 1);
                bytes.set([...undecorated].map(character=>character.charCodeAt(0) & 0xff));
                if (wholeAddress(buffer) !== 0)
                {
                    const room = Math.max(0, length | 0);
                    if (room === 0)
                    {
                        return 0;
                    }
                    const kept = bytes.slice(0, room);
                    kept[kept.length - 1] = 0;
                    guest.setBytes(buffer, kept);
                    return wholeAddress(buffer);
                }
                if (wholeAddress(allocate) === 0)
                {
                    return 0;
                }
                const at = await host.callGuest(wholeAddress(allocate), [bytes.length],
                    thread) >>> 0;
                if (at !== 0)
                {
                    guest.setBytes(at, bytes);
                }
                return at;
            },
        },
    });
    Object.assign(table, rttiOf('type_info', pointer));

    /**
     * The list `__std_type_info_name` keeps what it makes on: an SLIST_HEADER,
     * whose first entry is its first pointer at 32 bits (the depth after it)
     * and its second quadword at 64 (the depth in the first). An entry is
     * the next one's address, the name after it.
     */
    const listHead = pointer === 8 ? 8 : 0;

    /** @type {any} */ (table)[UNIVERSAL_CXX] = {
        /**
         * void __std_exception_copy(const __std_exception_data *from,
         *                           __std_exception_data *to)
         *
         * std::exception's copy, over its two fields - the message and
         * whether the object owns it: an owned message is copied for the new
         * object to own, one only pointed at is pointed at again.
         */
        __std_exception_copy: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([from, to])=>{
                const message = ptr(wholeAddress(from));
                const owned = guest.u8(wholeAddress(from) + pointer) !== 0;
                const copy = owned && message !== 0 ? copyString(cText(message)) : 0;
                setPtr(wholeAddress(to), owned && message !== 0 ? copy : message);
                guest.set8(wholeAddress(to) + pointer, copy !== 0 ? 1 : 0);
                return 0;
            },
        },

        /**
         * void __std_exception_destroy(__std_exception_data *data)
         *
         * The message freed when the object owns it, and both fields cleared.
         */
        __std_exception_destroy: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([data])=>{
                const message = ptr(wholeAddress(data));
                if (guest.u8(wholeAddress(data) + pointer) !== 0 && message !== 0)
                {
                    host.free(message);
                }
                setPtr(wholeAddress(data), 0);
                guest.set8(wholeAddress(data) + pointer, 0);
                return 0;
            },
        },

        /**
         * int __std_type_info_compare(const __std_type_info_data *left,
         *                             const __std_type_info_data *right)
         *
         * typeid's ==: the same record, or the decorated names past their
         * first character compared as strcmp compares them.
         */
        __std_type_info_compare: {
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([left, right])=>{
                if (wholeAddress(left) === wholeAddress(right))
                {
                    return 0;
                }
                const a = cText(wholeAddress(left) + pointer + 1);
                const b = cText(wholeAddress(right) + pointer + 1);
                return a === b ? 0 : a < b ? -1 : 1;
            },
        },

        /**
         * size_t __std_type_info_hash(const __std_type_info_data *data)
         *
         * FNV-1a over the decorated name past its first character, at the
         * width of a size_t: the same type hashes the same in every module.
         */
        __std_type_info_hash: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([data])=>{
                const name = cText(wholeAddress(data) + pointer + 1);
                if (pointer === 8)
                {
                    /** @type {bigint} */
                    let hash = FNV64.BASIS;
                    for (let at = 0; at < name.length; at++)
                    {
                        hash = BigInt.asUintN(64,
                            (hash ^ BigInt(name.charCodeAt(at) & 0xff)) * FNV64.PRIME);
                    }
                    return hash;
                }
                let hash = FNV32.BASIS;
                for (let at = 0; at < name.length; at++)
                {
                    hash = Math.imul((hash ^ (name.charCodeAt(at) & 0xff)) >>> 0,
                        FNV32.PRIME) >>> 0;
                }
                return hash;
            },
        },

        /**
         * const char *__std_type_info_name(__std_type_info_data *data,
         *                                  __type_info_node *root)
         *
         * typeid's name(): the undecorated name, made the first time and kept
         * in the record, the list the caller passes owning it until
         * `__std_type_info_destroy_list` frees what it holds.
         */
        __std_type_info_name: {
            returns: 'pointer',
            convention: 'cdecl',
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([data, root])=>{
                const kept = ptr(wholeAddress(data));
                if (kept !== 0)
                {
                    return kept;
                }
                const decorated = cText(wholeAddress(data) + pointer);
                const text = undecorateType(decorated.slice(1)) ?? decorated;
                const bytes = new Uint8Array(text.length + 1);
                bytes.set([...text].map(character=>character.charCodeAt(0) & 0xff));
                const entry = host.allocate(pointer + bytes.length);
                if (entry === 0)
                {
                    return 0;
                }
                const name = entry + pointer;
                guest.setBytes(name, bytes);
                // Pushed on the caller's list, which owns it from then on.
                const head = wholeAddress(root) + listHead;
                setPtr(entry, ptr(head));
                setPtr(head, entry);
                const depth = wholeAddress(root) + (pointer === 8 ? 0 : 4);
                guest.set16(depth, (guest.u16(depth) + 1) & 0xffff);
                setPtr(wholeAddress(data), name);
                return name;
            },
        },

        /** void __std_type_info_destroy_list(__type_info_node *root): every name on the list freed, the list empty. */
        __std_type_info_destroy_list: {
            convention: 'cdecl',
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([root])=>{
                const head = wholeAddress(root) + listHead;
                let entry = ptr(head);
                // A list damaged past this many names is not walked further.
                for (let walked = 0; entry !== 0 && walked < 0x100000; walked++)
                {
                    const next = ptr(entry);
                    host.free(entry);
                    entry = next;
                }
                guest.fill(wholeAddress(root), 0, pointer * 2);
                return 0;
            },
        },
    };
    if (pointer === 8)
    {
        // The members again under the names a 64-bit program imports; the
        // 32-bit ones stay, for the tables built over this one by name.
        for (const [name, entry] of Object.entries(table))
        {
            const long = longName(name);
            if (long !== name)
            {
                table[long] = entry;
            }
        }
    }
    return table;
}
