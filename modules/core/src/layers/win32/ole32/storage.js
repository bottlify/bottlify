/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Structured storage: the IStorage and IStream a program persists objects
 * through, the compound file they live in, and the ole32 entry points that
 * open one.
 *
 * A docfile is read whole when it is opened and written whole when it is
 * committed or the last object over it is released; in between, every
 * storage and stream is a view over one tree of entries (cfb.js). That makes
 * direct mode exact -- a write through one stream is visible through another
 * at once, as it is on Windows -- and makes transacted mode the one thing
 * this cannot do: there is no scratch copy to revert to, so STGM_TRANSACTED
 * is accepted as direct and reported as the difference it is.
 *
 * A stream over an HGLOBAL (CreateStreamOnHGlobal) is the same IStream over a
 * block of guest memory instead of an entry, which is why the stream methods
 * are written against a backing rather than against the tree.
 */

import { GUID_NULL, GUID_SIZE, formatGuid, readGuid, writeGuid } from './guid.js';
import {
    MAX_NAME_LENGTH, createEntry, createRoot, isCompoundFile, nameKey,
    parseCompoundFile, serializeCompoundFile,
} from './cfb.js';

const S_OK = 0;
const S_FALSE = 1;
const E_NOINTERFACE = 0x80004002 | 0;
const E_POINTER = 0x80004003 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const REGDB_E_CLASSNOTREG = 0x80040154 | 0;
const STG_E_INVALIDFUNCTION = 0x80030001 | 0;
const STG_E_FILENOTFOUND = 0x80030002 | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const STG_E_INSUFFICIENTMEMORY = 0x80030008 | 0;
const STG_E_SEEKERROR = 0x80030019 | 0;
const STG_E_INVALIDPOINTER = 0x80030009 | 0;
const STG_E_READFAULT = 0x8003001e | 0;
const STG_E_FILEALREADYEXISTS = 0x80030050 | 0;
const STG_E_INVALIDPARAMETER = 0x80030057 | 0;
const STG_E_INVALIDNAME = 0x800300fc | 0;
const STG_E_INVALIDFLAG = 0x800300ff | 0;
const STG_E_MEDIUMFULL = 0x80030070 | 0;

/** STGM_* -- the open mode a storage, stream or docfile is asked for. */
const STGM_ACCESS_MASK = 0x3;
const STGM_READ = 0x0;
const STGM_WRITE = 0x1;
const STGM_READWRITE = 0x2;
const STGM_SHARE_MASK = 0x70;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_SHARE_DENY_WRITE = 0x20;
const STGM_TRANSACTED = 0x10000;
const STGM_CONVERT = 0x20000;
const STGM_CREATE = 0x1000;
const STGM_DELETEONRELEASE = 0x4000000;
const STGM_PRIORITY = 0x40000;
/**
 * Every STGM bit there is: the access, the sharing, STGM_CREATE,
 * STGM_TRANSACTED, STGM_CONVERT, STGM_PRIORITY, STGM_NOSCRATCH,
 * STGM_NOSNAPSHOT, STGM_DIRECT_SWMR, STGM_DELETEONRELEASE and STGM_SIMPLE.
 */
const STGM_KNOWN = STGM_ACCESS_MASK | STGM_SHARE_MASK | STGM_CREATE | STGM_TRANSACTED
    | STGM_CONVERT | STGM_PRIORITY | 0x100000 | 0x200000 | 0x400000 | STGM_DELETEONRELEASE
    | 0x8000000;

/**
 * STGFMT_*, StgCreateStorageEx's formats: the two that are a compound file,
 * and the one StgOpenStorageEx takes to mean whichever the file is.
 */
const STGFMT_STORAGE = 0;
const STGFMT_ANY = 4;
const STGFMT_DOCFILE = 5;

/** STGTY_*, in STATSTG.type. */
const STGTY_STORAGE = 1;
const STGTY_STREAM = 2;
const STGTY_LOCKBYTES = 3;

const STATFLAG_NONAME = 1;
const STREAM_SEEK_SET = 0;
const STREAM_SEEK_CUR = 1;
const STREAM_SEEK_END = 2;
const STGMOVE_COPY = 1;

/** STATSTG, 72 bytes. */
const STATSTG = Object.freeze({
    NAME: 0, TYPE: 4, SIZE: 8, MTIME: 16, CTIME: 24, ATIME: 32, MODE: 40, LOCKS: 44,
    CLSID: 48, STATE_BITS: 64, SIZE_OF: 72,
});

export const IID_ISTORAGE = '{0000000B-0000-0000-C000-000000000046}';
export const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';
export const IID_ISEQUENTIALSTREAM = '{0C733A30-2A1C-11CE-ADE5-00AA0044773D}';
export const IID_IENUMSTATSTG = '{0000000D-0000-0000-C000-000000000046}';
export const IID_IPERSISTSTREAM = '{00000109-0000-0000-C000-000000000046}';

/** Private classes the three objects are registered under. */
const CLSID_STORAGE = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0010}';
const CLSID_STREAM = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0011}';
const CLSID_ENUM = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0012}';
const CLSID_LOCKBYTES = '{7B5B0B8E-1F8C-4B36-9D1C-2A6D4E4B0013}';
const IID_ILOCKBYTES = '{0000000A-0000-0000-C000-000000000046}';

/**
 * IPersistStream's slots after IUnknown's three: GetClassID, IsDirty, Load,
 * Save, GetSizeMax. IStream's Read and Write, likewise, for a stream a
 * program implemented itself.
 */
const SLOT_GETCLASSID = 3;
const SLOT_SAVE = 6;
const SLOT_STREAM_READ = 3;
const SLOT_STREAM_WRITE = 4;
const WORD = 4;

/** Where a nameless docfile goes, and the longest path one is opened by. */
const TEMP_DIRECTORY = 'C:\\WINDOWS\\TEMP';
const MAX_PATH = 260;

/**
 * The volume, as far as a docfile needs it.
 *
 * @typedef {Object} StorageFiles
 * @property {(path: string) => { exists: boolean, isDirectory: boolean, size: number } | null} stat
 * @property {(path: string, mode: { read?: boolean, write?: boolean, create?: boolean,
 *            truncate?: boolean }) => any} open
 * @property {(node: any, offset: number, length: number) => Uint8Array | Promise<Uint8Array>} read
 * @property {(node: any, offset: number, bytes: Uint8Array) => number} write
 * @property {(node: any) => void} close
 * @property {(path: string) => boolean} remove
 */

/**
 * @typedef {Object} StorageHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, value: number, length: number) => void} fillMemory
 *     Sets a range to one byte value in place, with no host buffer holding
 *     the pattern: the lengths are the program's, and a clear of a megabyte
 *     through writeMemory costs an allocation and two extra passes.
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => boolean,
 *              block: (address: number) => { size: number } | null,
 *              resize: (address: number, bytes: number) => boolean }} heap
 *           Task memory: STATSTG names, and the block a memory stream grows in.
 * @property {import('./objects.js').ComRegistry} registry
 * @property {{ publish: (object: import('./objects.js').ComObject,
 *              interfaceId: string) => number }} vtables
 * @property {((api: string, detail: string) => void) | undefined} [divergence]
 * @property {StorageFiles} [files]  Without it no docfile opens.
 * @property {(entry: number, args: number[], thread?: unknown) => Promise<number>} [call]
 *           A stdcall into guest code, for an object a program persists.
 *           The thread is whose call is being answered: a second call after
 *           the first has been awaited is made from nobody's turn, and the
 *           bridge has to be told whose stack to build the frame on.
 * @property {() => unknown} [callerThread]  Whose call is being handled.
 */

/**
 * One open docfile: the tree, where it goes back to, and how many objects
 * are looking at it.
 *
 * @typedef {Object} Document
 * @property {import('./cfb.js').CfbEntry} root
 * @property {string | null} path   Null for a tree with no file behind it.
 * @property {boolean} deleteOnRelease
 * @property {number} objects
 * @property {StreamBacking} [lockBytes]  The byte array of an ILockBytes it
 *           lives in instead of a file, held until the last object goes.
 * @property {() => void} [done]  Told when the last object goes.
 */

/**
 * What an IStream reads and writes. A docfile stream is over an entry, a
 * memory stream over a block the guest owns.
 *
 * @typedef {Object} StreamBacking
 * @property {string | null} name  None for a memory stream, whose Stat names nothing.
 * @property {() => number} size
 * @property {(offset: number, length: number) => Uint8Array} read
 * @property {(offset: number, bytes: Uint8Array) => boolean} write
 *           False when the backing cannot grow to hold it.
 * @property {(size: number) => boolean} resize
 * @property {import('./cfb.js').CfbEntry | null} entry  For Stat's times.
 * @property {() => number} [handle]  The HGLOBAL, for a memory stream.
 * @property {() => () => void} [retain]
 *           One more stream over the backing; answers what that stream calls
 *           when it goes.
 */

/**
 * @typedef {Object} StreamState
 * @property {StreamBacking} backing
 * @property {number} mode
 * @property {number} position
 * @property {Document | null} document
 */

/**
 * @typedef {Object} StorageState
 * @property {Document} document
 * @property {import('./cfb.js').CfbEntry} entry
 * @property {number} mode
 * @property {string | null} name  The path for the root, the element name below
 *           it; none for the root of a docfile in an ILockBytes.
 */

/**
 * @param {number} mode
 * @returns {boolean} whether the mode allows writing
 */
const writable = mode=>(mode & STGM_ACCESS_MASK) !== STGM_READ;
/** @param {number} mode */
const readable = mode=>(mode & STGM_ACCESS_MASK) !== STGM_WRITE;

/**
 * Builds the storage half of ole32: the objects, and the entry points that
 * hand them out.
 *
 * @param {StorageHost} host
 */
export function createStorageFunctions(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, WORD);
        return (bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24)) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(WORD);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address @param {bigint} value */
    const writeU64 = (address, value)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address */
    const readU64 = address=>new DataView(host.readMemory(address, 8).slice().buffer)
        .getBigUint64(0, true);

    /**
     * An OLESTR, read no further than a name of its kind can reach.
     *
     * @param {number} address @param {number} maxUnits
     * @returns {string | null} null for a NULL pointer
     */
    const readWide = (address, maxUnits)=>{
        if (address === 0)
        {
            return null;
        }
        const bytes = host.readMemory(address, (maxUnits + 1) * 2);
        let text = '';
        for (let index = 0; index + 1 < bytes.length; index += 2)
        {
            const unit = bytes[index] | (bytes[index + 1] << 8);
            if (unit === 0)
            {
                return text;
            }
            text += String.fromCharCode(unit);
        }
        return text;
    };

    /**
     * A string in task memory, terminated, for STATSTG.pwcsName; 0 when
     * nothing fits.
     *
     * @param {string} text
     */
    const allocateWide = text=>{
        const block = host.heap.allocate((text.length + 1) * 2);
        if (block === 0)
        {
            return 0;
        }
        const bytes = new Uint8Array((text.length + 1) * 2);
        for (let index = 0; index < text.length; index++)
        {
            const unit = text.charCodeAt(index);
            bytes[index * 2] = unit & 0xff;
            bytes[index * 2 + 1] = unit >>> 8;
        }
        host.writeMemory(block, bytes);
        return block;
    };

    /** @param {string} api @param {string} detail */
    const diverge = (api, detail)=>host.divergence?.(api, detail);

    /**
     * Objects by the interface pointer the guest holds, which is how a
     * stream or storage a program hands back -- to CopyTo, to WriteClassStm
     * -- is found again. An entry lives as long as its object.
     *
     * @type {Map<number, import('./objects.js').ComObject>}
     */
    const byPointer = new Map();

    /** @type {import('./objects.js').ComClassDefinition | null} */
    let pending = null;
    for (const clsid of [CLSID_STORAGE, CLSID_STREAM, CLSID_ENUM, CLSID_LOCKBYTES])
    {
        host.registry.registerClass(clsid, ()=>pending);
    }

    /**
     * Makes an object and puts its interface where the caller asked.
     *
     * @param {string} clsid
     * @param {import('./objects.js').ComClassDefinition} definition
     * @param {string} iid
     * @param {number} out  Where the pointer goes; 0 to only make the object.
     * @returns {number} an HRESULT
     */
    const publish = (clsid, definition, iid, out)=>{
        pending = definition;
        const object = host.registry.create(clsid);
        pending = null;
        if (!object)
        {
            return E_OUTOFMEMORY;
        }
        const pointer = host.vtables.publish(object, iid) >>> 0;
        if (pointer === 0)
        {
            object.release();
            return E_OUTOFMEMORY;
        }
        byPointer.set(pointer, object);
        const destroy = definition.destroy;
        definition.destroy = ()=>{
            byPointer.delete(pointer);
            destroy?.();
        };
        if (out !== 0)
        {
            writeU32(out, pointer);
        }
        return S_OK;
    };

    /**
     * @param {number} pointer
     * @param {string} clsid
     * @returns {any} the state of one of ours, or null
     */
    const stateAt = (pointer, clsid)=>{
        const object = byPointer.get(pointer >>> 0);
        return object && object.clsid === clsid && !object.destroyed ? object.state : null;
    };

    /**
     * Writes the tree back to its file. Direct mode has no other moment: a
     * program that crashes between two commits loses what it wrote, which
     * is also what happens to it on Windows.
     *
     * @param {Document} document
     */
    const flush = document=>{
        if (document.lockBytes)
        {
            const bytes = serializeCompoundFile(document.root);
            if (!document.lockBytes.resize(bytes.length) || !document.lockBytes.write(0, bytes))
            {
                diverge('IStorage::Commit', 'a docfile did not fit its ILockBytes');
            }
            return;
        }
        if (document.path === null || !host.files)
        {
            return;
        }
        const node = host.files.open(document.path, { write: true, create: true, truncate: true });
        if (!node)
        {
            diverge('IStorage::Commit', `${document.path} could not be written back`);
            return;
        }
        host.files.write(node, 0, serializeCompoundFile(document.root));
        host.files.close(node);
    };

    /**
     * One more object over the document; the file is written when the last
     * one goes.
     *
     * @param {Document} document
     */
    const attach = document=>{
        document.objects++;
        return ()=>{
            document.objects--;
            if (document.objects > 0)
            {
                return;
            }
            if (document.deleteOnRelease)
            {
                if (document.path !== null)
                {
                    host.files?.remove(document.path);
                }
            }
            else
            {
                flush(document);
            }
            document.done?.();
        };
    };

    /**
     * Fills a STATSTG.
     *
     * @param {number} at
     * @param {{ name: string | null, type: number, size: number, mode: number,
     *           entry: import('./cfb.js').CfbEntry | null }} about
     * @param {number} flags
     */
    const writeStat = (at, about, flags)=>{
        host.writeMemory(at, new Uint8Array(STATSTG.SIZE_OF));
        if ((flags & STATFLAG_NONAME) === 0 && about.name !== null)
        {
            const name = allocateWide(about.name);
            if (name === 0)
            {
                return STG_E_INSUFFICIENTMEMORY;
            }
            writeU32(at + STATSTG.NAME, name);
        }
        writeU32(at + STATSTG.TYPE, about.type);
        writeU64(at + STATSTG.SIZE, BigInt(about.size));
        writeU64(at + STATSTG.MTIME, about.entry?.modified ?? 0n);
        writeU64(at + STATSTG.CTIME, about.entry?.created ?? 0n);
        writeU32(at + STATSTG.MODE, about.mode);
        if (about.type === STGTY_STORAGE && about.entry)
        {
            writeGuid(host, at + STATSTG.CLSID, about.entry.clsid);
            writeU32(at + STATSTG.STATE_BITS, about.entry.stateBits);
        }
        return S_OK;
    };

    /**
     * An element name a program asks for, checked the way the format
     * requires: at most 31 characters and none of the four it reserves.
     *
     * @param {number} address
     * @returns {string | null}
     */
    const elementName = address=>{
        const name = readWide(address, MAX_NAME_LENGTH + 1);
        if (name === null || name.length === 0 || name.length > MAX_NAME_LENGTH
            || /[\\/:!]/.test(name))
        {
            return null;
        }
        return name;
    };

    /**
     * A deep copy of an entry, for CopyTo and MoveElementTo.
     *
     * @param {import('./cfb.js').CfbEntry} entry @param {string} name
     * @returns {import('./cfb.js').CfbEntry}
     */
    const cloneEntry = (entry, name)=>{
        const copy = createEntry(name, entry.kind);
        copy.clsid = entry.clsid;
        copy.stateBits = entry.stateBits;
        copy.created = entry.created;
        copy.modified = entry.modified;
        copy.data = entry.data.slice();
        for (const child of entry.children.values())
        {
            copy.children.set(nameKey(child.name), cloneEntry(child, child.name));
        }
        return copy;
    };

    /** @param {import('./cfb.js').CfbEntry} entry @returns {StreamBacking} */
    const entryBacking = entry=>({
        name: entry.name,
        entry,
        size: ()=>entry.data.length,
        read: (offset, length)=>entry.data.slice(offset, offset + length),
        write: (offset, bytes)=>{
            if (offset + bytes.length > entry.data.length)
            {
                const grown = new Uint8Array(offset + bytes.length);
                grown.set(entry.data);
                entry.data = grown;
            }
            entry.data.set(bytes, offset);
            return true;
        },
        resize: size=>{
            const resized = new Uint8Array(size);
            resized.set(entry.data.subarray(0, Math.min(size, entry.data.length)));
            entry.data = resized;
            return true;
        },
    });

    /**
     * Seek on a memory stream, whose position is a DWORD, as ole32's
     * hglobalstream tests pin: the move is the low half of its LARGE_INTEGER,
     * signed, and the high half is not read; a move that lands before the
     * start, or an origin there is no such thing as, is STG_E_SEEKERROR with
     * the position kept and reported; past 4 GiB it wraps.
     *
     * @param {StreamState} state @param {number} low @param {number} origin
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const seekMemory = (state, low, origin, out)=>{
        const base = origin === STREAM_SEEK_SET ? 0
            : origin === STREAM_SEEK_CUR ? state.position
                : origin === STREAM_SEEK_END ? state.backing.size() : -1;
        const target = base + (low | 0);
        const failed = base < 0 || target < 0;
        if (!failed)
        {
            state.position = target >>> 0;
        }
        if (out !== 0)
        {
            writeU64(out, BigInt(state.position));
        }
        return failed ? STG_E_SEEKERROR : S_OK;
    };

    /**
     * A stream's methods over its backing. Positions and sizes arrive as
     * 64-bit integers, two words each, and go back the same way.
     *
     * @returns {import('./objects.js').ComMethod[]}
     */
    const streamMethods = ()=>[
        { name: 'Read', argBytes: 16, invoke: (object, [pv, cb, pcbRead])=>{
            /** @type {StreamState} */
            const state = object.state;
            if ((pcbRead >>> 0) !== 0)
            {
                writeU32(pcbRead >>> 0, 0);
            }
            if (!readable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            const wanted = cb >>> 0;
            if ((pv >>> 0) === 0 && wanted !== 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const available = Math.max(0, state.backing.size() - state.position);
            const bytes = state.backing.read(state.position, Math.min(wanted, available));
            if (bytes.length > 0)
            {
                host.writeMemory(pv >>> 0, bytes);
            }
            state.position += bytes.length;
            if ((pcbRead >>> 0) !== 0)
            {
                writeU32(pcbRead >>> 0, bytes.length);
            }
            // S_OK even when short: a docfile stream reports the count and
            // leaves "was that the end" to the caller, and programs written
            // against it treat S_FALSE here as an error.
            return S_OK;
        } },
        { name: 'Write', argBytes: 16, invoke: (object, [pv, cb, pcbWritten])=>{
            /** @type {StreamState} */
            const state = object.state;
            if ((pcbWritten >>> 0) !== 0)
            {
                writeU32(pcbWritten >>> 0, 0);
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            const count = cb >>> 0;
            if ((pv >>> 0) === 0 && count !== 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            if (count > 0 && !state.backing.write(state.position, host.readMemory(pv >>> 0, count)))
            {
                return E_OUTOFMEMORY;
            }
            state.position += count;
            if ((pcbWritten >>> 0) !== 0)
            {
                writeU32(pcbWritten >>> 0, count);
            }
            return S_OK;
        } },
        { name: 'Seek', argBytes: 20, invoke: (object, [low, high, origin, out])=>{
            /** @type {StreamState} */
            const state = object.state;
            if (state.backing.handle)
            {
                return seekMemory(state, low, origin >>> 0, out >>> 0);
            }
            const move = Number(BigInt.asIntN(64, (BigInt(high >>> 0) << 32n) | BigInt(low >>> 0)));
            let target;
            switch (origin >>> 0){
                case STREAM_SEEK_SET:
                    target = move;
                    break;
                case STREAM_SEEK_CUR:
                    target = state.position + move;
                    break;
                case STREAM_SEEK_END:
                    target = state.backing.size() + move;
                    break;
                default:
                    return STG_E_INVALIDFUNCTION;
            }
            if (target < 0)
            {
                return STG_E_INVALIDFUNCTION;
            }
            // Past the end is allowed; the stream grows when something is
            // written there.
            state.position = target;
            if ((out >>> 0) !== 0)
            {
                writeU64(out >>> 0, BigInt(target));
            }
            return S_OK;
        } },
        { name: 'SetSize', argBytes: 12, invoke: (object, [low, high])=>{
            /** @type {StreamState} */
            const state = object.state;
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            // A memory stream's size is a DWORD and the high half is not
            // read at all, as ole32's hglobalstream tests pass it -1.
            if ((high >>> 0) !== 0 && !state.backing.handle)
            {
                return E_OUTOFMEMORY;
            }
            return state.backing.resize(low >>> 0) ? S_OK : E_OUTOFMEMORY;
        } },
        { name: 'CopyTo', argBytes: 24, invoke: (object, [pstm, low, high, pcbRead, pcbWritten])=>{
            /** @type {StreamState} */
            const state = object.state;
            const target = pstm >>> 0;
            for (const slot of [pcbRead >>> 0, pcbWritten >>> 0])
            {
                if (slot !== 0)
                {
                    writeU64(slot, 0n);
                }
            }
            if (target === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const wanted = (high >>> 0) !== 0
                ? Number.MAX_SAFE_INTEGER
                : low >>> 0;
            const available = Math.max(0, state.backing.size() - state.position);
            const bytes = state.backing.read(state.position, Math.min(wanted, available));
            state.position += bytes.length;
            /** @param {number} written */
            const report = written=>{
                if ((pcbRead >>> 0) !== 0)
                {
                    writeU64(pcbRead >>> 0, BigInt(bytes.length));
                }
                if ((pcbWritten >>> 0) !== 0)
                {
                    writeU64(pcbWritten >>> 0, BigInt(written));
                }
                return S_OK;
            };
            const written = writeToStream(target, bytes);
            return typeof written === 'number' ? report(written) : written.then(report);
        } },
        // Direct mode: a write is already in the tree, so there is nothing
        // to commit and nothing to take back.
        { name: 'Commit', argBytes: 8, invoke: ()=>S_OK },
        { name: 'Revert', argBytes: 4, invoke: ()=>S_OK },
        // Range locks are what the documentation says a docfile stream does
        // not support.
        { name: 'LockRegion', argBytes: 24, invoke: ()=>STG_E_INVALIDFUNCTION },
        { name: 'UnlockRegion', argBytes: 24, invoke: ()=>STG_E_INVALIDFUNCTION },
        { name: 'Stat', argBytes: 12, invoke: (object, [pstatstg, flags])=>{
            /** @type {StreamState} */
            const state = object.state;
            if ((pstatstg >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            return writeStat(pstatstg >>> 0, {
                name: state.backing.name, type: STGTY_STREAM, size: state.backing.size(),
                mode: state.mode, entry: state.backing.entry,
            }, flags >>> 0);
        } },
        { name: 'Clone', argBytes: 8, invoke: (object, [out])=>{
            /** @type {StreamState} */
            const state = object.state;
            if ((out >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            return publishStream({ ...state }, out >>> 0);
        } },
    ];

    /**
     * @param {StreamState} state
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publishStream = (state, out)=>{
        const methods = streamMethods();
        const detach = state.document ? attach(state.document) : null;
        const release = state.backing.retain?.();
        return publish(CLSID_STREAM, {
            state,
            interfaces: [
                { id: IID_ISTREAM, methods },
                // ISequentialStream is IStream's first two methods, which is
                // what a program that asks for it expects to find there.
                { id: IID_ISEQUENTIALSTREAM, methods: methods.slice(0, 2) },
            ],
            destroy: ()=>{
                detach?.();
                release?.();
            },
        }, IID_ISTREAM, out);
    };

    /**
     * Writes into a stream the guest holds: one of ours directly, one of the
     * program's own through its vtable.
     *
     * @param {number} pointer
     * @param {Uint8Array} bytes
     * @param {unknown} [thread]  Whose call this is, when it is not the one in flight.
     * @returns {number | Promise<number>} how many bytes went in
     */
    const writeToStream = (pointer, bytes, thread)=>{
        /** @type {StreamState | null} */
        const own = stateAt(pointer, CLSID_STREAM);
        if (own)
        {
            if (bytes.length > 0 && !own.backing.write(own.position, bytes))
            {
                return 0;
            }
            own.position += bytes.length;
            return bytes.length;
        }
        if (!host.call)
        {
            return 0;
        }
        // A buffer and a count slot the guest's Write can reach.
        const block = host.heap.allocate(bytes.length + WORD);
        if (block === 0)
        {
            return 0;
        }
        host.writeMemory(block, bytes);
        writeU32(block + bytes.length, 0);
        const entry = readU32(readU32(pointer) + SLOT_STREAM_WRITE * WORD);
        return host.call(entry, [pointer, block, bytes.length, block + bytes.length], thread)
            .then(hr=>{
                const written = (hr | 0) < 0 ? 0 : readU32(block + bytes.length);
                host.heap.free(block);
                return written;
            });
    };

    /**
     * Reads from a stream the guest holds, the same two ways.
     *
     * @param {number} pointer
     * @param {number} length
     * @returns {Uint8Array | Promise<Uint8Array>} what was read, short at the end
     */
    const readFromStream = (pointer, length)=>{
        /** @type {StreamState | null} */
        const own = stateAt(pointer, CLSID_STREAM);
        if (own)
        {
            const available = Math.max(0, own.backing.size() - own.position);
            const bytes = own.backing.read(own.position, Math.min(length, available));
            own.position += bytes.length;
            return bytes;
        }
        if (!host.call)
        {
            return new Uint8Array(0);
        }
        const block = host.heap.allocate(length + WORD);
        if (block === 0)
        {
            return new Uint8Array(0);
        }
        writeU32(block + length, 0);
        const entry = readU32(readU32(pointer) + SLOT_STREAM_READ * WORD);
        return host.call(entry, [pointer, block, length, block + length]).then(hr=>{
            const read = (hr | 0) < 0 ? 0 : Math.min(length, readU32(block + length));
            const bytes = host.readMemory(block, read).slice();
            host.heap.free(block);
            return bytes;
        });
    };

    /**
     * The mode an element is opened with, checked against the storage it is
     * in: an element cannot be more writable than its parent, and a docfile
     * element has to be opened exclusively.
     *
     * @param {StorageState} parent @param {number} mode
     * @returns {number} S_OK or the refusal
     */
    const checkElementMode = (parent, mode)=>{
        if ((mode & STGM_SHARE_MASK) !== STGM_SHARE_EXCLUSIVE)
        {
            return STG_E_INVALIDFLAG;
        }
        if (writable(mode) && !writable(parent.mode))
        {
            return STG_E_ACCESSDENIED;
        }
        return S_OK;
    };

    /** @returns {import('./objects.js').ComMethod[]} */
    const storageMethods = ()=>[
        { name: 'CreateStream', argBytes: 24, invoke: (object, [pwcsName, grfMode, r1, r2, out_])=>{
            /** @type {StorageState} */
            const state = object.state;
            const out = out_ >>> 0;
            if (out === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            writeU32(out, 0);
            // The two reserved words.
            if (r1 !== 0 || r2 !== 0)
            {
                return STG_E_INVALIDPARAMETER;
            }
            const name = elementName(pwcsName >>> 0);
            if (name === null)
            {
                return STG_E_INVALIDNAME;
            }
            const mode = grfMode >>> 0;
            const refused = checkElementMode(state, mode);
            if (refused !== S_OK)
            {
                return refused;
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            const existing = state.entry.children.get(nameKey(name));
            if (existing && ((mode & STGM_CREATE) === 0 || existing.kind !== 'stream'))
            {
                return STG_E_FILEALREADYEXISTS;
            }
            const entry = createEntry(name, 'stream');
            state.entry.children.set(nameKey(name), entry);
            return publishStream({
                backing: entryBacking(entry), mode, position: 0, document: state.document,
            }, out);
        } },
        { name: 'OpenStream', argBytes: 24, invoke: (object, [pwcsName, , grfMode, , ppstm])=>{
            /** @type {StorageState} */
            const state = object.state;
            const out = ppstm >>> 0;
            if (out === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            writeU32(out, 0);
            const name = elementName(pwcsName >>> 0);
            if (name === null)
            {
                return STG_E_INVALIDNAME;
            }
            const mode = grfMode >>> 0;
            const refused = checkElementMode(state, mode);
            if (refused !== S_OK)
            {
                return refused;
            }
            const entry = state.entry.children.get(nameKey(name));
            if (!entry || entry.kind !== 'stream')
            {
                return STG_E_FILENOTFOUND;
            }
            return publishStream({
                backing: entryBacking(entry), mode, position: 0, document: state.document,
            }, out);
        } },
        { name: 'CreateStorage', argBytes: 24, invoke: (object, [pwcsName, grfMode, , , ppstg])=>{
            /** @type {StorageState} */
            const state = object.state;
            const out = ppstg >>> 0;
            if (out === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            writeU32(out, 0);
            const name = elementName(pwcsName >>> 0);
            if (name === null)
            {
                return STG_E_INVALIDNAME;
            }
            const mode = grfMode >>> 0;
            const refused = checkElementMode(state, mode);
            if (refused !== S_OK)
            {
                return refused;
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            const existing = state.entry.children.get(nameKey(name));
            if (existing && ((mode & STGM_CREATE) === 0 || existing.kind !== 'storage'))
            {
                return STG_E_FILEALREADYEXISTS;
            }
            const entry = createEntry(name, 'storage');
            state.entry.children.set(nameKey(name), entry);
            return publishStorage({ document: state.document, entry, mode, name }, out);
        } },
        { name: 'OpenStorage', argBytes: 28,
            invoke: (object, [pwcsName, , grfMode, , , ppstg])=>{
                /** @type {StorageState} */
                const state = object.state;
                const out = ppstg >>> 0;
                if (out === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out, 0);
                const name = elementName(pwcsName >>> 0);
                if (name === null)
                {
                    return STG_E_INVALIDNAME;
                }
                const mode = grfMode >>> 0;
                const refused = checkElementMode(state, mode);
                if (refused !== S_OK)
                {
                    return refused;
                }
                const entry = state.entry.children.get(nameKey(name));
                if (!entry || entry.kind !== 'storage')
                {
                    return STG_E_FILENOTFOUND;
                }
                return publishStorage({ document: state.document, entry, mode, name }, out);
            } },
        { name: 'CopyTo', argBytes: 20, invoke: (object, [ciidExclude, , snbExclude, pstgDest])=>{
            /** @type {StorageState} */
            const state = object.state;
            /** @type {StorageState | null} */
            const target = stateAt(pstgDest >>> 0, CLSID_STORAGE);
            if (!target)
            {
                diverge('IStorage::CopyTo',
                    'the destination is not a storage this build made, and copying into '
                    + 'a storage a program implemented is not done');
                return STG_E_INVALIDPOINTER;
            }
            if (!writable(target.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            if ((ciidExclude >>> 0) !== 0 || (snbExclude >>> 0) !== 0)
            {
                diverge('IStorage::CopyTo', 'exclusions were asked for and everything was copied');
            }
            target.entry.clsid = state.entry.clsid;
            target.entry.stateBits = state.entry.stateBits;
            for (const child of state.entry.children.values())
            {
                target.entry.children.set(nameKey(child.name), cloneEntry(child, child.name));
            }
            return S_OK;
        } },
        { name: 'MoveElementTo', argBytes: 20,
            invoke: (object, [pwcsName, pstgDest, pwcsNewName, grfFlags])=>{
                /** @type {StorageState} */
                const state = object.state;
                const name = elementName(pwcsName >>> 0);
                const newName = elementName(pwcsNewName >>> 0);
                if (name === null || newName === null)
                {
                    return STG_E_INVALIDNAME;
                }
                /** @type {StorageState | null} */
                const target = stateAt(pstgDest >>> 0, CLSID_STORAGE);
                if (!target)
                {
                    diverge('IStorage::MoveElementTo',
                        'the destination is not a storage this build made');
                    return STG_E_INVALIDPOINTER;
                }
                const moving = (grfFlags >>> 0) !== STGMOVE_COPY;
                if (!writable(target.mode) || (moving && !writable(state.mode)))
                {
                    return STG_E_ACCESSDENIED;
                }
                const entry = state.entry.children.get(nameKey(name));
                if (!entry)
                {
                    return STG_E_FILENOTFOUND;
                }
                if (target.entry.children.has(nameKey(newName)))
                {
                    return STG_E_FILEALREADYEXISTS;
                }
                target.entry.children.set(nameKey(newName), cloneEntry(entry, newName));
                if (moving)
                {
                    state.entry.children.delete(nameKey(name));
                }
                return S_OK;
            } },
        { name: 'Commit', argBytes: 8, invoke: object=>{
            /** @type {StorageState} */
            const state = object.state;
            if (state.entry === state.document.root)
            {
                flush(state.document);
            }
            return S_OK;
        } },
        { name: 'Revert', argBytes: 4, invoke: ()=>S_OK },
        { name: 'EnumElements', argBytes: 20, invoke: (object, [, , , ppenum])=>{
            /** @type {StorageState} */
            const state = object.state;
            const out = ppenum >>> 0;
            if (out === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            writeU32(out, 0);
            return publishEnumerator([...state.entry.children.values()], out);
        } },
        { name: 'DestroyElement', argBytes: 8, invoke: (object, [pwcsName])=>{
            /** @type {StorageState} */
            const state = object.state;
            const name = elementName(pwcsName >>> 0);
            if (name === null)
            {
                return STG_E_INVALIDNAME;
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            return state.entry.children.delete(nameKey(name)) ? S_OK : STG_E_FILENOTFOUND;
        } },
        { name: 'RenameElement', argBytes: 12, invoke: (object, [pwcsOldName, pwcsNewName])=>{
            /** @type {StorageState} */
            const state = object.state;
            const oldName = elementName(pwcsOldName >>> 0);
            const newName = elementName(pwcsNewName >>> 0);
            if (oldName === null || newName === null)
            {
                return STG_E_INVALIDNAME;
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            const entry = state.entry.children.get(nameKey(oldName));
            if (!entry)
            {
                return STG_E_FILENOTFOUND;
            }
            if (state.entry.children.has(nameKey(newName)))
            {
                return STG_E_FILEALREADYEXISTS;
            }
            state.entry.children.delete(nameKey(oldName));
            entry.name = newName;
            state.entry.children.set(nameKey(newName), entry);
            return S_OK;
        } },
        { name: 'SetElementTimes', argBytes: 20,
            invoke: (object, [pwcsName, pctime, , pmtime])=>{
                /** @type {StorageState} */
                const state = object.state;
                if (!writable(state.mode))
                {
                    return STG_E_ACCESSDENIED;
                }
                // A NULL name means this storage itself.
                let entry = state.entry;
                if ((pwcsName >>> 0) !== 0)
                {
                    const name = elementName(pwcsName >>> 0);
                    const found = name === null
                        ? undefined
                        : state.entry.children.get(nameKey(name));
                    if (!found)
                    {
                        return name === null ? STG_E_INVALIDNAME : STG_E_FILENOTFOUND;
                    }
                    entry = found;
                }
                if ((pctime >>> 0) !== 0)
                {
                    entry.created = readU64(pctime >>> 0);
                }
                if ((pmtime >>> 0) !== 0)
                {
                    entry.modified = readU64(pmtime >>> 0);
                }
                return S_OK;
            } },
        { name: 'SetClass', argBytes: 8, invoke: (object, [clsid])=>{
            /** @type {StorageState} */
            const state = object.state;
            if ((clsid >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            state.entry.clsid = readGuid(host, clsid >>> 0);
            return S_OK;
        } },
        { name: 'SetStateBits', argBytes: 12, invoke: (object, [bits, mask])=>{
            /** @type {StorageState} */
            const state = object.state;
            if (!writable(state.mode))
            {
                return STG_E_ACCESSDENIED;
            }
            state.entry.stateBits = (((bits & mask) | (state.entry.stateBits & ~mask)) >>> 0);
            return S_OK;
        } },
        { name: 'Stat', argBytes: 12, invoke: (object, [pstatstg, flags])=>{
            /** @type {StorageState} */
            const state = object.state;
            if ((pstatstg >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            return writeStat(pstatstg >>> 0, {
                // The mode as opened: STGM_CREATE was how, not what it is now.
                name: state.name, type: STGTY_STORAGE, size: 0, mode: state.mode & ~STGM_CREATE,
                entry: state.entry,
            }, flags >>> 0);
        } },
    ];

    /**
     * @param {StorageState} state
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publishStorage = (state, out)=>{
        const detach = attach(state.document);
        return publish(CLSID_STORAGE, {
            state,
            interfaces: [{ id: IID_ISTORAGE, methods: storageMethods() }],
            destroy: detach,
        }, IID_ISTORAGE, out);
    };

    /**
     * IEnumSTATSTG over a snapshot of a storage's elements.
     *
     * @param {import('./cfb.js').CfbEntry[]} items
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publishEnumerator = (items, out)=>{
        const state = { items, index: 0 };
        /** @type {import('./objects.js').ComMethod[]} */
        const methods = [
            { name: 'Next', argBytes: 16, invoke: (object, [celt, rgelt, pceltFetched])=>{
                const wanted = celt >>> 0;
                if ((pceltFetched >>> 0) !== 0)
                {
                    writeU32(pceltFetched >>> 0, 0);
                }
                if ((rgelt >>> 0) === 0 || (wanted > 1 && (pceltFetched >>> 0) === 0))
                {
                    return STG_E_INVALIDPOINTER;
                }
                let fetched = 0;
                while (fetched < wanted && state.index < state.items.length)
                {
                    const entry = state.items[state.index++];
                    const hr = writeStat((rgelt >>> 0) + fetched * STATSTG.SIZE_OF, {
                        name: entry.name,
                        type: entry.kind === 'stream' ? STGTY_STREAM : STGTY_STORAGE,
                        size: entry.data.length, mode: 0, entry,
                    }, 0);
                    if (hr !== S_OK)
                    {
                        return hr;
                    }
                    fetched++;
                }
                if ((pceltFetched >>> 0) !== 0)
                {
                    writeU32(pceltFetched >>> 0, fetched);
                }
                return fetched === wanted ? S_OK : S_FALSE;
            } },
            { name: 'Skip', argBytes: 8, invoke: (object, [celt])=>{
                const left = state.items.length - state.index;
                state.index = Math.min(state.items.length, state.index + (celt >>> 0));
                return (celt >>> 0) <= left ? S_OK : S_FALSE;
            } },
            { name: 'Reset', argBytes: 4, invoke: ()=>{
                state.index = 0;
                return S_OK;
            } },
            { name: 'Clone', argBytes: 8, invoke: (object, [ppenum])=>{
                if ((ppenum >>> 0) === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                const hr = publishEnumerator(state.items, ppenum >>> 0);
                if (hr === S_OK)
                {
                    stateAt(readU32(ppenum >>> 0), CLSID_ENUM).index = state.index;
                }
                return hr;
            } },
        ];
        return publish(CLSID_ENUM, {
            state,
            interfaces: [{ id: IID_IENUMSTATSTG, methods }],
        }, IID_IENUMSTATSTG, out);
    };

    /**
     * The checks StgCreateDocfile and StgOpenStorage share: a docfile is
     * opened exclusively unless it is transacted, and transacted is the one
     * thing this build turns into something else.
     *
     * @param {string} api @param {number} mode
     * @returns {number} S_OK or the refusal
     */
    const checkDocfileMode = (api, mode)=>{
        const share = mode & STGM_SHARE_MASK;
        if ((mode & STGM_TRANSACTED) !== 0)
        {
            diverge(api, 'STGM_TRANSACTED was asked for and the docfile is opened in direct '
                + 'mode: writes go through as they are made, and Revert takes nothing back');
        }
        else if (share !== STGM_SHARE_EXCLUSIVE && share !== STGM_SHARE_DENY_WRITE)
        {
            return STG_E_INVALIDFLAG;
        }
        return S_OK;
    };

    /**
     * What creating a docfile takes beyond opening one, as ole32's storage
     * tests have Windows answer: a flag that is none, both access bits, a
     * priority open or no write access is no mode to create in, and one
     * that is not transacted must be exclusive.
     *
     * @param {string} api @param {number} mode
     * @returns {number} S_OK or the refusal
     */
    const checkCreateMode = (api, mode)=>{
        const access = mode & STGM_ACCESS_MASK;
        if ((mode & ~STGM_KNOWN) !== 0 || access === STGM_ACCESS_MASK || access === STGM_READ
            || (mode & STGM_PRIORITY) !== 0
            || ((mode & STGM_TRANSACTED) === 0
                && (mode & STGM_SHARE_MASK) !== STGM_SHARE_EXCLUSIVE))
        {
            return STG_E_INVALIDFLAG;
        }
        return checkDocfileMode(api, mode);
    };

    /**
     * Reads a file whole; null when it is not there. The bytes may still be
     * on their way, in which case the caller parks on them.
     *
     * @param {string} path
     * @returns {Uint8Array | Promise<Uint8Array> | null}
     */
    const fileBytes = path=>{
        const files = host.files;
        const entry = files?.stat(path);
        if (!files || !entry?.exists || entry.isDirectory)
        {
            return null;
        }
        const node = files.open(path, { read: true });
        if (!node)
        {
            return null;
        }
        const bytes = files.read(node, 0, entry.size);
        if (bytes instanceof Promise)
        {
            return bytes.finally(()=>files.close(node));
        }
        files.close(node);
        return bytes;
    };

    /**
     * A stream over a block of the process heap. The block is the program's
     * -- GlobalLock on the handle sees what the stream wrote -- so a write
     * past its end moves it the way GlobalReAlloc would, and
     * GetHGlobalFromStream hands back wherever it is now.
     *
     * @param {number} hGlobal  A block, or 0 for a new empty one.
     * @param {boolean} deleteOnRelease
     * @param {number} out
     * @returns {number} an HRESULT
     */
    const publishMemoryStream = (hGlobal, deleteOnRelease, out)=>{
        const backing = memoryBacking(hGlobal, deleteOnRelease);
        if (typeof backing === 'number')
        {
            return backing;
        }
        return publishStream(/** @type {StreamState} */ ({
            backing, mode: STGM_READWRITE | STGM_SHARE_EXCLUSIVE, position: 0,
            document: null,
        }), out);
    };

    /**
     * A byte array over a block of the process heap, which CreateStreamOnHGlobal
     * and CreateILockBytesOnHGlobal both stand on: every holder retains it,
     * and with `deleteOnRelease` the block goes with the last.
     *
     * @param {number} hGlobal  A block, or 0 for a new empty one.
     * @param {boolean} deleteOnRelease
     * @returns {StreamBacking | number} the backing, or an HRESULT
     */
    const memoryBacking = (hGlobal, deleteOnRelease)=>{
        let handle = hGlobal;
        if (handle === 0)
        {
            handle = host.heap.allocate(1);
            if (handle === 0)
            {
                return E_OUTOFMEMORY;
            }
        }
        const block = host.heap.block(handle);
        if (!block)
        {
            return E_INVALIDARG;
        }
        // A block handed in is used whole, which is the documented
        // starting size; one made here is empty.
        let size = hGlobal === 0 ? 0 : block.size;
        /** @param {number} wanted */
        const grow = wanted=>{
            if (wanted <= (host.heap.block(handle)?.size ?? 0))
            {
                return true;
            }
            if (host.heap.resize(handle, wanted))
            {
                return true;
            }
            const moved = host.heap.allocate(wanted);
            if (moved === 0)
            {
                return false;
            }
            host.writeMemory(moved, host.readMemory(handle, size).slice());
            host.heap.free(handle);
            handle = moved;
            return true;
        };
        // A block the program freed under the stream is one the stream no
        // longer has: it reads as empty and refuses to grow, as ole32's
        // hglobalstream tests free one and go on using the stream.
        const alive = ()=>host.heap.block(handle) !== null;
        /** @type {StreamBacking} */
        const backing = {
            name: null,
            entry: null,
            handle: ()=>handle,
            size: ()=>(alive() ? size : 0),
            read: (offset, length)=>host.readMemory(handle + offset, length).slice(),
            write: (offset, bytes)=>{
                if (!alive() || !grow(offset + bytes.length))
                {
                    return false;
                }
                if (offset > size)
                {
                    host.fillMemory(handle + size, 0, offset - size);
                }
                host.writeMemory(handle + offset, bytes);
                size = Math.max(size, offset + bytes.length);
                return true;
            },
            resize: wanted=>{
                if (!alive() || !grow(wanted))
                {
                    return false;
                }
                if (wanted > size)
                {
                    host.fillMemory(handle + size, 0, wanted - size);
                }
                size = wanted;
                return true;
            },
            // A clone shares the block, so it is freed with the last stream
            // over it rather than the first: ole32's hglobalstream tests
            // release the original and go on with the clone.
            retain: ()=>{
                holders++;
                return ()=>{
                    holders--;
                    if (holders === 0 && deleteOnRelease)
                    {
                        host.heap.free(handle);
                    }
                };
            },
        };
        let holders = 0;
        return backing;
    };

    /**
     * ILockBytes over a backing, after IUnknown: offsets are ULARGE_INTEGERs
     * passed by value, and the high half of one is past any block here.
     *
     * @returns {import('./objects.js').ComMethod[]}
     */
    const lockBytesMethods = ()=>[
        { name: 'ReadAt', argBytes: 24, invoke: (object, [low, high, pv, cb, pcbRead])=>{
            /** @type {StreamBacking} */
            const backing = object.state.backing;
            if ((pv >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const offset = (high >>> 0) === 0 ? low >>> 0 : Infinity;
            const bytes = offset >= backing.size() ? new Uint8Array(0)
                : backing.read(offset, Math.min(cb >>> 0, backing.size() - offset));
            if (bytes.length > 0)
            {
                host.writeMemory(pv >>> 0, bytes);
            }
            if ((pcbRead >>> 0) !== 0)
            {
                writeU32(pcbRead >>> 0, bytes.length);
            }
            return S_OK;
        } },
        { name: 'WriteAt', argBytes: 24, invoke: (object, [low, high, pv, cb, pcbWritten])=>{
            /** @type {StreamBacking} */
            const backing = object.state.backing;
            if ((pv >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const count = cb >>> 0;
            if ((high >>> 0) !== 0
                || (count > 0 && !backing.write(low >>> 0, host.readMemory(pv >>> 0, count))))
            {
                return STG_E_MEDIUMFULL;
            }
            if ((pcbWritten >>> 0) !== 0)
            {
                writeU32(pcbWritten >>> 0, count);
            }
            return S_OK;
        } },
        { name: 'Flush', argBytes: 4, invoke: ()=>S_OK },
        { name: 'SetSize', argBytes: 12, invoke: (object, [low, high])=>
            ((high >>> 0) === 0 && object.state.backing.resize(low >>> 0)
                ? S_OK : STG_E_MEDIUMFULL) },
        // A block of memory has no regions to lock, as Windows' says.
        { name: 'LockRegion', argBytes: 24, invoke: ()=>STG_E_INVALIDFUNCTION },
        { name: 'UnlockRegion', argBytes: 24, invoke: ()=>STG_E_INVALIDFUNCTION },
        { name: 'Stat', argBytes: 12, invoke: (object, [pstatstg, flags])=>{
            if ((pstatstg >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            return writeStat(pstatstg >>> 0, {
                name: null, type: STGTY_LOCKBYTES, size: object.state.backing.size(),
                mode: 0, entry: null,
            }, flags >>> 0);
        } },
    ];

    /**
     * The byte array of one of our ILockBytes, or null for one a program
     * implemented.
     *
     * @param {number} pointer
     * @returns {StreamBacking | null}
     */
    const lockBytesAt = pointer=>stateAt(pointer, CLSID_LOCKBYTES)?.backing ?? null;

    /**
     * A docfile in an ILockBytes' byte array: written there when committed
     * and when its last object goes, and holding the array until then, so
     * the program may release the ILockBytes first.
     *
     * @param {StreamBacking} lockBytes @param {import('./cfb.js').CfbEntry} root
     * @param {number} mode @param {number} out
     */
    const publishDocfileOn = (lockBytes, root, mode, out)=>{
        const release = lockBytes.retain?.();
        /** @type {Document} */
        const document = {
            root, path: null, lockBytes, deleteOnRelease: false, objects: 0,
            done: ()=>release?.(),
        };
        flush(document);
        return publishStorage({ document, entry: root, mode, name: null }, out);
    };

    let temporaries = 0;

    /**
     * @param {number} pointer  An interface the guest holds.
     * @param {number} slot     Its vtable index.
     */
    const methodAt = (pointer, slot)=>readU32(readU32(pointer) + slot * WORD);

    /**
     * @param {string} api @param {number} out
     * @returns {number} STG_E_INVALIDFUNCTION
     */
    const refuse = (api, out)=>{
        if (out !== 0)
        {
            writeU32(out, 0);
        }
        diverge(api, 'a docfile over an ILockBytes a program implemented is not done');
        return STG_E_INVALIDFUNCTION;
    };

    const table = {
        /**
         * HRESULT StgCreateDocfile(const OLECHAR *pwcsName, DWORD grfMode,
         *                          DWORD reserved, IStorage **ppstgOpen)
         *
         * A new docfile, written empty at once so the file is there the
         * moment the call returns, as it is on Windows. No name means a
         * temporary one that goes with the last release.
         */
        StgCreateDocfile: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([pwcsName, grfMode, reserved, ppstgOpen])=>{
                const out = ppstgOpen >>> 0;
                if (out === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out, 0);
                if (reserved !== 0)
                {
                    return STG_E_INVALIDPARAMETER;
                }
                let mode = grfMode >>> 0;
                if ((mode & STGM_CREATE) !== 0 && (mode & STGM_CONVERT) !== 0)
                {
                    return STG_E_INVALIDFLAG;
                }
                const refused = checkCreateMode('StgCreateDocfile', mode);
                if (refused !== S_OK)
                {
                    return refused;
                }
                let path = readWide(pwcsName >>> 0, MAX_PATH);
                if (path === null)
                {
                    path = `${TEMP_DIRECTORY}\\~DF${(++temporaries).toString(16)
                        .padStart(4, '0')}.TMP`;
                    mode |= STGM_DELETEONRELEASE;
                }
                if (!host.files)
                {
                    return STG_E_INVALIDFUNCTION;
                }
                const existing = host.files.stat(path);
                if (existing?.exists && (mode & (STGM_CREATE | STGM_CONVERT)) === 0)
                {
                    return STG_E_FILEALREADYEXISTS;
                }
                if ((mode & STGM_CONVERT) !== 0)
                {
                    diverge('StgCreateDocfile',
                        'STGM_CONVERT was asked for and the file is replaced rather than '
                        + 'kept as a CONTENTS stream');
                }
                /** @type {Document} */
                const document = {
                    root: createRoot(), path,
                    deleteOnRelease: (mode & STGM_DELETEONRELEASE) !== 0, objects: 0,
                };
                flush(document);
                if (!host.files.stat(path)?.exists)
                {
                    return STG_E_ACCESSDENIED;
                }
                return publishStorage({ document, entry: document.root, mode, name: path }, out);
            },
        },

        /**
         * HRESULT StgOpenStorage(const OLECHAR *pwcsName, IStorage *pstgPriority,
         *     DWORD grfMode, SNB snbExclude, DWORD reserved, IStorage **ppstgOpen)
         */
        StgOpenStorage: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([pwcsName, , grfMode, , , ppstgOpen])=>{
                const out = ppstgOpen >>> 0;
                if (out === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out, 0);
                const mode = grfMode >>> 0;
                if ((mode & STGM_CREATE) !== 0)
                {
                    return STG_E_INVALIDFLAG;
                }
                const refused = checkDocfileMode('StgOpenStorage', mode);
                if (refused !== S_OK)
                {
                    return refused;
                }
                const path = readWide(pwcsName >>> 0, MAX_PATH);
                if (path === null)
                {
                    return STG_E_INVALIDNAME;
                }
                const bytes = fileBytes(path);
                if (bytes === null)
                {
                    return STG_E_FILENOTFOUND;
                }
                /** @param {Uint8Array} loaded */
                const open = loaded=>{
                    const root = parseCompoundFile(loaded);
                    if (!root)
                    {
                        // The documented answer for "there is a file, and it
                        // is not a docfile".
                        return STG_E_FILEALREADYEXISTS;
                    }
                    /** @type {Document} */
                    const document = {
                        root, path, deleteOnRelease: (mode & STGM_DELETEONRELEASE) !== 0,
                        objects: 0,
                    };
                    return publishStorage({ document, entry: root, mode, name: path }, out);
                };
                return bytes instanceof Promise ? bytes.then(open) : open(bytes);
            },
        },

        /** HRESULT StgIsStorageFile(const OLECHAR *pwcsName) */
        StgIsStorageFile: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([pwcsName])=>{
                const path = readWide(pwcsName >>> 0, MAX_PATH);
                if (path === null)
                {
                    return STG_E_INVALIDNAME;
                }
                const bytes = fileBytes(path);
                if (bytes === null)
                {
                    return STG_E_FILENOTFOUND;
                }
                /** @param {Uint8Array} loaded */
                const answer = loaded=>(isCompoundFile(loaded) ? S_OK : S_FALSE);
                return bytes instanceof Promise ? bytes.then(answer) : answer(bytes);
            },
        },

        /**
         * HRESULT StgCreateDocfileOnILockBytes(ILockBytes *plkbyt, DWORD grfMode,
         *                                      DWORD reserved, IStorage **ppstgOpen)
         * HRESULT StgOpenStorageOnILockBytes(ILockBytes *plkbyt, IStorage *pstgPriority,
         *     DWORD grfMode, SNB snbExclude, DWORD reserved, IStorage **ppstgOpen)
         *
         * A docfile over a byte array a program implements. The array lives
         * on the program's side of the bridge, and reading it whole through
         * its vtable has not been needed by anything yet.
         */
        StgCreateDocfileOnILockBytes: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([plkbyt, grfMode, , out])=>{
                const lockBytes = lockBytesAt(plkbyt >>> 0);
                if (!lockBytes)
                {
                    return refuse('StgCreateDocfileOnILockBytes', out >>> 0);
                }
                if ((out >>> 0) === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out >>> 0, 0);
                const refused = checkCreateMode('StgCreateDocfileOnILockBytes', grfMode >>> 0);
                return refused !== S_OK ? refused
                    : publishDocfileOn(lockBytes, createRoot(), grfMode >>> 0, out >>> 0);
            },
        },
        StgOpenStorageOnILockBytes: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([plkbyt, , grfMode, , , out])=>{
                const lockBytes = lockBytesAt(plkbyt >>> 0);
                if (!lockBytes)
                {
                    return refuse('StgOpenStorageOnILockBytes', out >>> 0);
                }
                if ((out >>> 0) === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out >>> 0, 0);
                const refused = checkDocfileMode('StgOpenStorageOnILockBytes', grfMode >>> 0);
                if (refused !== S_OK)
                {
                    return refused;
                }
                const root = parseCompoundFile(lockBytes.read(0, lockBytes.size()));
                return root ? publishDocfileOn(lockBytes, root, grfMode >>> 0, out >>> 0)
                    : STG_E_FILEALREADYEXISTS;
            },
        },

        /** HRESULT StgIsStorageILockBytes(ILockBytes *plkbyt) */
        StgIsStorageILockBytes: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([plkbyt])=>{
                const lockBytes = lockBytesAt(plkbyt >>> 0);
                if (!lockBytes)
                {
                    diverge('StgIsStorageILockBytes',
                        'an ILockBytes a program implemented is not read');
                    return S_FALSE;
                }
                return isCompoundFile(lockBytes.read(0, lockBytes.size())) ? S_OK : S_FALSE;
            },
        },

        /**
         * HRESULT CreateILockBytesOnHGlobal(HGLOBAL hGlobal, BOOL fDeleteOnRelease,
         *                                   ILockBytes **pplkbyt)
         *
         * A byte array over a block of the process heap, as a memory stream
         * is: the program's block, grown as written past, freed with the last
         * holder when asked.
         */
        CreateILockBytesOnHGlobal: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hGlobal, fDeleteOnRelease, pplkbyt])=>{
                const out = pplkbyt >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                const backing = memoryBacking(hGlobal >>> 0, (fDeleteOnRelease >>> 0) !== 0);
                if (typeof backing === 'number')
                {
                    return backing;
                }
                const release = backing.retain?.();
                return publish(CLSID_LOCKBYTES, {
                    state: { backing },
                    interfaces: [{ id: IID_ILOCKBYTES, methods: lockBytesMethods() }],
                    destroy: ()=>release?.(),
                }, IID_ILOCKBYTES, out);
            },
        },

        /** HRESULT GetHGlobalFromILockBytes(ILockBytes *plkbyt, HGLOBAL *phglobal) */
        GetHGlobalFromILockBytes: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([plkbyt, phglobal])=>{
                const lockBytes = lockBytesAt(plkbyt >>> 0);
                if ((phglobal >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(phglobal >>> 0, lockBytes?.handle?.() ?? 0);
                return lockBytes ? S_OK : E_INVALIDARG;
            },
        },

        /**
         * HRESULT CreateStreamOnHGlobal(HGLOBAL hGlobal, BOOL fDeleteOnRelease, LPSTREAM *ppstm)
         *
         * A stream over a block of the process heap. The block is the
         * program's -- GlobalLock on the handle sees what the stream wrote --
         * so a write past its end moves it the way GlobalReAlloc would, and
         * GetHGlobalFromStream hands back wherever it is now.
         */
        /** HRESULT CreateStreamOnHGlobal(HGLOBAL hGlobal, BOOL fDeleteOnRelease, LPSTREAM *ppstm) */
        CreateStreamOnHGlobal: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([hGlobal, fDeleteOnRelease, ppstm])=>{
                const out = ppstm >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                writeU32(out, 0);
                return publishMemoryStream(hGlobal >>> 0, (fDeleteOnRelease >>> 0) !== 0, out);
            },
        },

        /** HRESULT GetHGlobalFromStream(IStream *pstm, HGLOBAL *phglobal) */
        GetHGlobalFromStream: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pstm, phglobal])=>{
                const out = phglobal >>> 0;
                if (out === 0)
                {
                    return E_INVALIDARG;
                }
                /** @type {StreamState | null} */
                const state = stateAt(pstm >>> 0, CLSID_STREAM);
                if (!state?.backing.handle)
                {
                    writeU32(out, 0);
                    return E_INVALIDARG;
                }
                writeU32(out, state.backing.handle());
                return S_OK;
            },
        },

        /**
         * HRESULT WriteClassStm(IStream *pStm, REFCLSID rclsid)
         * HRESULT ReadClassStm(IStream *pStm, CLSID *pclsid)
         *
         * A CLSID at the stream's position, which is how an object's class
         * precedes its data in a stream OleSaveToStream wrote.
         */
        WriteClassStm: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pStm, rclsid])=>{
                if ((pStm >>> 0) === 0 || (rclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const written = writeToStream(pStm >>> 0, host.readMemory(rclsid >>> 0, GUID_SIZE));
                /** @param {number} count */
                const check = count=>(count === GUID_SIZE ? S_OK : STG_E_ACCESSDENIED);
                return typeof written === 'number' ? check(written) : written.then(check);
            },
        },
        ReadClassStm: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pStm, pclsid])=>{
                if ((pStm >>> 0) === 0 || (pclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = readFromStream(pStm >>> 0, GUID_SIZE);
                /** @param {Uint8Array} read */
                const store = read=>{
                    if (read.length !== GUID_SIZE)
                    {
                        return STG_E_READFAULT;
                    }
                    host.writeMemory(pclsid >>> 0, read);
                    return S_OK;
                };
                return bytes instanceof Promise ? bytes.then(store) : store(bytes);
            },
        },

        /**
         * HRESULT WriteClassStg(IStorage *pStg, REFCLSID rclsid)
         * HRESULT ReadClassStg(IStorage *pStg, CLSID *pclsid)
         *
         * The storage's class, which is SetClass and Stat under other names.
         */
        WriteClassStg: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pStg, rclsid])=>{
                /** @type {StorageState | null} */
                const state = stateAt(pStg >>> 0, CLSID_STORAGE);
                if (!state || (rclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                if (!writable(state.mode))
                {
                    return STG_E_ACCESSDENIED;
                }
                state.entry.clsid = readGuid(host, rclsid >>> 0);
                return S_OK;
            },
        },
        ReadClassStg: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pStg, pclsid])=>{
                /** @type {StorageState | null} */
                const state = stateAt(pStg >>> 0, CLSID_STORAGE);
                if (!state || (pclsid >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                writeGuid(host, pclsid >>> 0, state.entry.clsid);
                return S_OK;
            },
        },

        /**
         * HRESULT OleSaveToStream(IPersistStream *pPStm, IStream *pStm)
         *
         * The object's class, then whatever the object writes: GetClassID,
         * WriteClassStm, Save with fClearDirty. Both calls into the object go
         * back across the bridge, because the object is the program's.
         */
        OleSaveToStream: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([pPStm, pStm])=>{
                const object = pPStm >>> 0;
                const stream = pStm >>> 0;
                if (object === 0 || stream === 0)
                {
                    return E_INVALIDARG;
                }
                if (!host.call)
                {
                    return STG_E_INVALIDFUNCTION;
                }
                const slot = host.heap.allocate(GUID_SIZE);
                if (slot === 0)
                {
                    return E_OUTOFMEMORY;
                }
                const call = host.call;
                const thread = host.callerThread?.();
                return call(methodAt(object, SLOT_GETCLASSID), [object, slot], thread).then(hr=>{
                    if ((hr | 0) < 0)
                    {
                        host.heap.free(slot);
                        return hr | 0;
                    }
                    const written = writeToStream(stream, host.readMemory(slot, GUID_SIZE), thread);
                    host.heap.free(slot);
                    return Promise.resolve(written).then(count=>(count === GUID_SIZE
                        ? call(methodAt(object, SLOT_SAVE), [object, stream, 1], thread)
                        : STG_E_ACCESSDENIED));
                });
            },
        },

        /**
         * HRESULT OleLoadFromStream(IStream *pStm, REFIID iidInterface, void **ppvObj)
         *
         * ReadClassStm, then the class's object, then its Load. Only a class
         * this build registers can be made, and none of those persists
         * itself, so the honest answers are "not registered" for a program's
         * own class and "no such interface" for one of ours.
         */
        OleLoadFromStream: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([pStm, iidInterface, ppvObj])=>{
                const out = ppvObj >>> 0;
                if (out === 0)
                {
                    return E_POINTER;
                }
                writeU32(out, 0);
                if ((pStm >>> 0) === 0 || (iidInterface >>> 0) === 0)
                {
                    return E_INVALIDARG;
                }
                const bytes = readFromStream(pStm >>> 0, GUID_SIZE);
                /** @param {Uint8Array} read */
                const load = read=>{
                    if (read.length !== GUID_SIZE)
                    {
                        return STG_E_READFAULT;
                    }
                    const clsid = formatGuid(read);
                    if (!host.registry.isRegistered(clsid))
                    {
                        diverge('OleLoadFromStream',
                            `the stream names class ${clsid}, which nothing here can make`);
                        return REGDB_E_CLASSNOTREG;
                    }
                    const object = host.registry.create(clsid);
                    if (!object)
                    {
                        return E_OUTOFMEMORY;
                    }
                    if (!object.interfaceFor(IID_IPERSISTSTREAM))
                    {
                        object.release();
                        return E_NOINTERFACE;
                    }
                    object.release();
                    return STG_E_INVALIDPARAMETER;
                };
                return bytes instanceof Promise ? bytes.then(load) : load(bytes);
            },
        },

        /**
         * HRESULT StgCreateStorageEx(const WCHAR *pwcsName, DWORD grfMode, DWORD stgfmt,
         *     DWORD grfAttrs, STGOPTIONS *pStgOptions, PSECURITY_DESCRIPTOR,
         *     REFIID riid, void **ppObjectOpen)
         *
         * StgCreateDocfile's docfile, in its two formats' names, as an
         * IStorage. Asked for 4096-byte sectors it is written in 512 all the
         * same, which a program reading it back through ole32 cannot tell.
         */
        StgCreateStorageEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([pwcsName, grfMode, stgfmt, , options, , riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out >>> 0, 0);
                if ((stgfmt >>> 0) !== STGFMT_STORAGE && (stgfmt >>> 0) !== STGFMT_DOCFILE)
                {
                    diverge('StgCreateStorageEx', `format ${stgfmt >>> 0} is not made; `
                        + 'only a compound file is');
                    return STG_E_INVALIDPARAMETER;
                }
                if ((riid >>> 0) === 0 || readGuid(host, riid >>> 0) !== IID_ISTORAGE)
                {
                    return E_NOINTERFACE;
                }
                if ((options >>> 0) !== 0 && readU32((options >>> 0) + 4) > 512)
                {
                    diverge('StgCreateStorageEx', 'a larger sector is asked for and 512 is used');
                }
                return table.StgCreateDocfile.handler([pwcsName, grfMode, 0, out]);
            },
        },

        /**
         * HRESULT StgOpenStorageEx(const WCHAR *pwcsName, DWORD grfMode, DWORD stgfmt,
         *     DWORD grfAttrs, STGOPTIONS *pStgOptions, PSECURITY_DESCRIPTOR,
         *     REFIID riid, void **ppObjectOpen)
         *
         * StgOpenStorage's docfile as an IStorage, asked for as a compound
         * file or as whatever the file is -- and a file here is a compound
         * file or nothing a storage opens, so STGFMT_ANY is the same. A
         * property set kept in an NTFS stream, or a plain file as a storage,
         * is a format this layer does not have.
         */
        StgOpenStorageEx: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([pwcsName, grfMode, stgfmt, , , , riid, out])=>{
                if ((out >>> 0) === 0)
                {
                    return STG_E_INVALIDPOINTER;
                }
                writeU32(out >>> 0, 0);
                const format = stgfmt >>> 0;
                if (format !== STGFMT_STORAGE && format !== STGFMT_DOCFILE
                    && format !== STGFMT_ANY)
                {
                    diverge('StgOpenStorageEx', `format ${format} is not opened; `
                        + 'only a compound file is');
                    return STG_E_INVALIDPARAMETER;
                }
                if ((riid >>> 0) === 0 || readGuid(host, riid >>> 0) !== IID_ISTORAGE)
                {
                    return E_NOINTERFACE;
                }
                return table.StgOpenStorage.handler([pwcsName, 0, grfMode, 0, 0, out]);
            },
        },
    };
    return table;
}

/** The mode a docfile stream is asked for in tests and by callers here. */
export const STGM = Object.freeze({
    READ: STGM_READ, WRITE: STGM_WRITE, READWRITE: STGM_READWRITE,
    SHARE_EXCLUSIVE: STGM_SHARE_EXCLUSIVE, SHARE_DENY_WRITE: STGM_SHARE_DENY_WRITE,
    TRANSACTED: STGM_TRANSACTED, CREATE: STGM_CREATE, DELETEONRELEASE: STGM_DELETEONRELEASE,
});

export { GUID_NULL };
