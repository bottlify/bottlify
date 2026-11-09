/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Direct3D 11's device contexts over the one device both versions share
 * (`../d3d10/device.js`).
 *
 * Direct3D 10 put the pipeline on the device; Direct3D 11 moved it to a
 * context and left the creates on the device. Here the device keeps both,
 * so the immediate context is the device's pipeline under another
 * interface: each of its calls is the device's method of the same name, the
 * one Direct3D 10's device calls too, and the command ring and a recording
 * see one call either way.
 *
 * A deferred context holds a pipeline of its own, which its getters answer
 * from, and records every call it is given; `FinishCommandList` hands the
 * record over as a command list, which the immediate context plays on the
 * device (`ExecuteCommandList`). A list starts from a cleared pipeline, as
 * the API says one does, and holds a reference on every object it names
 * until it is released.
 */

import {
    D3D11_DEVICE_CONTEXT, DXGI_ERROR_INVALID_CALL, E_UNEXPECTED, IID, S_OK,
} from '../d3d10/constants.js';
import { attachCom } from '../d3d10/com.js';
import { bindingsOf, copyPipeline, createPipelineState } from '../d3d10/pipeline.js';

/**
 * The calls a context makes on the pipeline and its resources, past the
 * bindings' own setters and getters (`pipeline.js`): what an immediate
 * context hands to the device and a deferred one records.
 */
export const CONTEXT_COMMANDS = Object.freeze([
    'Draw', 'DrawIndexed', 'DrawInstanced', 'DrawIndexedInstanced', 'DrawAuto',
    'DrawInstancedIndirect', 'DrawIndexedInstancedIndirect', 'Dispatch', 'DispatchIndirect',
    'CopySubresourceRegion', 'CopyResource', 'UpdateSubresource', 'CopyStructureCount',
    'ClearRenderTargetView', 'ClearUnorderedAccessViewUint', 'ClearUnorderedAccessViewFloat',
    'ClearDepthStencilView', 'GenerateMips', 'SetResourceMinLOD', 'ResolveSubresource',
    'ClearState', 'Flush', 'ExecuteCommandList',
    // Not Direct3D's: what a buffer mapped on a deferred context was written
    // with, recorded at its Unmap for where the list plays (seam/d3d11.js).
    'WriteMapped',
]);

/** The pipeline's methods, by name: setters and getters both. */
const PIPELINE_METHODS = Object.freeze(Object.keys(createPipelineState({
    diverge: ()=>{},
}).methods));

/** @param {string} name */
const isGetter = name=>/^(?:[A-Z]{2})?Get/.test(name);

/**
 * @typedef {Object} ContextServices
 * @property {() => any} device  the device the context belongs to
 * @property {() => void} retainDevice
 * @property {() => void} releaseDevice
 * @property {(detail: string) => void} diverge
 */

/**
 * The context's own methods every context has: what it is, and its device.
 *
 * @param {ContextServices} services @param {number} type @param {number} flags
 */
function contextBase(services, type, flags){
    return {
        GetType: ()=>type,
        GetContextFlags: ()=>flags,
        /** @param {{ device?: any }} out */
        GetDevice(out){
            services.retainDevice();
            out.device = services.device();
            return S_OK;
        },
        // ID3DUserDefinedAnnotation: no tool reads the markers; the API's own
        // answer for "no tool is attached" is -1 from a begin and 0 for status.
        BeginEvent: ()=>-1,
        EndEvent: ()=>-1,
        SetMarker: ()=>{},
        GetStatus: ()=>0,
    };
}

/**
 * The immediate context: the device's pipeline under Direct3D 11's
 * interface. It belongs to the device and starts at no references; the
 * first a program takes holds the device, and the last lets it go.
 *
 * @param {ContextServices} services
 */
export function createImmediateContext(services){
    const device = services.device;
    /**
     * Where a call goes while the device's context state is Direct3D 10's
     * (`SwapDeviceContextState`): Direct3D 11's calls are ignored, and its
     * getters see nothing bound.
     */
    const ignored = createPipelineState({ diverge: ()=>{} }).methods;
    /**
     * Under Direct3D 10's state a getter answers nothing bound -- but for the
     * pixel stage's samplers, which Windows leaves unwritten
     * (test_device_context_state).
     *
     * @param {string} name
     */
    const forward = name=>(/** @type {any[]} */ ...args)=>(device().drawsAsTen?.()
        ? (isGetter(name) && name !== 'PSGetSamplers'
            ? /** @type {any} */ (ignored)[name]?.(...args) : undefined)
        : device()[name](...args));
    /** A call the context state does not decide about. @param {string} name */
    const always = name=>(/** @type {any[]} */ ...args)=>device()[name](...args);
    return attachCom({
        ...Object.fromEntries([...PIPELINE_METHODS, ...CONTEXT_COMMANDS]
            .map(name=>[name, forward(name)])),
        ...Object.fromEntries(['Enter', 'Leave', 'SetMultithreadProtected',
            'GetMultithreadProtected', 'SwapDeviceContextState']
            .map(name=>[name, always(name)])),
        ...contextBase(services, D3D11_DEVICE_CONTEXT.IMMEDIATE, 0),
        /** An immediate context has no list to finish. */
        FinishCommandList: ()=>DXGI_ERROR_INVALID_CALL,
        /** Its device, no reference taken: the seam's, for the device's ring. */
        owner: ()=>device(),
        /**
         * Not gone at no references while its device lives: the device hands
         * the same context out again, at the same address.
         */
        get destroyed(){
            return device().refCount === 0;
        },
        /** Its pointer stays the program's while the device lives. */
        reachable(){
            return device().refCount > 0;
        },
    }, {
        interfaces: [IID.ID3D11DeviceChild, IID.ID3D11DeviceContext, IID.ID3D11DeviceContext1,
            IID.ID3D10Multithread, IID.ID3DUserDefinedAnnotation],
        implicit: true,
        onFirstRef: services.retainDevice,
        onLastRef: services.releaseDevice,
    });
}

/**
 * Every object a call names, each counted once more.
 *
 * @param {any[]} args @param {(object: any) => void} each
 */
function objectsIn(args, each){
    for (const arg of args)
    {
        if (Array.isArray(arg))
        {
            objectsIn(arg, each);
        }
        else if (arg && typeof arg === 'object' && typeof arg.addRef === 'function')
        {
            each(arg);
        }
    }
}

/**
 * A finished command list: the calls in order, and the objects they name
 * held until it is released, with the bindings it starts from (held too).
 *
 * @param {ContextServices} services @param {[string, any[]][]} calls
 * @param {import('../d3d10/pipeline.js').Pipeline | null} [start]  null for a cleared pipeline
 */
function createCommandList(services, calls, start = null){
    return attachCom({
        calls,
        start,
        GetContextFlags: ()=>0,
        /** @param {{ device?: any }} out */
        GetDevice(out){
            services.retainDevice();
            out.device = services.device();
            return S_OK;
        },
    }, {
        interfaces: [IID.ID3D11DeviceChild, IID.ID3D11CommandList],
        onFirstRef: services.retainDevice,
        onLastRef: ()=>{
            for (const [, args] of calls)
            {
                objectsIn(args, object=>object.release());
            }
            if (start)
            {
                bindingsOf(start).forEach(object=>object.release());
            }
            services.releaseDevice();
        },
    });
}

/**
 * A deferred context: a pipeline of its own, every call recorded.
 *
 * @param {ContextServices} services @param {number} flags
 */
export function createDeferredContext(services, flags){
    const state = createPipelineState({ diverge: services.diverge, keepsBound: true });
    /** @type {[string, any[]][]} */
    let calls = [];
    /**
     * A call kept for the list, with its own copy of the bytes it was handed
     * (UpdateSubresource's, an unmapped buffer's): Direct3D copies them at the
     * call, and the program -- or the graphics worker's channel, whose
     * message they came in -- may have reused or given back the memory by
     * the time the list plays.
     *
     * @param {string} name @param {any[]} args
     */
    const record = (name, args)=>{
        objectsIn(args, object=>object.addRef());
        calls.push([name, args.map(arg=>(ArrayBuffer.isView(arg) && !(arg instanceof DataView)
            ? /** @type {Uint8Array} */ (arg).slice() : arg))]);
    };
    /** @type {Record<string, Function>} */
    const setters = {};
    for (const name of PIPELINE_METHODS)
    {
        const method = /** @type {Record<string, Function>} */ (state.methods)[name];
        setters[name] = isGetter(name)
            ? method
            : (/** @type {any[]} */ ...args)=>{
                method(...args);
                record(name, args);
            };
    }
    /**
     * The bindings the next list starts from: the context's as a list was
     * finished keeping them, held for that list; null for a cleared pipeline.
     *
     * @type {import('../d3d10/pipeline.js').Pipeline | null}
     */
    let start = null;
    const released = ()=>{
        for (const [, args] of calls)
        {
            objectsIn(args, object=>object.release());
        }
        calls = [];
        if (start)
        {
            bindingsOf(start).forEach(object=>object.release());
            start = null;
        }
    };
    return attachCom({
        ...setters,
        ...Object.fromEntries(CONTEXT_COMMANDS.map(name=>[name,
            (/** @type {any[]} */ ...args)=>{
                record(name, args);
            }])),
        ...contextBase(services, D3D11_DEVICE_CONTEXT.DEFERRED, flags),
        ClearState(){
            state.clear();
            record('ClearState', []);
        },
        /** A deferred context has nothing to send to the GPU. */
        Flush(){
        },
        /**
         * A deferred context keeps no context state to swap: it is left as it
         * is and answers none before (Wine's test_deferred_context_swap_state).
         *
         * @param {any} next @param {{ previous?: any } | null} out
         */
        SwapDeviceContextState(next, out){
            if (out)
            {
                out.previous = null;
            }
        },
        /**
         * A query begun and ended in a list is begun and ended where it plays.
         *
         * @param {any} query
         */
        Begin(query){
            record('Begin', [query]);
        },
        /**
         * A list played into this one is recorded; the bindings here are
         * then kept, or cleared, as on the immediate context
         * (test_deferred_context_state).
         *
         * @param {any} list @param {boolean} restore
         */
        ExecuteCommandList(list, restore){
            record('ExecuteCommandList', [list, restore]);
            if (!restore)
            {
                state.clear();
            }
        },
        /** @param {any} query */
        End(query){
            record('End', [query]);
        },
        /**
         * What was recorded, handed over as a command list; the context starts
         * again from a cleared pipeline unless it is asked to keep its own.
         *
         * @param {boolean} restore @param {{ list?: any }} out
         */
        FinishCommandList(restore, out){
            const list = createCommandList(services, calls, start);
            calls = [];
            start = null;
            // The bindings kept are what the next list starts from where it
            // plays (test_deferred_context_rendering).
            if (restore)
            {
                start = copyPipeline(state.capture());
                bindingsOf(start).forEach(object=>object.addRef());
            }
            else
            {
                state.clear();
            }
            // Nowhere to put the list: what was recorded is dropped all the same.
            if (!out)
            {
                list.release();
                return E_UNEXPECTED;
            }
            out.list = list;
            return S_OK;
        },
    }, {
        interfaces: [IID.ID3D11DeviceChild, IID.ID3D11DeviceContext, IID.ID3D11DeviceContext1,
            IID.ID3DUserDefinedAnnotation],
        onFirstRef: services.retainDevice,
        onLastRef: ()=>{
            released();
            services.releaseDevice();
        },
    });
}
