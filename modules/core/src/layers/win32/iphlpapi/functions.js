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
        const connected = own !== 0 && own >>> 24 !== LOOPBACK_NET;
        const list = ADAPTER_INFO.IP_ADDRESS_LIST;
        record.set(ascii(connected ? dotted(own) : '0.0.0.0'), list + IP_ADDRESS);
        record.set(ascii(connected ? '255.255.255.0' : '0.0.0.0'), list + IP_MASK);
        for (const empty of [ADAPTER_INFO.GATEWAY_LIST, ADAPTER_INFO.DHCP_SERVER,
            ADAPTER_INFO.PRIMARY_WINS_SERVER, ADAPTER_INFO.SECONDARY_WINS_SERVER])
        {
            record.set(ascii('0.0.0.0'), empty + IP_ADDRESS);
            record.set(ascii('0.0.0.0'), empty + IP_MASK);
        }
        return record;
    };

    return {
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
    };
}
