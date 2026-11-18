/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The exports of GDI+ this build does not do, each answering
 * NotImplemented - a Status a program checks - and said once as a
 * divergence, instead of a missing import a program dies on.
 */

import { Status } from './kit.js';

/**
 * Each export not done here, by why: its argument bytes, as the 32-bit
 * stdcall pops them.
 *
 * @type {Record<string, Record<string, number>>}
 */
const NOT_DONE = {
    'no metafile is recorded, played or read': {
        GdipConvertToEmfPlus: 24, GdipConvertToEmfPlusToFile: 28, GdipCreateMetafileFromEmf: 12,
        GdipCreateMetafileFromFile: 8, GdipCreateMetafileFromStream: 8,
        GdipCreateMetafileFromWmf: 16, GdipCreateMetafileFromWmfFile: 12, GdipEmfToWmfBits: 20,
        GdipEnumerateMetafileDestPoint: 24, GdipEnumerateMetafileDestPointI: 24,
        GdipEnumerateMetafileDestRect: 24, GdipEnumerateMetafileDestRectI: 24,
        GdipEnumerateMetafileSrcRectDestPoints: 36, GdipEnumerateMetafileSrcRectDestRect: 32,
        GdipEnumerateMetafileSrcRectDestRectI: 32, GdipGetHemfFromMetafile: 8,
        GdipGetMetafileDownLevelRasterizationLimit: 8, GdipGetMetafileHeaderFromEmf: 8,
        GdipGetMetafileHeaderFromFile: 8, GdipGetMetafileHeaderFromMetafile: 8,
        GdipGetMetafileHeaderFromStream: 8, GdipGetMetafileHeaderFromWmf: 12,
        GdipPlayMetafileRecord: 20, GdipRecordMetafile: 24, GdipRecordMetafileFileName: 28,
        GdipRecordMetafileFileNameI: 28, GdipRecordMetafileI: 24, GdipRecordMetafileStream: 28,
        GdipRecordMetafileStreamI: 28, GdipSetMetafileDownLevelRasterizationLimit: 8,
    },
    'no image effect is applied': {
        GdipBitmapApplyEffect: 24, GdipBitmapCreateApplyEffect: 36, GdipCreateEffect: 20,
        GdipDeleteEffect: 4, GdipGetEffectParameterSize: 8, GdipGetEffectParameters: 12,
        GdipSetEffectParameters: 12,
    },
    'no glyph outline is made a path': {
        GdipAddPathString: 32, GdipAddPathStringI: 32, GdipWindingModeOutline: 12,
    },
    'an image is saved one frame to a file': {
        GdipSaveAdd: 8, GdipSaveAddImage: 12,
    },
    'not provided': {
        GdipCreateStreamOnFile: 12, GdipFindFirstImageItem: 8, GdipGetImageItemData: 8,
        GdipSetPathGradientPath: 8, GdipTestControl: 8,
    },
};

/**
 * @param {{ divergence?: (api: string, detail: string, kind?: string) => void }} host
 * @param {Record<string, unknown>} done  the exports the families have
 */
export function createUnsupportedFunctions(host, done){
    /** @type {Set<string>} */
    const said = new Set();
    return Object.fromEntries(Object.entries(NOT_DONE).flatMap(([why, names])=>Object
        .entries(names).filter(([name])=>!(name in done)).map(([name, argBytes])=>[name, {
            argBytes,
            handler: ()=>{
                if (!said.has(name))
                {
                    said.add(name);
                    host.divergence?.(name, why);
                }
                return Status.NotImplemented;
            },
        }])));
}
