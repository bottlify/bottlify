/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * A swap chain a program makes beside its device's own, in either version:
 * back buffers of its own, presented into a window of its own.
 *
 * The display shows one window's picture, the device's. A chain presenting
 * into that window is shown there; one presenting into another window still
 * has its frame drawn -- its back buffers hold what was drawn into them, and
 * what it presented can be read back -- but its picture has nowhere to go,
 * which the device reports. Which is which is the caller's to say at each
 * present, since only the caller knows the windows.
 */

import { D3DERR_INVALIDCALL, D3D_OK } from './constants.js';

/**
 * @typedef {Object} AdditionalChainOptions
 * @property {any} parameters
 *           The present parameters as normalised, with the window the chain
 *           presents into as `hDeviceWindow`. A back buffer count of zero is one.
 * @property {import('./resources.js').ReferenceCount} count
 *           The chain's own, which its back buffers share: a program releasing
 *           a back buffer it took from the chain releases the chain.
 * @property {(count: import('./resources.js').ReferenceCount) => any} makeBackBuffer
 * @property {(backBuffer: any, shown: boolean) => number | Promise<number>} present
 *           The device's: whether it can present at all, and what showing or
 *           keeping the picture takes. A promise is a present made and held
 *           until the device has room for another frame.
 * @property {(surface: any) => void} retire
 *           Gives a back buffer's storage back once the chain is gone.
 */

/**
 * @param {AdditionalChainOptions} options
 */
export function createAdditionalChain(options){
    const buffers = Array.from({ length: options.parameters.backBufferCount || 1 },
        ()=>options.makeBackBuffer(options.count));
    /** @type {any} the back buffer the last present handed over, or null before one */
    let presented = null;
    let presents = 0;
    return {
        get refCount(){
            return options.count.value;
        },
        addRef: ()=>options.count.addRef(),
        release(){
            const left = options.count.release();
            if (options.count.destroyed)
            {
                for (const surface of buffers)
                {
                    options.retire(surface);
                }
            }
            return left;
        },

        /** Its back buffers, first the one a present hands over. */
        backBuffers: /** @type {readonly any[]} */ (buffers),

        get presented(){
            return presented;
        },

        /** Presents that went through, for GetLastPresentCount. */
        get presentCount(){
            return presents;
        },

        /**
         * The type is not looked at: a stereo buffer asked for is the mono
         * one (Wine's d3d8 and d3d9 test_swapchain). An index past the last
         * leaves the caller's pointer alone.
         *
         * @param {number} index @param {number} _type @param {{ surface?: any }} out
         */
        GetBackBuffer(index, _type, out){
            const surface = buffers[index];
            if (!surface)
            {
                return D3DERR_INVALIDCALL;
            }
            surface.addRef();
            out.surface = surface;
            return D3D_OK;
        },

        /** @param {{ parameters?: any }} out */
        GetPresentParameters(out){
            out.parameters = { ...options.parameters, backBufferCount: buffers.length };
            return D3D_OK;
        },

        /**
         * @param {boolean} [shown]  Whether the picture goes to the window the display shows.
         * @returns {number | Promise<number>}
         */
        Present(shown = true){
            const hr = options.present(buffers[0], shown);
            if (hr === D3D_OK || hr instanceof Promise)
            {
                presented = buffers[0];
                presents++;
            }
            return hr;
        },
    };
}
