/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The program's thread's end of the graphics worker (`worker.js`): each
 * Direct3D 7, 8 or 9 root and each OpenGL root made here is a recorded one
 * whose twin the worker plays, over a port of its own, and each frame the worker presents comes
 * back as a picture that is copied into a texture of this thread's device
 * and presented as a frame drawn here would be.
 */

import { createSender } from './channel.js';
import { recordedDirect3D } from './direct3d.js';
import { recordedDirect3D7 } from './d3d7.js';
import { recordedOpengl } from './opengl.js';

/** GPUTextureUsage, here without the browser's global. */
const USAGE = { COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, RENDER_ATTACHMENT: 0x10 };

/**
 * What of a root's services crosses to its twin: the plain values -- the
 * capabilities and the knobs -- and whether a full-screen gamma ramp reaches
 * the display. What draws, what reads memory and what is told of the
 * program's state are the worker's own.
 *
 * @param {Record<string, any>} services
 */
function plainOf(services){
    /** @type {Record<string, any>} */
    const options = {};
    for (const [key, value] of Object.entries(services))
    {
        if (typeof value === 'function' || key === 'backend' || key === 'gamma')
        {
            continue;
        }
        if (value !== null && typeof value === 'object'
            && Object.values(value).some(member=>typeof member === 'function'))
        {
            continue;
        }
        options[key] = value;
    }
    options.gamma = services.gamma?.applies?.() === true;
    return options;
}

/**
 * @typedef {Object} GraphicsWorkerEnd
 * @property {(api: 'd3d7' | 'd3d8' | 'd3d9' | 'opengl', factory: (services: any) => any,
 *     services: any) => any} root
 *     a root the program is given, whose twin the worker plays
 * @property {() => { roots: number, frames: number }} diagnostics
 * @property {() => void} dispose
 */

/**
 * @param {Object} options
 * @param {{ postMessage: (message: any, transfer?: Transferable[]) => void,
 *     addEventListener: (type: 'message', listener: (event: { data: any }) => void) => void,
 *     removeEventListener: (type: 'message', listener: (event: { data: any }) => void) => void }}
 *     options.worker  a graphics worker that has answered `open`
 * @param {any} [options.device]  this thread's GPU device, which a frame is copied onto
 * @param {(frame: { surface: any, frameIndex: number }) => void} [options.presentTo]
 *     where a frame goes, as the backend of this thread hands its own on
 * @param {(address: number, bytes: Uint8Array) => void} [options.writeMemory]
 *     guest memory the worker wrote for a call the program waited on: pixels read back
 * @param {(api: string, detail: string) => void} [options.divergence]
 * @param {() => void} [options.lost]    the worker's GPU went away
 * @param {(message: string) => void} [options.failed]  a root's calls could not be played
 * @returns {GraphicsWorkerEnd}
 */
export function connectGraphicsWorker(options){
    const { worker, device, presentTo, writeMemory, divergence, lost, failed } = options;
    /** @type {{ texture: any, view: any, width: number, height: number, format: string } | null} */
    let surface = null;
    /** @type {MessagePort[]} */
    const ports = [];
    let frames = 0;

    /**
     * @param {{ bitmap?: any, pixels?: Uint8Array, bytesPerRow?: number, width?: number,
     *     height?: number, frameIndex: number, format: string }} frame
     */
    const present = ({ bitmap, pixels, bytesPerRow, frameIndex, format, ...size })=>{
        if (!device || !presentTo)
        {
            bitmap?.close?.();
            return;
        }
        const width = bitmap ? bitmap.width : /** @type {number} */ (size.width);
        const height = bitmap ? bitmap.height : /** @type {number} */ (size.height);
        if (!surface || surface.width !== width || surface.height !== height
            || surface.format !== format)
        {
            surface?.texture.destroy();
            const texture = device.createTexture({
                label: 'graphics-worker-frame',
                size: [width, height],
                format,
                usage: USAGE.COPY_SRC | USAGE.COPY_DST | USAGE.TEXTURE_BINDING
                    | USAGE.RENDER_ATTACHMENT,
            });
            surface = { texture, view: texture.createView(), width, height, format };
        }
        // The queue keeps the copy behind the presenter's use of the last
        // frame, so one texture serves every frame.
        if (bitmap)
        {
            device.queue.copyExternalImageToTexture({ source: bitmap },
                { texture: surface.texture }, [width, height]);
            bitmap.close?.();
        }
        else
        {
            device.queue.writeTexture({ texture: surface.texture }, pixels, { bytesPerRow },
                [width, height]);
        }
        frames++;
        presentTo({ surface, frameIndex });
    };

    /** @param {{ data: any }} event */
    const listener = ({ data })=>{
        switch (data?.type)
        {
            case 'frame':
                present(data);
                break;
            case 'lost':
                lost?.();
                break;
            default:
                break;
        }
    };
    worker.addEventListener('message', listener);

    return {
        root(api, factory, services){
            const { port1, port2 } = new MessageChannel();
            ports.push(port1);
            worker.postMessage({ type: 'root', api, options: plainOf(services), port: port2 },
                [port2]);
            const sender = createSender({
                post: (message, transfer)=>port1.postMessage(message, transfer),
                on: { wrote: writeMemory, divergence, lost, failed },
            });
            port1.onmessage = event=>sender.receive(event.data);
            switch (api)
            {
                case 'opengl':
                    return recordedOpengl(factory, services, sender);
                case 'd3d7':
                    return recordedDirect3D7(services.ddraw, services, sender);
                default:
                    return recordedDirect3D(factory, services, sender);
            }
        },
        diagnostics: ()=>({ roots: ports.length, frames }),
        dispose(){
            worker.removeEventListener('message', listener);
            for (const port of ports.splice(0))
            {
                port.postMessage({ type: 'close' });
                port.close();
            }
            surface?.texture.destroy();
            surface = null;
        },
    };
}
