/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * shlwapi's own IStream: SHCreateStreamOnFile's over a file, and
 * SHCreateMemStream's over a block of memory. Both are one object over a
 * backing -- what it reads and writes, how long it is -- so the two answer
 * every method alike but where their bytes live.
 *
 * A file stream's backing is kernel32's file handle, called as a program
 * would call it: the sharing a mode asks for, the error a path gets and the
 * bytes another handle sees are kernel32's, not a second implementation of
 * them here. The answers that are the stream's own -- S_FALSE for a short
 * read, STG_E_ACCESSDENIED for a write to a stream opened to read,
 * E_NOTIMPL for Revert and Clone, a region locked once and unlocked once --
 * are what Wine's shlwapi:istream records Windows answering.
 */

import { IUNKNOWN_METHODS } from '../ole32/objects.js';
import { createAdapter } from '../oleaut32/objects.js';
import { dword, u32 } from './text.js';

export const IID_ISTREAM = '{0000000C-0000-0000-C000-000000000046}';
export const IID_ISEQUENTIAL_STREAM = '{0C733A30-2A1C-11CE-ADE5-00AA0044773D}';

const S_OK = 0;
const S_FALSE = 1;
const E_NOTIMPL = 0x80004001 | 0;
const E_INVALIDARG = 0x80070057 | 0;
const E_OUTOFMEMORY = 0x8007000e | 0;
const STG_E_ACCESSDENIED = 0x80030005 | 0;
const STG_E_INVALIDPOINTER = 0x80030009 | 0;
const STG_E_LOCKVIOLATION = 0x80030021 | 0;
const STG_E_INVALIDFUNCTION = 0x80030001 | 0;

const ERROR_PATH_NOT_FOUND = 3;

const STGM_ACCESS = 0x3;
const STGM_READ = 0x0;
const STGM_SHARE_EXCLUSIVE = 0x10;
const STGM_SHARE_DENY_WRITE = 0x20;
const STGM_SHARE_DENY_READ = 0x30;
const STGM_SHARE_MASK = 0x70;
const STGM_CREATE = 0x1000;
const STGM_TRANSACTED = 0x10000;
const STGM_CONVERT = 0x20000;
const STGM_DELETEONRELEASE = 0x4000000;

const STATFLAG_NONAME = 1;
const STGTY_STREAM = 2;
const STATSTG_SIZE = 72;

const GENERIC_READ = 0x80000000;
const GENERIC_WRITE = 0x40000000;
const FILE_SHARE_READ = 0x1;
const FILE_SHARE_WRITE = 0x2;
const CREATE_NEW = 1;
const CREATE_ALWAYS = 2;
const OPEN_EXISTING = 3;
const FILE_ATTRIBUTE_NORMAL = 0x80;
const INVALID_HANDLE_VALUE = 0xffffffff;
const FILE_BEGIN = 0;

/** The most CopyTo moves through its buffer at a time. */
const COPY_CHUNK = 0x10000;

/**
 * Where a stream's bytes are. Each may answer at once or later.
 *
 * @typedef {Object} StreamBacking
 * @property {(offset: number, length: number) => Promise<Uint8Array> | Uint8Array} read
 * @property {(offset: number, bytes: Uint8Array) => Promise<boolean> | boolean} write
 * @property {() => Promise<number> | number} size
 * @property {(size: number) => Promise<boolean> | boolean} resize
 * @property {() => Promise<void> | void} close
 * @property {string | null} name  What Stat names it, none for memory.
 * @property {boolean} [narrow]
 *           Its position is 32 bits and wraps: SHCreateMemStream's, which a
 *           seek by -sizeof(buffer) -- 0xfffffff6 widened unsigned on i386 --
 *           takes back ten bytes (Wine's test_SHCreateMemStream).
 *
 * @typedef {Object} StreamState
 * @property {StreamBacking} backing
 * @property {number} mode
 * @property {number} position
 * @property {{ offset: number, length: number }[]} locks
 *
 * @typedef {Object} StreamHost
 * @property {(address: number, length: number) => Uint8Array} [readMemory]
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, maxLength: number) => string} readCString
 * @property {(address: number, maxLength: number) => string} [readWideString]
 * @property {(library: string) => Record<string, { handler: (args: number[]) => any }>
 *     | undefined} [library]
 * @property {(object: any, iid: string) => number} [publish]
 * @property {(bytes: number) => number} [allocate]
 * @property {(address: number) => void} [free]
 * @property {(api: string, detail: string) => void} [divergence]
 */

/** @param {number} low @param {number} high */
const quad = (low, high)=>(high | 0) * 0x100000000 + (low >>> 0);
/** @param {number} value */
const quadBytes = value=>{
    const bytes = new Uint8Array(8);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, value >>> 0, true);
    view.setUint32(4, Math.floor(value / 0x100000000) >>> 0, true);
    return bytes;
};

/**
 * The flags of SHCreateStreamOnFile as CreateFile's: a stream to write can
 * read too, a share mode denies what it names, STGM_CREATE replaces the file
 * and the rest opens one that is there -- or, through the Ex form's fCreate,
 * makes one that is not.
 *
 * @param {number} mode @param {boolean} create
 */
export function createFileArguments(mode, create){
    const access = (mode & STGM_ACCESS) === STGM_READ ? GENERIC_READ
        : (GENERIC_READ | GENERIC_WRITE) >>> 0;
    const share = mode & STGM_SHARE_MASK;
    const sharing = share === STGM_SHARE_EXCLUSIVE ? 0
        : share === STGM_SHARE_DENY_READ ? FILE_SHARE_WRITE
            : share === STGM_SHARE_DENY_WRITE ? FILE_SHARE_READ
                : FILE_SHARE_READ | FILE_SHARE_WRITE;
    const disposition = (mode & STGM_CREATE) !== 0 ? CREATE_ALWAYS
        : create ? CREATE_NEW : OPEN_EXISTING;
    return { access, sharing, disposition };
}

/**
 * @param {StreamHost} host
 */
export function createStreams(host){
    /** @param {number} address */
    const readU32 = address=>u32(host.readMemory?.(address >>> 0, 4) ?? new Uint8Array(4));
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, dword(value));
        }
    };
    /** @param {number} address @param {number} value */
    const writeQuad = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            host.writeMemory(address >>> 0, quadBytes(value));
        }
    };
    /**
     * @param {string} library @param {string} name @param {number[]} args
     * @returns {Promise<number>}
     */
    const call = async(library, name, args)=>{
        const target = host.library?.(library)?.[name];
        if (!target)
        {
            throw new Error(`shlwapi: ${library}!${name} is not there to build on`);
        }
        return /** @type {number} */ (await target.handler(args)) | 0;
    };
    /** @param {string} name @param {number[]} args */
    const kernel32 = (name, args)=>call('KERNEL32.dll', name, args);

    /**
     * A block of guest memory for the length of `body`.
     *
     * @template T
     * @param {number} size @param {(address: number) => Promise<T>} body
     */
    const scratch = async(size, body)=>{
        const at = host.allocate?.(Math.max(size, 8)) ?? 0;
        if (!at)
        {
            throw new Error('shlwapi: no memory for a stream\'s scratch');
        }
        try
        {
            return await body(at);
        }
        finally
        {
            host.free?.(at);
        }
    };

    /**
     * kernel32's file handle as a backing; the handle is closed with the
     * stream.
     *
     * @param {number} handle @param {string} name
     * @returns {StreamBacking}
     */
    const fileBacking = (handle, name)=>{
        /** @param {number} offset */
        const seek = offset=>scratch(4, async high=>{
            host.writeMemory(high, dword(Math.floor(offset / 0x100000000)));
            await kernel32('SetFilePointer', [handle, offset >>> 0, high, FILE_BEGIN]);
        });
        return {
            name,
            read: async(offset, length)=>{
                if (length === 0)
                {
                    return new Uint8Array(0);
                }
                await seek(offset);
                return scratch(length + 4, async at=>{
                    if (!await kernel32('ReadFile', [handle, at + 4, length, at, 0]))
                    {
                        return new Uint8Array(0);
                    }
                    const count = readU32(at);
                    return host.readMemory?.(at + 4, count).slice() ?? new Uint8Array(0);
                });
            },
            write: async(offset, bytes)=>{
                await seek(offset);
                return scratch(bytes.length + 4, async at=>{
                    host.writeMemory(at + 4, bytes);
                    const done = await kernel32('WriteFile', [handle, at + 4, bytes.length, at, 0]);
                    return done !== 0
                        && readU32(at) === bytes.length;
                });
            },
            size: ()=>scratch(4, async high=>{
                const low = (await kernel32('GetFileSize', [handle, high])) >>> 0;
                return quad(low, readU32(high));
            }),
            resize: async size=>{
                await seek(size);
                return (await kernel32('SetEndOfFile', [handle])) !== 0;
            },
            close: async()=>{
                await kernel32('CloseHandle', [handle]);
            },
        };
    };

    /**
     * Bytes the stream owns, as SHCreateMemStream's copy of what it was
     * given.
     *
     * @param {Uint8Array} initial
     * @returns {StreamBacking}
     */
    const memoryBacking = initial=>{
        let bytes = initial.slice();
        let length = bytes.length;
        /** @param {number} size */
        const room = size=>{
            if (size > bytes.length)
            {
                const grown = new Uint8Array(Math.max(size, bytes.length * 2, 64));
                grown.set(bytes.subarray(0, length));
                bytes = grown;
            }
        };
        return {
            name: null,
            narrow: true,
            read: (offset, count)=>bytes.slice(Math.min(offset, length),
                Math.min(offset + count, length)),
            write: (offset, data)=>{
                room(offset + data.length);
                bytes.set(data, offset);
                length = Math.max(length, offset + data.length);
                return true;
            },
            size: ()=>length,
            resize: size=>{
                room(size);
                bytes.fill(0, Math.min(size, length), Math.max(size, length));
                length = size;
                return true;
            },
            close: ()=>{},
        };
    };

    /**
     * A method's state, typed.
     *
     * @param {any} object
     * @returns {StreamState}
     */
    const stateOf = object=>object.state;

    /**
     * The streams of ours a program holds, by the pointer it was handed:
     * CopyTo writes into one of them directly.
     *
     * @type {Map<number, StreamState>}
     */
    const published = new Map();

    /** @type {readonly { name: string, argBytes: number, builtin?: string,
     *     invoke?: (object: any, args: number[]) => number | Promise<number> }[]} */
    const methods = Object.freeze([
        ...IUNKNOWN_METHODS,
        /** HRESULT Read(void *pv, ULONG cb, ULONG *pcbRead): S_FALSE when short. */
        { name: 'Read', argBytes: 16, invoke: async(object, [buffer, wanted, countOut])=>{
            const state = stateOf(object);
            writeU32(countOut, 0);
            if ((buffer >>> 0) === 0 && (wanted >>> 0) !== 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const bytes = await state.backing.read(state.position, wanted >>> 0);
            if (bytes.length > 0)
            {
                host.writeMemory(buffer >>> 0, bytes);
            }
            state.position += bytes.length;
            writeU32(countOut, bytes.length);
            return bytes.length < (wanted >>> 0) ? S_FALSE : S_OK;
        } },
        /**
         * HRESULT Write(const void *pv, ULONG cb, ULONG *pcbWritten)
         *
         * A stream opened to read refuses with the count untouched.
         */
        { name: 'Write', argBytes: 16, invoke: async(object, [buffer, count, countOut])=>{
            const state = stateOf(object);
            if ((state.mode & STGM_ACCESS) === STGM_READ)
            {
                return STG_E_ACCESSDENIED;
            }
            if ((count >>> 0) === 0)
            {
                writeU32(countOut, 0);
                return S_OK;
            }
            if ((buffer >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const bytes = host.readMemory?.(buffer >>> 0, count >>> 0).slice() ?? new Uint8Array(0);
            if (!await state.backing.write(state.position, bytes))
            {
                return STG_E_ACCESSDENIED;
            }
            state.position += bytes.length;
            writeU32(countOut, bytes.length);
            return S_OK;
        } },
        /** HRESULT Seek(LARGE_INTEGER dlibMove, DWORD dwOrigin, ULARGE_INTEGER *plibNewPosition) */
        { name: 'Seek', argBytes: 20, invoke: async(object, [low, high, origin, positionOut])=>{
            const state = stateOf(object);
            if ((origin >>> 0) > 2)
            {
                return E_INVALIDARG;
            }
            const base = origin === 0 ? 0 : origin === 1 ? state.position
                : await state.backing.size();
            const next = state.backing.narrow ? (base + (low >>> 0)) % 0x100000000
                : base + quad(low, high);
            if (next < 0)
            {
                return STG_E_INVALIDFUNCTION;
            }
            state.position = next;
            writeQuad(positionOut, next);
            return S_OK;
        } },
        /** HRESULT SetSize(ULARGE_INTEGER libNewSize) */
        { name: 'SetSize', argBytes: 12, invoke: async(object, [low, high])=>{
            const state = stateOf(object);
            if ((state.mode & STGM_ACCESS) === STGM_READ)
            {
                return STG_E_ACCESSDENIED;
            }
            return await state.backing.resize(quad(low, high >>> 0)) ? S_OK : STG_E_ACCESSDENIED;
        } },
        /**
         * HRESULT CopyTo(IStream *pstm, ULARGE_INTEGER cb, ULARGE_INTEGER *pcbRead,
         *                ULARGE_INTEGER *pcbWritten)
         *
         * As many bytes as there are, up to cb; no destination, or nothing
         * to copy, copies nothing and succeeds (Wine's
         * test_IStream_invalid_operations).
         */
        { name: 'CopyTo', argBytes: 24, invoke: async(object, words)=>{
            const [destination, low, high, readOut, writtenOut] = words;
            const state = stateOf(object);
            let left = quad(low, high >>> 0);
            let read = 0;
            let written = 0;
            let status = S_OK;
            const target = published.get(destination >>> 0);
            if ((destination >>> 0) === 0)
            {
                left = 0;
            }
            while (left > 0)
            {
                const bytes = await state.backing.read(state.position,
                    Math.min(left, COPY_CHUNK));
                if (bytes.length === 0)
                {
                    break;
                }
                state.position += bytes.length;
                read += bytes.length;
                left -= bytes.length;
                if (!target)
                {
                    host.divergence?.('IStream::CopyTo', 'a destination stream of the '
                        + 'program\'s own is not written: E_NOTIMPL');
                    status = E_NOTIMPL;
                    break;
                }
                if ((target.mode & STGM_ACCESS) === STGM_READ
                    || !await target.backing.write(target.position, bytes))
                {
                    status = STG_E_ACCESSDENIED;
                    break;
                }
                target.position += bytes.length;
                written += bytes.length;
            }
            writeQuad(readOut, read);
            writeQuad(writtenOut, written);
            return status;
        } },
        /** HRESULT Commit(DWORD grfCommitFlags): the bytes are the file's already. */
        { name: 'Commit', argBytes: 8, invoke: ()=>S_OK },
        /** HRESULT Revert(void) */
        { name: 'Revert', argBytes: 4, invoke: ()=>E_NOTIMPL },
        /**
         * HRESULT LockRegion(ULARGE_INTEGER libOffset, ULARGE_INTEGER cb, DWORD dwLockType)
         *
         * Kept as a record the unlock is checked against: one unlock for
         * each lock, the next one STG_E_LOCKVIOLATION.
         */
        { name: 'LockRegion', argBytes: 24, invoke: (object, words)=>{
            const [offsetLow, offsetHigh, lengthLow, lengthHigh] = words;
            stateOf(object).locks.push({ offset: quad(offsetLow, offsetHigh >>> 0),
                length: quad(lengthLow, lengthHigh >>> 0) });
            return S_OK;
        } },
        { name: 'UnlockRegion', argBytes: 24, invoke: (object, words)=>{
            const [offsetLow, offsetHigh, lengthLow, lengthHigh] = words;
            const { locks } = stateOf(object);
            const offset = quad(offsetLow, offsetHigh >>> 0);
            const length = quad(lengthLow, lengthHigh >>> 0);
            const at = locks.findIndex(lock=>lock.offset === offset && lock.length === length);
            if (at < 0)
            {
                return STG_E_LOCKVIOLATION;
            }
            locks.splice(at, 1);
            return S_OK;
        } },
        /**
         * HRESULT Stat(STATSTG *pstatstg, DWORD grfStatFlag)
         *
         * The name in task memory the caller frees, unless it asks for none.
         */
        { name: 'Stat', argBytes: 12, invoke: async(object, [out, flags])=>{
            const state = stateOf(object);
            if ((out >>> 0) === 0)
            {
                return STG_E_INVALIDPOINTER;
            }
            const record = new Uint8Array(STATSTG_SIZE);
            const view = new DataView(record.buffer);
            if ((flags & STATFLAG_NONAME) === 0 && state.backing.name !== null)
            {
                const name = state.backing.name;
                const allocate = host.library?.('ole32.dll')?.CoTaskMemAlloc;
                const at = allocate ? (/** @type {number} */ (await allocate.handler(
                    [(name.length + 1) * 2])) >>> 0) : 0;
                if (!at)
                {
                    return E_OUTOFMEMORY;
                }
                const text = new Uint8Array((name.length + 1) * 2);
                for (let i = 0; i < name.length; i++)
                {
                    text[i * 2] = name.charCodeAt(i) & 0xff;
                    text[i * 2 + 1] = name.charCodeAt(i) >>> 8;
                }
                host.writeMemory(at, text);
                view.setUint32(0, at, true);
            }
            view.setUint32(4, STGTY_STREAM, true);
            record.set(quadBytes(await state.backing.size()), 8);
            view.setUint32(40, state.mode >>> 0, true);
            host.writeMemory(out >>> 0, record);
            return S_OK;
        } },
        /** HRESULT Clone(IStream **ppstm): not made, the out pointer untouched. */
        { name: 'Clone', argBytes: 8, invoke: ()=>E_NOTIMPL },
    ]);
    const interfaces = Object.freeze({ [IID_ISTREAM]: methods, [IID_ISEQUENTIAL_STREAM]: methods });

    /**
     * A stream over a backing, as the pointer the program is handed; 0 when
     * none can be published.
     *
     * @param {StreamBacking} backing @param {number} mode
     */
    const publishStream = (backing, mode)=>{
        if (!host.publish)
        {
            return 0;
        }
        /** @type {StreamState} */
        const state = { backing, mode, position: 0, locks: [] };
        let pointer = 0;
        const adapter = createAdapter(state, interfaces, ()=>{
            published.delete(pointer);
            void backing.close();
        });
        pointer = host.publish(adapter, IID_ISTREAM) >>> 0;
        if (pointer)
        {
            published.set(pointer, state);
        }
        return pointer;
    };

    /**
     * SHCreateStreamOnFileEx's work for either spelling of the path.
     *
     * @param {'A' | 'W'} width @param {number} path @param {number} mode
     * @param {number} attributes @param {boolean} create @param {number} out
     */
    const openFile = async(width, path, mode, attributes, create, out)=>{
        if ((out >>> 0) === 0)
        {
            return E_INVALIDARG;
        }
        writeU32(out, 0);
        if ((path >>> 0) === 0)
        {
            return (0x80070000 | ERROR_PATH_NOT_FOUND) | 0;
        }
        if (!host.publish)
        {
            return E_NOTIMPL;
        }
        const { access, sharing, disposition } = createFileArguments(mode, create);
        const handle = (await kernel32(`CreateFile${width}`, [path, access, sharing, 0,
            disposition, attributes || FILE_ATTRIBUTE_NORMAL, 0])) >>> 0;
        if (handle === INVALID_HANDLE_VALUE || handle === 0)
        {
            const error = (await kernel32('GetLastError', [])) >>> 0;
            return error === 0 ? STG_E_ACCESSDENIED : ((error & 0xffff) | 0x80070000) | 0;
        }
        // Read to its terminator: the caller's buffer may end at the top of its stack.
        const name = (width === 'W' ? host.readWideString?.(path >>> 0, 0x8000)
            : host.readCString(path >>> 0, 0x8000)) ?? '';
        const stream = publishStream(fileBacking(handle, name), mode);
        if (!stream)
        {
            await kernel32('CloseHandle', [handle]);
            return E_OUTOFMEMORY;
        }
        writeU32(out, stream);
        return S_OK;
    };
    /**
     * SHCreateStreamOnFile for either spelling: a mode that asks for a
     * conversion, a transaction or a delete on release is refused, as the
     * short form does (Wine's test_SHCreateStreamOnFileA).
     *
     * @param {'A' | 'W'} width
     */
    const shCreateStreamOnFile = width=>({
        argBytes: 12,
        /** @param {number[]} args */
        handler: ([path, mode, out])=>{
            if (((mode >>> 0) & (STGM_CONVERT | STGM_DELETEONRELEASE | STGM_TRANSACTED)) !== 0)
            {
                writeU32(out, 0);
                return E_INVALIDARG;
            }
            return openFile(width, path, mode >>> 0, 0, false, out);
        },
    });

    return {
        /** HRESULT SHCreateStreamOnFileA(LPCSTR pszFile, DWORD grfMode, IStream **ppstm) */
        SHCreateStreamOnFileA: shCreateStreamOnFile('A'),
        SHCreateStreamOnFileW: shCreateStreamOnFile('W'),

        /**
         * HRESULT SHCreateStreamOnFileEx(LPCWSTR pszFile, DWORD grfMode, DWORD dwAttributes,
         *     BOOL fCreate, IStream *pstmTemplate, IStream **ppstm)
         *
         * A transacted stream to read is refused, as Vista on does.
         */
        SHCreateStreamOnFileEx: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([path, mode, attributes, create, , out])=>{
                if (((mode >>> 0) & STGM_TRANSACTED) !== 0 && (mode & STGM_ACCESS) === STGM_READ)
                {
                    writeU32(out, 0);
                    return E_INVALIDARG;
                }
                return openFile('W', path, mode >>> 0, attributes >>> 0, create !== 0, out);
            },
        },

        /**
         * IStream *SHCreateMemStream(const BYTE *pInit, UINT cbInit)
         *
         * A stream over a copy of the bytes, open to read and write.
         */
        SHCreateMemStream: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([initial, size])=>publishStream(memoryBacking((initial >>> 0) === 0
                ? new Uint8Array(0) : host.readMemory?.(initial >>> 0, size >>> 0)
                    ?? new Uint8Array(0)), 0x2),
        },
    };
}

