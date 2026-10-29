/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The item id list functions: an ITEMIDLIST walked by its items' `cb`
 * words, whatever the items hold, as shlobj.h lays one out -- a WORD
 * counting itself and the bytes after it, the list ended by a `cb` of 0.
 * These never look inside an item, so a list the program built from its own
 * items answers as one of ours does.
 *
 * A list handed out is the task allocator's: ILFree, SHFree and
 * CoTaskMemFree release it alike.
 */

/** The most items walked: a pointer to something that is no list ends here. */
const MOST_ITEMS = 256;

/**
 * Each is [ordinal, name]: the item id functions a program imports by number,
 * which is how shell32 exports most of them.
 *
 * @type {readonly (readonly [number, string])[]}
 */
export const IDLIST_ORDINALS = Object.freeze([
    [16, 'ILFindLastID'], [17, 'ILRemoveLastID'], [18, 'ILClone'], [19, 'ILCloneFirst'],
    [21, 'ILIsEqual'], [23, 'ILIsParent'], [24, 'ILFindChild'], [25, 'ILCombine'],
    [152, 'ILGetSize'], [153, 'ILGetNext'], [154, 'ILAppendID'], [155, 'ILFree'],
    [195, 'SHFree'], [196, 'SHAlloc'],
]);

/**
 * @typedef {Object} IdListHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} [allocate]  The task allocator's memory.
 * @property {(address: number) => void} [free]
 */

/**
 * @param {IdListHost} host
 */
export function createIdListFunctions(host){
    /** @param {number} at */
    const cbAt = at=>{
        const bytes = host.readMemory(at >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };

    /**
     * Where each item of a list starts, first to last, and where its
     * terminator is.
     *
     * @param {number} list
     */
    const walk = list=>{
        /** @type {number[]} */
        const items = [];
        let at = list >>> 0;
        for (let n = 0; at !== 0 && n < MOST_ITEMS; n++)
        {
            const cb = cbAt(at);
            if (cb === 0)
            {
                break;
            }
            items.push(at);
            at += cb;
        }
        return { items, end: at };
    };

    /** @param {number} list  The bytes of a list, its terminator with them. */
    const bytesOf = list=>{
        const { end } = walk(list);
        return host.readMemory(list >>> 0, end - (list >>> 0) + 2).slice();
    };

    /** @param {Uint8Array} bytes @returns {number} a list holding them, 0 for no memory */
    const allocated = bytes=>{
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at !== 0)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /** @param {number} at  One item's bytes, `cb` and all. */
    const itemBytes = at=>host.readMemory(at >>> 0, cbAt(at)).slice();

    /** @param {...Uint8Array} parts @returns {Uint8Array} the items, then a terminator */
    const joined = (...parts)=>{
        const total = parts.reduce((sum, part)=>sum + part.length, 0);
        const bytes = new Uint8Array(total + 2);
        let at = 0;
        for (const part of parts)
        {
            bytes.set(part, at);
            at += part.length;
        }
        return bytes;
    };

    /** @param {number} list @returns {Uint8Array} its items without the terminator */
    const itemsBytes = list=>{
        const bytes = bytesOf(list);
        return bytes.subarray(0, bytes.length - 2);
    };

    /** @param {number} first @param {number} second */
    const sameItem = (first, second)=>{
        const a = itemBytes(first);
        const b = itemBytes(second);
        return a.length === b.length && a.every((byte, i)=>byte === b[i]);
    };

    /**
     * Whether `parent`'s items lead `child`'s, and where in `child` the rest
     * starts; null when they do not.
     *
     * @param {number} parent @param {number} child
     */
    const childPart = (parent, child)=>{
        const above = walk(parent).items;
        const below = walk(child).items;
        if (above.length > below.length || !above.every((item, i)=>sameItem(item, below[i])))
        {
            return null;
        }
        return { rest: below.slice(above.length), end: walk(child).end };
    };

    return {
        /** UINT ILGetSize(PCUIDLIST_RELATIVE pidl): its bytes and its terminator's; 0 for NULL. */
        ILGetSize: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>((list >>> 0) === 0 ? 0 : walk(list).end - (list >>> 0) + 2),
        },

        /** PUIDLIST_RELATIVE ILGetNext(PCUIDLIST_RELATIVE pidl): NULL past the last item. */
        ILGetNext: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                if ((list >>> 0) === 0 || cbAt(list) === 0)
                {
                    return 0;
                }
                const next = (list >>> 0) + cbAt(list);
                return cbAt(next) === 0 ? 0 : next;
            },
        },

        /**
         * PUITEMID_CHILD ILFindLastID(PCUIDLIST_RELATIVE pidl)
         *
         * The last item, or the list itself when it is empty.
         */
        ILFindLastID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>((list >>> 0) === 0 ? 0 : walk(list).items.at(-1) ?? list >>> 0),
        },

        /** BOOL ILRemoveLastID(PUIDLIST_RELATIVE pidl): FALSE for an empty list. */
        ILRemoveLastID: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                const last = (list >>> 0) === 0 ? undefined : walk(list).items.at(-1);
                if (last === undefined)
                {
                    return 0;
                }
                host.writeMemory(last, Uint8Array.of(0, 0));
                return 1;
            },
        },

        /** PIDLIST_RELATIVE ILClone(PCUIDLIST_RELATIVE pidl) */
        ILClone: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>((list >>> 0) === 0 ? 0 : allocated(bytesOf(list))),
        },

        /** PITEMID_CHILD ILCloneFirst(PCUIDLIST_RELATIVE pidl): the first item, ended. */
        ILCloneFirst: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                if ((list >>> 0) === 0)
                {
                    return 0;
                }
                return allocated(cbAt(list) === 0 ? Uint8Array.of(0, 0) : joined(itemBytes(list)));
            },
        },

        /**
         * BOOL ILIsEqual(PCIDLIST_ABSOLUTE pidl1, PCIDLIST_ABSOLUTE pidl2)
         *
         * The same items, byte for byte; never for a missing list.
         */
        ILIsEqual: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                if ((first >>> 0) === 0 || (second >>> 0) === 0)
                {
                    return 0;
                }
                const a = walk(first).items;
                const b = walk(second).items;
                return a.length === b.length && a.every((item, i)=>sameItem(item, b[i])) ? 1 : 0;
            },
        },

        /**
         * BOOL ILIsParent(PCIDLIST_ABSOLUTE pidlParent, PCIDLIST_ABSOLUTE pidlBelow,
         *                 BOOL fImmediate)
         *
         * Whether the parent's items lead the other's, which has more; with
         * fImmediate, exactly one more.
         */
        ILIsParent: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([parent, child, immediate])=>{
                if ((parent >>> 0) === 0 || (child >>> 0) === 0)
                {
                    return 0;
                }
                const part = childPart(parent, child);
                if (part === null || part.rest.length === 0)
                {
                    return 0;
                }
                return (immediate | 0) === 0 || part.rest.length === 1 ? 1 : 0;
            },
        },

        /**
         * PUIDLIST_RELATIVE ILFindChild(PCIDLIST_ABSOLUTE pidlParent,
         *                               PCIDLIST_ABSOLUTE pidlChild)
         *
         * Where in the child the parent's items end: the child itself for an
         * empty parent, its terminator for the same list.
         */
        ILFindChild: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([parent, child])=>{
                if ((parent >>> 0) === 0 || (child >>> 0) === 0)
                {
                    return 0;
                }
                const part = childPart(parent, child);
                return part === null ? 0 : part.rest[0] ?? part.end;
            },
        },

        /**
         * PIDLIST_ABSOLUTE ILCombine(PCIDLIST_ABSOLUTE pidl1, PCUIDLIST_RELATIVE pidl2)
         *
         * A new list of the first's items then the second's; one missing is
         * a copy of the other, both missing NULL.
         */
        ILCombine: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([first, second])=>{
                if ((first >>> 0) === 0 && (second >>> 0) === 0)
                {
                    return 0;
                }
                return allocated(joined(...[first, second].filter(list=>(list >>> 0) !== 0)
                    .map(itemsBytes)));
            },
        },

        /**
         * PIDLIST_RELATIVE ILAppendID(PIDLIST_RELATIVE pidl, LPCSHITEMID pmkid, BOOL fAppend)
         *
         * A new list with the item at its end, or its start, the old list
         * freed: what the caller holds afterwards is the answer.
         */
        ILAppendID: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([list, item, append])=>{
                const old = (list >>> 0) === 0 ? new Uint8Array(0) : itemsBytes(list);
                const added = (item >>> 0) === 0 ? new Uint8Array(0) : itemBytes(item);
                const made = allocated((append | 0) !== 0 ? joined(old, added)
                    : joined(added, old));
                if (made !== 0 && (list >>> 0) !== 0)
                {
                    host.free?.(list >>> 0);
                }
                return made;
            },
        },

        /** void ILFree(PIDLIST_RELATIVE pidl): NULL is nothing to free. */
        ILFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([list])=>{
                if ((list >>> 0) !== 0)
                {
                    host.free?.(list >>> 0);
                }
                return 0;
            },
        },

        /** void SHFree(LPVOID pv): the task allocator's free. */
        SHFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([block])=>{
                if ((block >>> 0) !== 0)
                {
                    host.free?.(block >>> 0);
                }
                return 0;
            },
        },

        /** LPVOID SHAlloc(SIZE_T cb): the task allocator's memory. */
        SHAlloc: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([bytes])=>host.allocate?.(Math.max(bytes >>> 0, 1)) ?? 0,
        },
    };
}
