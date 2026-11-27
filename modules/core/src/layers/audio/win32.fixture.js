/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { createComRegistry } from '../win32/ole32/objects.js';

/**
 * What the sound layer takes of win32, for a test that builds it alone: a
 * real class registry, and a codec manager that takes the codec.
 *
 * @param {Record<string, any>} [over]
 */
export const testWin32 = (over = {})=>{
    const com = createComRegistry();
    return { com: ()=>com, installAcmCodec: ()=>{}, ...over };
};
