/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * netapi32's workstation information and the buffers it is handed in.
 *
 * NetWkstaGetInfo is how a program -- an installer's uninstaller, a runtime
 * checking the system -- learns the machine's name, its workgroup and the
 * version of Windows that really runs: the call answers the system's own
 * version, not the one a compatibility shim gives GetVersionEx. Its answer is
 * one buffer the call allocates, structure and strings together, which the
 * caller hands back with NetApiBufferFree.
 */

const NERR_SUCCESS = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BAD_NETPATH = 53;
const ERROR_INVALID_LEVEL = 124;
const ERROR_NOT_ENOUGH_MEMORY = 8;
/** PLATFORM_ID_NT. */
const PLATFORM_ID_NT = 500;
/** The workgroup a machine not joined to a domain is in, as LsaQueryInformationPolicy says. */
const WORKGROUP = 'WORKGROUP';

/**
 * @typedef {Object} WorkstationHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} allocate  guest memory, 0 when there is none
 * @property {(address: number) => void} release
 * @property {string} computerName
 * @property {{ major: number, minor: number }} version  the system's own
 */

/** @param {WorkstationHost} host */
export function createWorkstationFunctions(host){
    /** The buffers NetApiBufferAllocate and the Get calls handed out, by address, with their sizes. */
    const buffers = new Map();

    /** @param {number} bytes @returns {number} */
    const allocate = bytes=>{
        const at = host.allocate(Math.max(bytes, 1)) >>> 0;
        if (at !== 0)
        {
            buffers.set(at, bytes);
        }
        return at;
    };

    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>
        host.writeMemory(address >>> 0, new Uint8Array(new Uint32Array([value >>> 0]).buffer));

    /**
     * The name a server is given by, its leading backslashes taken off; empty
     * for none.
     *
     * @param {number} pointer
     */
    const serverName = pointer=>{
        if ((pointer >>> 0) === 0)
        {
            return '';
        }
        let text = '';
        for (let at = pointer >>> 0; text.length < 256; at += 2)
        {
            const [low, high] = host.readMemory(at, 2);
            const unit = low | high << 8;
            if (unit === 0)
            {
                break;
            }
            text += String.fromCharCode(unit);
        }
        return text.replace(/^\\\\/, '');
    };

    return {
        /** NET_API_STATUS NetApiBufferAllocate(DWORD ByteCount, LPVOID *Buffer) */
        NetApiBufferAllocate: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([bytes, out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const at = allocate(bytes >>> 0);
                writeU32(out, at);
                return at === 0 ? ERROR_NOT_ENOUGH_MEMORY : NERR_SUCCESS;
            },
        },

        /** NET_API_STATUS NetApiBufferFree(LPVOID Buffer): NULL is nothing to free. */
        NetApiBufferFree: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([buffer])=>{
                const at = buffer >>> 0;
                if (at !== 0 && buffers.delete(at))
                {
                    host.release(at);
                }
                return NERR_SUCCESS;
            },
        },

        /** NET_API_STATUS NetApiBufferSize(LPVOID Buffer, LPDWORD ByteCount) */
        NetApiBufferSize: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([buffer, out])=>{
                const size = buffers.get(buffer >>> 0);
                if (size === undefined || (out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeU32(out, size);
                return NERR_SUCCESS;
            },
        },

        /**
         * NET_API_STATUS NetWkstaGetInfo(LMSTR servername, DWORD level, LPBYTE *bufptr)
         *
         * Levels 100, 101 and 102 of this machine: WKSTA_INFO_100's platform,
         * name, workgroup and version, 101's LAN root (none) after them, 102's
         * count of users logged on (the one) after that; the strings follow the
         * structure in the same buffer. Another machine is not on any network
         * here. Level 502 asks for an administrator's view and is refused.
         */
        NetWkstaGetInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([server, level, out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const name = serverName(server);
                if (name !== '' && name.toUpperCase() !== host.computerName.toUpperCase())
                {
                    return ERROR_BAD_NETPATH;
                }
                const fields = level === 100 ? 5 : level === 101 ? 6 : level === 102 ? 7 : 0;
                if (fields === 0)
                {
                    return ERROR_INVALID_LEVEL;
                }
                const strings = [host.computerName, WORKGROUP, ...level >= 101 ? [''] : []];
                const head = fields * 4;
                const size = head + strings.reduce((sum, text)=>sum + (text.length + 1) * 2, 0);
                const at = allocate(size);
                if (at === 0)
                {
                    writeU32(out, 0);
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                const bytes = new Uint8Array(size);
                const view = new DataView(bytes.buffer);
                let place = head;
                /** @type {number[]} */
                const pointers = strings.map(text=>{
                    const here = place;
                    for (let index = 0; index < text.length; index++)
                    {
                        view.setUint16(here + index * 2, text.charCodeAt(index), true);
                    }
                    place += (text.length + 1) * 2;
                    return at + here;
                });
                view.setUint32(0, PLATFORM_ID_NT, true);
                view.setUint32(4, pointers[0], true);
                view.setUint32(8, pointers[1], true);
                view.setUint32(12, host.version.major, true);
                view.setUint32(16, host.version.minor, true);
                if (level >= 101)
                {
                    view.setUint32(20, pointers[2], true);
                }
                if (level === 102)
                {
                    view.setUint32(24, 1, true);
                }
                host.writeMemory(at, bytes);
                writeU32(out, at);
                return NERR_SUCCESS;
            },
        },
    };
}
