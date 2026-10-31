/**
 * DirectSound's 3D interfaces: IDirectSound3DListener on the primary buffer
 * and IDirectSound3DBuffer on a secondary one created with DSBCAPS_CTRL3D.
 *
 * Every parameter is kept and handed back as Windows does (Wine's ds3d
 * tests), deferred settings included -- a deferred change is read back at
 * once and only waits for CommitDeferredSettings to be heard. What they would
 * do to the sound is not modelled: a 3D buffer plays as it would with 3D
 * processing disabled, which the caller reports as a divergence.
 */

const DS_OK = 0;
const DSERR_INVALIDPARAM = 0x80070057 | 0;

/**
 * A vector passed by value: three D3DVALUEs after `this`, which a 64-bit
 * caller passes in XMM1 to XMM3.
 */
const XYZ = [1, 2, 3];

/** IDirectSound3DListener, after IUnknown's three. A third element names the float arguments. */
export const IDIRECTSOUND3DLISTENER_SLOTS = /** @type {[string, number, number[]?][]} */ ([
    ['GetAllParameters', 1],
    ['GetDistanceFactor', 1],
    ['GetDopplerFactor', 1],
    ['GetOrientation', 2],
    ['GetPosition', 1],
    ['GetRolloffFactor', 1],
    ['GetVelocity', 1],
    ['SetAllParameters', 2],
    ['SetDistanceFactor', 2, [1]],
    ['SetDopplerFactor', 2, [1]],
    ['SetOrientation', 7, [1, 2, 3, 4, 5, 6]],
    ['SetPosition', 4, XYZ],
    ['SetRolloffFactor', 2, [1]],
    ['SetVelocity', 4, XYZ],
    ['CommitDeferredSettings', 0],
]);

/** IDirectSound3DBuffer, after IUnknown's three. */
export const IDIRECTSOUND3DBUFFER_SLOTS = /** @type {[string, number, number[]?][]} */ ([
    ['GetAllParameters', 1],
    ['GetConeAngles', 2],
    ['GetConeOrientation', 1],
    ['GetConeOutsideVolume', 1],
    ['GetMaxDistance', 1],
    ['GetMinDistance', 1],
    ['GetMode', 1],
    ['GetPosition', 1],
    ['GetVelocity', 1],
    ['SetAllParameters', 2],
    ['SetConeAngles', 3],
    ['SetConeOrientation', 4, XYZ],
    ['SetConeOutsideVolume', 2],
    ['SetMaxDistance', 2, [1]],
    ['SetMinDistance', 2, [1]],
    ['SetMode', 2],
    ['SetPosition', 4, XYZ],
    ['SetVelocity', 4, XYZ],
]);

/** DS3DLISTENER, as d3dtypes lays it out: three-float vectors, then floats. */
export const DS3DLISTENER = Object.freeze({
    dwSize: 0, vPosition: 4, vVelocity: 16, vOrientFront: 28, vOrientTop: 40,
    flDistanceFactor: 52, flRolloffFactor: 56, flDopplerFactor: 60, SIZE: 64,
});

/** DS3DBUFFER. */
export const DS3DBUFFER = Object.freeze({
    dwSize: 0, vPosition: 4, vVelocity: 16, dwInsideConeAngle: 28, dwOutsideConeAngle: 32,
    vConeOrientation: 36, lConeOutsideVolume: 48, flMinDistance: 52, flMaxDistance: 56,
    dwMode: 60, SIZE: 64,
});

const DS3D_MAXCONEANGLE = 360;
const DS3DMODE_DISABLE = 2;

/** @typedef {[number, number, number]} Vector */

/**
 * @typedef {Object} Listener
 * @property {Vector} position
 * @property {Vector} velocity
 * @property {Vector} front
 * @property {Vector} top
 * @property {number} distance
 * @property {number} rolloff
 * @property {number} doppler
 */

/**
 * @typedef {Object} Placement
 * @property {Vector} position
 * @property {Vector} velocity
 * @property {number} inside
 * @property {number} outside
 * @property {Vector} cone
 * @property {number} outsideVolume
 * @property {number} min
 * @property {number} max
 * @property {number} mode
 */

/** @returns {Listener} */
const defaultListener = ()=>({
    position: [0, 0, 0], velocity: [0, 0, 0], front: [0, 0, 1], top: [0, 1, 0],
    distance: 1, rolloff: 1, doppler: 1,
});

/** @returns {Placement} */
const defaultPlacement = ()=>({
    position: [0, 0, 0], velocity: [0, 0, 0], inside: DS3D_MAXCONEANGLE,
    outside: DS3D_MAXCONEANGLE, cone: [0, 0, 1], outsideVolume: 0, min: 1, max: 1e9, mode: 0,
});

/**
 * The two method tables, over a device's listener and its buffers' places.
 *
 * @param {Object} deps
 * @param {any} deps.memory   readMemory/writeMemory over guest memory.
 */
export function createSpatial({ memory }){
    const scratch = new DataView(new ArrayBuffer(4));
    /** A float passed by value arrives as its bits in a dword. @param {number} bits */
    const asFloat = bits=>{
        scratch.setUint32(0, bits >>> 0, true);
        return scratch.getFloat32(0, true);
    };
    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readF32 = address=>asFloat(readU32(address));
    /** @param {number} address @returns {Vector} */
    const readVector = address=>[readF32(address), readF32(address + 4), readF32(address + 8)];
    /** @param {number} address @param {number[]} values float or dword per slot */
    const write = (address, values, floats = true)=>{
        const bytes = new Uint8Array(values.length * 4);
        const view = new DataView(bytes.buffer);
        values.forEach((value, at)=>{
            if (floats)
            {
                view.setFloat32(at * 4, value, true);
            }
            else
            {
                view.setUint32(at * 4, value >>> 0, true);
            }
        });
        memory.writeMemory(address >>> 0, bytes);
    };

    /** @type {WeakMap<object, Listener>} */
    const listeners = new WeakMap();
    /** @type {WeakMap<object, Placement>} */
    const placements = new WeakMap();
    /** @param {any} primary */
    const listenerOf = primary=>{
        let state = listeners.get(primary);
        if (!state)
        {
            state = defaultListener();
            listeners.set(primary, state);
        }
        return state;
    };
    /** @param {any} buffer */
    const placementOf = buffer=>{
        let state = placements.get(buffer);
        if (!state)
        {
            state = defaultPlacement();
            placements.set(buffer, state);
        }
        return state;
    };

    /**
     * An orientation Windows takes: no NaN, neither vector empty, and the two
     * not parallel -- there is no telling up from ahead along one line.
     *
     * @param {Vector} front @param {Vector} top
     */
    const orientable = (front, top)=>{
        if ([...front, ...top].some(Number.isNaN))
        {
            return false;
        }
        const cross = [
            front[1] * top[2] - front[2] * top[1],
            front[2] * top[0] - front[0] * top[2],
            front[0] * top[1] - front[1] * top[0],
        ];
        return cross.some(component=>component !== 0);
    };

    /** @param {number} at @param {number} size */
    const sized = (at, size)=>(at >>> 0) !== 0 && readU32(at) === size;

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const listenerMethods = {
        GetAllParameters(primary, [at]){
            if (!sized(at, DS3DLISTENER.SIZE))
            {
                return DSERR_INVALIDPARAM;
            }
            const state = listenerOf(primary);
            write(at + DS3DLISTENER.vPosition, [...state.position, ...state.velocity,
                ...state.front, ...state.top, state.distance, state.rolloff, state.doppler]);
            return DS_OK;
        },
        GetDistanceFactor(primary, [at]){
            return getFloat(at, listenerOf(primary).distance);
        },
        GetDopplerFactor(primary, [at]){
            return getFloat(at, listenerOf(primary).doppler);
        },
        GetOrientation(primary, [front, top]){
            if ((front >>> 0) === 0 || (top >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            const state = listenerOf(primary);
            write(front, state.front);
            write(top, state.top);
            return DS_OK;
        },
        GetPosition(primary, [at]){
            return getVector(at, listenerOf(primary).position);
        },
        GetRolloffFactor(primary, [at]){
            return getFloat(at, listenerOf(primary).rolloff);
        },
        GetVelocity(primary, [at]){
            return getVector(at, listenerOf(primary).velocity);
        },
        SetAllParameters(primary, [at]){
            if (!sized(at, DS3DLISTENER.SIZE))
            {
                return DSERR_INVALIDPARAM;
            }
            const front = readVector(at + DS3DLISTENER.vOrientFront);
            const top = readVector(at + DS3DLISTENER.vOrientTop);
            if (!orientable(front, top))
            {
                return DSERR_INVALIDPARAM;
            }
            Object.assign(listenerOf(primary), {
                position: readVector(at + DS3DLISTENER.vPosition),
                velocity: readVector(at + DS3DLISTENER.vVelocity),
                front, top,
                distance: readF32(at + DS3DLISTENER.flDistanceFactor),
                rolloff: readF32(at + DS3DLISTENER.flRolloffFactor),
                doppler: readF32(at + DS3DLISTENER.flDopplerFactor),
            });
            return DS_OK;
        },
        SetDistanceFactor(primary, [value]){
            listenerOf(primary).distance = asFloat(value);
            return DS_OK;
        },
        SetDopplerFactor(primary, [value]){
            listenerOf(primary).doppler = asFloat(value);
            return DS_OK;
        },
        SetOrientation(primary, [fx, fy, fz, tx, ty, tz]){
            /** @type {Vector} */
            const front = [asFloat(fx), asFloat(fy), asFloat(fz)];
            /** @type {Vector} */
            const top = [asFloat(tx), asFloat(ty), asFloat(tz)];
            if (!orientable(front, top))
            {
                return DSERR_INVALIDPARAM;
            }
            Object.assign(listenerOf(primary), { front, top });
            return DS_OK;
        },
        SetPosition(primary, [x, y, z]){
            listenerOf(primary).position = [asFloat(x), asFloat(y), asFloat(z)];
            return DS_OK;
        },
        SetRolloffFactor(primary, [value]){
            listenerOf(primary).rolloff = asFloat(value);
            return DS_OK;
        },
        SetVelocity(primary, [x, y, z]){
            listenerOf(primary).velocity = [asFloat(x), asFloat(y), asFloat(z)];
            return DS_OK;
        },
        CommitDeferredSettings(){
            return DS_OK;
        },
    };

    /** @param {number} at @param {number} value */
    function getFloat(at, value){
        if ((at >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        write(at, [value]);
        return DS_OK;
    }
    /** @param {number} at @param {Vector} value */
    function getVector(at, value){
        if ((at >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        write(at, value);
        return DS_OK;
    }
    /** @param {number} at @param {number} value */
    function getDword(at, value){
        if ((at >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        write(at, [value], false);
        return DS_OK;
    }

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const bufferMethods = {
        GetAllParameters(buffer, [at]){
            if (!sized(at, DS3DBUFFER.SIZE))
            {
                return DSERR_INVALIDPARAM;
            }
            const state = placementOf(buffer);
            write(at + DS3DBUFFER.vPosition, [...state.position, ...state.velocity]);
            write(at + DS3DBUFFER.dwInsideConeAngle, [state.inside, state.outside], false);
            write(at + DS3DBUFFER.vConeOrientation, state.cone);
            write(at + DS3DBUFFER.lConeOutsideVolume, [state.outsideVolume], false);
            write(at + DS3DBUFFER.flMinDistance, [state.min, state.max]);
            write(at + DS3DBUFFER.dwMode, [state.mode], false);
            return DS_OK;
        },
        GetConeAngles(buffer, [inside, outside]){
            const state = placementOf(buffer);
            if ((inside >>> 0) === 0 && (outside >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if ((inside >>> 0) !== 0)
            {
                write(inside, [state.inside], false);
            }
            if ((outside >>> 0) !== 0)
            {
                write(outside, [state.outside], false);
            }
            return DS_OK;
        },
        GetConeOrientation(buffer, [at]){
            return getVector(at, placementOf(buffer).cone);
        },
        GetConeOutsideVolume(buffer, [at]){
            return getDword(at, placementOf(buffer).outsideVolume);
        },
        GetMaxDistance(buffer, [at]){
            return getFloat(at, placementOf(buffer).max);
        },
        GetMinDistance(buffer, [at]){
            return getFloat(at, placementOf(buffer).min);
        },
        GetMode(buffer, [at]){
            return getDword(at, placementOf(buffer).mode);
        },
        GetPosition(buffer, [at]){
            return getVector(at, placementOf(buffer).position);
        },
        GetVelocity(buffer, [at]){
            return getVector(at, placementOf(buffer).velocity);
        },
        SetAllParameters(buffer, [at]){
            if (!sized(at, DS3DBUFFER.SIZE))
            {
                return DSERR_INVALIDPARAM;
            }
            const inside = readU32(at + DS3DBUFFER.dwInsideConeAngle);
            const outside = readU32(at + DS3DBUFFER.dwOutsideConeAngle);
            const mode = readU32(at + DS3DBUFFER.dwMode);
            if (inside > DS3D_MAXCONEANGLE || outside > DS3D_MAXCONEANGLE
                || mode > DS3DMODE_DISABLE)
            {
                return DSERR_INVALIDPARAM;
            }
            Object.assign(placementOf(buffer), {
                position: readVector(at + DS3DBUFFER.vPosition),
                velocity: readVector(at + DS3DBUFFER.vVelocity),
                inside, outside,
                cone: readVector(at + DS3DBUFFER.vConeOrientation),
                outsideVolume: readU32(at + DS3DBUFFER.lConeOutsideVolume) | 0,
                min: readF32(at + DS3DBUFFER.flMinDistance),
                max: readF32(at + DS3DBUFFER.flMaxDistance),
                mode,
            });
            return DS_OK;
        },
        SetConeAngles(buffer, [inside, outside]){
            if ((inside >>> 0) > DS3D_MAXCONEANGLE || (outside >>> 0) > DS3D_MAXCONEANGLE)
            {
                return DSERR_INVALIDPARAM;
            }
            Object.assign(placementOf(buffer), { inside: inside >>> 0, outside: outside >>> 0 });
            return DS_OK;
        },
        SetConeOrientation(buffer, [x, y, z]){
            placementOf(buffer).cone = [asFloat(x), asFloat(y), asFloat(z)];
            return DS_OK;
        },
        SetConeOutsideVolume(buffer, [volume]){
            placementOf(buffer).outsideVolume = volume | 0;
            return DS_OK;
        },
        SetMaxDistance(buffer, [value]){
            placementOf(buffer).max = asFloat(value);
            return DS_OK;
        },
        SetMinDistance(buffer, [value]){
            placementOf(buffer).min = asFloat(value);
            return DS_OK;
        },
        SetMode(buffer, [mode]){
            if ((mode >>> 0) > DS3DMODE_DISABLE)
            {
                return DSERR_INVALIDPARAM;
            }
            placementOf(buffer).mode = mode >>> 0;
            return DS_OK;
        },
        SetPosition(buffer, [x, y, z]){
            placementOf(buffer).position = [asFloat(x), asFloat(y), asFloat(z)];
            return DS_OK;
        },
        SetVelocity(buffer, [x, y, z]){
            placementOf(buffer).velocity = [asFloat(x), asFloat(y), asFloat(z)];
            return DS_OK;
        },
    };

    return { listenerMethods, bufferMethods };
}
