/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * D3DX's data loaders, ID3DX10DataLoader and ID3DX11DataLoader: what an
 * asynchronous load reads its bytes through -- memory the program holds, a
 * file read when the loader is told to load, a resource of a module. The
 * interface is not COM: three methods and no IUnknown, Load, Decompress and
 * Destroy, the last ending the loader.
 *
 * The contract is Wine's d3dx10 and d3dx11 tests: a memory loader hands back
 * the program's own pointer and size; a file loader reads the file at each
 * Load, keeping what it last read when the file has gone, and decompresses
 * nothing before a load succeeded; a resource loader is refused at creation
 * for a resource the module does not have.
 */

const S_OK = 0;
const E_FAIL = 0x80004005 | 0;
/** D3DX10_ERR_INVALID_DATA and D3DX11_ERR_INVALID_DATA, one number. */
const D3DX_ERR_INVALID_DATA = 0x88760b59 | 0;
/** RT_RCDATA: where D3DX looks for a resource it is named. */
const RT_RCDATA = 10;

/**
 * @typedef {Object} LoaderHost
 * @property {(address: number, length: number) => Uint8Array} readMemory
 * @property {(address: number, bytes: Uint8Array) => void} writeMemory
 * @property {{ allocate: (bytes: number) => number, free: (address: number) => any }} [heap]
 * @property {{ publish: (object: any, interfaceId: string) => number,
 *     unpublish?: (object: any, interfaceId: string) => boolean }} [vtables]
 * @property {(path: string) => Promise<Uint8Array | null> | Uint8Array | null} [readFile]
 * @property {(module: number, name: string | number, type: number)
 *     => Uint8Array | null | Promise<Uint8Array | null>}
 *     [resource]
 */

/** The name its one table is published under: it has no IID, being no COM interface. */
const LOADER_ID = 'ID3DXDataLoader';

/**
 * @param {LoaderHost} host
 * @param {{ prefix: string, fileNotFound: number,
 *     string: (address: number, wide: boolean, max: number) => string }} how
 *     the library's prefix, its Direct3D's ERROR_FILE_NOT_FOUND, and a string reader
 */
export function createDataLoaders(host, how){
    const { prefix, fileNotFound, string } = how;
    /** @param {number} at @param {number} value */
    const writeU32 = (at, value)=>host.writeMemory(at >>> 0,
        new Uint8Array(new Uint32Array([value >>> 0]).buffer));

    /**
     * A loader published, its three methods over `state`: `load` makes its
     * bytes available, `data` says where they are, `end` lets them go.
     *
     * @param {{ load: () => number | Promise<number>, data: () => { at: number, size: number }
     *     | null, end?: () => void }} state
     * @param {number} out
     */
    const publishLoader = (state, out)=>{
        /**
         * @param {any} _self
         * @param {number[]} args
         */
        const decompress = (_self, [dataAt, sizeAt])=>{
            const data = state.data();
            if (!data)
            {
                return E_FAIL;
            }
            if (dataAt >>> 0)
            {
                writeU32(dataAt, data.at);
            }
            if (sizeAt >>> 0)
            {
                writeU32(sizeAt, data.size);
            }
            return S_OK;
        };
        /** @type {any} */
        const object = {
            interfaceFor: (/** @type {string} */ id)=>(id === LOADER_ID ? record : null),
        };
        const record = Object.freeze({ object, id: LOADER_ID, methods: [
            /** HRESULT Load() */
            { name: 'Load', argBytes: 4, invoke: ()=>state.load() },
            /** HRESULT Decompress(void **ppData, SIZE_T *pcBytes) */
            { name: 'Decompress', argBytes: 12, invoke: decompress },
            /** HRESULT Destroy() */
            { name: 'Destroy', argBytes: 4, invoke: ()=>{
                state.end?.();
                host.vtables?.unpublish?.(object, LOADER_ID);
                return S_OK;
            } },
        ] });
        const pointer = host.vtables?.publish(object, LOADER_ID) ?? 0;
        if (!pointer)
        {
            state.end?.();
            return E_FAIL;
        }
        writeU32(out, pointer);
        return S_OK;
    };

    /**
     * Bytes copied into the process's heap, for a loader to hand out; 0 when
     * there is no room.
     *
     * @param {Uint8Array} bytes
     */
    const held = bytes=>{
        const at = host.heap?.allocate(Math.max(1, bytes.length)) ?? 0;
        if (at)
        {
            host.writeMemory(at, bytes);
        }
        return at;
    };

    /**
     * The file loader: the file read at each Load, the last bytes read kept
     * when a later Load does not find it.
     *
     * @param {boolean} wide
     */
    const fileLoader = wide=>({
        argBytes: 8,
        handler: (/** @type {number[]} */ [nameAt, out])=>{
            if ((nameAt >>> 0) === 0 || (out >>> 0) === 0)
            {
                return E_FAIL;
            }
            const path = string(nameAt >>> 0, wide, 260);
            /** @type {{ at: number, size: number } | null} */
            let data = null;
            const drop = ()=>{
                if (data)
                {
                    host.heap?.free(data.at);
                    data = null;
                }
            };
            return publishLoader({
                load: async()=>{
                    const bytes = await host.readFile?.(path) ?? null;
                    if (!bytes)
                    {
                        return fileNotFound;
                    }
                    const at = held(bytes);
                    if (!at)
                    {
                        return E_FAIL;
                    }
                    drop();
                    data = { at, size: bytes.length };
                    return S_OK;
                },
                data: ()=>data,
                end: drop,
            }, out >>> 0);
        },
    });

    /**
     * The resource loader: refused at creation for a resource the module does
     * not have (RT_RCDATA, by name or number), its bytes held from then on.
     *
     * @param {boolean} wide
     */
    const resourceLoader = wide=>({
        argBytes: 12,
        handler: async(/** @type {number[]} */ [module, nameAt, out])=>{
            if ((out >>> 0) === 0)
            {
                return E_FAIL;
            }
            const name = (nameAt >>> 0) === 0 ? null : (nameAt >>> 0) < 0x10000 ? nameAt >>> 0
                : string(nameAt >>> 0, wide, 256);
            const bytes = name === null ? null
                : await host.resource?.(module >>> 0, name, RT_RCDATA) ?? null;
            if (!bytes)
            {
                return D3DX_ERR_INVALID_DATA;
            }
            const at = held(bytes);
            if (!at)
            {
                return E_FAIL;
            }
            return publishLoader({ load: ()=>S_OK, data: ()=>({ at, size: bytes.length }),
                end: ()=>host.heap?.free(at) }, out >>> 0);
        },
    });

    return {
        /**
         * HRESULT CreateAsyncMemoryLoader(LPCVOID pData, SIZE_T cbData,
         *     ID3DX11DataLoader **ppDataLoader)
         *
         * The program's own bytes, handed back as they are; Load does nothing.
         */
        [`${prefix}CreateAsyncMemoryLoader`]: {
            argBytes: 12,
            handler: (/** @type {number[]} */ [data, size, out])=>{
                if ((data >>> 0) === 0 || (out >>> 0) === 0)
                {
                    return E_FAIL;
                }
                return publishLoader({ load: ()=>S_OK,
                    data: ()=>({ at: data >>> 0, size: size >>> 0 }) }, out >>> 0);
            },
        },
        [`${prefix}CreateAsyncFileLoaderA`]: fileLoader(false),
        [`${prefix}CreateAsyncFileLoaderW`]: fileLoader(true),
        [`${prefix}CreateAsyncResourceLoaderA`]: resourceLoader(false),
        [`${prefix}CreateAsyncResourceLoaderW`]: resourceLoader(true),
    };
}
