/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * IP Helper's tables and the names an interface goes by: routes, neighbours,
 * the connections the socket layer holds, the counters, and the conversions
 * between an interface's index, LUID, GUID, name and alias.
 *
 * Every table is drawn from the one model functions.js keeps - the adapter
 * and the loopback - so a program that asks the same machine two ways is told
 * the same thing. No packet is counted: the statistics hold the counts that
 * describe the machine (interfaces, addresses, routes, connections) and zero
 * traffic. ICMP reaches this machine alone: an echo to the loopback or to its
 * own address is answered here, one to anywhere else times out, the network
 * the relay gives carrying no ICMP.
 */

import { readToTerminator } from '../common/scan-windows.js';

const NO_ERROR = 0;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_NOT_ENOUGH_MEMORY = 8;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_INSUFFICIENT_BUFFER = 122;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_NO_DATA = 232;
const ERROR_NOT_FOUND = 1168;
const ERROR_NETWORK_UNREACHABLE = 1231;
const ERROR_IO_PENDING = 997;
const ERROR_INVALID_NETNAME = 1214;
const ERROR_MR_MID_NOT_FOUND = 317;
const IP_BUF_TOO_SMALL = 11001;
const IP_REQ_TIMED_OUT = 11010;

const AF_UNSPEC = 0;
const AF_INET = 2;
const AF_INET6 = 23;
const SOCK_STREAM = 1;
const LOOPBACK_NET = 127;
const MIB_IF_TYPE_LOOPBACK = 24;
const INADDR_NONE = 0xffffffff;
const INVALID_HANDLE_VALUE = 0xffffffff;

/** MIB_IPFORWARDROW: fourteen DWORDs. */
const FORWARD_ROW = 56;
/** MIB_IPFORWARD_ROW2 and its table's eight-byte head. */
const FORWARD_ROW2 = Object.freeze({
    SIZE: 104, LUID: 0, INDEX: 8, PREFIX: 12, PREFIX_LENGTH: 40, NEXT_HOP: 44,
    VALID_LIFETIME: 76, PREFERRED_LIFETIME: 80, METRIC: 84, PROTOCOL: 88, LOOPBACK: 92,
    AUTOCONFIGURE: 93, PUBLISH: 94, IMMORTAL: 95, ORIGIN: 100,
});
/** MIB_IPNETROW: index, address length, eight address bytes, the IP and the type. */
const NET_ROW = 24;
/** MIB_IPNET_ROW2. */
const NET_ROW2 = Object.freeze({
    SIZE: 88, INDEX: 28, LUID: 32, PHYSICAL: 40, PHYSICAL_LENGTH: 72, STATE: 76, FLAGS: 80,
});
/** MIB_UNICASTIPADDRESS_ROW. */
const UNICAST_ROW = Object.freeze({
    SIZE: 80, LUID: 32, INDEX: 40, PREFIX_ORIGIN: 44, SUFFIX_ORIGIN: 48, VALID_LIFETIME: 52,
    PREFERRED_LIFETIME: 56, PREFIX_LENGTH: 60, DAD_STATE: 64,
});
/** MIB_IPINTERFACE_ROW, as far as this machine has anything to say in it. */
const IP_INTERFACE_ROW = Object.freeze({
    SIZE: 168, FAMILY: 0, LUID: 8, INDEX: 16, MAX_REASSEMBLY: 20, WEAK_HOST_SEND: 42,
    USE_AUTOMATIC_METRIC: 44, UNREACHABILITY_DETECTION: 45, DAD_TRANSMITS: 56,
    BASE_REACHABLE_TIME: 60, RETRANSMIT_TIME: 64, PATH_MTU_TIMEOUT: 68, METRIC: 148,
    NL_MTU: 152, CONNECTED: 156, NEIGHBOR_DISCOVERY: 158, ROUTER_DISCOVERY: 159,
    REACHABLE_TIME: 160,
});
/** A SOCKADDR_INET: as large as a sockaddr_in6. */
const SOCKADDR_INET = 28;
const SOCKADDR_IN6 = 28;
/** The eight-byte head of a Vista table, its rows aligned for their LUIDs. */
const TABLE2_HEAD = 8;

/** MIB_IPFORWARD_TYPE and MIB_IPPROTO_LOCAL. */
const ROUTE_DIRECT = 3;
const ROUTE_INDIRECT = 4;
const PROTO_LOCAL = 2;
/** MIB_IPNET_TYPE_STATIC and NlnsPermanent. */
const NET_TYPE_STATIC = 4;
const NL_PERMANENT = 6;
/** NlpoManual / NlpoDhcp and NlsoManual / NlsoDhcp, IpDadStatePreferred. */
const ORIGIN_MANUAL = 1;
const ORIGIN_DHCP = 3;
const DAD_PREFERRED = 4;
/** MIB_TCP_STATE. */
const TCP_LISTEN = 2;
const TCP_ESTABLISHED = 5;
const TCP_DELETE_TCB = 12;
/** ICMP_ECHO_REPLY: address, status, round trip, data size, reserved, data, options. */
const ECHO_REPLY = 28;
/** IP_SUCCESS. */
const IP_SUCCESS = 0;

/**
 * The type name an interface's name begins with, by its IANA type, as
 * Windows writes `ethernet_32768` and `loopback_0`.
 *
 * @type {Record<number, string>}
 */
const TYPE_NAMES = { 6: 'ethernet', 24: 'loopback', 71: 'wireless', 131: 'tunnel' };

/**
 * @typedef {Object} InterfaceModel
 * @property {number} index
 * @property {number} type
 * @property {string} guid
 * @property {string} alias
 * @property {string} description
 * @property {readonly number[]} physical
 * @property {boolean} up
 * @property {number | null} address
 * @property {number} prefix
 * @property {number} mtu
 * @property {number} speed
 * @property {number} metric
 * @property {number} flags
 * @property {boolean} dhcp
 */

/**
 * @typedef {Object} TablesHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(bytes: number) => number} [allocate]
 * @property {() => any[]} [sockets]  The socket layer's sockets, for the TCP and UDP tables.
 * @property {() => string} [hostName]
 * @property {{ open: (type: string, object: any) => number,
 *     close?: (handle: number) => boolean, get?: (handle: number) => any }} [handles]
 * @property {(api: string, detail: string) => void} [divergence]
 * @property {(code: number) => void} [setLastError]
 * @property {(handle: number) => void} [signalEvent]
 * @property {() => number} [processId]
 */

/**
 * @param {TablesHost} host
 * @param {{ interfaces: () => InterfaceModel[], luidOf: (one: InterfaceModel) => bigint,
 *     interfaceRow: (index: number) => Uint8Array | null,
 *     ifRow2: (one: InterfaceModel) => Uint8Array,
 *     guidBytes: (text: string) => Uint8Array }} model
 */
export function createIphlpapiTables(host, model){
    const { interfaces, luidOf, interfaceRow, ifRow2, guidBytes } = model;

    /** @param {number} address */
    const readU32 = address=>new DataView(host.readMemory(address, 4).slice().buffer)
        .getUint32(0, true);
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        const bytes = new Uint8Array(4);
        new DataView(bytes.buffer).setUint32(0, value >>> 0, true);
        host.writeMemory(address, bytes);
    };
    /** @param {number} address */
    const readLuid = address=>new DataView(host.readMemory(address, 8).slice().buffer)
        .getBigUint64(0, true);
    /** @param {number} address @param {bigint} luid */
    const writeLuid = (address, luid)=>{
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setBigUint64(0, luid, true);
        host.writeMemory(address, bytes);
    };

    /** @param {number} address @param {number} limit characters */
    const readAnsi = (address, limit = 512)=>String.fromCharCode(
        ...readToTerminator(host, address, 1, limit).bytes);
    /** @param {number} address @param {number} limit characters */
    const readWide = (address, limit = 512)=>{
        const bytes = readToTerminator(host, address, 2, limit).bytes.slice();
        const view = new DataView(bytes.buffer);
        let text = '';
        for (let at = 0; at + 1 < bytes.length; at += 2)
        {
            text += String.fromCharCode(view.getUint16(at, true));
        }
        return text;
    };
    /** @param {string} text */
    const ansiBytes = text=>Uint8Array.from([...text, '\0'], char=>char.charCodeAt(0) & 0xff);
    /** @param {string} text */
    const wideBytes = text=>{
        const bytes = new Uint8Array(text.length * 2 + 2);
        const view = new DataView(bytes.buffer);
        for (let at = 0; at < text.length; at++)
        {
            view.setUint16(at * 2, text.charCodeAt(at), true);
        }
        return bytes;
    };

    /** NET_LUID's NetLuidIndex, the 24 bits under the type. @param {bigint} luid */
    const luidIndex = luid=>Number((luid >> 24n) & 0xffffffn);
    /** The interface a NET_LUID names, or undefined. @param {bigint} luid */
    const byLuid = luid=>interfaces().find(one=>luidOf(one) === luid);
    /** @param {number} index */
    const byIndex = index=>interfaces().find(one=>one.index === index);
    /** The interface's name, as ConvertInterfaceLuidToName writes it. @param {InterfaceModel} one */
    const nameOf = one=>`${TYPE_NAMES[one.type] ?? `iftype${one.type}`}_${luidIndex(luidOf(one))}`;
    /** @param {number} prefix */
    const maskOf = prefix=>(prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0);
    /** The IPAddr a program hands over: the first octet low in the DWORD. @param {number} raw */
    const fromIpAddr = raw=>(((raw & 0xff) << 24) | ((raw >>> 8 & 0xff) << 16)
        | ((raw >>> 16 & 0xff) << 8) | (raw >>> 24 & 0xff)) >>> 0;

    /**
     * The IPv4 routes, as `route print` shows a machine with one adapter and
     * no gateway: the on-link network, the host and its broadcast on the
     * adapter while it has a network, the loopback's three, and multicast and
     * the limited broadcast on each interface that is up.
     */
    const routes = ()=>{
        /** @type {{ destination: number, prefix: number, nextHop: number, index: number,
         *     metric: number, direct: boolean }[]} */
        const out = [];
        for (const one of interfaces())
        {
            if (!one.up || one.address === null)
            {
                continue;
            }
            const mask = maskOf(one.prefix);
            const network = (one.address & mask) >>> 0;
            const onLink = one.type === MIB_IF_TYPE_LOOPBACK ? one.address : one.address;
            const metric = one.metric + 256;
            out.push({ destination: network, prefix: one.prefix, nextHop: onLink,
                index: one.index, metric, direct: true });
            out.push({ destination: one.address, prefix: 32, nextHop: onLink, index: one.index,
                metric, direct: true });
            out.push({ destination: (network | ~mask) >>> 0, prefix: 32, nextHop: onLink,
                index: one.index, metric, direct: true });
            out.push({ destination: 0xe0000000, prefix: 4, nextHop: onLink, index: one.index,
                metric, direct: true });
            out.push({ destination: 0xffffffff, prefix: 32, nextHop: onLink, index: one.index,
                metric, direct: true });
        }
        return out;
    };

    /**
     * The route a packet to `destination` takes: the longest prefix that
     * holds it, the lower metric between equals.
     *
     * @param {number} destination host order
     */
    const bestRoute = destination=>routes()
        .filter(route=>((destination & maskOf(route.prefix)) >>> 0) === route.destination)
        .sort((a, b)=>b.prefix - a.prefix || a.metric - b.metric)[0];

    /** The interfaces that have an IPv4 address. */
    const addressed = ()=>interfaces().filter(one=>one.address !== null);

    /**
     * The sockets the socket layer holds, as the TCP and UDP tables list
     * them: a listener or a connected stream, a bound datagram socket.
     */
    const sockets = ()=>(host.sockets?.() ?? []).filter(socket=>!socket.closed && socket.bound);

    /**
     * A table a caller sizes: the size with ERROR_INSUFFICIENT_BUFFER while
     * the buffer is short of it or absent, the table otherwise.
     *
     * @param {number} table @param {number} size @param {Uint8Array} bytes
     */
    const sized = (table, size, bytes)=>{
        if ((size >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((table >>> 0) === 0 || readU32(size >>> 0) < bytes.length)
        {
            writeU32(size >>> 0, bytes.length);
            return ERROR_INSUFFICIENT_BUFFER;
        }
        host.writeMemory(table >>> 0, bytes);
        return NO_ERROR;
    };

    /**
     * A table this library allocates and FreeMibTable frees.
     *
     * @param {number} out @param {Uint8Array} bytes
     */
    const allocated = (out, bytes)=>{
        const at = host.allocate?.(bytes.length) ?? 0;
        if (at === 0)
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        host.writeMemory(at >>> 0, bytes);
        writeU32(out >>> 0, at);
        return NO_ERROR;
    };

    /**
     * A count, then rows of `size` bytes from `head`, each filled by `fill`.
     *
     * @template T
     * @param {T[]} rows @param {number} size @param {number} head
     * @param {(view: DataView, at: number, row: T) => void} fill
     */
    const table = (rows, size, head, fill)=>{
        const bytes = new Uint8Array(head + rows.length * size);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, rows.length, true);
        rows.forEach((row, i)=>fill(view, head + i * size, row));
        return bytes;
    };

    /** A SOCKADDR_INET holding an IPv4 address. @param {DataView} view @param {number} at @param {number} address */
    const sockaddrInet = (view, at, address)=>{
        view.setUint16(at, AF_INET, true);
        view.setUint32(at + 4, address, false);
    };

    /** The routes as MIB_IPFORWARDROWs. @param {boolean} order */
    const forwardTable = order=>{
        const rows = routes();
        if (order)
        {
            rows.sort((a, b)=>a.destination - b.destination || a.prefix - b.prefix);
        }
        return table(rows, FORWARD_ROW, 4, (view, at, route)=>{
            view.setUint32(at, route.destination, false);
            view.setUint32(at + 4, maskOf(route.prefix), false);
            view.setUint32(at + 12, route.nextHop, false);
            view.setUint32(at + 16, route.index, true);
            view.setUint32(at + 20, route.direct ? ROUTE_DIRECT : ROUTE_INDIRECT, true);
            view.setUint32(at + 24, PROTO_LOCAL, true);
            view.setUint32(at + 36, route.metric, true);
            for (const unused of [40, 44, 48, 52])
            {
                view.setUint32(at + unused, 0xffffffff, true);
            }
        });
    };

    /** One MIB_IPFORWARDROW, for GetBestRoute. @param {ReturnType<typeof routes>[number]} route */
    const forwardRow = route=>{
        const bytes = new Uint8Array(FORWARD_ROW);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, route.destination, false);
        view.setUint32(4, maskOf(route.prefix), false);
        view.setUint32(12, route.nextHop, false);
        view.setUint32(16, route.index, true);
        view.setUint32(20, route.direct ? ROUTE_DIRECT : ROUTE_INDIRECT, true);
        view.setUint32(24, PROTO_LOCAL, true);
        view.setUint32(36, route.metric, true);
        for (const unused of [40, 44, 48, 52])
        {
            view.setUint32(unused, 0xffffffff, true);
        }
        return bytes;
    };

    /**
     * One MIB_IPFORWARD_ROW2 into `view` at `at`.
     *
     * @param {DataView} view @param {number} at @param {ReturnType<typeof routes>[number]} route
     */
    const forwardRow2 = (view, at, route)=>{
        const one = /** @type {InterfaceModel} */ (byIndex(route.index));
        view.setBigUint64(at + FORWARD_ROW2.LUID, luidOf(one), true);
        view.setUint32(at + FORWARD_ROW2.INDEX, route.index, true);
        sockaddrInet(view, at + FORWARD_ROW2.PREFIX, route.destination);
        view.setUint8(at + FORWARD_ROW2.PREFIX_LENGTH, route.prefix);
        sockaddrInet(view, at + FORWARD_ROW2.NEXT_HOP, 0);
        view.setUint32(at + FORWARD_ROW2.VALID_LIFETIME, 0xffffffff, true);
        view.setUint32(at + FORWARD_ROW2.PREFERRED_LIFETIME, 0xffffffff, true);
        view.setUint32(at + FORWARD_ROW2.METRIC, route.metric - one.metric, true);
        view.setUint32(at + FORWARD_ROW2.PROTOCOL, PROTO_LOCAL, true);
        view.setUint8(at + FORWARD_ROW2.LOOPBACK, one.type === MIB_IF_TYPE_LOOPBACK ? 1 : 0);
        view.setUint8(at + FORWARD_ROW2.AUTOCONFIGURE, 1);
        view.setUint8(at + FORWARD_ROW2.IMMORTAL, 0);
    };

    /**
     * The neighbours: the adapter's broadcast and the multicast groups it
     * belongs to, each a static entry, while it has a network.
     */
    const neighbours = ()=>{
        /** @type {{ index: number, address: number, physical: number[] }[]} */
        const out = [];
        for (const one of addressed())
        {
            if (one.type === MIB_IF_TYPE_LOOPBACK || !one.up)
            {
                continue;
            }
            const mask = maskOf(one.prefix);
            out.push({ index: one.index, address: ((one.address ?? 0) | ~mask) >>> 0,
                physical: [0xff, 0xff, 0xff, 0xff, 0xff, 0xff] });
            out.push({ index: one.index, address: 0xe0000016,
                physical: [0x01, 0x00, 0x5e, 0x00, 0x00, 0x16] });
        }
        return out;
    };

    /**
     * One MIB_UNICASTIPADDRESS_ROW for an interface's address.
     *
     * @param {DataView} view @param {number} at @param {InterfaceModel} one
     */
    const unicastRow = (view, at, one)=>{
        sockaddrInet(view, at, one.address ?? 0);
        view.setBigUint64(at + UNICAST_ROW.LUID, luidOf(one), true);
        view.setUint32(at + UNICAST_ROW.INDEX, one.index, true);
        const origin = one.dhcp ? ORIGIN_DHCP : ORIGIN_MANUAL;
        view.setUint32(at + UNICAST_ROW.PREFIX_ORIGIN, origin, true);
        view.setUint32(at + UNICAST_ROW.SUFFIX_ORIGIN, origin, true);
        view.setUint32(at + UNICAST_ROW.VALID_LIFETIME, 0xffffffff, true);
        view.setUint32(at + UNICAST_ROW.PREFERRED_LIFETIME, 0xffffffff, true);
        view.setUint8(at + UNICAST_ROW.PREFIX_LENGTH, one.prefix);
        view.setUint32(at + UNICAST_ROW.DAD_STATE, DAD_PREFERRED, true);
    };

    /**
     * An interface named by a row's LUID when it is set, else by its index.
     *
     * @param {number} row @param {number} luidField @param {number} indexField
     */
    const namedBy = (row, luidField, indexField)=>{
        const luid = readLuid(row + luidField);
        return luid !== 0n ? byLuid(luid) : byIndex(readU32(row + indexField));
    };

    /** A family a Vista table call takes. @param {number} family */
    const family4 = family=>family === AF_INET || family === AF_UNSPEC;

    /** Counters: zero traffic, and the counts that describe the machine. */
    const ipStats = ()=>{
        const bytes = new Uint8Array(23 * 4);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, 2, true);
        view.setUint32(4, 128, true);
        view.setUint32(80, interfaces().length, true);
        view.setUint32(84, addressed().length, true);
        view.setUint32(88, routes().length, true);
        return bytes;
    };
    const tcpStats = ()=>{
        const bytes = new Uint8Array(15 * 4);
        const view = new DataView(bytes.buffer);
        // MIB_TCP_RTO_VANJ, and the bounds Windows reports, in milliseconds.
        view.setUint32(0, 4, true);
        view.setUint32(4, 300, true);
        view.setUint32(8, 120000, true);
        view.setInt32(12, -1, true);
        const streams = sockets().filter(socket=>socket.type === SOCK_STREAM);
        view.setUint32(32, streams.filter(socket=>socket.connected).length, true);
        view.setUint32(56, streams.length, true);
        return bytes;
    };
    const udpStats = ()=>{
        const bytes = new Uint8Array(5 * 4);
        new DataView(bytes.buffer).setUint32(16,
            sockets().filter(socket=>socket.type !== SOCK_STREAM).length, true);
        return bytes;
    };

    /** The TCP table's rows from the socket layer, in the order asked. @param {boolean} order */
    const tcpRows = order=>{
        const rows = sockets().filter(socket=>socket.type === SOCK_STREAM
            && (socket.listening || socket.connected))
            .map(socket=>({
                state: socket.listening ? TCP_LISTEN : TCP_ESTABLISHED,
                local: socket.local,
                remote: socket.listening ? { host: 0, port: 0 } : socket.remote,
            }));
        if (order)
        {
            rows.sort((a, b)=>a.local.host - b.local.host || a.local.port - b.local.port
                || a.remote.host - b.remote.host || a.remote.port - b.remote.port);
        }
        return rows;
    };
    /** @param {boolean} order */
    const udpRows = order=>{
        const rows = sockets().filter(socket=>socket.type !== SOCK_STREAM)
            .map(socket=>socket.local);
        if (order)
        {
            rows.sort((a, b)=>a.host - b.host || a.port - b.port);
        }
        return rows;
    };

    /** A GUID as its registry text, in capitals. @param {Uint8Array} bytes */
    const guidText = bytes=>{
        const hex = (/** @type {number} */ byte)=>byte.toString(16).padStart(2, '0').toUpperCase();
        const order = [3, 2, 1, 0, -1, 5, 4, -1, 7, 6, -1, 8, 9, -1, 10, 11, 12, 13, 14, 15];
        return `{${order.map(at=>(at < 0 ? '-' : hex(bytes[at]))).join('')}}`;
    };

    /** An interface's MIB_IPINTERFACE_ROW for IPv4. @param {InterfaceModel} one */
    const ipInterfaceRow = one=>{
        const bytes = new Uint8Array(IP_INTERFACE_ROW.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(IP_INTERFACE_ROW.FAMILY, AF_INET, true);
        view.setBigUint64(IP_INTERFACE_ROW.LUID, luidOf(one), true);
        view.setUint32(IP_INTERFACE_ROW.INDEX, one.index, true);
        view.setUint32(IP_INTERFACE_ROW.MAX_REASSEMBLY, 0xffff, true);
        view.setUint8(IP_INTERFACE_ROW.USE_AUTOMATIC_METRIC, 1);
        view.setUint8(IP_INTERFACE_ROW.UNREACHABILITY_DETECTION, 1);
        view.setUint32(IP_INTERFACE_ROW.DAD_TRANSMITS, 3, true);
        view.setUint32(IP_INTERFACE_ROW.BASE_REACHABLE_TIME, 30000, true);
        view.setUint32(IP_INTERFACE_ROW.RETRANSMIT_TIME, 1000, true);
        view.setUint32(IP_INTERFACE_ROW.PATH_MTU_TIMEOUT, 600000, true);
        view.setUint32(IP_INTERFACE_ROW.METRIC, one.metric, true);
        view.setUint32(IP_INTERFACE_ROW.NL_MTU, one.mtu, true);
        view.setUint8(IP_INTERFACE_ROW.CONNECTED, one.up ? 1 : 0);
        view.setUint8(IP_INTERFACE_ROW.NEIGHBOR_DISCOVERY,
            one.type === MIB_IF_TYPE_LOOPBACK ? 0 : 1);
        view.setUint8(IP_INTERFACE_ROW.ROUTER_DISCOVERY,
            one.type === MIB_IF_TYPE_LOOPBACK ? 0 : 1);
        view.setUint32(IP_INTERFACE_ROW.REACHABLE_TIME, 30000, true);
        return bytes;
    };

    /** The change notifications handed out, by handle. */
    const notifications = new Set();
    let initialRefused = false;

    /**
     * A Notify*Change2 call: a handle, and no callback.
     *
     * @param {string} api
     */
    function notifier(api){
        return {
            argBytes: 20,
            /** @param {number[]} args */
            handler: (/** @type {number[]} */ [family, callback, , initial, handle])=>{
                if ((callback >>> 0) === 0 || (handle >>> 0) === 0
                    || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const opened = host.handles?.open('mib-change', { api }) ?? 0;
                notifications.add(opened);
                writeU32(handle >>> 0, opened);
                if ((initial & 0xff) !== 0 && !initialRefused)
                {
                    initialRefused = true;
                    host.divergence?.(api, 'the initial notification is not made');
                }
                return NO_ERROR;
            },
        };
    }

    /** The echoes ICMP has handed out handles for. */
    const echoHandles = new Set();
    let refusedEcho = false;

    /**
     * An echo request: answered at once where it reaches this machine, timed
     * out where it would have to leave it.
     *
     * @param {number} destination host order @param {number} data @param {number} size
     * @param {number} reply @param {number} replySize
     * @returns {{ replies: number, error: number }} the replies written, or
     *     none and why; a timeout leaves its status in the reply
     */
    const echo = (destination, data, size, reply, replySize)=>{
        if ((reply >>> 0) === 0 || replySize < ECHO_REPLY)
        {
            return { replies: 0, error: ERROR_INVALID_PARAMETER };
        }
        if (destination === 0 || destination === INADDR_NONE)
        {
            return { replies: 0, error: ERROR_INVALID_NETNAME };
        }
        if (replySize < ECHO_REPLY + size)
        {
            return { replies: 0, error: IP_BUF_TOO_SMALL };
        }
        const own = addressed().some(one=>one.address === destination);
        if (destination >>> 24 !== LOOPBACK_NET && !own)
        {
            if (!refusedEcho)
            {
                refusedEcho = true;
                host.divergence?.('ICMP',
                    'an echo beyond this machine times out: the network carries no ICMP');
            }
            const timedOut = new Uint8Array(ECHO_REPLY);
            const view = new DataView(timedOut.buffer);
            view.setUint32(0, destination, false);
            view.setUint32(4, IP_REQ_TIMED_OUT, true);
            host.writeMemory(reply >>> 0, timedOut);
            return { replies: 0, error: IP_REQ_TIMED_OUT };
        }
        const bytes = new Uint8Array(ECHO_REPLY);
        const view = new DataView(bytes.buffer);
        view.setUint32(0, destination, false);
        view.setUint32(4, IP_SUCCESS, true);
        view.setUint16(12, size, true);
        view.setUint32(16, (reply >>> 0) + ECHO_REPLY, true);
        view.setUint8(20, 128);
        host.writeMemory(reply >>> 0, bytes);
        if (size > 0 && (data >>> 0) !== 0)
        {
            host.writeMemory((reply >>> 0) + ECHO_REPLY, host.readMemory(data >>> 0, size).slice());
        }
        return { replies: 1, error: 0 };
    };

    /**
     * A synchronous echo's answer: the replies, the error set either way.
     *
     * @param {{ replies: number, error: number }} outcome
     */
    const answered = outcome=>{
        host.setLastError?.(outcome.error);
        return outcome.replies;
    };
    /**
     * An echo asked for with an event: its reply is already written, and the
     * call answers as an asynchronous one does - 0 with ERROR_IO_PENDING, the
     * event set - unless it failed before it was sent.
     *
     * @param {number} event @param {{ replies: number, error: number }} outcome
     */
    const overlapped = (event, outcome)=>{
        const refused = outcome.error === ERROR_INVALID_PARAMETER
            || outcome.error === ERROR_INVALID_NETNAME || outcome.error === IP_BUF_TOO_SMALL;
        if ((event >>> 0) === 0 || refused)
        {
            return answered(outcome);
        }
        host.signalEvent?.(event >>> 0);
        host.setLastError?.(ERROR_IO_PENDING);
        return 0;
    };

    /** An ICMP handle that is not one: ERROR_INVALID_HANDLE. */
    const badHandle = ()=>{
        host.setLastError?.(6);
        return 0;
    };

    return {
        /**
         * DWORD GetTcp6Table and GetUdp6Table: no IPv6 stack, so an empty
         * table - a count of zero.
         */
        GetTcp6Table: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size])=>sized(out, size, new Uint8Array(4)),
        },
        GetUdp6Table: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size])=>sized(out, size, new Uint8Array(4)),
        },

        /**
         * DWORD GetExtendedTcpTable(PVOID pTcpTable, PDWORD pdwSize, BOOL bOrder,
         *   ULONG ulAf, TCP_TABLE_CLASS TableClass, ULONG Reserved)
         *
         * The connections the socket layer holds, in the class asked:
         * basic rows, rows with the owner's process id, rows with its module
         * (a time and sixteen bytes of module information, zero here); the
         * listeners, the connections or both. IPv6 has none.
         */
        GetExtendedTcpTable: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, size, order, family, tableClass])=>{
                const kind = tableClass >>> 0;
                if ((size >>> 0) === 0 || kind > 8
                    || ((family >>> 0) !== AF_INET && (family >>> 0) !== AF_INET6))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                // BASIC_LISTENER, BASIC_CONNECTIONS, BASIC_ALL, then the same
                // three with the owner's id and with its module.
                const which = kind % 3;
                const rows = (family >>> 0) === AF_INET6 ? []
                    : tcpRows((order | 0) !== 0).filter(row=>which === 2
                        || (which === 0) === (row.state === TCP_LISTEN));
                const width = kind < 3 ? 20 : kind < 6 ? 24 : 160;
                const head = kind < 6 ? 4 : 8;
                const pid = host.processId?.() ?? 0;
                return sized(out, size, table(rows, width, head, (view, at, row)=>{
                    view.setUint32(at, row.state, true);
                    view.setUint32(at + 4, row.local.host, false);
                    view.setUint16(at + 8, row.local.port, false);
                    view.setUint32(at + 12, row.remote.host, false);
                    view.setUint16(at + 16, row.remote.port, false);
                    if (kind >= 3)
                    {
                        view.setUint32(at + 20, pid, true);
                    }
                }));
            },
        },

        /**
         * DWORD GetExtendedUdpTable(PVOID pUdpTable, PDWORD pdwSize, BOOL bOrder,
         *   ULONG ulAf, UDP_TABLE_CLASS TableClass, ULONG Reserved)
         */
        GetExtendedUdpTable: {
            argBytes: 24,
            /** @param {number[]} args */
            handler: ([out, size, order, family, tableClass])=>{
                const kind = tableClass >>> 0;
                if ((size >>> 0) === 0 || kind > 2
                    || ((family >>> 0) !== AF_INET && (family >>> 0) !== AF_INET6))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const rows = (family >>> 0) === AF_INET6 ? [] : udpRows((order | 0) !== 0);
                const width = kind === 0 ? 8 : kind === 1 ? 12 : 160;
                const head = kind < 2 ? 4 : 8;
                const pid = host.processId?.() ?? 0;
                return sized(out, size, table(rows, width, head, (view, at, local)=>{
                    view.setUint32(at, local.host, false);
                    view.setUint16(at + 4, local.port, false);
                    if (kind >= 1)
                    {
                        view.setUint32(at + 8, pid, true);
                    }
                }));
            },
        },

        /** NETIOAPI_API GetIpInterfaceTable(ADDRESS_FAMILY Family, PMIB_IPINTERFACE_TABLE *Table) */
        GetIpInterfaceTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                if ((out >>> 0) === 0 || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const rows = family4(family >>> 0) ? interfaces() : [];
                return allocated(out, table(rows, IP_INTERFACE_ROW.SIZE, TABLE2_HEAD,
                    (view, at, one)=>new Uint8Array(view.buffer).set(ipInterfaceRow(one), at)));
            },
        },

        /**
         * NotifyUnicastIpAddressChange, NotifyIpInterfaceChange and
         * NotifyRouteChange2 (Family, Callback, CallerContext,
         * InitialNotification, NotificationHandle): a handle for
         * CancelMibChangeNotify2. Nothing ever changes here - the address is
         * the run's - so the callback is never called for a change; the
         * initial notification Windows makes from a thread of its own is not
         * made, and said once.
         */
        NotifyUnicastIpAddressChange: notifier('NotifyUnicastIpAddressChange'),
        NotifyIpInterfaceChange: notifier('NotifyIpInterfaceChange'),
        NotifyRouteChange2: notifier('NotifyRouteChange2'),

        /** NETIOAPI_API CancelMibChangeNotify2(HANDLE NotificationHandle) */
        CancelMibChangeNotify2: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!notifications.delete(handle >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.handles?.close?.(handle >>> 0);
                return NO_ERROR;
            },
        },

        /**
         * NETIOAPI_API CreateSortedAddressPairs(const PSOCKADDR_IN6 SourceAddressList,
         *   ULONG SourceAddressCount, const PSOCKADDR_IN6 DestinationAddressList,
         *   ULONG DestinationAddressCount, ULONG AddressSortOptions,
         *   PSOCKADDR_IN6_PAIR *SortedAddressPairList, ULONG *SortedAddressPairCount)
         *
         * Each destination with the source this machine would send to it
         * from, in a list FreeMibTable frees: the pairs first, then the
         * addresses they point to. A source list is not taken, as on Windows.
         * IPv4 destinations come as IPv4-mapped IPv6 addresses; one this
         * machine has no route to keeps an unspecified source.
         */
        CreateSortedAddressPairs: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([sources, sourceCount, destinations, count, , out, outCount])=>{
                const n = count >>> 0;
                if ((sources >>> 0) !== 0 || (sourceCount >>> 0) !== 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((destinations >>> 0) === 0 || n === 0 || (out >>> 0) === 0
                    || (outCount >>> 0) === 0 || n > 500)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const pairs = n * 8;
                const bytes = new Uint8Array(pairs + n * 2 * SOCKADDR_IN6);
                const view = new DataView(bytes.buffer);
                const at = host.allocate?.(bytes.length) ?? 0;
                if (at === 0)
                {
                    return ERROR_NOT_ENOUGH_MEMORY;
                }
                for (let i = 0; i < n; i++)
                {
                    const wanted = host.readMemory((destinations >>> 0) + i * SOCKADDR_IN6,
                        SOCKADDR_IN6).slice();
                    const sourceAt = pairs + i * 2 * SOCKADDR_IN6;
                    const destinationAt = sourceAt + SOCKADDR_IN6;
                    bytes.set(wanted, destinationAt);
                    view.setUint16(sourceAt, AF_INET6, true);
                    const address = new DataView(wanted.buffer);
                    const mapped = address.getUint32(8, false) === 0
                        && address.getUint32(12, false) === 0
                        && address.getUint32(16, false) === 0xffff;
                    const route = mapped ? bestRoute(address.getUint32(20, false)) : undefined;
                    const from = route ? byIndex(route.index)?.address ?? null : null;
                    if (from !== null)
                    {
                        view.setUint32(sourceAt + 16, 0xffff, false);
                        view.setUint32(sourceAt + 20, from, false);
                    }
                    view.setUint32(i * 8, at + sourceAt, true);
                    view.setUint32(i * 8 + 4, at + destinationAt, true);
                }
                host.writeMemory(at >>> 0, bytes);
                writeU32(out >>> 0, at);
                writeU32(outCount >>> 0, n);
                return NO_ERROR;
            },
        },

        /** DWORD GetIfTable(PMIB_IFTABLE pIfTable, PULONG pdwSize, BOOL bOrder) */
        GetIfTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size, order])=>{
                const rows = interfaces().map(one=>one.index);
                if ((order | 0) !== 0)
                {
                    rows.sort((a, b)=>a - b);
                }
                const filled = rows.map(index=>/** @type {Uint8Array} */ (interfaceRow(index)));
                const size0 = filled[0]?.length ?? 0;
                return sized(out, size, table(filled, size0, 4,
                    (view, at, row)=>new Uint8Array(view.buffer).set(row, at)));
            },
        },

        /** NETIOAPI_API GetIfTable2Ex(MIB_IF_TABLE_LEVEL Level, PMIB_IF_TABLE2 *Table) */
        GetIfTable2Ex: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([level, out])=>{
                if ((out >>> 0) === 0 || (level >>> 0) > 2)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const all = interfaces();
                const rows = all.map(ifRow2);
                return allocated(out, table(rows, rows[0].length, TABLE2_HEAD,
                    (view, at, row)=>new Uint8Array(view.buffer).set(row, at)));
            },
        },

        /** DWORD GetIpForwardTable(PMIB_IPFORWARDTABLE pIpForwardTable, PULONG pdwSize, BOOL bOrder) */
        GetIpForwardTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size, order])=>sized(out, size, forwardTable((order | 0) !== 0)),
        },

        /** NETIOAPI_API GetIpForwardTable2(ADDRESS_FAMILY Family, PMIB_IPFORWARD_TABLE2 *Table) */
        GetIpForwardTable2: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                if ((out >>> 0) === 0 || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const rows = family4(family >>> 0) ? routes() : [];
                return allocated(out, table(rows, FORWARD_ROW2.SIZE, TABLE2_HEAD, forwardRow2));
            },
        },

        /** ULONG GetIpNetTable(PMIB_IPNETTABLE IpNetTable, PULONG SizePointer, BOOL Order) */
        GetIpNetTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size, order])=>{
                const rows = neighbours();
                if ((order | 0) !== 0)
                {
                    rows.sort((a, b)=>a.address - b.address);
                }
                if ((size >>> 0) !== 0 && rows.length === 0)
                {
                    return ERROR_NO_DATA;
                }
                return sized(out, size, table(rows, NET_ROW, 4, (view, at, row)=>{
                    view.setUint32(at, row.index, true);
                    view.setUint32(at + 4, row.physical.length, true);
                    row.physical.forEach((byte, i)=>view.setUint8(at + 8 + i, byte));
                    view.setUint32(at + 16, row.address, false);
                    view.setUint32(at + 20, NET_TYPE_STATIC, true);
                }));
            },
        },

        /** NETIOAPI_API GetIpNetTable2(ADDRESS_FAMILY Family, PMIB_IPNET_TABLE2 *Table) */
        GetIpNetTable2: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                if ((out >>> 0) === 0 || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const rows = family4(family >>> 0) ? neighbours() : [];
                return allocated(out, table(rows, NET_ROW2.SIZE, TABLE2_HEAD, (view, at, row)=>{
                    sockaddrInet(view, at, row.address);
                    view.setUint32(at + NET_ROW2.INDEX, row.index, true);
                    view.setBigUint64(at + NET_ROW2.LUID,
                        luidOf(/** @type {InterfaceModel} */ (byIndex(row.index))), true);
                    row.physical.forEach((byte, i)=>view.setUint8(at + NET_ROW2.PHYSICAL + i,
                        byte));
                    view.setUint32(at + NET_ROW2.PHYSICAL_LENGTH, row.physical.length, true);
                    view.setUint32(at + NET_ROW2.STATE, NL_PERMANENT, true);
                }));
            },
        },

        /** DWORD GetTcpTable(PMIB_TCPTABLE TcpTable, PULONG SizePointer, BOOL Order) */
        GetTcpTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size, order])=>sized(out, size,
                table(tcpRows((order | 0) !== 0), 20, 4, (view, at, row)=>{
                    view.setUint32(at, row.state, true);
                    view.setUint32(at + 4, row.local.host, false);
                    view.setUint16(at + 8, row.local.port, false);
                    view.setUint32(at + 12, row.remote.host, false);
                    view.setUint16(at + 16, row.remote.port, false);
                })),
        },

        /** DWORD GetUdpTable(PMIB_UDPTABLE UdpTable, PULONG SizePointer, BOOL Order) */
        GetUdpTable: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([out, size, order])=>sized(out, size,
                table(udpRows((order | 0) !== 0), 8, 4, (view, at, local)=>{
                    view.setUint32(at, local.host, false);
                    view.setUint16(at + 4, local.port, false);
                })),
        },

        /**
         * DWORD SetTcpEntry(PMIB_TCPROW pTcpRow): only MIB_TCP_STATE_DELETE_TCB
         * is a state a row can be set to; a connection this machine does not
         * hold is ERROR_NOT_FOUND.
         */
        SetTcpEntry: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([row])=>{
                if ((row >>> 0) === 0 || readU32(row >>> 0) !== TCP_DELETE_TCB)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                // As Windows answers for a connection it has no table entry for.
                return ERROR_MR_MID_NOT_FOUND;
            },
        },

        GetIpStatistics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>((out >>> 0) === 0 ? ERROR_INVALID_PARAMETER
                : (host.writeMemory(out >>> 0, ipStats()), NO_ERROR)),
        },
        GetIpStatisticsEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, family])=>statsEx(out, family, ipStats),
        },
        GetTcpStatistics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>((out >>> 0) === 0 ? ERROR_INVALID_PARAMETER
                : (host.writeMemory(out >>> 0, tcpStats()), NO_ERROR)),
        },
        GetTcpStatisticsEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, family])=>statsEx(out, family, tcpStats),
        },
        GetUdpStatistics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>((out >>> 0) === 0 ? ERROR_INVALID_PARAMETER
                : (host.writeMemory(out >>> 0, udpStats()), NO_ERROR)),
        },
        GetUdpStatisticsEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, family])=>statsEx(out, family, udpStats),
        },
        /** MIB_ICMP: the in and out MIBICMPSTATS, thirteen DWORDs each, all zero. */
        GetIcmpStatistics: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([out])=>((out >>> 0) === 0 ? ERROR_INVALID_PARAMETER
                : (host.writeMemory(out >>> 0, new Uint8Array(2 * 13 * 4)), NO_ERROR)),
        },
        /** MIB_ICMP_EX: messages, errors and 256 type counts, in then out. */
        GetIcmpStatisticsEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, family])=>statsEx(out, family, ()=>new Uint8Array(2 * 258 * 4)),
        },

        /**
         * DWORD GetNetworkParams(PFIXED_INFO pFixedInfo, PULONG pOutBufLen):
         * the machine's name, no domain, and no DNS server - names resolve
         * through the transport, not through a server this machine knows.
         */
        GetNetworkParams: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([out, size])=>{
                const bytes = new Uint8Array(584);
                const view = new DataView(bytes.buffer);
                bytes.set(ansiBytes((host.hostName?.() ?? 'BOTTLIFY').slice(0, 131)), 0);
                // The DNS server list's own address field, as Windows points at it.
                view.setUint32(268, 0, true);
                // BROADCAST_NODETYPE: no WINS server to ask.
                view.setUint32(312, 1, true);
                if ((size >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                if ((out >>> 0) === 0 || readU32(size >>> 0) < bytes.length)
                {
                    writeU32(size >>> 0, bytes.length);
                    return 111;
                }
                view.setUint32(264, (out >>> 0) + 268, true);
                host.writeMemory(out >>> 0, bytes);
                return NO_ERROR;
            },
        },

        /**
         * DWORD GetPerAdapterInfo(ULONG IfIndex, PIP_PER_ADAPTER_INFO
         *   pPerAdapterInfo, PULONG pOutBufLen): autoconfiguration on, not
         * active (the address is the network's), no DNS server.
         */
        GetPerAdapterInfo: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([index, out, size])=>{
                if ((size >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = byIndex(index >>> 0);
                if (!one)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const bytes = new Uint8Array(52);
                const view = new DataView(bytes.buffer);
                view.setUint32(0, one.type === MIB_IF_TYPE_LOOPBACK ? 0 : 1, true);
                if ((out >>> 0) === 0 || readU32(size >>> 0) < bytes.length)
                {
                    writeU32(size >>> 0, bytes.length);
                    return 111;
                }
                host.writeMemory(out >>> 0, bytes);
                return NO_ERROR;
            },
        },

        /** DWORD GetAdapterIndex(LPWSTR AdapterName, PULONG IfIndex) */
        GetAdapterIndex: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, out])=>{
                if ((name >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const wanted = readWide(name >>> 0).toUpperCase();
                const one = interfaces().find(each=>`\\DEVICE\\TCPIP_${each.guid}` === wanted);
                if (!one)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                writeU32(out >>> 0, one.index);
                return NO_ERROR;
            },
        },

        /** DWORD GetBestRoute(DWORD dwDestAddr, DWORD dwSourceAddr, PMIB_IPFORWARDROW pBestRoute) */
        GetBestRoute: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([destination, , out])=>{
                if ((out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const route = bestRoute(fromIpAddr(destination));
                if (!route)
                {
                    return ERROR_NETWORK_UNREACHABLE;
                }
                host.writeMemory(out >>> 0, forwardRow(route));
                return NO_ERROR;
            },
        },

        /** DWORD GetBestInterfaceEx(struct sockaddr *pDestAddr, PDWORD pdwBestIfIndex) */
        GetBestInterfaceEx: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([address, out])=>{
                if ((address >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const sockaddr = new DataView(host.readMemory(address >>> 0, 8).slice().buffer);
                if (sockaddr.getUint16(0, true) !== AF_INET)
                {
                    return sockaddr.getUint16(0, true) === AF_INET6
                        ? ERROR_NETWORK_UNREACHABLE : ERROR_INVALID_PARAMETER;
                }
                const route = bestRoute(sockaddr.getUint32(4, false));
                if (!route)
                {
                    return ERROR_NETWORK_UNREACHABLE;
                }
                writeU32(out >>> 0, route.index);
                return NO_ERROR;
            },
        },

        /**
         * NETIOAPI_API GetBestRoute2(NET_LUID *InterfaceLuid, NET_IFINDEX
         *   InterfaceIndex, const SOCKADDR_INET *SourceAddress, const
         *   SOCKADDR_INET *DestinationAddress, ULONG AddressSortOptions,
         *   PMIB_IPFORWARD_ROW2 BestRoute, SOCKADDR_INET *BestSourceAddress)
         */
        GetBestRoute2: {
            argBytes: 28,
            /** @param {number[]} args */
            handler: ([, , , destination, , out, source])=>{
                if ((destination >>> 0) === 0 || (out >>> 0) === 0 || (source >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const sockaddr = new DataView(host.readMemory(destination >>> 0, 8).slice().buffer);
                if (sockaddr.getUint16(0, true) !== AF_INET)
                {
                    return ERROR_NETWORK_UNREACHABLE;
                }
                const route = bestRoute(sockaddr.getUint32(4, false));
                if (!route)
                {
                    return ERROR_NETWORK_UNREACHABLE;
                }
                const row = new Uint8Array(FORWARD_ROW2.SIZE);
                forwardRow2(new DataView(row.buffer), 0, route);
                host.writeMemory(out >>> 0, row);
                const best = new Uint8Array(SOCKADDR_INET);
                sockaddrInet(new DataView(best.buffer), 0,
                    /** @type {InterfaceModel} */ (byIndex(route.index)).address ?? 0);
                host.writeMemory(source >>> 0, best);
                return NO_ERROR;
            },
        },

        /** NETIOAPI_API GetIpInterfaceEntry(PMIB_IPINTERFACE_ROW Row) */
        GetIpInterfaceEntry: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([row])=>{
                if ((row >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const family = readU32((row >>> 0) + IP_INTERFACE_ROW.FAMILY) & 0xffff;
                if (family !== AF_INET && family !== AF_INET6)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = namedBy(row >>> 0, IP_INTERFACE_ROW.LUID, IP_INTERFACE_ROW.INDEX);
                if (!one || family === AF_INET6)
                {
                    return ERROR_NOT_FOUND;
                }
                host.writeMemory(row >>> 0, ipInterfaceRow(one));
                return NO_ERROR;
            },
        },

        /** NETIOAPI_API GetUnicastIpAddressEntry(PMIB_UNICASTIPADDRESS_ROW Row) */
        GetUnicastIpAddressEntry: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([row])=>{
                if ((row >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const sockaddr = new DataView(host.readMemory(row >>> 0, 8).slice().buffer);
                const family = sockaddr.getUint16(0, true);
                if (family !== AF_INET && family !== AF_INET6)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = namedBy(row >>> 0, UNICAST_ROW.LUID, UNICAST_ROW.INDEX);
                if (!one)
                {
                    return ERROR_FILE_NOT_FOUND;
                }
                if (family === AF_INET6 || one.address !== sockaddr.getUint32(4, false))
                {
                    return ERROR_NOT_FOUND;
                }
                const bytes = new Uint8Array(UNICAST_ROW.SIZE);
                unicastRow(new DataView(bytes.buffer), 0, one);
                host.writeMemory(row >>> 0, bytes);
                return NO_ERROR;
            },
        },

        /** NETIOAPI_API GetUnicastIpAddressTable(ADDRESS_FAMILY Family, PMIB_UNICASTIPADDRESS_TABLE *Table) */
        GetUnicastIpAddressTable: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([family, out])=>{
                if ((out >>> 0) === 0 || ![AF_UNSPEC, AF_INET, AF_INET6].includes(family >>> 0))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const rows = family4(family >>> 0) ? addressed() : [];
                return allocated(out, table(rows, UNICAST_ROW.SIZE, TABLE2_HEAD, unicastRow));
            },
        },

        /** NETIO_STATUS ConvertInterfaceIndexToLuid(NET_IFINDEX InterfaceIndex, PNET_LUID InterfaceLuid) */
        ConvertInterfaceIndexToLuid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([index, luid])=>{
                if ((luid >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = byIndex(index >>> 0);
                writeLuid(luid >>> 0, one ? luidOf(one) : 0n);
                return one ? NO_ERROR : ERROR_FILE_NOT_FOUND;
            },
        },

        /** NETIO_STATUS ConvertInterfaceLuidToIndex(const NET_LUID *InterfaceLuid, PNET_IFINDEX InterfaceIndex) */
        ConvertInterfaceLuidToIndex: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([luid, index])=>{
                if ((luid >>> 0) === 0 || (index >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = byLuid(readLuid(luid >>> 0));
                writeU32(index >>> 0, one ? one.index : 0);
                return one ? NO_ERROR : ERROR_FILE_NOT_FOUND;
            },
        },

        /** NETIO_STATUS ConvertInterfaceLuidToGuid(const NET_LUID *InterfaceLuid, GUID *InterfaceGuid) */
        ConvertInterfaceLuidToGuid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([luid, guid])=>{
                if ((luid >>> 0) === 0 || (guid >>> 0) === 0)
                {
                    return ERROR_INVALID_PARAMETER;
                }
                const one = byLuid(readLuid(luid >>> 0));
                host.writeMemory(guid >>> 0, one ? guidBytes(one.guid) : new Uint8Array(16));
                return one ? NO_ERROR : ERROR_FILE_NOT_FOUND;
            },
        },

        ConvertInterfaceLuidToNameA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([luid, name, length])=>luidToText(luid, name, length, false, nameOf),
        },
        ConvertInterfaceLuidToNameW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([luid, name, length])=>luidToText(luid, name, length, true, nameOf),
        },
        ConvertInterfaceLuidToAlias: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([luid, alias, length])=>luidToText(luid, alias, length, true,
                one=>one.alias),
        },
        ConvertInterfaceNameToLuidA: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, luid])=>textToLuid(name, luid, false, nameOf),
        },
        ConvertInterfaceNameToLuidW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([name, luid])=>textToLuid(name, luid, true, nameOf),
        },
        ConvertInterfaceAliasToLuid: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([alias, luid])=>textToLuid(alias, luid, true, one=>one.alias),
        },

        /** NET_IFINDEX if_nametoindex(PCSTR InterfaceName): 0 for no such name. */
        if_nametoindex: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([name])=>{
                if ((name >>> 0) === 0)
                {
                    return 0;
                }
                const wanted = readAnsi(name >>> 0, 256);
                return interfaces().find(one=>nameOf(one) === wanted)?.index ?? 0;
            },
        },

        /** PCHAR if_indextoname(NET_IFINDEX InterfaceIndex, PCHAR InterfaceName) */
        if_indextoname: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([index, name])=>{
                const one = byIndex(index >>> 0);
                if (!one || (name >>> 0) === 0)
                {
                    return 0;
                }
                host.writeMemory(name >>> 0, ansiBytes(nameOf(one)));
                return name >>> 0;
            },
        },

        /** NETIO_STATUS ConvertLengthToIpv4Mask(ULONG MaskLength, PULONG Mask) */
        ConvertLengthToIpv4Mask: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([length, mask])=>{
                if ((length >>> 0) > 32)
                {
                    if ((mask >>> 0) !== 0)
                    {
                        writeU32(mask >>> 0, INADDR_NONE);
                    }
                    return ERROR_INVALID_PARAMETER;
                }
                const bytes = new Uint8Array(4);
                new DataView(bytes.buffer).setUint32(0, maskOf(length >>> 0), false);
                host.writeMemory(mask >>> 0, bytes);
                return NO_ERROR;
            },
        },

        ConvertGuidToStringA: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, out, length])=>guidToString(guid, out, length, false),
        },
        ConvertGuidToStringW: {
            argBytes: 12,
            /** @param {number[]} args */
            handler: ([guid, out, length])=>guidToString(guid, out, length, true),
        },

        /** DWORD ConvertStringToGuidW(PCWSTR String, GUID *Guid) */
        ConvertStringToGuidW: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([text, guid])=>{
                const value = (text >>> 0) === 0 ? '' : readWide(text >>> 0, 64);
                if (!/^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/i
                    .test(value))
                {
                    return ERROR_INVALID_PARAMETER;
                }
                host.writeMemory(guid >>> 0, guidBytes(value));
                return NO_ERROR;
            },
        },

        /** NET_IF_COMPARTMENT_ID GetCurrentThreadCompartmentId(void): the primary one. */
        GetCurrentThreadCompartmentId: {
            argBytes: 0,
            handler: ()=>1,
        },

        /** HANDLE IcmpCreateFile(void) */
        IcmpCreateFile: {
            argBytes: 0,
            handler: ()=>{
                const handle = host.handles?.open('icmp', {}) ?? 0;
                if (handle === 0)
                {
                    return INVALID_HANDLE_VALUE;
                }
                echoHandles.add(handle);
                return handle;
            },
        },

        /**
         * HANDLE Icmp6CreateFile(void): there is no IPv6 stack here, as on a
         * machine with IPv6 removed.
         */
        Icmp6CreateFile: {
            argBytes: 0,
            handler: ()=>{
                host.setLastError?.(ERROR_NOT_SUPPORTED);
                return INVALID_HANDLE_VALUE;
            },
        },

        /** BOOL IcmpCloseHandle(HANDLE IcmpHandle) */
        IcmpCloseHandle: {
            argBytes: 4,
            /** @param {number[]} args */
            handler: ([handle])=>{
                if (!echoHandles.delete(handle >>> 0))
                {
                    return 0;
                }
                host.handles?.close?.(handle >>> 0);
                return 1;
            },
        },

        /**
         * DWORD IcmpSendEcho(HANDLE IcmpHandle, IPAddr DestinationAddress,
         *   LPVOID RequestData, WORD RequestSize, PIP_OPTION_INFORMATION
         *   RequestOptions, LPVOID ReplyBuffer, DWORD ReplySize, DWORD Timeout)
         */
        IcmpSendEcho: {
            argBytes: 32,
            /** @param {number[]} args */
            handler: ([handle, destination, data, size, , reply, replySize])=>(
                echoHandles.has(handle >>> 0)
                    ? answered(echo(fromIpAddr(destination), data, size & 0xffff, reply,
                        replySize >>> 0))
                    : badHandle()),
        },

        /** IcmpSendEcho2, with an event and an APC routine this machine never needs to wait for. */
        IcmpSendEcho2: {
            argBytes: 44,
            /** @param {number[]} args */
            handler: ([handle, event, , , destination, data, size, , reply, replySize])=>(
                echoHandles.has(handle >>> 0)
                    ? overlapped(event, echo(fromIpAddr(destination), data, size & 0xffff, reply,
                        replySize >>> 0))
                    : badHandle()),
        },

        /** IcmpSendEcho2Ex, with a source address. */
        IcmpSendEcho2Ex: {
            argBytes: 48,
            /** @param {number[]} args */
            handler: ([handle, event, , , , destination, data, size, , reply, replySize])=>(
                echoHandles.has(handle >>> 0)
                    ? overlapped(event, echo(fromIpAddr(destination), data, size & 0xffff, reply,
                        replySize >>> 0))
                    : badHandle()),
        },

        /** Icmp6SendEcho2: no handle from Icmp6CreateFile is ever valid. */
        Icmp6SendEcho2: {
            argBytes: 48,
            handler: badHandle,
        },

        /** DWORD IcmpParseReplies(LPVOID ReplyBuffer, DWORD ReplySize): the replies the buffer holds. */
        IcmpParseReplies: {
            argBytes: 8,
            /** @param {number[]} args */
            handler: ([reply])=>{
                const count = (reply >>> 0) !== 0 && readU32((reply >>> 0) + 4) === IP_SUCCESS
                    && readU32(reply >>> 0) !== 0 ? 1 : 0;
                host.setLastError?.(count === 0 ? IP_REQ_TIMED_OUT : 0);
                return count;
            },
        },

        Icmp6ParseReplies: {
            argBytes: 8,
            handler: ()=>0,
        },

        /**
         * DWORD GetOwnerModuleFromTcpEntry(PMIB_TCPROW_OWNER_MODULE pTcpEntry,
         *   TCPIP_OWNER_MODULE_INFO_CLASS Class, PVOID pBuffer, PDWORD
         *   pdwSize), and the IPv6 form: the extended table lists no rows
         * with an owner, so no row is one this machine can name the owner of.
         */
        GetOwnerModuleFromTcpEntry: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([entry, , , size])=>((entry >>> 0) === 0 || (size >>> 0) === 0
                ? ERROR_INVALID_PARAMETER : ERROR_NOT_FOUND),
        },
        GetOwnerModuleFromTcp6Entry: {
            argBytes: 16,
            /** @param {number[]} args */
            handler: ([entry, , , size])=>((entry >>> 0) === 0 || (size >>> 0) === 0
                ? ERROR_INVALID_PARAMETER : ERROR_NOT_FOUND),
        },
    };

    /**
     * The Ex form of a statistics call: IPv4's counters, nothing for IPv6,
     * which this machine has no stack for.
     *
     * @param {number} out @param {number} family @param {() => Uint8Array} make
     */
    function statsEx(out, family, make){
        if ((out >>> 0) === 0 || ((family >>> 0) !== AF_INET && (family >>> 0) !== AF_INET6))
        {
            return ERROR_INVALID_PARAMETER;
        }
        if ((family >>> 0) === AF_INET6)
        {
            return ERROR_NOT_SUPPORTED;
        }
        host.writeMemory(out >>> 0, make());
        return NO_ERROR;
    }

    /**
     * An interface's name or alias by its LUID, into a buffer of `length`
     * characters; ERROR_NOT_ENOUGH_MEMORY where it does not fit with its
     * terminator.
     *
     * @param {number} luid @param {number} out @param {number} length
     * @param {boolean} wide @param {(one: InterfaceModel) => string} textOf
     */
    function luidToText(luid, out, length, wide, textOf){
        if ((luid >>> 0) === 0 || (out >>> 0) === 0 || (length >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const one = byLuid(readLuid(luid >>> 0));
        if (!one)
        {
            return ERROR_FILE_NOT_FOUND;
        }
        const text = textOf(one);
        if (text.length + 1 > (length >>> 0))
        {
            return ERROR_NOT_ENOUGH_MEMORY;
        }
        host.writeMemory(out >>> 0, wide ? wideBytes(text) : ansiBytes(text));
        return NO_ERROR;
    }

    /**
     * The LUID of the interface a name or alias names.
     *
     * @param {number} text @param {number} luid @param {boolean} wide
     * @param {(one: InterfaceModel) => string} textOf
     */
    function textToLuid(text, luid, wide, textOf){
        if ((text >>> 0) === 0 || (luid >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const wanted = wide ? readWide(text >>> 0, 257) : readAnsi(text >>> 0, 257);
        const one = interfaces().find(each=>textOf(each).toLowerCase() === wanted.toLowerCase());
        writeLuid(luid >>> 0, one ? luidOf(one) : 0n);
        return one ? NO_ERROR : ERROR_INVALID_PARAMETER;
    }

    /**
     * A GUID as `{XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX}` into a buffer of
     * `length` characters.
     *
     * @param {number} guid @param {number} out @param {number} length @param {boolean} wide
     */
    function guidToString(guid, out, length, wide){
        if ((guid >>> 0) === 0 || (out >>> 0) === 0)
        {
            return ERROR_INVALID_PARAMETER;
        }
        const text = guidText(host.readMemory(guid >>> 0, 16).slice());
        if ((length >>> 0) < text.length + 1)
        {
            return ERROR_INSUFFICIENT_BUFFER;
        }
        host.writeMemory(out >>> 0, wide ? wideBytes(text) : ansiBytes(text));
        return NO_ERROR;
    }
}
