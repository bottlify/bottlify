/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX 11: the helper library a Direct3D 11 program links as `d3dx11_42.dll`
 * or `d3dx11_43.dll`. It is D3DX 10's library over the other device
 * (`../d3dx10/functions.js` with D3DX11_PROFILE): the image loaders make their
 * textures through ID3D11Device's own creates, the compiles go to D3DCompile,
 * the data loaders are the same. What takes an ID3D11DeviceContext -- the
 * texture filter, saving, copying one texture into another -- takes it first,
 * where D3DX 10's took none.
 */

import { createD3dx10Functions } from '../d3dx10/functions.js';

/** D3D11_SDK_VERSION, which D3DX11CheckVersion holds a program's to. */
const D3D11_SDK_VERSION = 7;

const E_NOTIMPL = 0x80004001 | 0;

/**
 * D3DX 11, over ID3D11Device: its creates by vtable slot (d3d11.h, the
 * device's table in `graphics/seam/d3d11.js`).
 *
 * @type {import('../d3dx10/functions.js').D3dxProfile}
 */
export const D3DX11_PROFILE = Object.freeze({ prefix: 'D3DX11', sdk: D3D11_SDK_VERSION,
    // D3D11_ERROR_FILE_NOT_FOUND.
    fileNotFound: 0x887c0002 | 0,
    device: { CreateTexture1D: 4, CreateTexture2D: 5, CreateTexture3D: 6,
        CreateShaderResourceView: 7 } });

/** What D3DX 11 exports, as the library does (d3dx11_43.spec). */
const EXPORTS = new Set(['CheckVersion', 'CompileFromFileA', 'CompileFromFileW',
    'CompileFromMemory', 'CreateAsyncFileLoaderA', 'CreateAsyncFileLoaderW',
    'CreateAsyncMemoryLoader', 'CreateAsyncResourceLoaderA', 'CreateAsyncResourceLoaderW',
    'CreateShaderResourceViewFromFileA', 'CreateShaderResourceViewFromFileW',
    'CreateShaderResourceViewFromMemory', 'CreateShaderResourceViewFromResourceA',
    'CreateShaderResourceViewFromResourceW', 'CreateTextureFromFileA', 'CreateTextureFromFileW',
    'CreateTextureFromMemory', 'CreateTextureFromResourceA', 'CreateTextureFromResourceW',
    'GetImageInfoFromFileA', 'GetImageInfoFromFileW', 'GetImageInfoFromMemory',
    'GetImageInfoFromResourceA', 'GetImageInfoFromResourceW'].map(name=>`D3DX11${name}`));

/**
 * @param {import('../d3dx10/functions.js').D3dx10Host} host
 * @param {number} version  the SDK version this copy answers to: 42 or 43
 */
export function createD3dx11Functions(host, version){
    const shared = createD3dx10Functions(host, version, D3DX11_PROFILE);
    const kept = Object.fromEntries(Object.entries(shared).filter(([name])=>EXPORTS.has(name)));

    /**
     * Refused, saying why.
     *
     * @param {string} api @param {number} argBytes @param {string} why
     */
    const refused = (api, argBytes, why)=>({
        argBytes,
        handler: ()=>{
            host.divergence?.(api, why);
            return E_NOTIMPL;
        },
    });

    return {
        ...kept,
        /**
         * HRESULT D3DX11FilterTexture(ID3D11DeviceContext*, ID3D11Resource *pTexture,
         *     UINT SrcLevel, UINT MipFilter)
         *
         * D3DX 10's, the context first.
         */
        D3DX11FilterTexture: {
            argBytes: 16,
            handler: (/** @type {number[]} */ [, ...rest])=>
                shared.D3DX11FilterTexture.handler(rest),
        },
        /** HRESULT D3DX11SaveTextureToFile(ID3D11DeviceContext*, ID3D11Resource*, format, file) */
        D3DX11SaveTextureToFileA: refused('D3DX11SaveTextureToFileA', 16,
            'refused: saving a Direct3D 11 texture to a file is not implemented'),
        D3DX11SaveTextureToFileW: refused('D3DX11SaveTextureToFileW', 16,
            'refused: saving a Direct3D 11 texture to a file is not implemented'),
        /** HRESULT D3DX11SaveTextureToMemory(context, resource, format, ID3D10Blob**, flags) */
        D3DX11SaveTextureToMemory: refused('D3DX11SaveTextureToMemory', 20,
            'refused: saving a Direct3D 11 texture to memory is not implemented'),
        /**
         * HRESULT D3DX11LoadTextureFromTexture(ID3D11DeviceContext*, ID3D11Resource *pSrc,
         *     D3DX11_TEXTURE_LOAD_INFO*, ID3D11Resource *pDst)
         */
        D3DX11LoadTextureFromTexture: refused('D3DX11LoadTextureFromTexture', 16,
            'refused: copying one Direct3D 11 texture into another is not implemented'),
    };
}
