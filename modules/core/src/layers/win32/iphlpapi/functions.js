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
 * @property {(bytes: number) => number} [allocate]  Memory the caller frees
 *           with FreeMibTable (GetIfTable2's table); 0 when there is none.
 * @property {(address: number) => void} [free]
 * @property {{ open: (type: string, object: any) => number }} [handles]
 *           Where NotifyAddrChange's handle comes from.
 */

const NO_ERROR = 0;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_BUFFER_OVERFLOW = 111;
const ERROR_INVALID_DATA = 13;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_NO_DATA = 232;
const ERROR_IO_PENDING = 997;
const ERROR_NETWORK_UNREACHABLE = 1231;

const AF_UNSPEC = 0;
const AF_INET = 2;
const AF_INET6 = 23;

/**
 * IP_ADAPTER_ADDRESSES_LH as 32-bit Windows lays it out, eight-aligned for its
 * 64-bit fields; its Length is its size.
 */
export const ADAPTER_ADDRESSES = Object.freeze({
    SIZE: 376, LENGTH: 0, IF_INDEX: 4, NEXT: 8, ADAPTER_NAME: 12, FIRST_UNICAST: 16,
    FIRST_ANYCAST: 20, FIRST_MULTICAST: 24, FIRST_DNS_SERVER: 28, DNS_SUFFIX: 32,
    DESCRIPTION: 36, FRIENDLY_NAME: 40, PHYSICAL_ADDRESS: 44, PHYSICAL_ADDRESS_LENGTH: 52,
    FLAGS: 56, MTU: 60, IF_TYPE: 64, OPER_STATUS: 68, IPV6_IF_INDEX: 72, FIRST_PREFIX: 140,
    TRANSMIT_SPEED: 144, RECEIVE_SPEED: 152, FIRST_GATEWAY: 164, IPV4_METRIC: 168,
    IPV6_METRIC: 172, LUID: 176, CONNECTION_TYPE: 212,
});
/** IP_ADAPTER_UNICAST_ADDRESS_LH: a length, flags, next, a SOCKET_ADDRESS, then its origins. */
export const UNICAST = Object.freeze({
    SIZE: 48, NEXT: 8, SOCKADDR: 12, SOCKADDR_LENGTH: 16, PREFIX_ORIGIN: 20,
    SUFFIX_ORIGIN: 24, DAD_STATE: 28, VALID_LIFETIME: 32, PREFERRED_LIFETIME: 36,
    LEASE_LIFETIME: 40, ON_LINK_PREFIX_LENGTH: 44,
});
/** IP_ADAPTER_PREFIX_XP: a length, flags, next, a SOCKET_ADDRESS and the prefix's length. */
export const PREFIX = Object.freeze({ SIZE: 24, NEXT: 8, SOCKADDR: 12, PREFIX_LENGTH: 20 });
const SOCKADDR_IN_SIZE = 16;
/** GetAdaptersAddresses' flags this answer changes with. */
const GAA_FLAG_SKIP_UNICAST = 0x1;
const GAA_FLAG_INCLUDE_PREFIX = 0x10;
const GAA_FLAG_SKIP_FRIENDLY_NAME = 0x20;
/** The adapter's flags: DDNS and DHCP, IPv4 bound; the loopback is IPv4 alone. */
const IP_ADAPTER_DDNS_ENABLED = 0x1;
const IP_ADAPTER_DHCP_ENABLED = 0x4;
const IP_ADAPTER_IPV4_ENABLED = 0x80;
/** IF_OPER_STATUS, as the Vista calls number it (MIB_IFROW's numbering is older). */
const IF_OPER_STATUS_UP = 1;
const IF_OPER_STATUS_DOWN = 2;
const NET_IF_CONNECTION_DEDICATED = 1;

/** MIB_IF_ROW2, 1352 bytes; MIB_IF_TABLE2 is a count and the rows from offset 8. */
export const IF_ROW2 = Object.freeze({
    SIZE: 1352, LUID: 0, INDEX: 8, GUID: 12, ALIAS: 28, DESCRIPTION: 542,
    PHYS_ADDR_LEN: 1056, PHYS_ADDR: 1060, PERMANENT_PHYS_ADDR: 1092, MTU: 1124, TYPE: 1128,
    MEDIA_TYPE: 1136, PHYSICAL_MEDIUM: 1140, ACCESS_TYPE: 1144, FLAGS: 1152,
    OPER_STATUS: 1156, ADMIN_STATUS: 1160, MEDIA_CONNECT_STATE: 1164, CONNECTION_TYPE: 1184,
    TRANSMIT_SPEED: 1192, RECEIVE_SPEED: 1200,
});
const IF_TABLE2_ROWS = 8;
/** Characters an alias or a description holds, its terminator among them. */
const IF_MAX_STRING_SIZE = 257;

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

/**
 * A GUID's sixteen bytes from its registry text.
 *
 * @param {string} text
 */
const guidBytes = text=>{
    const hex = text.replace(/[{}-]/g, '');
    const bytes = Uint8Array.from({ length: 16 },
        (_, at)=>parseInt(hex.slice(at * 2, at * 2 + 2), 16));
    // The first three fields are little-endian in memory.
    return Uint8Array.of(bytes[3], bytes[2], bytes[1], bytes[0], bytes[5], bytes[4], bytes[7],
        bytes[6], ...bytes.subarray(8));
};

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

    /**
     * The interfaces: the adapter, and the loopback the Vista calls list
     * after it. An address and its prefix length where the interface has one.
     */
    const interfaces = ()=>{
        const own = (host.localAddress?.() ?? 0) >>> 0;
        const online = connected();
        return [
            { index: INDEX, type: MIB_IF_TYPE_ETHERNET, guid: NAME, alias: 'Ethernet',
                description: DESCRIPTION, physical: HARDWARE_ADDRESS, up: online,
                address: online ? own : null, prefix: 24, mtu: MTU, speed: ADAPTER_SPEED,
                metric: 25, flags: IP_ADAPTER_DDNS_ENABLED | IP_ADAPTER_DHCP_ENABLED
                    | IP_ADAPTER_IPV4_ENABLED, dhcp: true },
            { index: LOOPBACK_INDEX, type: MIB_IF_TYPE_LOOPBACK,
                guid: '{00000000-0000-0000-0000-000000000000}',
                alias: 'Loopback Pseudo-Interface 1', description: 'Software Loopback Interface 1',
                physical: /** @type {number[]} */ ([]), up: true, address: 0x7f000001, prefix: 8,
                mtu: 0xffffffff, speed: LOOPBACK_SPEED, metric: 75,
                flags: IP_ADAPTER_IPV4_ENABLED, dhcp: false },
        ];
    };

    /**
     * NET_LUID: the interface type in the top 16 bits, an index under it.
     *
     * @param {{ type: number, index: number }} one
     */
    const luidOf = one=>(BigInt(one.type) << 48n) | (BigInt(one.index) << 24n);

    /**
     * A block laid out at offsets from its start, its pointers made absolute
     * once the start is known.
     */
    const layout = ()=>{
        /** @type {{ at: number, bytes: Uint8Array }[]} */
        const pieces = [];
        /** @type {[number, number][]} */
        const pointers = [];
        let size = 0;
        return {
            get size(){
                return size;
            },
            /** @param {number} length @param {number} [align] */
            reserve(length, align = 4){
                size = Math.ceil(size / align) * align;
                const at = size;
                pieces.push({ at, bytes: new Uint8Array(length) });
                size += length;
                return at;
            },
            /** @param {number} at */
            view(at){
                const piece = /** @type {{ at: number, bytes: Uint8Array }} */ (
                    pieces.find(one=>one.at === at));
                return new DataView(piece.bytes.buffer);
            },
            /** @param {number} field @param {number} target */
            point(field, target){
                pointers.push([field, target]);
            },
            /** @param {number} base */
            build(base){
                const out = new Uint8Array(size);
                for (const piece of pieces)
                {
                    out.set(piece.bytes, piece.at);
                }
                const view = new DataView(out.buffer);
                for (const [field, target] of pointers)
                {
                    view.setUint32(field, base + target, true);
                }
                return out;
            },
        };
    };

    /**
     * A sockaddr_in for `address` laid into `block`, its SOCKET_ADDRESS at
     * `field` pointing to it.
     *
     * @param {ReturnType<typeof layout>} block @param {number} field
     * @param {number} owner @param {number} address
     */
    const socketAddress = (block, owner, field, address)=>{
        const at = block.reserve(SOCKADDR_IN_SIZE);
        const view = block.view(at);
        view.setUint16(0, AF_INET, true);
        view.setUint32(4, address, false);
        block.point(owner + field, at);
        block.view(owner).setUint32(field + 4, SOCKADDR_IN_SIZE, true);
    };

    /** A wide string with its terminator, laid into `block`. @param {ReturnType<typeof layout>} block @param {string} text */
    const wideIn = (block, text)=>{
        const at = block.reserve(text.length * 2 + 2, 2);
        const view = block.view(at);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint16(i * 2, text.charCodeAt(i), true);
        }
        return at;
    };

    /**
     * GetAdaptersAddresses' list for `flags`, laid out from offset zero.
     *
     * @param {number} flags
     */
    const adapterAddresses = flags=>{
        const block = layout();
        let previous = -1;
        for (const one of interfaces())
        {
            const at = block.reserve(ADAPTER_ADDRESSES.SIZE, 8);
            if (previous >= 0)
            {
                block.point(previous + ADAPTER_ADDRESSES.NEXT, at);
            }
            previous = at;
            const view = block.view(at);
            view.setUint32(ADAPTER_ADDRESSES.LENGTH, ADAPTER_ADDRESSES.SIZE, true);
            view.setUint32(ADAPTER_ADDRESSES.IF_INDEX, one.index, true);
            const name = block.reserve(one.guid.length + 1);
            pieceText(block, name, one.guid);
            block.point(at + ADAPTER_ADDRESSES.ADAPTER_NAME, name);
            if (one.address !== null && (flags & GAA_FLAG_SKIP_UNICAST) === 0)
            {
                const unicast = block.reserve(UNICAST.SIZE, 8);
                const entry = block.view(unicast);
                entry.setUint32(0, UNICAST.SIZE, true);
                socketAddress(block, unicast, UNICAST.SOCKADDR, one.address);
                // Manual and well known on the loopback; the adapter's lease is DHCP's.
                entry.setUint32(UNICAST.PREFIX_ORIGIN, one.dhcp ? 3 : 2, true);
                entry.setUint32(UNICAST.SUFFIX_ORIGIN, one.dhcp ? 3 : 2, true);
                entry.setUint32(UNICAST.DAD_STATE, 4, true);
                for (const field of [UNICAST.VALID_LIFETIME, UNICAST.PREFERRED_LIFETIME,
                    UNICAST.LEASE_LIFETIME])
                {
                    entry.setUint32(field, 0xffffffff, true);
                }
                entry.setUint8(UNICAST.ON_LINK_PREFIX_LENGTH, one.prefix);
                block.point(at + ADAPTER_ADDRESSES.FIRST_UNICAST, unicast);
            }
            if (one.address !== null && (flags & GAA_FLAG_INCLUDE_PREFIX) !== 0)
            {
                // The on-link network, the address itself and the network's
                // broadcast address, as Windows lists an IPv4 interface's.
                const mask = one.prefix === 0 ? 0 : (0xffffffff << (32 - one.prefix)) >>> 0;
                const network = (one.address & mask) >>> 0;
                let last = -1;
                for (const [address, length] of [[network, one.prefix], [one.address, 32],
                    [(network | ~mask) >>> 0, 32]])
                {
                    const prefix = block.reserve(PREFIX.SIZE, 8);
                    block.view(prefix).setUint32(0, PREFIX.SIZE, true);
                    socketAddress(block, prefix, PREFIX.SOCKADDR, address);
                    block.view(prefix).setUint32(PREFIX.PREFIX_LENGTH, length, true);
                    block.point(last < 0 ? at + ADAPTER_ADDRESSES.FIRST_PREFIX
                        : last + PREFIX.NEXT, prefix);
                    last = prefix;
                }
            }
            block.point(at + ADAPTER_ADDRESSES.DNS_SUFFIX, wideIn(block, ''));
            block.point(at + ADAPTER_ADDRESSES.DESCRIPTION, wideIn(block, one.description));
            block.point(at + ADAPTER_ADDRESSES.FRIENDLY_NAME,
                wideIn(block, (flags & GAA_FLAG_SKIP_FRIENDLY_NAME) === 0 ? one.alias : ''));
            one.physical.forEach((byte, i)=>view.setUint8(ADAPTER_ADDRESSES.PHYSICAL_ADDRESS + i,
                byte));
            view.setUint32(ADAPTER_ADDRESSES.PHYSICAL_ADDRESS_LENGTH, one.physical.length, true);
            view.setUint32(ADAPTER_ADDRESSES.FLAGS, one.flags, true);
            view.setUint32(ADAPTER_ADDRESSES.MTU, one.mtu, true);
            view.setUint32(ADAPTER_ADDRESSES.IF_TYPE, one.type, true);
            view.setUint32(ADAPTER_ADDRESSES.OPER_STATUS,
                one.up ? IF_OPER_STATUS_UP : IF_OPER_STATUS_DOWN, true);
            view.setBigUint64(ADAPTER_ADDRESSES.TRANSMIT_SPEED, BigInt(one.speed), true);
            view.setBigUint64(ADAPTER_ADDRESSES.RECEIVE_SPEED, BigInt(one.speed), true);
            view.setUint32(ADAPTER_ADDRESSES.IPV4_METRIC, one.metric, true);
            view.setBigUint64(ADAPTER_ADDRESSES.LUID, luidOf(one), true);
            view.setUint32(ADAPTER_ADDRESSES.CONNECTION_TYPE, NET_IF_CONNECTION_DEDICATED, true);
        }
        return block;
    };

    /** ASCII text with its terminator into a piece already reserved. */
    /** @param {ReturnType<typeof layout>} block @param {number} at @param {string} text */
    function pieceText(block, at, text){
        const view = block.view(at);
        for (let i = 0; i < text.length; i++)
        {
            view.setUint8(i, text.charCodeAt(i) & 0x7f);
        }
    }

    /**
     * An interface's MIB_IF_ROW2.
     *
     * @param {ReturnType<typeof interfaces>[number]} one
     */
    const ifRow2 = one=>{
        const row = new Uint8Array(IF_ROW2.SIZE);
        const view = new DataView(row.buffer);
        view.setBigUint64(IF_ROW2.LUID, luidOf(one), true);
        view.setUint32(IF_ROW2.INDEX, one.index, true);
        row.set(guidBytes(one.guid), IF_ROW2.GUID);
        /** @type {[number, string][]} */
        const texts = [[IF_ROW2.ALIAS, one.alias], [IF_ROW2.DESCRIPTION, one.description]];
        for (const [field, text] of texts)
        {
            for (let i = 0; i < Math.min(text.length, IF_MAX_STRING_SIZE - 1); i++)
            {
                view.setUint16(field + i * 2, text.charCodeAt(i), true);
            }
        }
        view.setUint32(IF_ROW2.PHYS_ADDR_LEN, one.physical.length, true);
        row.set(one.physical, IF_ROW2.PHYS_ADDR);
        row.set(one.physical, IF_ROW2.PERMANENT_PHYS_ADDR);
        view.setUint32(IF_ROW2.MTU, one.mtu, true);
        view.setUint32(IF_ROW2.TYPE, one.type, true);
        const loopback = one.type === MIB_IF_TYPE_LOOPBACK;
        // NdisMediumLoopback or 802.3; the physical medium 802.3 or unspecified.
        view.setUint32(IF_ROW2.MEDIA_TYPE, loopback ? 17 : 0, true);
        view.setUint32(IF_ROW2.PHYSICAL_MEDIUM, loopback ? 0 : 14, true);
        // NET_IF_ACCESS_LOOPBACK or NET_IF_ACCESS_BROADCAST.
        view.setUint32(IF_ROW2.ACCESS_TYPE, loopback ? 1 : 2, true);
        // HardwareInterface and ConnectorPresent for the card, NotMediaConnected without a network.
        view.setUint8(IF_ROW2.FLAGS, loopback ? 0 : 0x5 | (one.up ? 0 : 0x10));
        view.setUint32(IF_ROW2.OPER_STATUS, one.up ? IF_OPER_STATUS_UP : IF_OPER_STATUS_DOWN, true);
        view.setUint32(IF_ROW2.ADMIN_STATUS, MIB_IF_ADMIN_STATUS_UP, true);
        // MediaConnectStateConnected, or Disconnected.
        view.setUint32(IF_ROW2.MEDIA_CONNECT_STATE, one.up ? 1 : 2, true);
        view.setUint32(IF_ROW2.CONNECTION_TYPE, NET_IF_CONNECTION_DEDICATED, true);
        view.setBigUint64(IF_ROW2.TRANSMIT_SPEED, BigInt(one.speed), true);
        view.setBigUint64(IF_ROW2.RECEIVE_SPEED, BigInt(one.speed), true);
        return row;
    };

    /** The overlapped structures NotifyAddrChange left pending, for CancelIPChangeNotify. */
    const pendingChanges = new Set();

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
        /**
         * ULONG GetAdaptersAddresses(ULONG Family, ULONG Flags, PVOID Reserved,
         *   PIP_ADAPTER_ADDRESSES AdapterAddresses, PULONG SizePointer)
         *
         * The adapter, then the loopback, with their IPv4 addresses (and with
         * GAA_FLAG_INCLUDE_PREFIX, the on-link network, the address and the
         * broadcast address as prefixes). There is no IPv6 stack: AF_INET6
         * finds nothing, ERROR_NO_DATA. No anycast, multicast, DNS server or
         * gateway is listed -- none is known here; names resolve through the
         * transport. The size the list needs with ERROR_BUFFER_OVERFLOW while
         * the buffer is short of it or absent.
         */
        GetAdaptersAddresses: {
            argBytes: 20,
            /** @param {number[]} args */
            handler: ([family, flags, reserved, addresses, size])=>{
                if ((size >>> 0) === 0 || (reserved >>> 0) !== 0
                    || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((family >>> 0) === AF_INET6)
                {
                    return ERROR_NO_DATA;
                }
                const block = adapterAddresses(flags >>> 0);
                if ((addresses >>> 0) === 0 || readU32(size >>> 0) < block.size)
                {
                    writeU32(size >>> 0, block.size);
                    return ERROR_BUFFER_OVERFLOW;
                }
                host.writeMemory(addresses >>> 0, block.build(addresses >>> 0));
                return NO_ERROR;
            },
        },

        /**
         * DWORD GetExtendedTcpTable(PVOID pTcpTable, PDWORD pdwSize, BOOL bOrder,
         *   ULONG ulAf, TCP_TABLE_CLASS TableClass, ULONG Reserved)
         *
         * The table's count and no rows: the connections are the socket
         * layer's, which this library does not see, so none is listed. The
         * header is a DWORD, eight bytes for the module classes whose rows
         * hold a 64-bit time.
         */
        GetExtendedTcpTable: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([table, size, , family, tableClass])=>{
                const classOf = tableClass >>> 0;
                if ((size >>> 0) === 0 || classOf > 8
                    || ((family >>> 0) !== AF_INET && (family >>> 0) !== AF_INET6))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const header = classOf >= 6 ? 8 : 4;
                if ((table >>> 0) === 0 || readU32(size >>> 0) < header)
                {
                    writeU32(size >>> 0, header);
                    return ERROR_INSUFFICIENT_BUFFER;
                }
                host.writeMemory(table >>> 0, new Uint8Array(header));
                writeU32(size >>> 0, header);
                return NO_ERROR;
            },
        },

        /**
         * NETIOAPI_API GetIfEntry2(PMIB_IF_ROW2 Row)
         *
         * The row of the interface the caller named: by InterfaceLuid when
         * it is set, else by InterfaceIndex. One that is not there is
         * ERROR_FILE_NOT_FOUND.
         */
        GetIfEntry2: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([row])=>{
                if ((row >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const named = host.readMemory(row >>> 0, 12);
                const view = new DataView(named.buffer, named.byteOffset, 12);
                const luid = view.getBigUint64(0, true);
                const index = view.getUint32(8, true);
                const one = interfaces().find(each=>(luid !== 0n ? luidOf(each) === luid
                    : each.index === index));
                if (!one)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                host.writeMemory(row >>> 0, ifRow2(one));
                return NO_ERROR;
            },
        },

        /**
         * NETIOAPI_API GetIfTable2(PMIB_IF_TABLE2 *Table)
         *
         * Every interface's row, in a table this library allocates and
         * FreeMibTable frees.
         */
        GetIfTable2: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const all = interfaces();
                const bytes = new Uint8Array(IF_TABLE2_ROWS + all.length * IF_ROW2.SIZE);
                new DataView(bytes.buffer).setUint32(0, all.length, true);
                all.forEach((one, i)=>bytes.set(ifRow2(one), IF_TABLE2_ROWS + i * IF_ROW2.SIZE));
                const at = host.allocate?.(bytes.length) ?? 0;
                if (at === 0)
                {
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                host.writeMemory(at >>> 0, bytes);
                writeU32(out >>> 0, at);
                return NO_ERROR;
            },
        },

        /** VOID FreeMibTable(PVOID Memory) */
        FreeMibTable: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([memory])=>{
                if ((memory >>> 0) !== 0)
                {
                    host.free?.(memory >>> 0);
                }
                return 0;
            },
        },

        /**
         * NETIO_STATUS ConvertInterfaceGuidToLuid(const GUID *InterfaceGuid,
         *   PNET_LUID InterfaceLuid)
         */
        ConvertInterfaceGuidToLuid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([guid, luid])=>{
                if ((guid >>> 0) === 0 || (luid >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const wanted = host.readMemory(guid >>> 0, 16);
                const one = interfaces().find(each=>guidBytes(each.guid)
                    .every((byte, i)=>byte === wanted[i]));
                if (!one)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const out = new Uint8Array(8);
                new DataView(out.buffer).setBigUint64(0, luidOf(one), true);
                host.writeMemory(luid >>> 0, out);
                return NO_ERROR;
            },
        },

        /**
         * DWORD GetBestInterface(IPAddr dwDestAddr, PDWORD pdwBestIfIndex)
         *
         * The loopback for the loopback network and for this machine's own
         * address; the adapter for anywhere else while it has a network, and
         * no route at all without one.
         */
        GetBestInterface: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([destination, out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                // IPAddr is the address as it sits in memory: the first octet low.
                const address = (((destination & 0xff) << 24) | ((destination >>> 8 & 0xff) << 16)
                    | ((destination >>> 16 & 0xff) << 8) | (destination >>> 24 & 0xff)) >>> 0;
                const own = (host.localAddress?.() ?? 0) >>> 0;
                if (address >>> 24 === LOOPBACK_NET || (address === own && connected()))
                {
                    writeU32(out >>> 0, LOOPBACK_INDEX);
                    return NO_ERROR;
                }
                if (!connected())
                {
                    return ERROR_NETWORK_UNREACHABLE;
                }
                writeU32(out >>> 0, INDEX);
                return NO_ERROR;
            },
        },

        /**
         * DWORD NotifyAddrChange(PHANDLE Handle, LPOVERLAPPED overlapped)
         *
         * The address only changes when the run starts, so no change is ever
         * reported. Overlapped, the request is pending (ERROR_IO_PENDING) and
         * its event is never signalled until it is cancelled; without an
         * OVERLAPPED the call blocks until a change, which here is forever --
         * a thread a program set to watch for changes waits as it would on
         * a machine whose address never moves.
         */
        NotifyAddrChange: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([handle, overlapped])=>{
                if ((overlapped >>> 0) === 0)
                {
                    return new Promise(()=>{});
                }
                if ((handle >>> 0) !== 0)
                {
                    writeU32(handle >>> 0, host.handles?.open('ip-change', {}) ?? 0);
                }
                pendingChanges.add(overlapped >>> 0);
                return ERROR_IO_PENDING;
            },
        },

        /**
         * BOOL CancelIPChangeNotify(LPOVERLAPPED notifyOverlapped)
         *
         * TRUE for a request NotifyAddrChange left pending, which is
         * forgotten; FALSE for any other.
         */
        CancelIPChangeNotify: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([overlapped])=>(pendingChanges.delete(overlapped >>> 0) ? 1 : 0),
        },

        /**
         * DWORD IpReleaseAddress(PIP_ADAPTER_INDEX_MAP AdapterInfo) and
         * IpRenewAddress: the address is the network's, handed out with the
         * run rather than leased from a DHCP server this machine could ask
         * again, so neither can be done for the adapter. An index that is no
         * adapter's is ERROR_INVALID_PARAMETER.
         */
        IpReleaseAddress: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([map])=>((map >>> 0) === 0 || readU32(map >>> 0) !== INDEX
                ? ERROR_INVALID_PARAMETER : ERROR_NOT_SUPPORTED),
        },
        IpRenewAddress: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([map])=>((map >>> 0) === 0 || readU32(map >>> 0) !== INDEX
                ? ERROR_INVALID_PARAMETER : ERROR_NOT_SUPPORTED),
        },
    };
}
