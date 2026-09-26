/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Queries and predicates: what a program asks the GPU after the fact.
 *
 * A query goes through three states, and `GetData` answers from which one it
 * is in. One never issued, or begun and not yet ended, has nothing to report
 * and says `DXGI_ERROR_INVALID_CALL` -- not `S_FALSE`, which would tell a
 * polling program to keep waiting for an answer that is not coming. One ended
 * is waiting for the work recorded before its end to reach the GPU, and says
 * `S_FALSE` until it has; a `GetData` without `DONOTFLUSH` sends that work, so
 * a program that polls an event query in a loop gets its answer. Two kinds
 * have no beginning at all, the event and the timestamp: only their end is
 * issued, and a `Begin` on them is ignored.
 *
 * What this build measures, and what it cannot:
 *
 * - The counts the input assembler and the vertex shader see are exact: they
 *   follow from the draw's arguments and topology.
 * - What the rasteriser produced is not counted by anything here. An occlusion
 *   query answers the samples its draws' viewports cover on their targets --
 *   the answer that never hides what should have been drawn -- and says so.
 * - A timestamp is the host's clock at the query's end, not the GPU's, and the
 *   disjoint query that brackets it says so the documented way: `Disjoint` is
 *   TRUE, which tells a program to discard what it measured.
 * - Nothing is ever written to a stream-output buffer, so stream-output counts
 *   are zero and nothing overflows.
 */

import { attachCom } from './com.js';
import {
    D3D10_PRIMITIVE_TOPOLOGY, D3D10_QUERY, DXGI_ERROR_INVALID_CALL, E_INVALIDARG, IID,
    S_FALSE, S_OK,
} from './constants.js';
import { levelExtent } from './validity.js';

/** D3D10_ASYNC_GETDATA_DONOTFLUSH: answer from what already reached the GPU. */
export const D3D10_ASYNC_GETDATA_DONOTFLUSH = 0x1;

/**
 * The size of each kind's answer: the structure `GetData` fills.
 *
 * @type {Readonly<Record<number, number>>}
 */
export const QUERY_DATA_SIZE = Object.freeze({
    [D3D10_QUERY.EVENT]: 4,
    [D3D10_QUERY.OCCLUSION]: 8,
    [D3D10_QUERY.TIMESTAMP]: 8,
    // A UINT64 and a BOOL, padded to the alignment of the UINT64.
    [D3D10_QUERY.TIMESTAMP_DISJOINT]: 16,
    // Eight UINT64 counters: input assembler, shader stages and clipper.
    [D3D10_QUERY.PIPELINE_STATISTICS]: 64,
    [D3D10_QUERY.OCCLUSION_PREDICATE]: 4,
    [D3D10_QUERY.SO_STATISTICS]: 16,
    [D3D10_QUERY.SO_OVERFLOW_PREDICATE]: 4,
});

/** The kinds a program only ends: they mark a point rather than bracket a span. */
/** @type {ReadonlySet<number>} */
const END_ONLY = new Set([D3D10_QUERY.EVENT, D3D10_QUERY.TIMESTAMP]);

/** Ticks per second of the timestamps handed out: nanoseconds. */
const TIMESTAMP_FREQUENCY = 1_000_000_000n;

/**
 * @typedef {Object} DrawTotals
 * @property {number} iaVertices
 * @property {number} iaPrimitives
 * @property {number} vsInvocations
 * @property {number} psInvocations
 * @property {number} samples
 */

/**
 * @param {number} topology
 * @param {number} count  vertices or indices
 * @returns {number} how many primitives the input assembler makes of them
 */
export function primitivesOf(topology, count){
    switch (topology)
    {
        case D3D10_PRIMITIVE_TOPOLOGY.POINTLIST:
            return count;
        case D3D10_PRIMITIVE_TOPOLOGY.LINELIST:
            return Math.floor(count / 2);
        case D3D10_PRIMITIVE_TOPOLOGY.LINESTRIP:
            return Math.max(0, count - 1);
        case D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST:
            return Math.floor(count / 3);
        case D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP:
            return Math.max(0, count - 2);
        case D3D10_PRIMITIVE_TOPOLOGY.LINELIST_ADJ:
            return Math.floor(count / 4);
        case D3D10_PRIMITIVE_TOPOLOGY.LINESTRIP_ADJ:
            return Math.max(0, count - 3);
        case D3D10_PRIMITIVE_TOPOLOGY.TRIANGLELIST_ADJ:
            return Math.floor(count / 6);
        case D3D10_PRIMITIVE_TOPOLOGY.TRIANGLESTRIP_ADJ:
            return Math.max(0, Math.floor(count / 2) - 2);
        default:
            return 0;
    }
}

/**
 * The extent of the level a view looks at.
 *
 * @param {any} view
 * @returns {{ width: number, height: number, samples: number } | null}
 */
function viewExtent(view){
    if (!view)
    {
        return null;
    }
    /** @type {{ resource?: any }} */
    const held = {};
    view.GetResource(held);
    const resource = held.resource;
    resource.release();
    /** @type {{ desc?: any }} */
    const described = {};
    view.GetDesc(described);
    const level = described.desc.MipSlice ?? 0;
    return {
        width: levelExtent(resource.desc.Width ?? 1, level),
        height: levelExtent(resource.desc.Height ?? 1, level),
        samples: resource.desc.SampleDesc?.Count ?? 1,
    };
}

/**
 * The running totals every query reads its span out of: a query takes a copy
 * at its beginning and the difference at its end.
 */
export function createDrawStatistics(){
    /** @type {DrawTotals} */
    const totals = {
        iaVertices: 0, iaPrimitives: 0, vsInvocations: 0, psInvocations: 0, samples: 0,
    };

    return {
        /** @returns {DrawTotals} */
        snapshot: ()=>({ ...totals }),

        /**
         * One draw as the program issued it.
         *
         * @param {import('./render.js').PipelineSnapshot} pipeline
         * @param {{ vertexCount: number, indexCount?: number, instanceCount?: number }} draw
         */
        note(pipeline, draw){
            const instances = draw.instanceCount ?? 1;
            const count = draw.indexCount ?? draw.vertexCount;
            const primitives = primitivesOf(pipeline.topology, count) * instances;
            totals.iaVertices += count * instances;
            totals.iaPrimitives += primitives;
            totals.vsInvocations += pipeline.stages.vs.shader ? count * instances : 0;
            const viewport = pipeline.viewports[0];
            const target = viewExtent(pipeline.renderTargets[0])
                ?? viewExtent(pipeline.depthStencilView);
            if (primitives === 0 || !viewport || !target)
            {
                return;
            }
            const left = Math.max(0, viewport.TopLeftX);
            const top = Math.max(0, viewport.TopLeftY);
            const right = Math.min(target.width, viewport.TopLeftX + viewport.Width);
            const bottom = Math.min(target.height, viewport.TopLeftY + viewport.Height);
            const covered = Math.max(0, right - left) * Math.max(0, bottom - top)
                * target.samples * instances;
            totals.samples += covered;
            totals.psInvocations += pipeline.stages.ps.shader ? covered : 0;
        },
    };
}

/**
 * @typedef {Object} QueryServices
 * @property {() => DrawTotals} totals
 * @property {() => number} recorded   Commands recorded so far, ever.
 * @property {() => number} submitted  Commands handed to the GPU so far, ever.
 * @property {() => void} flush        Hands what is recorded to the GPU.
 * @property {() => number} now        Milliseconds, for a timestamp.
 * @property {(detail: string) => void} diverge
 */

/**
 * @param {{ Query: number, MiscFlags: number }} desc
 * @param {readonly string[]} interfaces
 * @param {QueryServices} services
 * @param {{ retainDevice: () => void, releaseDevice: () => void, device: () => any }} owner
 */
export function createQueryObject(desc, interfaces, services, owner){
    const kind = desc.Query;
    const size = QUERY_DATA_SIZE[kind];
    const endOnly = END_ONLY.has(kind);
    /** @type {'idle' | 'building' | 'issued'} */
    let state = 'idle';
    /** @type {DrawTotals | null} */
    let begun = null;
    /** @type {Uint8Array | null} */
    let answer = null;
    let waitFor = 0;

    if (kind === D3D10_QUERY.OCCLUSION || kind === D3D10_QUERY.OCCLUSION_PREDICATE)
    {
        services.diverge('an occlusion query counts every sample its draws\' viewports cover:'
            + ' nothing here counts the samples that passed the depth and stencil tests');
    }
    if (kind === D3D10_QUERY.TIMESTAMP || kind === D3D10_QUERY.TIMESTAMP_DISJOINT)
    {
        services.diverge('a timestamp is the host\'s clock when the query ended, and the'
            + ' disjoint query around it reports Disjoint so a program discards it');
    }

    /**
     * The structure the query's span fills, as its bytes.
     *
     * @param {DrawTotals} from
     * @param {DrawTotals} to
     */
    const measure = (from, to)=>{
        const bytes = new Uint8Array(size);
        const view = new DataView(bytes.buffer);
        /** @param {number} at @param {number} value */
        const u64 = (at, value)=>view.setBigUint64(at, BigInt(Math.max(0, value)), true);
        const samples = to.samples - from.samples;
        switch (kind)
        {
            case D3D10_QUERY.EVENT:
                view.setUint32(0, 1, true);
                break;
            case D3D10_QUERY.OCCLUSION:
                u64(0, samples);
                break;
            case D3D10_QUERY.OCCLUSION_PREDICATE:
                view.setUint32(0, samples > 0 ? 1 : 0, true);
                break;
            case D3D10_QUERY.TIMESTAMP:
                view.setBigUint64(0, BigInt(Math.round(services.now() * 1e6)), true);
                break;
            case D3D10_QUERY.TIMESTAMP_DISJOINT:
                view.setBigUint64(0, TIMESTAMP_FREQUENCY, true);
                view.setUint32(8, 1, true);
                break;
            case D3D10_QUERY.PIPELINE_STATISTICS: {
                const primitives = to.iaPrimitives - from.iaPrimitives;
                u64(0, to.iaVertices - from.iaVertices);
                u64(8, primitives);
                u64(16, to.vsInvocations - from.vsInvocations);
                // GSInvocations and GSPrimitives stay zero: no geometry
                // shader runs.
                u64(40, primitives);
                u64(48, primitives);
                u64(56, to.psInvocations - from.psInvocations);
                break;
            }
            default:
                // Stream-output statistics and overflow: nothing is written.
                break;
        }
        return bytes;
    };

    return attachCom({
        desc,

        Begin(){
            if (endOnly)
            {
                return;
            }
            state = 'building';
            answer = null;
            begun = services.totals();
        },

        End(){
            if (endOnly)
            {
                begun = services.totals();
            }
            else if (state !== 'building')
            {
                return;
            }
            state = 'issued';
            answer = measure(/** @type {DrawTotals} */ (begun), services.totals());
            waitFor = services.recorded();
        },

        /** @returns {number} */
        GetDataSize(){
            return size;
        },

        /**
         * @param {boolean} hasData   Whether the caller supplied somewhere to write.
         * @param {number} dataSize
         * @param {number} flags
         * @param {{ data?: Uint8Array | null }} out
         * @returns {number}
         */
        GetData(hasData, dataSize, flags, out){
            out.data = null;
            if ((!hasData && dataSize !== 0) || (dataSize !== 0 && dataSize !== size))
            {
                return E_INVALIDARG;
            }
            if (state !== 'issued')
            {
                return DXGI_ERROR_INVALID_CALL;
            }
            if (services.submitted() < waitFor)
            {
                if ((flags & D3D10_ASYNC_GETDATA_DONOTFLUSH) !== 0)
                {
                    return S_FALSE;
                }
                services.flush();
                if (services.submitted() < waitFor)
                {
                    return S_FALSE;
                }
            }
            if (hasData && dataSize !== 0)
            {
                out.data = answer;
            }
            return S_OK;
        },

        /** @param {{ desc?: any }} target */
        GetDesc(target){
            target.desc = desc;
            return S_OK;
        },

        /** @param {{ device?: any }} target */
        GetDevice(target){
            owner.retainDevice();
            target.device = owner.device();
            return S_OK;
        },
    }, {
        interfaces: [IID.ID3D10DeviceChild, IID.ID3D10Asynchronous, ...interfaces],
        onFirstRef: owner.retainDevice,
        onLastRef: owner.releaseDevice,
    });
}
