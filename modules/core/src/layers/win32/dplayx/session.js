/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The DirectPlay session object. Unbound it answers DPERR_UNINITIALIZED, as
 * Windows's does. It knows one connection, TCP/IP, and once bound to it hosts
 * a session on this machine: the players are all local, and a message one
 * sends is queued for the others here. Nobody joins from elsewhere and there is
 * no session elsewhere to join; a program that hosts a game only it plays -- a
 * single-player game run over its multiplayer engine -- gets one that works.
 */

/** dplay.h: MAKE_HRESULT(1, _FACDP = 0x877, code). */
const dpError = (/** @type {number} */ code)=>(0x88770000 | code) >>> 0;
export const DP_OK = 0;
export const DPERR_ALREADYINITIALIZED = dpError(5);
export const DPERR_BUFFERTOOSMALL = dpError(30);
export const DPERR_INVALIDPLAYER = dpError(150);
export const DPERR_NOMESSAGES = dpError(190);
export const DPERR_NOSESSIONS = dpError(220);
export const DPERR_UNAVAILABLE = dpError(250);
export const DPERR_UNINITIALIZED = dpError(320);
export const DPERR_INVALIDPARAMS = 0x80070057;
export const DPERR_UNSUPPORTED = 0x80004001;

/** dpaddr.h / dplay.h: the one provider, and the address chunk naming it. */
export const DPSPGUID_TCPIP = '{36E95EE0-8577-11CF-960C-0080C7534E82}';
export const DPAID_SERVICEPROVIDER = '{07D916C0-E0AF-11CF-9C4E-00A0C905425E}';
const TCPIP_NAME = 'Internet TCP/IP Connection For DirectPlay';
const DPOPEN_CREATE = 2;
const DPRECEIVE_TOPLAYER = 2;
const DPRECEIVE_FROMPLAYER = 4;
const DPRECEIVE_PEEK = 8;
const DPID_ALLPLAYERS = 0;
const DPPLAYERTYPE_PLAYER = 1;
const DPENUMPLAYERS_LOCAL = 8;
const DPCAPS_ISHOST = 0x80;
const DPSESSIONDESC2_SIZE = 80;
const DPCAPS_SIZE = 40;
const DPNAME_SIZE = 16;

/** @param {string} guid @returns {Uint8Array} the GUID as it lies in memory */
export const guidBytes = guid=>{
    const hex = guid.replace(/[{}-]/g, '');
    const out = new Uint8Array(16);
    const view = new DataView(out.buffer);
    view.setUint32(0, parseInt(hex.slice(0, 8), 16), true);
    view.setUint16(4, parseInt(hex.slice(8, 12), 16), true);
    view.setUint16(6, parseInt(hex.slice(12, 16), 16), true);
    for (let i = 0; i < 8; i++)
    {
        out[8 + i] = parseInt(hex.slice(16 + 2 * i, 18 + 2 * i), 16);
    }
    return out;
};

/**
 * @typedef {Object} SessionHost
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(bytes: number) => number} [allocate]
 * @property {(entry: number, args: number[], thread?: any) => Promise<number>} [callGuest]
 * @property {() => any} [callerThread]
 */

/**
 * @typedef {Object} PlayInterface
 * @property {string} id
 * @property {string} list   "Name argBytes" pairs in vtable order after IUnknown.
 * @property {number} count  How many of them this revision has.
 * @property {boolean} wide  Whether its strings are UTF-16.
 */

/** @param {Uint8Array} bytes */
const view = bytes=>new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** @param {string} text @param {boolean} wide */
const stringBytes = (text, wide)=>{
    const out = new Uint8Array((text.length + 1) * (wide ? 2 : 1));
    for (let i = 0; i < text.length; i++)
    {
        if (wide)
        {
            view(out).setUint16(2 * i, text.charCodeAt(i), true);
        }
        else
        {
            out[i] = text.charCodeAt(i) & 0xff;
        }
    }
    return out;
};

/**
 * A DPNAME followed by its strings, laid out for the address it will be
 * written at.
 *
 * @param {number} at @param {string | null} short @param {string | null} long
 * @param {boolean} wide
 */
const nameBytes = (at, short, long, wide)=>{
    const parts = [short, long].map(text=>(text === null ? null : stringBytes(text, wide)));
    const block = new Uint8Array(DPNAME_SIZE + parts.reduce((n, p)=>n + (p?.length ?? 0), 0));
    view(block).setUint32(0, DPNAME_SIZE, true);
    let tail = DPNAME_SIZE;
    parts.forEach((part, index)=>{
        if (part)
        {
            view(block).setUint32(8 + 4 * index, at + tail, true);
            block.set(part, tail);
            tail += part.length;
        }
    });
    return block;
};

/**
 * @param {SessionHost} host
 * @param {readonly PlayInterface[]} revisions
 * @returns {import('../ole32/objects.js').ComClassDefinition}
 */
export function sessionDefinition(host, revisions){
    const u32 = (/** @type {number} */ at)=>view(host.readMemory(at >>> 0, 4)).getUint32(0, true);
    /** @param {number} at @param {number} value */
    const put32 = (at, value)=>{
        const bytes = new Uint8Array(4);
        view(bytes).setUint32(0, value >>> 0, true);
        host.writeMemory(at >>> 0, bytes);
    };
    /** @param {number} at @param {boolean} wide */
    const readString = (at, wide)=>{
        if ((at >>> 0) === 0)
        {
            return null;
        }
        let text = '';
        for (let i = 0; i < 512; i++)
        {
            const code = wide ? view(host.readMemory(at + 2 * i, 2)).getUint16(0, true)
                : host.readMemory(at + i, 1)[0];
            if (code === 0)
            {
                break;
            }
            text += String.fromCharCode(code);
        }
        return text;
    };
    /**
     * A DPNAME the caller is given for the length of a callback; 0 when there
     * is no memory.
     *
     * @param {string | null} short @param {string | null} long @param {boolean} wide
     */
    const lentName = (short, long, wide)=>{
        const size = nameBytes(0, short, long, wide).length;
        const at = host.allocate?.(size) ?? 0;
        if (at !== 0)
        {
            host.writeMemory(at, nameBytes(at, short, long, wide));
        }
        return at;
    };
    /**
     * Writes a variable-sized answer the DirectPlay way: the size it needs
     * always, the bytes only when the caller's buffer holds them.
     *
     * @param {number} data @param {number} sizeAt @param {(at: number) => Uint8Array} make
     */
    const sized = (data, sizeAt, make)=>{
        if ((sizeAt >>> 0) === 0)
        {
            return DPERR_INVALIDPARAMS;
        }
        const bytes = make(data >>> 0);
        const room = u32(sizeAt);
        put32(sizeAt, bytes.length);
        if ((data >>> 0) === 0 || room < bytes.length)
        {
            return DPERR_BUFFERTOOSMALL;
        }
        host.writeMemory(data >>> 0, bytes);
        return DP_OK;
    };
    /** Runs a guest callback per item, stopping when it answers FALSE. */
    const each = (/** @type {number} */ callback, /** @type {number[][]} */ calls)=>{
        const run = host.callGuest;
        if (calls.length === 0 || !run)
        {
            return DP_OK;
        }
        const thread = host.callerThread?.();
        return (async()=>{
            for (const args of calls)
            {
                if ((await run(callback >>> 0, args, thread)) === 0)
                {
                    break;
                }
            }
            return DP_OK;
        })();
    };

    let bound = false;
    /** @type {Uint8Array | null} */
    let session = null;
    /** @type {string | null} */
    let sessionName = null;
    let nextPlayer = 0x1001;
    /** @type {Map<number, { short: string | null, long: string | null, data: Uint8Array }>} */
    const players = new Map();
    /** @type {{ from: number, to: number, bytes: Uint8Array }[]} */
    let queue = [];

    /** @param {number} at a DPCAPS to fill */
    const writeCaps = at=>{
        if ((at >>> 0) === 0 || u32(at) < DPCAPS_SIZE)
        {
            return DPERR_INVALIDPARAMS;
        }
        const caps = new Uint8Array(DPCAPS_SIZE);
        const v = view(caps);
        v.setUint32(0, DPCAPS_SIZE, true);
        v.setUint32(4, DPCAPS_ISHOST, true);
        v.setUint32(8, 0xffffffff, true);
        v.setUint32(16, 0x10, true);
        v.setUint32(28, 0x10, true);
        v.setUint32(36, 5000, true);
        host.writeMemory(at >>> 0, caps);
        return DP_OK;
    };
    /** @param {number} name a DPNAME, or 0 @param {boolean} wide */
    const readName = (name, wide)=>({
        short: name ? readString(u32(name + 8), wide) : null,
        long: name ? readString(u32(name + 12), wide) : null,
    });
    /** A session description as kept: its strings dropped, its name aside. */
    const keepSession = (/** @type {number} */ desc, /** @type {boolean} */ wide)=>{
        const kept = host.readMemory(desc >>> 0, DPSESSIONDESC2_SIZE).slice();
        sessionName = readString(view(kept).getUint32(48, true), wide);
        view(kept).setUint32(48, 0, true);
        view(kept).setUint32(52, 0, true);
        return kept;
    };

    /** @type {Record<string, (args: number[], wide: boolean) => number | Promise<number>>} */
    const methods = {
        Close: ()=>{
            session = null;
            players.clear();
            queue = [];
            return DP_OK;
        },
        // Open(DPSESSIONDESC2 *, flags): only DPOPEN_CREATE has a session to
        // open; there is none elsewhere to join.
        Open: ([desc, flags], wide)=>{
            if ((desc >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            if ((flags & DPOPEN_CREATE) === 0)
            {
                return DPERR_NOSESSIONS;
            }
            session = keepSession(desc, wide);
            crypto.getRandomValues(session.subarray(8, 24));
            return DP_OK;
        },
        // CreatePlayer(id *, name, event, data, size, flags)
        CreatePlayer: ([out, name, , data, size], wide)=>{
            if ((out >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            const id = nextPlayer++;
            players.set(id, {
                ...readName(name, wide),
                data: data && size ? host.readMemory(data >>> 0, size >>> 0).slice()
                    : new Uint8Array(0),
            });
            put32(out, id);
            return DP_OK;
        },
        DestroyPlayer: ([id])=>{
            queue = queue.filter(m=>m.to !== (id >>> 0));
            return players.delete(id >>> 0) ? DP_OK : DPERR_INVALIDPLAYER;
        },
        // EnumPlayers(session GUID *, callback, context, flags)
        EnumPlayers: ([, callback, context], wide)=>{
            if ((callback >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            return each(callback, [...players].map(([id, player])=>[id, DPPLAYERTYPE_PLAYER,
                lentName(player.short, player.long, wide), DPENUMPLAYERS_LOCAL, context >>> 0]));
        },
        EnumGroups: ()=>DP_OK,
        EnumGroupPlayers: ()=>DP_OK,
        EnumSessions: ()=>DP_OK,
        GetCaps: ([caps])=>writeCaps(caps),
        GetPlayerCaps: ([id, caps])=>(players.has(id >>> 0) ? writeCaps(caps)
            : DPERR_INVALIDPLAYER),
        GetMessageCount: ([id, out])=>{
            if ((out >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            put32(out, queue.filter(m=>m.to === (id >>> 0)).length);
            return DP_OK;
        },
        GetPlayerData: ([id, data, sizeAt])=>{
            const player = players.get(id >>> 0);
            return player ? sized(data, sizeAt, ()=>player.data) : DPERR_INVALIDPLAYER;
        },
        SetPlayerData: ([id, data, size])=>{
            const player = players.get(id >>> 0);
            if (!player)
            {
                return DPERR_INVALIDPLAYER;
            }
            player.data = data && size ? host.readMemory(data >>> 0, size >>> 0).slice()
                : new Uint8Array(0);
            return DP_OK;
        },
        GetPlayerName: ([id, data, sizeAt], wide)=>{
            const player = players.get(id >>> 0);
            return player ? sized(data, sizeAt, at=>nameBytes(at, player.short, player.long, wide))
                : DPERR_INVALIDPLAYER;
        },
        SetPlayerName: ([id, name], wide)=>{
            const player = players.get(id >>> 0);
            if (!player)
            {
                return DPERR_INVALIDPLAYER;
            }
            Object.assign(player, readName(name, wide));
            return DP_OK;
        },
        GetSessionDesc: ([data, sizeAt], wide)=>{
            const kept = session;
            if (!kept)
            {
                return DPERR_NOSESSIONS;
            }
            return sized(data, sizeAt, at=>{
                const name = sessionName === null ? null : stringBytes(sessionName, wide);
                const block = new Uint8Array(DPSESSIONDESC2_SIZE + (name?.length ?? 0));
                block.set(kept);
                view(block).setUint32(44, players.size, true);
                if (name)
                {
                    view(block).setUint32(48, at + DPSESSIONDESC2_SIZE, true);
                    block.set(name, DPSESSIONDESC2_SIZE);
                }
                return block;
            });
        },
        SetSessionDesc: ([desc], wide)=>{
            const kept = session;
            if (!kept || (desc >>> 0) === 0)
            {
                return DPERR_NOSESSIONS;
            }
            session = keepSession(desc, wide);
            session.set(kept.subarray(8, 24), 8);
            return DP_OK;
        },
        // Send(from, to, flags, data, size): to every other player here, or
        // to the one named.
        Send: ([from, to, , data, size])=>{
            if (!players.has(from >>> 0) || (to !== DPID_ALLPLAYERS && !players.has(to >>> 0)))
            {
                return DPERR_INVALIDPLAYER;
            }
            const bytes = host.readMemory(data >>> 0, size >>> 0).slice();
            const targets = to === DPID_ALLPLAYERS
                ? [...players.keys()].filter(id=>id !== (from >>> 0)) : [to >>> 0];
            for (const target of targets)
            {
                queue.push({ from: from >>> 0, to: target, bytes });
            }
            return DP_OK;
        },
        // Receive(from *, to *, flags, data, size *)
        Receive: ([fromAt, toAt, flags, data, sizeAt])=>{
            if ((sizeAt >>> 0) === 0)
            {
                return DPERR_INVALIDPARAMS;
            }
            const wantFrom = (flags & DPRECEIVE_FROMPLAYER) && fromAt ? u32(fromAt) : null;
            const wantTo = (flags & DPRECEIVE_TOPLAYER) && toAt ? u32(toAt) : null;
            const index = queue.findIndex(m=>(wantFrom === null || m.from === wantFrom)
                && (wantTo === null || m.to === wantTo));
            if (index < 0)
            {
                return DPERR_NOMESSAGES;
            }
            const message = queue[index];
            const answer = sized(data, sizeAt, ()=>message.bytes);
            if (answer !== DP_OK)
            {
                return answer;
            }
            if (fromAt)
            {
                put32(fromAt, message.from);
            }
            if (toAt)
            {
                put32(toAt, message.to);
            }
            if ((flags & DPRECEIVE_PEEK) === 0)
            {
                queue.splice(index, 1);
            }
            return DP_OK;
        },
        StartSession: ()=>DP_OK,
    };

    /**
     * EnumConnections(application GUID *, callback, context, flags): the one
     * connection, TCP/IP, its address a DPAID_ServiceProvider chunk.
     *
     * @param {number[]} args @param {boolean} wide
     */
    const enumConnections = ([, callback, context], wide)=>{
        if ((callback >>> 0) === 0)
        {
            return DPERR_INVALIDPARAMS;
        }
        const address = host.allocate?.(52) ?? 0;
        if (address === 0)
        {
            return DP_OK;
        }
        const block = new Uint8Array(52);
        block.set(guidBytes(DPAID_SERVICEPROVIDER), 0);
        view(block).setUint32(16, 16, true);
        block.set(guidBytes(DPSPGUID_TCPIP), 20);
        block.set(guidBytes(DPSPGUID_TCPIP), 36);
        host.writeMemory(address, block);
        return each(callback, [[address + 36, address, 36,
            lentName(TCPIP_NAME, null, wide), 0, context >>> 0]]);
    };

    /** @param {string} name @param {boolean} wide */
    const answer = (name, wide)=>(/** @type {any} */ _, /** @type {number[]} */ args)=>{
        if (name === 'EnumConnections')
        {
            return enumConnections(args, wide);
        }
        if (name === 'InitializeConnection')
        {
            if (bound)
            {
                return DPERR_ALREADYINITIALIZED;
            }
            bound = true;
            return DP_OK;
        }
        if (name === 'Initialize')
        {
            return DPERR_UNAVAILABLE;
        }
        if (!bound)
        {
            return DPERR_UNINITIALIZED;
        }
        return methods[name]?.(args, wide) ?? DPERR_UNSUPPORTED;
    };

    return {
        interfaces: revisions.map(({ id, list, count, wide })=>{
            const words = list.split(' ');
            return {
                id,
                methods: Array.from({ length: count }, (_, i)=>({
                    name: words[2 * i],
                    argBytes: Number(words[2 * i + 1]),
                    invoke: answer(words[2 * i], wide),
                })),
            };
        }),
    };
}
