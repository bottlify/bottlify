/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Seeking passed upstream, as the SDK's CPosPassThru passes it: a filter
 * downstream of the one that can seek - a renderer, a transform - answers
 * IMediaSeeking and IMediaPosition by asking the output pin its input is
 * connected to, method for method, so a graph that asks a renderer to seek
 * moves the source. Unconnected, there is nobody to ask: E_NOTIMPL, as
 * CPosPassThru answers.
 *
 * CLSID_SeekingPassThru is the same as an object of its own: a filter a
 * program writes hands it its input pin with ISeekingPassThru::Init and
 * answers seeking with it.
 */

import { describe } from './describe.js';
import {
    IID_IMEDIA_POSITION, IID_IMEDIA_SEEKING, IMEDIA_POSITION_SLOTS, IMEDIA_SEEKING_SLOTS,
} from './interfaces.js';

const S_OK = 0x00000000;
const E_NOTIMPL = 0x80004001 | 0;
const E_POINTER = 0x80004003 | 0;
const E_UNEXPECTED = 0x8000ffff | 0;
const VFW_E_NOT_CONNECTED = 0x80040209 | 0;

export const CLSID_SEEKING_PASS_THRU = '{060AF76C-68DD-11D0-8FC1-00C04FD9189D}';
export const IID_ISEEKING_PASS_THRU = '{36B73883-C2C8-11CF-8B46-00805F6CEF60}';
/** @type {[string, number][]} */
const ISEEKING_PASS_THRU_SLOTS = [['Init', 2]];

/** IUnknown's three slots come before an interface's own. */
const FIRST = 3;
/** IPin::ConnectedTo, IUnknown's three counted. */
const PIN_CONNECTED_TO = 6;
/** IDispatch's four methods open IMediaPosition, a dual interface. */
const DISPATCH = new Set(['GetTypeInfoCount', 'GetTypeInfo', 'GetIDsOfNames', 'Invoke']);

/**
 * The passing-through over one filter base.
 *
 * @param {ReturnType<typeof import('./filter.js').createFilterBase>} base
 * @param {import('./filter.js').FilterHost} host
 */
export function createPassThru(base, host){
    /**
     * Methods of one interface that ask the upstream pin's.
     *
     * @param {string} iid @param {import('./describe.js').Slot[]} slots
     * @param {(state: any) => number | Promise<number>} upstream  The output pin
     *     to ask, 0 where there is none.
     * @param {number} unconnected  The answer where there is none.
     */
    const forwarding = (iid, slots, upstream, unconnected)=>Object.fromEntries(slots.map(
        ([name], index)=>[
            name,
            DISPATCH.has(name)
                ? (/** @type {any} */ _state, /** @type {number[]} */ args)=>{
                // An IDispatch caller asks for type information this one has
                // none of: no type info, and the methods by vtable only.
                    if (name === 'GetTypeInfoCount')
                    {
                        if ((args[0] >>> 0) === 0)
                        {
                            return E_POINTER;
                        }
                        host.writeMemory(args[0] >>> 0, new Uint8Array(4));
                        return S_OK;
                    }
                    return E_NOTIMPL;
                }
                : async(/** @type {any} */ state, /** @type {number[]} */ args)=>{
                    const pin = await upstream(state);
                    if (pin === 0)
                    {
                        return unconnected;
                    }
                    const face = await base.queryInterface(pin, iid);
                    if (face === 0)
                    {
                        return E_NOTIMPL;
                    }
                    const answer = await base.call(face, FIRST + index, args);
                    await base.release(face);
                    return answer;
                },
        ]));

    /**
     * IMediaSeeking and IMediaPosition passed to `upstream`'s.
     *
     * @param {(state: any) => number | Promise<number>} upstream
     * @param {number} [unconnected]  The answer with nothing upstream: a
     *     filter's own seeking says E_NOTIMPL, as CPosPassThru does; a
     *     transform's output pin VFW_E_NOT_CONNECTED, its input not being.
     * @returns {import('../ole32/objects.js').ComInterfaceDescriptor[]}
     */
    const seekingFaces = (upstream, unconnected = E_NOTIMPL)=>[
        describe(IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS,
            forwarding(IID_IMEDIA_SEEKING, IMEDIA_SEEKING_SLOTS, upstream, unconnected)),
        describe(IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS,
            forwarding(IID_IMEDIA_POSITION, IMEDIA_POSITION_SLOTS, upstream, unconnected)),
    ];

    /**
     * The output pin an input pin is connected to, asked of the pin
     * (IPin::ConnectedTo); 0 unconnected. The reference ConnectedTo hands
     * back is let go at once: the connection holds the pin.
     *
     * @param {number} input
     */
    const connectedTo = async input=>{
        if (input === 0)
        {
            return 0;
        }
        const slot = host.allocate(4);
        host.writeMemory(slot, new Uint8Array(4));
        const answer = await base.call(input, PIN_CONNECTED_TO, [slot]);
        const peer = host.readU32(slot);
        host.free(slot);
        if ((answer | 0) < 0 || peer === 0)
        {
            return 0;
        }
        await base.release(peer);
        return peer;
    };

    /**
     * @typedef {Object} PassThruState
     * @property {number} pin       The input pin Init was given, one reference held.
     * @property {boolean} rendering
     */

    /** @returns {import('../ole32/objects.js').ComClassDefinition} */
    const seekingPassThru = ()=>{
        /** @type {PassThruState} */
        const own = { pin: 0, rendering: false };
        return {
            state: own,
            aggregatable: true,
            // The pin's reference goes inside the program's last Release, on its thread.
            lastRelease: async()=>{
                if (own.pin !== 0)
                {
                    const pin = own.pin;
                    own.pin = 0;
                    await base.release(pin);
                }
            },
            interfaces: [
                describe(IID_ISEEKING_PASS_THRU, ISEEKING_PASS_THRU_SLOTS, {
                /** HRESULT Init(BOOL bSupportRendering, IPin *pPin) */
                    Init: async(/** @type {PassThruState} */ state, [rendering, pin])=>{
                        if ((pin >>> 0) === 0)
                        {
                            return E_POINTER;
                        }
                        if (state.pin !== 0)
                        {
                            return E_UNEXPECTED;
                        }
                        await base.addRef(pin >>> 0);
                        state.pin = pin >>> 0;
                        state.rendering = (rendering | 0) !== 0;
                        return S_OK;
                    },
                }),
                ...seekingFaces(async(/** @type {PassThruState} */ state)=>(state.pin === 0 ? 0
                    : connectedTo(state.pin))),
            ],
        };
    };

    return { seekingFaces, seekingPassThru, connectedTo, VFW_E_NOT_CONNECTED };
}
