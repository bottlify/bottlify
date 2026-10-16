/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IP Helper: what a program asks about the machine's network adapters. One
 * Ethernet adapter answers, the one network the transport gives this machine,
 * with a hardware address that stays the same from run to run -- a program may
 * make an identity of it. Without a network the adapter is there with no
 * address, as a card is with no cable.
 *
 * @typedef {Object} IphlpapiHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {() => number} [localAddress]  The machine's IPv4 address, the
 *           first octet in the high byte; the loopback when it has no network.
 */

const NO_ERROR = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BUFFER_OVERFLOW = 111;
const ERROR_INVALID_DATA = 13;
const ERROR_INSUFFICIENT_BUFFER = 122;

/** MIB_IFROW: a wide name, then DWORDs, the hardware address and the description. */
export const IFROW = Object.freeze({
    SIZE: 860, INDEX: 512, TYPE: 516, MTU: 520, SPEED: 524, PHYS_ADDR_LEN: 528,
    PHYS_ADDR: 532, ADMIN_STATUS: 540, OPER_STATUS: 544, DESCR_LEN: 600, DESCR: 604,
});
/** IP_INTERFACE_INFO: a count, then IP_ADAPTER_INDEX_MAPs of an index and 128 wide characters. */
const INTERFACE_INFO = Object.freeze({ COUNT: 0, INDEX: 4, NAME: 8, SIZE: 264 });

const MIB_IF_TYPE_LOOPBACK = 24;
const MIB_IF_ADMIN_STATUS_UP = 1;
const MIB_IF_OPER_STATUS_DISCONNECTED = 2;
const MIB_IF_OPER_STATUS_OPERATIONAL = 5;
/** The loopback interface's index, beside the adapter's. */
const LOOPBACK_INDEX = 2;
const MTU = 1500;
const ADAPTER_SPEED = 1000000000;
const LOOPBACK_SPEED = 10000000;

/**
 * IP_ADAPTER_INFO as 32-bit Windows writes it, its two time_t fields 32 bits
 * wide. IP_ADDR_STRING within it is Next, IpAddress[16], IpMask[16], Context.
 */
export const ADAPTER_INFO = Object.freeze({
    SIZE: 640,
    NEXT: 0,
    COMBO_INDEX: 4,
    ADAPTER_NAME: 8,
    DESCRIPTION: 268,
    ADDRESS_LENGTH: 400,
    ADDRESS: 404,
    INDEX: 412,
    TYPE: 416,
    DHCP_ENABLED: 420,
    CURRENT_IP_ADDRESS: 424,
    IP_ADDRESS_LIST: 428,
    GATEWAY_LIST: 468,
    DHCP_SERVER: 508,
    PRIMARY_WINS_SERVER: 552,
    SECONDARY_WINS_SERVER: 592,
});
const IP_ADDRESS = 4;
const IP_MASK = 20;

const MIB_IF_TYPE_ETHERNET = 6;
const INDEX = 1;
const NAME = '{6C1E5B3A-2F0D-4B8E-9A47-0B0771E5F001}';
const DESCRIPTION = 'Ethernet Adapter';
/** Locally administered, so it names no real card. */
export const HARDWARE_ADDRESS = Object.freeze([0x02, 0x00, 0x4c, 0x55, 0x00, 0x01]);

const LOOPBACK_NET = 127;
/** The adapter and the loopback interface. */
const INTERFACES = 2;

/** @param {number} address */
const dotted = address=>[24, 16, 8, 0].map(shift=>address >>> shift & 0xff).join('.');

/** @param {string} text */
const ascii = text=>Uint8Array.from(text, char=>char.charCodeAt(0) & 0x7f);

/** @param {IphlpapiHost} host */
export function createIphlpapiFunctions(host){
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = host.readMemory(address, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>host.writeMemory(address,
        Uint8Array.of(value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff));

    /** The one adapter's record, laid out at `at`. @param {number} at */
    const adapter = at=>{
        const record = new Uint8Array(ADAPTER_INFO.SIZE);
        const view = new DataView(record.buffer);
        record.set(ascii(NAME), ADAPTER_INFO.ADAPTER_NAME);
        record.set(ascii(DESCRIPTION), ADAPTER_INFO.DESCRIPTION);
        view.setUint32(ADAPTER_INFO.COMBO_INDEX, INDEX, true);
        view.setUint32(ADAPTER_INFO.ADDRESS_LENGTH, HARDWARE_ADDRESS.length, true);
        record.set(HARDWARE_ADDRESS, ADAPTER_INFO.ADDRESS);
        view.setUint32(ADAPTER_INFO.INDEX, INDEX, true);
        view.setUint32(ADAPTER_INFO.TYPE, MIB_IF_TYPE_ETHERNET, true);
        view.setUint32(ADAPTER_INFO.DHCP_ENABLED, 1, true);
        view.setUint32(ADAPTER_INFO.CURRENT_IP_ADDRESS, at + ADAPTER_INFO.IP_ADDRESS_LIST, true);
        const own = (host.localAddress?.() ?? 0) >>> 0;
        const online = own !== 0 && own >>> 24 !== LOOPBACK_NET;
        const list = ADAPTER_INFO.IP_ADDRESS_LIST;
        record.set(ascii(online ? dotted(own) : '0.0.0.0'), list + IP_ADDRESS);
        record.set(ascii(online ? '255.255.255.0' : '0.0.0.0'), list + IP_MASK);
        for (const empty of [ADAPTER_INFO.GATEWAY_LIST, ADAPTER_INFO.DHCP_SERVER,
            ADAPTER_INFO.PRIMARY_WINS_SERVER, ADAPTER_INFO.SECONDARY_WINS_SERVER])
        {
            record.set(ascii('0.0.0.0'), empty + IP_ADDRESS);
            record.set(ascii('0.0.0.0'), empty + IP_MASK);
        }
        return record;
    };

    /** Whether the adapter has a network to be on. */
    const connected = ()=>{
        const own = (host.localAddress?.() ?? 0) >>> 0;
        return own !== 0 && own >>> 24 !== LOOPBACK_NET;
    };

    /** An interface's MIB_IFROW, or null for an index there is none at. @param {number} index */
    const interfaceRow = index=>{
        const loopback = index === LOOPBACK_INDEX;
        if (index !== INDEX && !loopback)
        {
            return null;
        }
        const row = new Uint8Array(IFROW.SIZE);
        const view = new DataView(row.buffer);
        const description = loopback ? 'Software Loopback Interface 1' : DESCRIPTION;
        const guid = loopback ? '{00000000-0000-0000-0000-000000000000}' : NAME;
        const name = `\\DEVICE\\TCPIP_${guid}`;
        for (let at = 0; at < name.length; at++)
        {
            view.setUint16(at * 2, name.charCodeAt(at), true);
        }
        view.setUint32(IFROW.INDEX, index, true);
        view.setUint32(IFROW.TYPE, loopback ? MIB_IF_TYPE_LOOPBACK : MIB_IF_TYPE_ETHERNET, true);
        view.setUint32(IFROW.MTU, MTU, true);
        view.setUint32(IFROW.SPEED, loopback ? LOOPBACK_SPEED : ADAPTER_SPEED, true);
        if (!loopback)
        {
            view.setUint32(IFROW.PHYS_ADDR_LEN, HARDWARE_ADDRESS.length, true);
            row.set(HARDWARE_ADDRESS, IFROW.PHYS_ADDR);
        }
        view.setUint32(IFROW.ADMIN_STATUS, MIB_IF_ADMIN_STATUS_UP, true);
        view.setUint32(IFROW.OPER_STATUS, loopback || connected()
            ? MIB_IF_OPER_STATUS_OPERATIONAL : MIB_IF_OPER_STATUS_DISCONNECTED, true);
        view.setUint32(IFROW.DESCR_LEN, description.length + 1, true);
        row.set(ascii(description), IFROW.DESCR);
        return row;
    };

    return {
        /**
         * DWORD GetIfEntry(PMIB_IFROW pIfRow)
         *
         * The row of the interface whose index the caller put in dwIndex:
         * the adapter or the loopback. The traffic counters are zero -- no
         * count of them is kept.
         */
        GetIfEntry: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([row])=>{
                if ((row >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const filled = interfaceRow(readU32((row >>> 0) + IFROW.INDEX));
                if (!filled)
                {
                    return ERROR_INVALID_DATA;
                }
                host.writeMemory(row >>> 0, filled);
                return NO_ERROR;
            },
        },

        /**
         * DWORD GetInterfaceInfo(PIP_INTERFACE_INFO pIfTable, PULONG dwOutBufLen)
         *
         * The adapters, the loopback not among them: the one, by its index and
         * its device name. The size, with ERROR_INSUFFICIENT_BUFFER, while the
         * buffer is short of it or absent.
         */
        GetInterfaceInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([table, size])=>{
                if ((size >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((table >>> 0) === 0 || readU32(size >>> 0) < INTERFACE_INFO.SIZE)
                {
                    writeU32(size >>> 0, INTERFACE_INFO.SIZE);
                    return ERROR_INSUFFICIENT_BUFFER;
                }
                const record = new Uint8Array(INTERFACE_INFO.SIZE);
                const view = new DataView(record.buffer);
                view.setUint32(INTERFACE_INFO.COUNT, 1, true);
                view.setUint32(INTERFACE_INFO.INDEX, INDEX, true);
                const name = `\\DEVICE\\TCPIP_${NAME}`;
                for (let at = 0; at < name.length; at++)
                {
                    view.setUint16(INTERFACE_INFO.NAME + at * 2, name.charCodeAt(at), true);
                }
                host.writeMemory(table >>> 0, record);
                return NO_ERROR;
            },
        },

        /**
         * DWORD GetAdaptersInfo(PIP_ADAPTER_INFO pAdapterInfo, PULONG pOutBufLen)
         *
         * The size the list needs, with ERROR_BUFFER_OVERFLOW, while the
         * buffer is short of it or absent; otherwise the list, written.
         */
        GetAdaptersInfo: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([info, size])=>{
                if ((size >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((info >>> 0) === 0 || readU32(size >>> 0) < ADAPTER_INFO.SIZE)
                {
                    writeU32(size >>> 0, ADAPTER_INFO.SIZE);
                    return ERROR_BUFFER_OVERFLOW;
                }
                host.writeMemory(info >>> 0, adapter(info >>> 0));
                return NO_ERROR;
            },
        },
        /**
         * DWORD GetNumberOfInterfaces(PDWORD pdwNumIf)
         *
         * The interface table counts the loopback interface beside the
         * adapter, as GetIfTable lists both on a real machine.
         */
        GetNumberOfInterfaces: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([count])=>{
                if ((count >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeU32(count >>> 0, INTERFACES);
                return NO_ERROR;
            },
        },
    };
}
