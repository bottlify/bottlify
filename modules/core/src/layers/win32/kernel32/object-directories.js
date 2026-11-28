/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The native calls over the object manager's directories and symbolic links
 * (`object-namespace.js`), which ntdll publishes.
 *
 * A directory or link made with a name is kept in the run's table under it
 * and found by every process; one made with none is reached by its handle
 * alone, and a directory of that kind still holds the names made relative to
 * it. A create finds a name already held as every native create does: the
 * same kind is opened where OBJ_OPENIF asks (STATUS_OBJECT_NAME_EXISTS) and a
 * collision otherwise, another kind is STATUS_OBJECT_TYPE_MISMATCH.
 */

import { STATUS } from '../ntdll/status.js';
import { nameToWalk, readObjectAttributes, OBJ_OPENIF } from './object-attributes.js';
import { DIRECTORY, SYMBOLIC_LINK, TYPE_NAMES } from './object-namespace.js';
import { grantedAccess } from './access.js';
import { wholeAddress } from '../common/pointers.js';

const STATUS_BUFFER_TOO_SMALL = STATUS.BUFFER_TOO_SMALL;
/** A query that wrote what fitted and has more to give. */
const STATUS_MORE_ENTRIES = 0x00000105;
/** DIRECTORY_BASIC_INFORMATION: two UNICODE_STRINGs, a 32-bit process's. */
const ENTRY_BYTES = 16;

/**
 * @typedef {Object} DirectoryNativesHost
 * @property {import('../common/guest.js').Guest} guest
 * @property {{ handles: { open: (kind: string, object: any, access?: number | null) => number,
 *     typeOf: (handle: number) => string | null, resolve: (handle: number) => any } }} kernel
 * @property {ReturnType<typeof import('./named-objects.js').createNamedObjects>} namedObjects
 */

/**
 * @param {DirectoryNativesHost} host
 */
export function createDirectoryNatives(host){
    const { guest } = host;
    const { kernel, namedObjects } = host;
    /** Paths no name reaches, for the directories made with none. */
    let unnamed = 0;

    /** @param {number} handle @param {string} kind @param {number} access */
    const opened = (handle, kind, access)=>{
        const granted = grantedAccess(kind, access);
        return 'error' in granted ? null : granted.granted;
    };

    /**
     * A native create of a directory or a link: `make` builds the object for
     * its path (null for one made with no name).
     *
     * @param {string} kind @param {number} out @param {number} access @param {number} attributes
     * @param {(path: string | null) => any} make
     */
    const create = (kind, out, access, attributes, make)=>{
        if ((out >>> 0) === 0)
        {
            return STATUS.ACCESS_VIOLATION;
        }
        guest.set32(out, 0);
        const given = readObjectAttributes(guest, attributes);
        const walked = nameToWalk(given, false);
        if ('status' in walked)
        {
            return walked.status;
        }
        if (given === null || walked.name === null)
        {
            const object = make(null);
            guest.set32(out, kernel.handles.open(kind, object, opened(0, kind, access)));
            return STATUS.SUCCESS;
        }
        const place = namedObjects.place(given, kind);
        if ('status' in place)
        {
            return place.status;
        }
        if (place.held)
        {
            if (place.held.kind !== kind)
            {
                return STATUS.OBJECT_TYPE_MISMATCH;
            }
            if ((given.attributes & OBJ_OPENIF) === 0)
            {
                return STATUS.OBJECT_NAME_COLLISION;
            }
            namedObjects.reference(place.held.object);
            guest.set32(out, kernel.handles.open(kind, place.held.object,
                opened(0, kind, access)));
            return STATUS.OBJECT_NAME_EXISTS;
        }
        const path = place.directory === '\\' ? `\\${place.name}`
            : `${place.directory}\\${place.name}`;
        const object = make(path);
        namedObjects.remember(place.key, kind, object, false, ()=>{});
        guest.set32(out, kernel.handles.open(kind, object, opened(0, kind, access)));
        return STATUS.SUCCESS;
    };

    /**
     * A native open of a directory or a link by name.
     *
     * @param {string} kind @param {number} out @param {number} access @param {number} attributes
     */
    const open = (kind, out, access, attributes)=>{
        if ((out >>> 0) === 0)
        {
            return STATUS.ACCESS_VIOLATION;
        }
        guest.set32(out, 0);
        const given = readObjectAttributes(guest, attributes);
        const walked = nameToWalk(given, true);
        if ('status' in walked || given === null)
        {
            return 'status' in walked ? walked.status : STATUS.INVALID_PARAMETER;
        }
        const place = namedObjects.place(given, kind);
        if ('status' in place)
        {
            return place.status;
        }
        if (!place.held)
        {
            return STATUS.OBJECT_NAME_NOT_FOUND;
        }
        if (place.held.kind !== kind)
        {
            return STATUS.OBJECT_TYPE_MISMATCH;
        }
        const granted = grantedAccess(kind, access);
        if ('error' in granted)
        {
            return STATUS.ACCESS_DENIED;
        }
        namedObjects.reference(place.held.object);
        guest.set32(out, kernel.handles.open(kind, place.held.object, granted.granted));
        return STATUS.SUCCESS;
    };

    /**
     * A UNICODE_STRING's text, or null for a null pointer.
     *
     * @param {number} pointer
     */
    const unicodeAt = pointer=>{
        const length = guest.u32(pointer) & 0xffff;
        const buffer = guest.u32(pointer + 4);
        const units = length === 0 ? new Uint8Array(0) : guest.snapshot(buffer, length & ~1);
        let text = '';
        for (let at = 0; at + 1 < units.length; at += 2)
        {
            text += String.fromCharCode(units[at] | units[at + 1] << 8);
        }
        return text;
    };

    return {
        /**
         * NTSTATUS NtCreateDirectoryObject(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES)
         */
        NtCreateDirectoryObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>create(DIRECTORY, out, access, attributes,
                path=>({ path: path ?? `\\<unnamed directory ${++unnamed}>` })),
        },

        /**
         * NTSTATUS NtOpenDirectoryObject(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES)
         */
        NtOpenDirectoryObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open(DIRECTORY, out, access, attributes),
        },

        /**
         * NTSTATUS NtQueryDirectoryObject(HANDLE, PVOID Buffer, ULONG Length,
         *   BOOLEAN ReturnSingleEntry, BOOLEAN RestartScan, PULONG Context,
         *   PULONG ReturnLength)
         *
         * The names a directory holds from the context on (from the first
         * where the scan restarts), in the order they were made: an array of
         * DIRECTORY_BASIC_INFORMATION closed by an empty entry, the names and
         * their types' names after it. As many as fit are written, the
         * context moved past them and STATUS_MORE_ENTRIES answered when some
         * did not; a single entry that does not fit is STATUS_BUFFER_TOO_SMALL
         * and moves nothing. No entry left is STATUS_NO_MORE_ENTRIES, the
         * closing entry's size answered and that entry cleared where it fits.
         */
        NtQueryDirectoryObject: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([handle, buffer, length, single, restart, context, returned])=>{
                const kind = kernel.handles.typeOf(handle >>> 0);
                if (kind === null)
                {
                    return STATUS.INVALID_HANDLE;
                }
                if (kind !== DIRECTORY)
                {
                    return STATUS.OBJECT_TYPE_MISMATCH;
                }
                if (wholeAddress(context) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const { path } = kernel.handles.resolve(handle >>> 0);
                const start = (restart & 0xff) !== 0 ? 0 : guest.u32(context);
                const left = namedObjects.list(path)
                    .filter(entry=>TYPE_NAMES.has(entry.kind)).slice(start);
                const room = length >>> 0;
                /** @param {number} needed */
                const answer = needed=>{
                    if (wholeAddress(returned) !== 0)
                    {
                        guest.set32(returned, needed);
                    }
                };
                /** @param {number} count  the entries' strings' bytes, by how many are taken */
                const bytesFor = count=>(count + 1) * ENTRY_BYTES + left.slice(0, count)
                    .reduce((sum, entry)=>sum + (entry.name.length + 1) * 2
                        + (/** @type {string} */ (TYPE_NAMES.get(entry.kind)).length + 1) * 2, 0);
                if (left.length === 0)
                {
                    if (room >= ENTRY_BYTES)
                    {
                        guest.setBytes(wholeAddress(buffer), new Uint8Array(ENTRY_BYTES));
                    }
                    answer(ENTRY_BYTES);
                    return STATUS.NO_MORE_ENTRIES;
                }
                const wanted = (single & 0xff) !== 0 ? 1 : left.length;
                let taken = wanted;
                while (taken > 0 && bytesFor(taken) > room)
                {
                    taken--;
                }
                if (taken === 0 && wanted === 1)
                {
                    answer(bytesFor(1));
                    return STATUS_BUFFER_TOO_SMALL;
                }
                const size = bytesFor(taken);
                const bytes = new Uint8Array(size);
                const view = new DataView(bytes.buffer);
                let text = (taken + 1) * ENTRY_BYTES;
                /** @param {number} at @param {string} value */
                const string = (at, value)=>{
                    view.setUint16(at, value.length * 2, true);
                    view.setUint16(at + 2, value.length * 2 + 2, true);
                    view.setUint32(at + 4, wholeAddress(buffer) + text, true);
                    for (let unit = 0; unit < value.length; unit++)
                    {
                        view.setUint16(text + unit * 2, value.charCodeAt(unit), true);
                    }
                    text += (value.length + 1) * 2;
                };
                left.slice(0, taken).forEach((entry, at)=>{
                    string(at * ENTRY_BYTES, entry.name);
                    string(at * ENTRY_BYTES + 8, /** @type {string} */ (TYPE_NAMES.get(entry.kind)));
                });
                if (room >= ENTRY_BYTES)
                {
                    guest.setBytes(wholeAddress(buffer), bytes.subarray(0, Math.min(size, room)));
                }
                guest.set32(context, start + taken);
                answer(size);
                return taken < left.length && wanted > 1 ? STATUS_MORE_ENTRIES : STATUS.SUCCESS;
            },
        },

        /**
         * NTSTATUS NtCreateSymbolicLinkObject(PHANDLE, ACCESS_MASK,
         *   POBJECT_ATTRIBUTES, PUNICODE_STRING LinkTarget)
         *
         * A link names its target as a path, which is not looked at until a
         * walk goes through it; an empty target is refused.
         */
        NtCreateSymbolicLinkObject: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([out, access, attributes, target])=>{
                if (wholeAddress(out) === 0 || wholeAddress(target) === 0)
                {
                    return STATUS.ACCESS_VIOLATION;
                }
                const text = unicodeAt(wholeAddress(target));
                if (text === '')
                {
                    return STATUS.INVALID_PARAMETER;
                }
                return create(SYMBOLIC_LINK, out, access, attributes,
                    path=>({ path, target: text }));
            },
        },

        /**
         * NTSTATUS NtOpenSymbolicLinkObject(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES)
         */
        NtOpenSymbolicLinkObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, access, attributes])=>open(SYMBOLIC_LINK, out, access, attributes),
        },

        /**
         * NTSTATUS NtQuerySymbolicLinkObject(HANDLE, PUNICODE_STRING LinkTarget,
         *   PULONG ReturnedLength)
         *
         * The target and its terminator are written where both fit, the
         * string's Length the target's; the length needed is answered either
         * way, and a buffer too small for both leaves the string alone.
         */
        NtQuerySymbolicLinkObject: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([handle, string, returned])=>{
                const kind = kernel.handles.typeOf(handle >>> 0);
                if (kind === null)
                {
                    return STATUS.INVALID_HANDLE;
                }
                if (kind !== SYMBOLIC_LINK)
                {
                    return STATUS.OBJECT_TYPE_MISMATCH;
                }
                const { target } = kernel.handles.resolve(handle >>> 0);
                const needed = target.length * 2 + 2;
                if (wholeAddress(returned) !== 0)
                {
                    guest.set32(returned, needed);
                }
                const room = guest.u32(wholeAddress(string)) >>> 16;
                if (room < needed)
                {
                    return STATUS_BUFFER_TOO_SMALL;
                }
                const bytes = new Uint8Array(needed);
                for (let at = 0; at < target.length; at++)
                {
                    bytes[at * 2] = target.charCodeAt(at) & 0xff;
                    bytes[at * 2 + 1] = target.charCodeAt(at) >>> 8;
                }
                guest.setBytes(guest.u32(wholeAddress(string) + 4), bytes);
                guest.setBytes(wholeAddress(string), Uint8Array.of((needed - 2) & 0xff,
                    (needed - 2) >>> 8));
                return STATUS.SUCCESS;
            },
        },
    };
}
