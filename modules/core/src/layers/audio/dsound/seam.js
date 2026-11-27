/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * How a program reaches DirectSound: the library it links against, the vtables
 * it calls through, and the structures that cross between.
 *
 * The shape here is the one the drawing layer's seam already uses -- interfaces
 * declared as an ordered list of slots, one adapter per object so that identity
 * survives, and a DLL table shaped like a win32 library's so the caller
 * assembling the process binds it with no special case. It is not *imported*
 * from there: this layer declares `win32`, `bridge` and `memory` in its
 * requires and not `graphics`, so reaching into that directory would be a
 * dependency the module graph does not admit. The adapter below is the twenty
 * lines that duplication costs.
 *
 * Two rules carry over unchanged, and both are enforced by the tests beside
 * this file:
 *
 * - **Every slot is listed, including the ones nothing implements.** A method
 *   with no implementation answers an error a program handles; a method left
 *   out shifts every later slot up one and breaks all of them silently.
 * - **`argBytes` counts the interface pointer.** A COM method is stdcall,
 *   and the bridge has the
 *   callee pop everything but `this`, so a miscount returns to a wrong address
 *   rather than returning a wrong value.
 */

import { createComPublisher, IID_IUNKNOWN } from '../../bridge/com-seam.js';
import { readGuid } from '../../../system/guid.js';
import { createSoundBuffer, normaliseFormat, DSBSTATUS_PLAYING } from './buffers.js';
import {
    createSpatial, IDIRECTSOUND3DLISTENER_SLOTS, IDIRECTSOUND3DBUFFER_SLOTS,
} from './spatial.js';
import {
    SOUND_ADAPTER_NAME, SOUND_DEVICE_GUID, SOUND_DEVICE_INTERFACE,
} from '../../win32/devices.js';
import { parseGuid } from '../../../system/guid.js';
import { GUID, struct } from '../../../system/layout.js';
import {
    FORMAT_WaveFormatEx, IID_IMediaObject, IID_IMediaObjectInPlace, MEDIASUBTYPE_IEEE_FLOAT,
    MEDIASUBTYPE_PCM, MEDIATYPE_Audio,
} from './effects.js';

export const DS_OK = 0;
const DS_UNCERTIFIED = 1;
const DSERR_INVALIDPARAM = 0x80070057 | 0;
const DSERR_OUTOFMEMORY = 0x8007000e | 0;
const DSERR_UNSUPPORTED = 0x80004001 | 0;
/** An object a class factory made, before Initialize names its device. */
const DSERR_UNINITIALIZED = 0x887800aa | 0;
/** What Compact answers below DSSCL_PRIORITY. */
const DSERR_PRIOLEVELNEEDED = 0x88780046 | 0;
const DSSCL_PRIORITY = 2;
const DSERR_ALREADYINITIALIZED = 0x88780082 | 0;
/** CLASS_E_NOAGGREGATION, under the name DirectSound gives it. */
const DSERR_NOAGGREGATION = 0x80040110 | 0;
const E_NOINTERFACE = 0x80004002 | 0;
const CLASS_E_CLASSNOTAVAILABLE = 0x80040111 | 0;

/** The classes this library's DllGetClassObject makes, and which generation each is. */
const CLSID_DirectSound = '{47D4D946-62E8-11CF-93BC-444553540000}';
const CLSID_DirectSound8 = '{3901CC3F-84B5-4FA4-BA35-AA8172B8A09B}';
const CLSID_DirectSoundCapture = '{B0210780-89CD-11D0-AF08-00A0C925CD16}';
const CLSID_DirectSoundCapture8 = '{E4BCAC13-7F99-4908-9A8E-74E3BF24B6E1}';
const CLSID_DirectSoundFullDuplex = '{FEA4300C-7959-4147-B26A-2377B9E7A91D}';
/** dsconf.h's private property set, which a program reaches only through DllGetClassObject. */
const CLSID_DirectSoundPrivate = '{11AB3EC0-25EC-11D1-A4D8-00C04FC28ACA}';
/** Each class this library makes, and the kind of object its factory makes. */
const CLASS_KINDS = new Map([
    [CLSID_DirectSound, 'sound'], [CLSID_DirectSound8, 'sound8'],
    [CLSID_DirectSoundCapture, 'capture'], [CLSID_DirectSoundCapture8, 'capture'],
    [CLSID_DirectSoundFullDuplex, 'duplex'], [CLSID_DirectSoundPrivate, 'private'],
]);
/** IDirectSoundCapture, which IDirectSoundCapture8 is by another name. */
const IID_IDirectSoundCapture = '{B0210781-89CD-11D0-AF08-00A0C925CD16}';
const IDIRECTSOUNDCAPTURE_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateCaptureBuffer', 3],
    ['GetCaps', 1],
    ['Initialize', 1],
]);
const IID_IDirectSoundFullDuplex = '{EDCB4C7A-DAAB-4216-A42E-6C50596DDC1D}';
const IDIRECTSOUNDFULLDUPLEX_SLOTS = /** @type {[string, number][]} */ ([
    ['Initialize', 8],
]);
const IID_IClassFactory = '{00000001-0000-0000-C000-000000000046}';
/** IClassFactory, after IUnknown's three. */
const ICLASSFACTORY_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateInstance', 3],
    ['LockServer', 1],
]);
const DSERR_INVALIDCALL = 0x88780032 | 0;
const DSERR_CONTROLUNAVAIL = 0x8878001e | 0;
const DSERR_NODRIVER = 0x88780078 | 0;
const DSERR_ALLOCATED = 0x8878000a | 0;
const WAVE_FORMAT_PCM = 1;

/** DSBCAPS flags a program sets when it describes a buffer it wants. */
const DSBCAPS_PRIMARYBUFFER = 0x00000001;
/** How long the primary buffer is, in bytes. */
const PRIMARY_BYTES = 0x10000;
const DSBCAPS_LOCHARDWARE = 0x00000004;
const DSBCAPS_LOCSOFTWARE = 0x00000008;
const DSBCAPS_CTRL3D = 0x00000010;
const DSBCAPS_CTRLFREQUENCY = 0x00000020;
const DSBCAPS_CTRLPAN = 0x00000040;
const DSBCAPS_CTRLVOLUME = 0x00000080;
const DSBCAPS_CTRLPOSITIONNOTIFY = 0x00000100;
const DSBCAPS_CTRLFX = 0x00000200;
const DSBCAPS_LOCDEFER = 0x00040000;
const DSBSTATUS_LOCSOFTWARE = 0x00000010;

/** @param {readonly string[]} names @returns {[string, 'u32'][]} a run of DWORDs */
const dwords = names=>names.map(name=>[name, 'u32']);

/** Interface identifiers. Facts about somebody else's ABI; there is no partial credit. */
export const IID_IDirectSound = '{279AFA83-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSound8 = '{C50A7E93-F395-4834-9EF6-7FA99DE50966}';
export const IID_IDirectSoundBuffer = '{279AFA85-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSoundBuffer8 = '{6825A449-7524-4D82-920F-50E36AB3AB1E}';
export const IID_IDirectSoundNotify = '{B0210783-89CD-11D0-AF08-00A0C925CD16}';
export const IID_IDirectSound3DListener = '{279AFA84-4981-11CE-A521-0020AF0BE560}';
export const IID_IDirectSound3DBuffer = '{279AFA86-4981-11CE-A521-0020AF0BE560}';
export const IID_IKsPropertySet = '{31EFAC30-515C-11D0-A9AA-00AA0061BE93}';
const COUNTED_ON_THEIR_OWN = new Set([IID_IDirectSoundNotify, IID_IKsPropertySet,
    IID_IDirectSound3DListener, IID_IDirectSound3DBuffer]);
/** IDirectSound and IDirectSound8 share the device's count; its IUnknown has one of its own. */
const DEVICE_COUNTED_ON_ITS_OWN = new Set([IID_IUNKNOWN]);

/**
 * WAVEFORMATEX, under mmsystem.h's #pragma pack(1): eighteen bytes, and the
 * two-byte fields are why it is not a table of dwords.
 */
const WAVE_FORMAT = struct([['wFormatTag', 'u16'], ['nChannels', 'u16'],
    ['nSamplesPerSec', 'u32'], ['nAvgBytesPerSec', 'u32'], ['nBlockAlign', 'u16'],
    ['wBitsPerSample', 'u16'], ['cbSize', 'u16']], { pack: 1 });
export const WAVEFORMATEX = WAVE_FORMAT.at(4);
/** WAVE_FORMAT_EXTENSIBLE, and where its extension's fields sit after WAVEFORMATEX. */
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;
/** WAVE_FORMAT_IEEE_FLOAT; also the first dword of KSDATAFORMAT_SUBTYPE_IEEE_FLOAT. */
const WAVE_FORMAT_IEEE_FLOAT = 3;
/**
 * WAVEFORMATEXTENSIBLE (mmreg.h, packed as its WAVEFORMATEX is): the
 * Samples union is one WORD, whichever of its names is meant.
 */
const EXTENSIBLE = struct([['Format', WAVE_FORMAT], ['wValidBitsPerSample', 'u16'],
    ['dwChannelMask', 'u32'], ['SubFormat', GUID]], { pack: 1 }).at(4);
/** The cbSize a whole WAVEFORMATEXTENSIBLE names: what follows its WAVEFORMATEX. */
const EXTENSIBLE_EXTRA = EXTENSIBLE.SIZE - WAVEFORMATEX.SIZE;

/**
 * DSBUFFERDESC, dsound.h's.
 *
 * DirectX 7 appended a 3D algorithm GUID, so the structure is either the
 * older DSBUFFERDESC1 or this one, and the caller says which in its first
 * field. Nothing before that moves, so both are read the same way and only
 * the trailing field is conditional. In a 64-bit process lpwfxFormat is
 * eight bytes and stays at 0x10, already aligned for it, so only the sizes
 * and the GUID behind it move: a 64-bit caller declares 24 or 40, and a
 * check against the 32-bit sizes refuses every buffer it asks for.
 */
const BUFFERDESC1_FIELDS = /** @type {const} */ ([['dwSize', 'u32'], ['dwFlags', 'u32'],
    ['dwBufferBytes', 'u32'], ['dwReserved', 'u32'], ['lpwfxFormat', 'ptr']]);
const BUFFERDESC = struct([...BUFFERDESC1_FIELDS, ['guid3DAlgorithm', GUID]]);
const BUFFERDESC1 = struct(BUFFERDESC1_FIELDS);
export const DSBUFFERDESC = BUFFERDESC.at(4);
export const DSBUFFERDESC_64 = BUFFERDESC.at(8);
export const DSBUFFERDESC1 = BUFFERDESC1.at(4);
export const DSBUFFERDESC1_64 = BUFFERDESC1.at(8);

/** DSBCAPS, which a program reads back to learn what it actually got. */
export const DSBCAPS = struct(dwords(['dwSize', 'dwFlags', 'dwBufferBytes',
    'dwUnlockTransferRate', 'dwPlayCpuOverhead'])).at(4);

/**
 * DSCAPS. Only the first few fields are filled; the rest exist to place them.
 *
 * Twenty-four dwords, which is ninety-six bytes and not a hundred. The size is
 * the one field a program fills in before the call, and it is checked against
 * this: too large a figure here refuses every correctly-filled structure, which
 * is what a sound library reads as "there is no DirectSound on this machine".
 */
export const DSCAPS = struct(dwords(['dwSize', 'dwFlags', 'dwMinSecondarySampleRate',
    'dwMaxSecondarySampleRate', 'dwPrimaryBuffers', 'dwMaxHwMixingAllBuffers',
    'dwMaxHwMixingStaticBuffers', 'dwMaxHwMixingStreamingBuffers', 'dwFreeHwMixingAllBuffers',
    'dwFreeHwMixingStaticBuffers', 'dwFreeHwMixingStreamingBuffers', 'dwMaxHw3DAllBuffers',
    'dwMaxHw3DStaticBuffers', 'dwMaxHw3DStreamingBuffers', 'dwFreeHw3DAllBuffers',
    'dwFreeHw3DStaticBuffers', 'dwFreeHw3DStreamingBuffers', 'dwTotalHwMemBytes',
    'dwFreeHwMemBytes', 'dwMaxContigFreeHwMemBytes', 'dwUnlockTransferRateHwBuffers',
    'dwPlayCpuOverheadSwBuffers', 'dwReserved1', 'dwReserved2'])).at(4);

/**
 * DSCAPS.dwFlags -- what the device says it can play.
 *
 * A program reads these before it decides how to open anything, so a device
 * that names none of them has said it can play neither mono nor stereo,
 * neither eight bits nor sixteen. There is nothing left for a caller to ask
 * for, and a sound library reads that as a device it cannot drive.
 */
export const DSCAPS_FLAGS = Object.freeze({
    PRIMARYMONO: 0x00000001,
    PRIMARYSTEREO: 0x00000002,
    PRIMARY8BIT: 0x00000004,
    PRIMARY16BIT: 0x00000008,
    CONTINUOUSRATE: 0x00000010,
    EMULDRIVER: 0x00000020,
    CERTIFIED: 0x00000040,
    SECONDARYMONO: 0x00000100,
    SECONDARYSTEREO: 0x00000200,
    SECONDARY8BIT: 0x00000400,
    SECONDARY16BIT: 0x00000800,
});

/**
 * The DSCAPS fields this device reports as zero.
 *
 * Everything about hardware mixing and hardware sound memory: there is none,
 * and a program that asks is entitled to be told so rather than to read
 * whatever its own stack happened to hold.
 */
const ZEROED_CAPS = Object.freeze([
    DSCAPS.dwMaxHwMixingAllBuffers, DSCAPS.dwMaxHwMixingStaticBuffers,
    DSCAPS.dwMaxHwMixingStreamingBuffers, DSCAPS.dwFreeHwMixingAllBuffers,
    DSCAPS.dwFreeHwMixingStaticBuffers, DSCAPS.dwFreeHwMixingStreamingBuffers,
    DSCAPS.dwMaxHw3DAllBuffers, DSCAPS.dwMaxHw3DStaticBuffers,
    DSCAPS.dwMaxHw3DStreamingBuffers, DSCAPS.dwFreeHw3DAllBuffers,
    DSCAPS.dwFreeHw3DStaticBuffers, DSCAPS.dwFreeHw3DStreamingBuffers,
    DSCAPS.dwTotalHwMemBytes, DSCAPS.dwFreeHwMemBytes,
    DSCAPS.dwMaxContigFreeHwMemBytes, DSCAPS.dwUnlockTransferRateHwBuffers,
    DSCAPS.dwPlayCpuOverheadSwBuffers, DSCAPS.dwReserved1, DSCAPS.dwReserved2,
]);

/**
 * Which ordinal is which export, for a program that links DSOUND.dll by
 * number: Windows' own, and only for the entry points this table has -- a
 * number bound to nothing is a call that binds and then jumps into nowhere.
 *
 * @type {Readonly<Record<number, string>>}
 */
const DSOUND_ORDINALS = Object.freeze({
    1: 'DirectSoundCreate',
    2: 'DirectSoundEnumerateA',
    3: 'DirectSoundEnumerateW',
    6: 'DirectSoundCaptureCreate',
    7: 'DirectSoundCaptureEnumerateA',
    8: 'DirectSoundCaptureEnumerateW',
    9: 'GetDeviceID',
    10: 'DirectSoundFullDuplexCreate',
    11: 'DirectSoundCreate8',
    12: 'DirectSoundCaptureCreate8',
});

/**
 * The one device's GUID, as a program reads it: what enumeration hands out
 * and GetDeviceID answers. Every GUID opens the same output here, so its value
 * only has to be stable and not null.
 */
const DEVICE_GUID = Object.freeze([.../** @type {Uint8Array} */ (parseGuid(SOUND_DEVICE_GUID))]);

/**
 * dsound.h's DSDEVID_Default* aliases, {DEF0000n-9C6D-47ED-AAF1-4DDA8F2B5C03},
 * as the sixteen bytes a GUID is in memory: n = 0 and 2 are DefaultPlayback
 * and DefaultVoicePlayback, 1 and 3 DefaultCapture and DefaultVoiceCapture.
 *
 * @param {number} which
 */
const defaultDeviceId = which=>Object.freeze([
    which, 0x00, 0xf0, 0xde, 0x6d, 0x9c, 0xed, 0x47,
    0xaa, 0xf1, 0x4d, 0xda, 0x8f, 0x2b, 0x5c, 0x03,
]);
const DEFAULT_PLAYBACK_IDS = Object.freeze([0, 2].map(defaultDeviceId));
const DEFAULT_CAPTURE_IDS = Object.freeze([1, 3].map(defaultDeviceId));

/**
 * DSBPOSITIONNOTIFY, one per position a program wants to be told about. In a
 * 64-bit process the HANDLE is eight bytes, aligned to eight.
 */
const POSITIONNOTIFY = struct([['dwOffset', 'u32'], ['hEventNotify', 'handle']]);
export const DSBPOSITIONNOTIFY = POSITIONNOTIFY.at(4);
export const DSBPOSITIONNOTIFY_64 = POSITIONNOTIFY.at(8);

/** IDirectSound, after IUnknown's three. */
export const IDIRECTSOUND_SLOTS = /** @type {[string, number][]} */ ([
    ['CreateSoundBuffer', 3],
    ['GetCaps', 1],
    ['DuplicateSoundBuffer', 2],
    ['SetCooperativeLevel', 2],
    ['Compact', 0],
    ['GetSpeakerConfig', 1],
    ['SetSpeakerConfig', 1],
    ['Initialize', 1],
]);

/** IDirectSound8 is IDirectSound with one appended. */
export const IDIRECTSOUND8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTSOUND_SLOTS,
    ['VerifyCertification', 1],
]);

/**
 * IDirectSoundBuffer, after IUnknown's three.
 *
 * The order is alphabetical for the getters and then not, which looks like a
 * mistake and is not: it is the order the header declares, and the header is
 * what a program was compiled against.
 */
export const IDIRECTSOUNDBUFFER_SLOTS = /** @type {[string, number][]} */ ([
    ['GetCaps', 1],
    ['GetCurrentPosition', 2],
    ['GetFormat', 3],
    ['GetVolume', 1],
    ['GetPan', 1],
    ['GetFrequency', 1],
    ['GetStatus', 1],
    ['Initialize', 2],
    ['Lock', 7],
    ['Play', 3],
    ['SetCurrentPosition', 1],
    ['SetFormat', 1],
    ['SetVolume', 1],
    ['SetPan', 1],
    ['SetFrequency', 1],
    ['Stop', 0],
    ['Unlock', 4],
    ['Restore', 0],
]);

/** IDirectSoundBuffer8 is the same interface with three appended. */
export const IDIRECTSOUNDBUFFER8_SLOTS = /** @type {[string, number][]} */ ([
    ...IDIRECTSOUNDBUFFER_SLOTS,
    ['SetFX', 3],
    ['AcquireResources', 3],
    ['GetObjectInPath', 4],
]);

/** IKsPropertySet, after IUnknown's three. */
const IKSPROPERTYSET_SLOTS = /** @type {[string, number][]} */ ([
    ['Get', 7],
    ['Set', 6],
    ['QuerySupport', 3],
]);

/** HRESULT_FROM_WIN32(ERROR_NOT_FOUND): a property set this device does not have. */
const E_PROP_ID_UNSUPPORTED = 0x80070490;

/** An effect's place in a buffer's chain (DSFXR_*), as SetFX reports it. */
const DSFXR_PRESENT = 0;
const DSFXR_LOCSOFTWARE = 2;
const DSFXR_UNKNOWN = 5;
const DSERR_OBJECTNOTFOUND = 0x88781161 | 0;
/** GetObjectInPath's "any object on the path". */
const GUID_All_Objects = '{AA114DE5-C262-4169-A1C8-23D698CC73B5}';
const CLSCTX_INPROC_SERVER = 1;
/** The vtable slots an effect is driven through. */
const SLOT_QUERY_INTERFACE = 0;
const SLOT_RELEASE = 2;
const SLOT_SET_INPUT_TYPE = 8;
const SLOT_SET_OUTPUT_TYPE = 9;
const SLOT_DISCONTINUITY = 17;
const SLOT_PROCESS = 3;

/** dsconf.h's DSPROPSETID_DirectSoundDevice, the private object's one property set. */
const DSPROPSETID_DirectSoundDevice = '{84624F82-25EC-11D1-A4D8-00C04FC28ACA}';
/** KSPROPERTY_SUPPORT_GET: every property of that set is read, none written. */
const KSPROPERTY_SUPPORT_GET = 1;
/**
 * DSPROPERTY_DIRECTSOUNDDEVICE, by id: what each asks and the form of its data
 * - A or W for the character width its strings are in, 1 for the structure
 * that carries both inline.
 *
 * @type {ReadonlyMap<number, { property: 'mapping' | 'description' | 'enumerate',
 *     form: 'A' | 'W' | '1' }>}
 */
const DEVICE_PROPERTIES = new Map([
    [1, { property: 'mapping', form: 'A' }],
    [2, { property: 'description', form: '1' }],
    [3, { property: 'enumerate', form: '1' }],
    [4, { property: 'mapping', form: 'W' }],
    [5, { property: 'description', form: 'A' }],
    [6, { property: 'description', form: 'W' }],
    [7, { property: 'enumerate', form: 'A' }],
    [8, { property: 'enumerate', form: 'W' }],
]);
/** DIRECTSOUNDDEVICE_DATAFLOW. */
const DATAFLOW_RENDER = 0;
const DATAFLOW_CAPTURE = 1;
/** DIRECTSOUNDDEVICE_TYPE_WDM: Windows NT has no VxD, so every device it lists is WDM. */
const DEVICE_TYPE_WDM = 2;
/**
 * dsconf.h's ..._WAVEDEVICEMAPPING_A/W_DATA: the wave device's name and flow
 * in, its GUID out.
 */
const WAVEDEVICEMAPPING_LAYOUT = struct([['DeviceName', 'ptr'], ['DataFlow', 'u32'],
    ['DeviceId', GUID]]);
const WAVEDEVICEMAPPING = WAVEDEVICEMAPPING_LAYOUT.at(4);
const WAVEDEVICEMAPPING_64 = WAVEDEVICEMAPPING_LAYOUT.at(8);
/** MAX_PATH, the length of the module name fields. */
const MAX_PATH = 260;
/** ..._DESCRIPTION_1_DATA: no pointer in it, one layout in either width. */
const DESCRIPTION_1 = struct([['DeviceId', GUID], ['DescriptionA', 'u8', 0x100],
    ['DescriptionW', 'u16', 0x100], ['ModuleA', 'u8', MAX_PATH], ['ModuleW', 'u16', MAX_PATH],
    ...dwords(['Type', 'DataFlow', 'WaveDeviceId', 'Devnode'])]).at(4);
/** ..._DESCRIPTION_A/W_DATA: the strings are pointers to text the library keeps. */
const DESCRIPTION_LAYOUT = struct([['Type', 'u32'], ['DataFlow', 'u32'], ['DeviceId', GUID],
    ['Description', 'ptr'], ['Module', 'ptr'], ['Interface', 'ptr'], ['WaveDeviceId', 'u32']]);
const DESCRIPTION = DESCRIPTION_LAYOUT.at(4);
const DESCRIPTION_64 = DESCRIPTION_LAYOUT.at(8);
/** ..._ENUMERATE_1/A/W_DATA: the program's callback and its context. */
const ENUMERATE_LAYOUT = struct([['Callback', 'ptr'], ['Context', 'ptr']]);
const ENUMERATE = ENUMERATE_LAYOUT.at(4);
const ENUMERATE_64 = ENUMERATE_LAYOUT.at(8);

/** IDirectSoundNotify, after IUnknown's three. */
const IDIRECTSOUNDNOTIFY_SLOTS = /** @type {[string, number][]} */ ([
    ['SetNotificationPositions', 2],
]);

/**
 * Builds an interface descriptor from `[name, argumentCount, floats?]` slots.
 *
 * The count excludes `this`, because that is how a header reads and
 * transcribing a header is what these lists are. `floats` names the
 * arguments that are a D3DVALUE, counting `this` as 0: a 64-bit caller passes
 * those among its first four in XMM registers, where the bridge reads them
 * from only when it is told.
 *
 * @param {string} id
 * @param {[string, number, number[]?][]} slots
 * @param {Record<string, (target: any, args: number[]) => number | Promise<number>>} [implemented]
 *        A method that calls back into the guest answers with a promise.
 */
export function describe(id, slots, implemented = {}){
    return {
        id,
        methods: slots.map(([name, args, floats])=>({
            name,
            argBytes: 4 + args * 4,
            invoke: implemented[name],
            ...floats ? { floats: Object.fromEntries(floats.map(at=>[at, 'f32'])) } : {},
        })),
    };
}

/**
 * DirectSound's counting (`bridge/com-seam.js`). Some interfaces keep counts
 * of their own, as on Windows -- a buffer's notify, property-set and 3D ones,
 * a device's IUnknown: each holds the object once while it is held, and the
 * object's own count leaves those holds out.
 *
 * @param {import('../../bridge/com-seam.js').ComSeat} seat
 * @param {ReadonlySet<string>} ownCounted
 * @returns {import('../../bridge/com-seam.js').ComCounting}
 */
function countedApart({ api }, ownCounted){
    /** @type {Map<string, number>} */
    const sides = new Map();
    const held = ()=>[...sides.values()].filter(count=>count > 0).length;
    return {
        addRef(id){
            if (id !== undefined && ownCounted.has(id))
            {
                const count = (sides.get(id) ?? 0) + 1;
                sides.set(id, count);
                if (count === 1)
                {
                    api.addRef?.();
                }
                return count;
            }
            return (api.addRef?.() ?? 1) - held();
        },
        release(id){
            if (id !== undefined && ownCounted.has(id))
            {
                const before = sides.get(id) ?? 0;
                sides.set(id, Math.max(0, before - 1));
                if (before === 1)
                {
                    api.release?.();
                }
                return Math.max(0, before - 1);
            }
            if (held() >= (api.references ?? 1))
            {
                return 0;
            }
            return (api.release?.() ?? 0) - held();
        },
        // Whether the bridge keeps the pointer at a count of zero: a primary
        // buffer lives as long as its device does.
        reachable: ()=>api.reachable?.() ?? false,
        // One count for every interface an object answers to, so its last
        // reference ends them all; `reachable` still keeps each.
        destroyed: ()=>api.destroyed === true,
    };
}

/**
 * DirectSound's objects as COM interfaces.
 *
 * @param {Object} deps
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 */
export function createPublisher({ publishInterface }){
    const seam = createComPublisher({ publishInterface, counting: countedApart });
    return {
        ...seam,
        /**
         * @param {any} api @param {any[]} interfaces @param {string} id
         * @param {ReadonlySet<string>} [ownCounted]  The interfaces that count
         *     their references apart from the object's own; fixed by the
         *     object's first publish.
         */
        publish: (api, interfaces, id, ownCounted = COUNTED_ON_THEIR_OWN)=>
            seam.publish(api, interfaces, id, ownCounted),
        /**
         * Moves the reference an object was made with from one of its
         * interfaces to another, as a class factory asked for the second.
         *
         * @param {any} api @param {string} from @param {string} to
         */
        hand(api, from, to){
            const adapter = seam.adapterFor(api);
            adapter?.addRef(to);
            adapter?.release(from);
        },
    };
}

/**
 * The DirectSound library and everything behind it.
 *
 * @param {Object} deps
 * @param {any} deps.memory   readMemory/writeMemory over guest memory, and writePointer
 *     (the memory layer's, a pointer of 4 or 8 bytes whole).
 * @param {(bytes: number) => number} deps.allocate  Guest memory for a buffer's samples.
 * @param {() => number} deps.now   The guest's clock, in milliseconds.
 * @param {(object: any, interfaceId: string) => number} deps.publishInterface
 * @param {(event: number) => void} [deps.signal]  Signals an event a notification names.
 * @param {(entry: number, args: number[], thread?: any) => Promise<number>} [deps.callGuest]
 *        Runs a guest routine and answers with what it returned. A sound
 *        library of this era hands the system a callback and expects it run
 *        before the call returns, so a table without this route cannot answer
 *        those calls truthfully.
 * @param {() => unknown} [deps.callerThread]
 *        Whose call `EnumDevices` is answering, named before the loop's first
 *        await: a second callback is a call made after that await, by when
 *        the thread on the processor may no longer be this one.
 * @param {(api: string, detail: string) => void} [deps.divergence]
 *        Told where this DirectSound behaves differently from Windows'.
 * @param {{ enter: () => void, leave: () => void }} [deps.mtaUsage]
 *        ole32's hold on the multithreaded apartment. An initialized device
 *        keeps it open while it lives, as Windows' worker threads do, so a
 *        thread that entered no apartment is in it implicitly.
 * @param {4 | 8} [deps.pointerSize]  8 for a 64-bit process: its descriptors
 *        and notification arrays in their 64-bit layouts, and every pointer an
 *        out parameter takes written whole.
 * @param {(clsid: number, outer: number, context: number, iid: number, out: number)
 *     => number | Promise<number>} [deps.createInstance]
 *        CoCreateInstance as a program calls it, guest pointers in: how a
 *        buffer's SetFX makes the effects it names, the program's own
 *        registered class included.
 * @param {(buffer: any) => void} [deps.played]  Told at each Play, after the
 *        buffer is playing: where the sound device gives it its voice, so the
 *        voice starts where the cursor was put.
 */
export function createDirectSound({
    memory, allocate, now, publishInterface, signal, callGuest, callerThread, divergence, mtaUsage,
    pointerSize = 4, createInstance, played,
})
{
    const publisher = createPublisher({ publishInterface });
    const long = pointerSize === 8;
    const descriptorLayout = long ? DSBUFFERDESC_64 : DSBUFFERDESC;
    const descriptorLayout1 = long ? DSBUFFERDESC1_64 : DSBUFFERDESC1;
    const notifyLayout = long ? DSBPOSITIONNOTIFY_64 : DSBPOSITIONNOTIFY;

    /** @param {number} address */
    const readU32 = address=>{
        const bytes = memory.readMemory(address >>> 0, 4);
        return (bytes[0] | bytes[1] << 8 | bytes[2] << 16 | bytes[3] << 24) >>> 0;
    };
    /** @param {number} address */
    const readU16 = address=>{
        const bytes = memory.readMemory(address >>> 0, 2);
        return bytes[0] | bytes[1] << 8;
    };
    /** @param {number} address @param {number} value */
    const writeU32 = (address, value)=>{
        if ((address >>> 0) === 0)
        {
            return;
        }
        memory.writeMemory(address >>> 0, new Uint8Array([
            value & 0xff, value >>> 8 & 0xff, value >>> 16 & 0xff, value >>> 24 & 0xff,
        ]));
    };
    /**
     * An interface or a sample address into a pointer-sized out parameter,
     * whole, by the memory layer's writer: a 64-bit caller's slot holds
     * whatever its stack held, so the upper half is written too.
     *
     * @param {number} address @param {number} value
     */
    const writePointer = (address, value)=>{
        if ((address >>> 0) !== 0)
        {
            memory.writePointer(address, value, long ? 8 : 4);
        }
    };

    /** @type {any[]} */
    const buffers = [];
    /**
     * The buffers a look may have something to do with: made since the last
     * one, called by the program, or not idle when last looked at. A stopped
     * buffer the program leaves alone stays idle -- its cursor does not move
     * with time -- so a program that keeps a thousand sounds loaded and plays
     * a few is walked for the few, not the thousand, on every turn.
     *
     * @type {Set<any>}
     */
    const awake = new Set();
    /** @param {Record<string, Function>} methods  methods whose target is a buffer */
    const waking = methods=>Object.fromEntries(Object.entries(methods).map(([name, method])=>
        [name, (/** @type {any} */ buffer, /** @type {number[]} */ args)=>{
            awake.add(buffer);
            return method(buffer, args);
        }]));
    let placedOnce = false;
    /** Deferred buffers whose place has been settled. @type {WeakSet<object>} */
    const placedInSoftware = new WeakSet();
    // How often a program drove each buffer method. A sound that is never heard
    // and a sound that is played and dropped on the way to the mixer look the
    // same from outside, and this is the first thing that tells them apart.
    /** @type {Record<string, number>} */
    const calls = {};
    // The last calls in order, with the detail that says why a sound starts and
    // dies: Play's loop flag, what GetCurrentPosition handed back, where Stop
    // left the cursor. Totals cannot show a sequence, and the sequence is what
    // a program's own sound engine decided.
    /** @type {string[]} */
    const events = [];
    /** Every buffer asked for, with its flags and the answer; kept whole. */
    /** @type {string[]} */
    const creations = [];
    /** @param {string} line */
    const record = line=>{
        events.push(line);
        if (events.length > 48)
        {
            events.shift();
        }
    };
    /**
     * The last level a program asked for. DSSCL_NORMAL is 1, and the levels
     * above it are what Windows requires before the primary format may be set.
     */
    let cooperativeLevel = 0;

    /**
     * Delivers whatever notifications a buffer's cursor has passed.
     *
     * Called from every entry point that touches a buffer rather than from a
     * timer, for the reason the streaming path already has: a program that
     * polls instead of waiting never reaches a timer, and its notifications
     * would never fire.
     *
     * @param {any} buffer
     */
    const deliver = buffer=>{
        for (const event of buffer.drainNotifications())
        {
            signal?.(event);
        }
    };

    /** @param {number} address @returns {import('./buffers.js').SoundFormat | null} */
    const readFormat = address=>{
        if ((address >>> 0) === 0)
        {
            return null;
        }
        // WAVEFORMATEXTENSIBLE: the extension has to be whole, name its sample
        // type, and claim no more valid bits than the container has (Wine's
        // dsound.c test_primary_secondary); zero valid bits means all of them.
        if (readU16(address + WAVEFORMATEX.wFormatTag) === WAVE_FORMAT_EXTENSIBLE)
        {
            const subFormat = memory.readMemory((address >>> 0) + EXTENSIBLE.SubFormat, 16);
            if (readU16(address + WAVEFORMATEX.cbSize) < EXTENSIBLE_EXTRA
                || subFormat.every((/** @type {number} */ byte)=>byte === 0)
                || readU16(address + EXTENSIBLE.wValidBitsPerSample)
                    > readU16(address + WAVEFORMATEX.wBitsPerSample))
            {
                return null;
            }
        }
        // As DirectSound checks every format (Wine's dsound.c
        // perform_invalid_fmt_tests): channels, a rate, whole bytes a sample,
        // a block of exactly one frame and some byte rate, which need not
        // agree with the rest. Plain PCM stops at stereo; more channels are
        // said with WAVEFORMATEXTENSIBLE.
        const channels = readU16(address + WAVEFORMATEX.nChannels);
        const sampleRate = readU32(address + WAVEFORMATEX.nSamplesPerSec);
        const bitsPerSample = readU16(address + WAVEFORMATEX.wBitsPerSample);
        const averageBytes = readU32(address + WAVEFORMATEX.nAvgBytesPerSec);
        if (channels === 0 || sampleRate === 0 || bitsPerSample === 0 || bitsPerSample % 8 !== 0
            || readU16(address + WAVEFORMATEX.nBlockAlign) !== channels * bitsPerSample / 8
            || averageBytes === 0
            || (readU16(address + WAVEFORMATEX.wFormatTag) === WAVE_FORMAT_PCM && channels > 2))
        {
            return null;
        }
        // Floats are said by WAVE_FORMAT_IEEE_FLOAT, or by an extensible
        // format's KSDATAFORMAT_SUBTYPE_IEEE_FLOAT, whose first dword is that
        // tag -- SDL2's thirty-two-bit stream, which read as integers is noise.
        const tag = readU16(address + WAVEFORMATEX.wFormatTag);
        const float = bitsPerSample === 32 && (tag === WAVE_FORMAT_IEEE_FLOAT
            || (tag === WAVE_FORMAT_EXTENSIBLE
                && readU32(address + EXTENSIBLE.SubFormat) === WAVE_FORMAT_IEEE_FLOAT));
        return normaliseFormat({ channels, sampleRate, bitsPerSample, averageBytes,
            ...float ? { float } : {} });
    };

    /**
     * The format structure as the program wrote it, which GetFormat hands
     * back whole -- its tag and its extension included.
     *
     * @param {number} address
     */
    const formatBytes = address=>{
        const extra = readU16(address + WAVEFORMATEX.cbSize);
        const tag = readU16(address + WAVEFORMATEX.wFormatTag);
        const length = tag === WAVE_FORMAT_PCM ? WAVEFORMATEX.SIZE - 2
            : WAVEFORMATEX.SIZE + Math.min(extra, EXTENSIBLE_EXTRA);
        const bytes = new Uint8Array(WAVEFORMATEX.SIZE + EXTENSIBLE_EXTRA);
        bytes.set(memory.readMemory(address >>> 0, length));
        return bytes.subarray(0, Math.max(length, WAVEFORMATEX.SIZE));
    };
    /** @type {WeakMap<object, Uint8Array>} */
    const programFormats = new WeakMap();

    /** @param {number} address @param {import('./buffers.js').SoundFormat} format */
    const writeFormat = (address, format)=>{
        const bytes = new Uint8Array(WAVEFORMATEX.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint16(WAVEFORMATEX.wFormatTag, 1, true); // WAVE_FORMAT_PCM
        view.setUint16(WAVEFORMATEX.nChannels, format.channels, true);
        view.setUint32(WAVEFORMATEX.nSamplesPerSec, format.sampleRate, true);
        view.setUint32(WAVEFORMATEX.nAvgBytesPerSec,
            format.averageBytes ?? format.sampleRate * format.blockAlign, true);
        view.setUint16(WAVEFORMATEX.nBlockAlign, format.blockAlign, true);
        view.setUint16(WAVEFORMATEX.wBitsPerSample, format.bitsPerSample, true);
        view.setUint16(WAVEFORMATEX.cbSize, 0, true);
        memory.writeMemory(address >>> 0, bytes);
    };

    // Described once: the bridge shares one table of stubs per method list, and
    // a list per buffer was a table per buffer. Built on first use, because the
    // methods it names are defined below.
    /** @type {{ buffer: any, buffer8: any, notify: any, properties: any, listener: any,
     *     placed: any } | null} */
    let describedBuffer = null;
    const bufferDescriptors = ()=>describedBuffer ??= {
        buffer: describe(IID_IDirectSoundBuffer, IDIRECTSOUNDBUFFER_SLOTS, waking(bufferMethods)),
        buffer8: describe(IID_IDirectSoundBuffer8, IDIRECTSOUNDBUFFER8_SLOTS,
            waking(bufferMethods)),
        notify: describe(IID_IDirectSoundNotify, IDIRECTSOUNDNOTIFY_SLOTS, waking(notifyMethods)),
        properties: describe(IID_IKsPropertySet, IKSPROPERTYSET_SLOTS,
            waking(propertySetMethods)),
        listener: describe(IID_IDirectSound3DListener, IDIRECTSOUND3DLISTENER_SLOTS,
            waking(spatial.listenerMethods)),
        placed: describe(IID_IDirectSound3DBuffer, IDIRECTSOUND3DBUFFER_SLOTS,
            waking(spatial.bufferMethods)),
    };
    const spatial = createSpatial({ memory });
    /**
     * What one buffer answers QueryInterface for. IDirectSoundNotify only when
     * it was created to notify: a program asks for it to learn which kind of
     * buffer it holds, and E_NOINTERFACE is the answer for one that is not.
     *
     * The 3D interfaces: the listener is the primary buffer's, a placement in
     * space a secondary buffer's only when it was created with DSBCAPS_CTRL3D.
     *
     * IKsPropertySet is every buffer's, primary too, as on Windows: a program
     * asks it for EAX and the voice manager, and is told the device has
     * neither.
     *
     * @param {any} buffer
     */
    const bufferInterfaces = buffer=>{
        const { buffer: base, buffer8, notify, properties, listener, placed } = bufferDescriptors();
        return [
            // A secondary buffer is IDirectSoundBuffer and IDirectSoundBuffer8
            // through one pointer (Wine's dsound8.c test_buffer8); the
            // primary buffer is the one IDirectSoundBuffer8 is not.
            buffer.primary ? base : { id: base.id, sharedWith: buffer8.id },
            properties,
            ...buffer.primary ? [listener] : [buffer8],
            ...(buffer.capabilities & DSBCAPS_CTRLPOSITIONNOTIFY) !== 0 ? [notify] : [],
            ...!buffer.primary && (buffer.capabilities & DSBCAPS_CTRL3D) !== 0 ? [placed] : [],
        ];
    };

    /**
     * IKsPropertySet over a device with no property set of its own: no EAX
     * environment, no voice manager. Every set is E_PROP_ID_UNSUPPORTED, the
     * answer a program asking after EAX takes as "play without it", and a
     * support query clears the caller's flags first.
     *
     * @type {Record<string, (target: any, args: number[]) => number>}
     */
    const propertySetMethods = {
        Get: ()=>E_PROP_ID_UNSUPPORTED,
        Set: ()=>E_PROP_ID_UNSUPPORTED,
        /** HRESULT QuerySupport(REFGUID, ULONG, PULONG pTypeSupport) */
        QuerySupport(_buffer, [, , support]){
            if ((support >>> 0) !== 0)
            {
                memory.writeMemory(support >>> 0, new Uint8Array(4));
            }
            return E_PROP_ID_UNSUPPORTED;
        },
    };

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const notifyMethods = {
        /** HRESULT SetNotificationPositions(DWORD count, LPCDSBPOSITIONNOTIFY) */
        SetNotificationPositions(buffer, [count, array]){
            const wanted = count >>> 0;
            if (wanted > 0 && (array >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            const positions = [];
            for (let at = 0; at < wanted; at++)
            {
                const entry = (array >>> 0) + at * notifyLayout.SIZE;
                positions.push({
                    offset: readU32(entry + notifyLayout.dwOffset),
                    event: readU32(entry + notifyLayout.hEventNotify),
                });
            }
            buffer.setNotifications(positions);
            return DS_OK;
        },
    };

    /**
     * Whether a buffer has a control: only if it was created with it, which is
     * what a program checks GetCaps for before touching one. The primary
     * buffer is the device's output and has no rate of its own to change.
     *
     * @param {any} buffer @param {number} flag
     */
    const hasControl = (buffer, flag)=>(buffer.capabilities & flag) !== 0
        && !(buffer.primary && flag === DSBCAPS_CTRLFREQUENCY);

    /**
     * A value now or a promise of one, the next step run on it either way:
     * a buffer with no effects answers in the call, as it always has.
     *
     * @template T, U
     * @param {T | Promise<T>} value @param {(value: T) => U | Promise<U>} next
     * @returns {U | Promise<U>}
     */
    const andThen = (value, next)=>(value instanceof Promise ? value.then(next) : next(value));

    /** A pointer whole, by the memory layer's reader. @param {number} address */
    const readPointer = address=>memory.readPointer(address, long ? 8 : 4);

    /**
     * Calls a method of a guest object - an effect the program or the engine
     * made - through its vtable.
     *
     * @param {number} object @param {number} slot @param {number[]} args
     * @param {unknown} thread
     * @returns {Promise<number>}
     */
    const callMethod = async(object, slot, args, thread)=>{
        const entry = readPointer(readPointer(object) + slot * pointerSize);
        return (await /** @type {NonNullable<typeof callGuest>} */ (callGuest)(entry,
            [object, ...args], thread)) | 0;
    };

    /**
     * Each buffer's effects, in the chain's order: the class it was made by,
     * its IMediaObject and its IMediaObjectInPlace (0 where it has none).
     *
     * @type {WeakMap<any, { clsid: string, object: number, inPlace: number }[]>}
     */
    const effectsOf = new WeakMap();
    /**
     * Guest memory a buffer's effects are driven with, made once: a class
     * and interface id and an out pointer, a DMO_MEDIA_TYPE and its
     * WAVEFORMATEX, then room for the whole buffer, which an effect runs
     * over in place.
     *
     * @type {WeakMap<any, number>}
     */
    const scratchOf = new WeakMap();
    const SCRATCH_CLSID = 0;
    const SCRATCH_IID = 16;
    const SCRATCH_OUT = 32;
    const SCRATCH_TYPE = 48;
    const SCRATCH_FORMAT = 144;
    const SCRATCH_DATA = 176;
    /** Effects that could not run over a span, said once each. @type {Set<string>} */
    const effectSaid = new Set();

    /** @param {any} buffer */
    const scratchFor = buffer=>{
        let at = scratchOf.get(buffer);
        if (at === undefined)
        {
            at = allocate(SCRATCH_DATA + buffer.bytes);
            scratchOf.set(buffer, at);
        }
        return at;
    };

    /**
     * The buffer's format as a DMO_MEDIA_TYPE: PCM (or float) audio, its
     * WAVEFORMATEX, a sample the size of a frame going in and of a byte
     * coming out, as DirectSound hands it to an effect.
     *
     * @param {any} buffer @param {number} at  the scratch block @param {number} sampleSize
     */
    const writeMediaType = (buffer, at, sampleSize)=>{
        const format = buffer.format;
        const wave = new DataView(new ArrayBuffer(18));
        wave.setUint16(0, format.float ? WAVE_FORMAT_IEEE_FLOAT : WAVE_FORMAT_PCM, true);
        wave.setUint16(2, format.channels, true);
        wave.setUint32(4, format.sampleRate, true);
        wave.setUint32(8, format.sampleRate * format.blockAlign, true);
        wave.setUint16(12, format.blockAlign, true);
        wave.setUint16(14, format.bitsPerSample, true);
        memory.writeMemory(at + SCRATCH_FORMAT, new Uint8Array(wave.buffer));
        const type = new Uint8Array(long ? 88 : 72);
        type.set(/** @type {Uint8Array} */ (parseGuid(MEDIATYPE_Audio)), 0);
        type.set(/** @type {Uint8Array} */ (parseGuid(format.float
            ? MEDIASUBTYPE_IEEE_FLOAT : MEDIASUBTYPE_PCM)), 16);
        const view = new DataView(type.buffer);
        view.setUint32(32, 1, true);
        view.setUint32(40, sampleSize, true);
        type.set(/** @type {Uint8Array} */ (parseGuid(FORMAT_WaveFormatEx)), 44);
        view.setUint32(long ? 72 : 64, 18, true);
        view.setUint32(long ? 80 : 68, at + SCRATCH_FORMAT, true);
        memory.writeMemory(at + SCRATCH_TYPE, type);
    };

    /**
     * Lets a chain go: each effect's interfaces released, as the buffer
     * holds them.
     *
     * @param {{ object: number, inPlace: number }[]} chain @param {unknown} thread
     */
    const releaseEffects = async(chain, thread)=>{
        for (const effect of chain)
        {
            if (effect.inPlace !== 0)
            {
                await callMethod(effect.inPlace, SLOT_RELEASE, [], thread);
            }
            await callMethod(effect.object, SLOT_RELEASE, [], thread);
        }
    };

    /**
     * SetFX's work once its arguments are checked.
     *
     * @param {any} buffer @param {number} count @param {number} descriptions
     * @param {number} results
     */
    const setEffects = async(buffer, count, descriptions, results)=>{
        const thread = callerThread?.();
        await releaseEffects(effectsOf.get(buffer) ?? [], thread);
        effectsOf.delete(buffer);
        buffer.clearEffected?.();
        if (count === 0)
        {
            return DS_OK;
        }
        const at = scratchFor(buffer);
        const descriptionSize = long ? 40 : 32;
        /** @type {{ clsid: string, object: number, inPlace: number }[]} */
        const made = [];
        let failure = DS_OK;
        for (let index = 0; index < count; index++)
        {
            const clsid = memory.readMemory(descriptions + index * descriptionSize + 8, 16);
            memory.writeMemory(at + SCRATCH_CLSID, clsid);
            memory.writeMemory(at + SCRATCH_IID,
                /** @type {Uint8Array} */ (parseGuid(IID_IMediaObject)));
            memory.writeMemory(at + SCRATCH_OUT, new Uint8Array(8));
            const created = await /** @type {NonNullable<typeof createInstance>} */ (
                createInstance)(at + SCRATCH_CLSID, 0, CLSCTX_INPROC_SERVER, at + SCRATCH_IID,
                at + SCRATCH_OUT) | 0;
            if (created < 0)
            {
                failure = created;
                break;
            }
            const object = readPointer(at + SCRATCH_OUT);
            writeMediaType(buffer, at, buffer.format.blockAlign);
            let answer = await callMethod(object, SLOT_SET_INPUT_TYPE, [0, at + SCRATCH_TYPE, 0],
                thread);
            if (answer >= 0)
            {
                writeMediaType(buffer, at, 1);
                answer = await callMethod(object, SLOT_SET_OUTPUT_TYPE,
                    [0, at + SCRATCH_TYPE, 0], thread);
            }
            if (answer < 0)
            {
                await callMethod(object, SLOT_RELEASE, [], thread);
                failure = answer;
                break;
            }
            memory.writeMemory(at + SCRATCH_IID,
                /** @type {Uint8Array} */ (parseGuid(IID_IMediaObjectInPlace)));
            memory.writeMemory(at + SCRATCH_OUT, new Uint8Array(8));
            const asked = await callMethod(object, SLOT_QUERY_INTERFACE,
                [at + SCRATCH_IID, at + SCRATCH_OUT], thread);
            const inPlace = asked >= 0 ? readPointer(at + SCRATCH_OUT) : 0;
            const name = readGuid(memory, at + SCRATCH_CLSID);
            if (inPlace === 0)
            {
                divergence?.('IDirectSoundBuffer8::SetFX',
                    `effect ${name} has no IMediaObjectInPlace and is not run`);
            }
            made.push({ clsid: name, object, inPlace });
        }
        if (failure < 0)
        {
            await releaseEffects(made, thread);
            if (results !== 0)
            {
                for (let index = 0; index < count; index++)
                {
                    writeU32(results + index * 4,
                        index < made.length ? DSFXR_PRESENT : DSFXR_UNKNOWN);
                }
            }
            return failure;
        }
        effectsOf.set(buffer, made);
        if (results !== 0)
        {
            for (let index = 0; index < count; index++)
            {
                writeU32(results + index * 4, DSFXR_LOCSOFTWARE);
            }
        }
        return DS_OK;
    };

    /**
     * Runs a buffer's effects over spans of it, in the chain's order, each
     * in place on a copy: what is heard of those spans is what they make of
     * the program's samples, which stay as the program wrote them.
     *
     * @param {any} buffer @param {{ from: number, length: number }[]} spans
     * @param {unknown} thread
     */
    const runEffects = async(buffer, spans, thread)=>{
        const chain = effectsOf.get(buffer) ?? [];
        const data = scratchFor(buffer) + SCRATCH_DATA;
        for (const { from, length } of spans)
        {
            if (length <= 0)
            {
                continue;
            }
            memory.writeMemory(data, memory.readMemory(buffer.address + from, length));
            for (const effect of chain)
            {
                if (effect.inPlace === 0)
                {
                    continue;
                }
                const answer = await callMethod(effect.inPlace, SLOT_PROCESS,
                    long ? [length, data, 0, 0] : [length, data, 0, 0, 0], thread);
                if (answer < 0 && !effectSaid.has(effect.clsid))
                {
                    effectSaid.add(effect.clsid);
                    divergence?.('IMediaObjectInPlace::Process', `effect ${effect.clsid} refused`
                        + ` a span (0x${(answer >>> 0).toString(16)}); it is heard as written`);
                }
            }
            buffer.setEffected?.(from, memory.readMemory(data, length));
        }
    };

    /**
     * What Play owes a buffer's effects: each told the stream starts again,
     * then run over the whole buffer.
     *
     * @param {any} buffer @param {unknown} thread
     */
    const startEffects = async(buffer, thread)=>{
        for (const effect of effectsOf.get(buffer) ?? [])
        {
            await callMethod(effect.object, SLOT_DISCONTINUITY, [0], thread);
        }
        await runEffects(buffer, [{ from: 0, length: buffer.bytes }], thread);
    };

    /** @type {Record<string, (target: any, args: number[]) => number | Promise<number>>} */
    const bufferMethods = {
        /** HRESULT GetCurrentPosition(LPDWORD play, LPDWORD write) */
        GetCurrentPosition(buffer, [play, write]){
            calls.GetCurrentPosition = (calls.GetCurrentPosition || 0) + 1;
            deliver(buffer);
            const { play: at, write: ahead } = buffer.cursors();
            writeU32(play, at);
            writeU32(write, ahead);
            record(`b${buffers.indexOf(buffer)} GetPos p=${at} w=${ahead} st=${buffer.status()}`);
            return DS_OK;
        },

        /** HRESULT GetStatus(LPDWORD status) */
        GetStatus(buffer, [status]){
            deliver(buffer);
            if ((status >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(status, buffer.status()
                | (placedInSoftware.has(buffer) ? DSBSTATUS_LOCSOFTWARE : 0));
            return DS_OK;
        },

        /**
         * HRESULT AcquireResources(DWORD flags, DWORD count, LPDWORD results)
         *
         * Where a buffer created with DSBCAPS_LOCDEFER is mixed is settled
         * here, or at its first Play: in software, the one place there is.
         */
        AcquireResources(buffer){
            if ((buffer.capabilities & DSBCAPS_LOCDEFER) !== 0)
            {
                placedInSoftware.add(buffer);
            }
            return DS_OK;
        },

        /** HRESULT Play(DWORD reserved, DWORD priority, DWORD flags) */
        Play(buffer, [, , flags]){
            calls.Play = (calls.Play || 0) + 1;
            record(`b${buffers.indexOf(buffer)} Play loop=${(flags >>> 0) & 1} n=${buffer.bytes}`);
            const start = ()=>{
                buffer.play(flags >>> 0);
                played?.(buffer);
                bufferMethods.AcquireResources(buffer, []);
                return DS_OK;
            };
            // Each effect is told the stream starts again, and runs over what
            // the buffer holds before it is heard.
            return (effectsOf.get(buffer)?.length ?? 0) > 0
                ? andThen(startEffects(buffer, callerThread?.()), start) : start();
        },

        /** HRESULT Stop(void) */
        Stop(buffer){
            calls.Stop = (calls.Stop || 0) + 1;
            buffer.stop();
            // After the stop, so the call itself sets DSBPN_OFFSETSTOP: a
            // program stops a buffer and at once waits to be told it has.
            deliver(buffer);
            record(`b${buffers.indexOf(buffer)} Stop cursor=${buffer.cursors().play}`);
            return DS_OK;
        },

        /** HRESULT SetCurrentPosition(DWORD position) */
        SetCurrentPosition(buffer, [position]){
            if ((position >>> 0) >= buffer.bytes)
            {
                return DSERR_INVALIDPARAM;
            }
            buffer.setCurrentPosition(position);
            record(`b${buffers.indexOf(buffer)} SetPos ${position >>> 0}`);
            return DS_OK;
        },

        /**
         * HRESULT Lock(DWORD offset, DWORD bytes, LPVOID* p1, LPDWORD n1,
         *              LPVOID* p2, LPDWORD n2, DWORD flags)
         */
        Lock(buffer, [offset, bytes, p1, n1, p2, n2, flags]){
            calls.Lock = (calls.Lock || 0) + 1;
            record(`b${buffers.indexOf(buffer)} Lock off=${offset >>> 0} bytes=${bytes >>> 0}`);
            if ((p1 >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if ((n1 >>> 0) === 0)
            {
                writePointer(p1, 0);
                return DSERR_INVALIDPARAM;
            }
            deliver(buffer);
            const ranges = buffer.lockRange(offset, bytes, flags >>> 0);
            const none = { address: 0, bytes: 0 };
            const { first, second } = ranges ?? { first: none, second: none };
            writePointer(p1, first.address);
            writeU32(n1, first.bytes);
            // The second range is written wherever the caller offered somewhere
            // to put it, zero included: a caller that passed pointers and reads
            // a stale value there splices audio from a previous lock. Either of
            // the two may be missing, even when the lock wraps.
            writePointer(p2, second.address);
            writeU32(n2, second.bytes);
            return ranges ? DS_OK : DSERR_INVALIDPARAM;
        },

        /** HRESULT Unlock(LPVOID p1, DWORD n1, LPVOID p2, DWORD n2) */
        Unlock(buffer, [p1, n1, p2, n2]){
            record(`b${buffers.indexOf(buffer)} Unlock`);
            // A range is named by its pointer; the sizes are not looked at,
            // save by the effects, which run over what was written.
            if (!buffer.unlock([p1 >>> 0, p2 >>> 0].filter(at=>at !== 0)))
            {
                return DSERR_INVALIDPARAM;
            }
            if ((effectsOf.get(buffer)?.length ?? 0) === 0)
            {
                return DS_OK;
            }
            const spans = [[p1 >>> 0, n1 >>> 0], [p2 >>> 0, n2 >>> 0]]
                .filter(([at, length])=>at !== 0 && length > 0)
                .map(([at, length])=>({ from: at - buffer.address,
                    length: Math.min(length, buffer.bytes - (at - buffer.address)) }));
            return andThen(runEffects(buffer, spans, callerThread?.()), ()=>DS_OK);
        },

        /** HRESULT GetCaps(LPDSBCAPS caps) */
        GetCaps(buffer, [caps]){
            if ((caps >>> 0) === 0 || readU32(caps + DSBCAPS.dwSize) < DSBCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            // What the program asked for, which is what it branches on before
            // touching a control, and where the buffer is mixed. That is in
            // software unless it asked for hardware and was given it: a
            // buffer is in one place or the other, never neither.
            writeU32(caps + DSBCAPS.dwFlags, buffer.primary
                || (buffer.capabilities & DSBCAPS_LOCHARDWARE) !== 0
                ? buffer.capabilities
                : buffer.capabilities | DSBCAPS_LOCSOFTWARE);
            writeU32(caps + DSBCAPS.dwBufferBytes, buffer.bytes);
            writeU32(caps + DSBCAPS.dwUnlockTransferRate, 0);
            writeU32(caps + DSBCAPS.dwPlayCpuOverhead, 0);
            return DS_OK;
        },

        /**
         * HRESULT SetFormat(LPCWAVEFORMATEX)
         *
         * How a program says what the mix should run at, and it is asked of the
         * primary buffer alone -- a secondary one's format is fixed when it is
         * created, and DirectSound refuses this on one. Refusing it on the
         * primary as well is what a sound library reads as a device it cannot
         * drive: it releases everything and falls back to wave-out, which is
         * how a game ends up with no DirectSound at all.
         */
        SetFormat(buffer, [format]){
            if (!buffer.primary)
            {
                return DSERR_INVALIDCALL;
            }
            const wanted = readFormat(format);
            if (!wanted)
            {
                // More than stereo in plain PCM is a mix the device will not
                // take, rather than a structure that makes no sense.
                return (format >>> 0) !== 0 && readU16(format + WAVEFORMATEX.nChannels) > 2
                    && readU16(format + WAVEFORMATEX.wFormatTag) === WAVE_FORMAT_PCM
                    ? DSERR_ALLOCATED : DSERR_INVALIDPARAM;
            }
            buffer.setFormat(wanted);
            programFormats.set(buffer, formatBytes(format));
            return DS_OK;
        },

        /** HRESULT GetFormat(LPWAVEFORMATEX, DWORD size, LPDWORD written) */
        GetFormat(buffer, [format, size, written]){
            const given = programFormats.get(buffer);
            const length = given ? given.length : WAVEFORMATEX.SIZE;
            if ((format >>> 0) !== 0)
            {
                if ((size >>> 0) < length)
                {
                    return DSERR_INVALIDPARAM;
                }
                if (given)
                {
                    memory.writeMemory(format >>> 0, given);
                }
                else
                {
                    writeFormat(format, buffer.format);
                }
            }
            // Optional, and a caller that wants only the structure passes null
            // for it -- which is what Miles passes. Writing through it anyway
            // puts four bytes at address zero.
            if ((written >>> 0) !== 0)
            {
                writeU32(written, length);
            }
            return DS_OK;
        },

        /** HRESULT GetVolume(LPLONG) */
        GetVolume(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLVOLUME))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.volume);
            return DS_OK;
        },
        /** HRESULT SetVolume(LONG) */
        SetVolume(buffer, [value]){
            if (!hasControl(buffer, DSBCAPS_CTRLVOLUME))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setVolume(value | 0);
            return DS_OK;
        },
        /** HRESULT GetPan(LPLONG) */
        GetPan(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLPAN))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.pan);
            return DS_OK;
        },
        /** HRESULT SetPan(LONG) */
        SetPan(buffer, [value]){
            if (!hasControl(buffer, DSBCAPS_CTRLPAN))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setPan(value | 0);
            return DS_OK;
        },
        /** HRESULT GetFrequency(LPDWORD) */
        GetFrequency(buffer, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (!hasControl(buffer, DSBCAPS_CTRLFREQUENCY))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            writeU32(out, buffer.frequency);
            return DS_OK;
        },
        /** HRESULT SetFrequency(DWORD) */
        SetFrequency(buffer, [hz]){
            if (!hasControl(buffer, DSBCAPS_CTRLFREQUENCY))
            {
                return DSERR_CONTROLUNAVAIL;
            }
            buffer.setFrequency(hz >>> 0);
            return DS_OK;
        },

        /**
         * HRESULT SetFX(DWORD count, LPDSEFFECTDESC effects, LPDWORD results)
         *
         * Effects are a control like volume and pan, and a buffer created
         * without it refuses them as it would refuse either; a locked or
         * playing buffer keeps the chain it has. The chain given replaces the
         * one there: each effect made through COM as a DMO and given the
         * buffer's format in and out. One that cannot be made or refuses the
         * format fails the whole call with its answer, and the buffer is left
         * with no effects, as on Windows; the results say which were made
         * (DSFXR_PRESENT) and which not (DSFXR_UNKNOWN).
         */
        SetFX(buffer, [count, effects, results]){
            if ((buffer.capabilities & DSBCAPS_CTRLFX) === 0)
            {
                return DSERR_CONTROLUNAVAIL;
            }
            // A count names that many descriptions; none names none, and a
            // result array with nothing to report on is a caller's mistake.
            if ((count >>> 0) === 0
                ? (effects >>> 0) !== 0 || (results >>> 0) !== 0
                : (effects >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            if (buffer.locked || (buffer.status() & DSBSTATUS_PLAYING) !== 0)
            {
                return DSERR_INVALIDCALL;
            }
            if (!createInstance || !callGuest)
            {
                return (count >>> 0) === 0 ? DS_OK : DSERR_UNSUPPORTED;
            }
            return setEffects(buffer, count >>> 0, effects >>> 0, results >>> 0);
        },

        /**
         * HRESULT GetObjectInPath(REFGUID object, DWORD index, REFGUID iid,
         *     LPVOID *out)
         *
         * An effect on the buffer's chain, by its class (or any, with
         * GUID_All_Objects) and its place among those that match, asked for
         * one of its interfaces.
         */
        GetObjectInPath(buffer, [object, index, iid, out]){
            if ((out >>> 0) === 0 || (object >>> 0) === 0 || (iid >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            const wanted = readGuid(memory, object >>> 0);
            const found = (effectsOf.get(buffer) ?? []).filter((/** @type {any} */ effect)=>
                wanted === GUID_All_Objects || effect.clsid === wanted)[index >>> 0];
            if (!found)
            {
                return DSERR_OBJECTNOTFOUND;
            }
            return andThen(callMethod(found.object, SLOT_QUERY_INTERFACE,
                [iid >>> 0, out >>> 0], callerThread?.()), hr=>{
                if (hr < 0)
                {
                    writePointer(out, 0);
                }
                return hr;
            });
        },

        /**
         * HRESULT Restore(void)
         *
         * Nothing here loses a buffer -- the samples are in guest memory and
         * stay there -- so this succeeds. It exists because a program that has
         * seen DSBSTATUS_BUFFERLOST calls it before writing again, and one that
         * never sees that status still calls it after regaining focus.
         */
        Restore(){
            return DS_OK;
        },
    };

    /** @param {any} buffer */
    const publishBuffer = buffer=>
        publisher.publish(buffer, bufferInterfaces(buffer), IID_IDirectSoundBuffer);

    /** @type {Record<string, (target: any, args: number[]) => number>} */
    const soundMethods = {
        /** HRESULT CreateSoundBuffer(LPCDSBUFFERDESC, LPDIRECTSOUNDBUFFER*, IUnknown*) */
        CreateSoundBuffer(root, [descriptor, out]){
            if ((descriptor >>> 0) === 0 || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // One of the two layouts, or a caller that disagrees with us about
            // where every later field is.
            const size = readU32(descriptor + descriptorLayout.dwSize);
            if (size !== descriptorLayout1.SIZE && size !== descriptorLayout.SIZE)
            {
                writePointer(out, 0);
                return DSERR_INVALIDPARAM;
            }
            const flags = readU32(descriptor + descriptorLayout.dwFlags);
            const primary = (flags & DSBCAPS_PRIMARYBUFFER) !== 0;
            const wanted = readU32(descriptor + descriptorLayout.dwBufferBytes);
            const formatAt = readU32(descriptor + descriptorLayout.lpwfxFormat);
            const format = readFormat(formatAt);
            const asked = `CreateSoundBuffer flags=0x${(flags >>> 0).toString(16)} bytes=${wanted}`
                + ` fmt=${format ? `${format.sampleRate}/${format.bitsPerSample}/${format.channels}` : '-'}`;
            record(asked);
            creations.push(asked);

            // The primary buffer's format is the device's, set afterwards
            // through SetFormat; a description that names one is refused, as
            // is one asking for effects, which only a secondary buffer takes.
            if (primary && (formatAt !== 0 || (flags & DSBCAPS_CTRLFX) !== 0))
            {
                writePointer(out, 0);
                return DSERR_INVALIDPARAM;
            }

            // A device has one primary buffer, and asking again hands it out
            // again with its count raised; the new description is ignored, as
            // DirectSound's own debug output says it is.
            if (primary && root.primary)
            {
                root.primary.addRef();
                writePointer(out, publishBuffer(root.primary));
                return DS_OK;
            }

            // A primary buffer names no size and no format: it is the mix
            // target, and a program creates one only to set the format the
            // hardware runs at. A secondary one without a size is a caller's
            // mistake.
            if (!primary && (wanted === 0 || !format))
            {
                writePointer(out, 0);
                return DSERR_INVALIDPARAM;
            }
            // DirectSound 8's rule, not the older interface's, which makes
            // both: a sound placed in space is one point, so it is mono and
            // has no pan of its own.
            if (root.eight && !primary && (flags & DSBCAPS_CTRL3D) !== 0
                && ((flags & DSBCAPS_CTRLPAN) !== 0 || format?.channels !== 1))
            {
                writePointer(out, 0);
                return DSERR_INVALIDPARAM;
            }

            const resolved = format ?? normaliseFormat({});
            // Up to a whole frame, as DirectSound does: every cursor and every
            // read is frame-aligned, and a lap that ends part way through a
            // frame starts the next one reading its samples out of step.
            // The primary buffer is a power of two long, as Windows' is (Wine's
            // 64 KiB): a program that writes it itself indexes its ring with a
            // mask of the length less one, and over any other length every lap
            // writes its samples to the wrong places -- sound in fragments.
            const bytes = primary
                ? PRIMARY_BYTES
                : Math.ceil(wanted / resolved.blockAlign) * resolved.blockAlign;
            const address = allocate(bytes);
            if (address === 0)
            {
                writePointer(out, 0);
                return DSERR_OUTOFMEMORY;
            }
            // A new buffer holds silence, as DirectSound's does. A program may
            // start one looping before it has written a byte -- a mixer that
            // fills it from a timer only once something plays -- and a block a
            // heap hands out again still holds whatever was there, which the
            // loop would play over and over. The primary buffer too: under
            // DSSCL_WRITEPRIMARY it is played as the program left it.
            memory.writeMemory(address, new Uint8Array(bytes)
                .fill(resolved.bitsPerSample === 8 ? 0x80 : 0));

            const buffer = createSoundBuffer({
                bytes, address, format: resolved, now, primary, capabilities: flags,
                // The device's own, which the program can ask for again after
                // releasing every reference it had.
                kept: primary ? ()=>root.references > 0 : undefined,
                touched: ()=>awake.add(buffer),
            });
            buffers.push(buffer);
            awake.add(buffer);
            if (!primary && (flags & DSBCAPS_CTRL3D) !== 0 && !placedOnce)
            {
                placedOnce = true;
                divergence?.('DirectSound', 'a 3D buffer keeps its place in space but is heard'
                    + ' as with 3D processing disabled');
            }
            if (format)
            {
                programFormats.set(buffer, formatBytes(formatAt));
            }
            if (primary)
            {
                root.primary = buffer;
            }
            writePointer(out, publishBuffer(buffer));
            return DS_OK;
        },

        /** HRESULT DuplicateSoundBuffer(LPDIRECTSOUNDBUFFER, LPDIRECTSOUNDBUFFER*) */
        DuplicateSoundBuffer(root, [original, out]){
            const source = publisher.objectAt(original);
            if (!source || (out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // The primary buffer is the device's output, and there is one.
            if (source.primary)
            {
                return DSERR_INVALIDCALL;
            }
            // A duplicate shares its original's samples and has its own
            // cursors and volume. Sharing the address is the whole point: a
            // program duplicates a sound to play it twice at once without
            // paying for the audio twice.
            const copy = createSoundBuffer({
                bytes: source.bytes,
                address: source.address,
                format: source.format,
                now,
                capabilities: source.capabilities,
                touched: ()=>awake.add(copy),
            });
            buffers.push(copy);
            awake.add(copy);
            writePointer(out, publishBuffer(copy));
            return DS_OK;
        },

        /**
         * HRESULT SetCooperativeLevel(HWND, DWORD)
         *
         * Which program owns the device, on a machine where only one program
         * runs. Recorded and otherwise inert.
         */
        SetCooperativeLevel(root, [, level]){
            cooperativeLevel = level >>> 0;
            root.level = cooperativeLevel;
            record(`SetCooperativeLevel ${cooperativeLevel}`);
            // Recorded and not enforced. Windows refuses SetFormat on the
            // primary buffer below DSSCL_PRIORITY and this does not: a program
            // that sets the mix format without asking for the right to gets it
            // anyway. Nothing here is shared with another program, so the
            // permission it is really asking for is not ours to withhold -- but
            // it is a difference from the real thing, and this layer has no
            // reporter to say so through yet.
            return DS_OK;
        },

        /** HRESULT GetCaps(LPDSCAPS) */
        GetCaps(root, [caps]){
            record('GetCaps');
            if ((caps >>> 0) === 0 || readU32(caps + DSCAPS.dwSize) < DSCAPS.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            // What this device can play, which is everything: the mixer behind
            // it converts whatever a program opens. Naming none of these -- as
            // this did -- says the opposite, that it can play neither mono nor
            // stereo and neither eight bits nor sixteen, and a sound library
            // reading that has nothing left to ask for. Miles asked, was told
            // there was nothing, and went away without opening a single buffer.
            writeU32(caps + DSCAPS.dwFlags,
                DSCAPS_FLAGS.PRIMARYMONO | DSCAPS_FLAGS.PRIMARYSTEREO
                | DSCAPS_FLAGS.PRIMARY8BIT | DSCAPS_FLAGS.PRIMARY16BIT
                | DSCAPS_FLAGS.SECONDARYMONO | DSCAPS_FLAGS.SECONDARYSTEREO
                | DSCAPS_FLAGS.SECONDARY8BIT | DSCAPS_FLAGS.SECONDARY16BIT
                // Any rate, because resampling is what the mixer does anyway.
                //
                // Not EMULDRIVER. That flag meant the wave-out emulation of a
                // system with no DirectSound driver at all, and no working
                // device of the last two decades reports it. A sound
                // middleware reading it concludes DirectSound is not really
                // there, mixes through wave-out instead, and refuses every
                // positional provider that needs the DirectSound path -- which
                // is the whole of a title's effects, silently.
                | DSCAPS_FLAGS.CONTINUOUSRATE);
            writeU32(caps + DSCAPS.dwMinSecondarySampleRate, 100);
            writeU32(caps + DSCAPS.dwMaxSecondarySampleRate, 100000);
            writeU32(caps + DSCAPS.dwPrimaryBuffers, 1);
            // Every remaining field written, because a field left alone is one
            // the caller reads out of its own uninitialised memory. Zero is the
            // honest answer to all of them: nothing here is mixed in hardware,
            // so there are no hardware voices and no sound memory to report.
            for (const field of ZEROED_CAPS)
            {
                writeU32(caps + field, 0);
            }
            return DS_OK;
        },

        /**
         * HRESULT Compact(void): there is no sound memory to compact, but
         * asking needs DSSCL_PRIORITY, as on Windows.
         */
        Compact(root){
            return (root.level ?? 0) >= DSSCL_PRIORITY ? DS_OK : DSERR_PRIOLEVELNEEDED;
        },

        /** HRESULT GetSpeakerConfig(LPDWORD) */
        GetSpeakerConfig(root, [out]){
            record('GetSpeakerConfig');
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // DSSPEAKER_COMBINED(DSSPEAKER_STEREO (4), DSSPEAKER_GEOMETRY_WIDE
            // (20 degrees)), what Windows answers for two speakers and Wine's
            // dsound answers by default. 2 is DSSPEAKER_MONO: told so, FMOD
            // mixed every title down to one channel.
            writeU32(out, 0x00140004);
            return DS_OK;
        },
        /** HRESULT SetSpeakerConfig(DWORD) */
        SetSpeakerConfig(){
            return DS_OK;
        },
        /**
         * HRESULT Initialize(LPCGUID)
         *
         * Names the device of an object a class factory made; one already
         * named -- every object DirectSoundCreate made -- refuses. A capture
         * device named is none this machine has.
         */
        Initialize(root, [guid]){
            if (root.initialized !== false)
            {
                return DSERR_ALREADYINITIALIZED;
            }
            if (!namesPlayback(guid))
            {
                return DSERR_NODRIVER;
            }
            root.initialized = true;
            mtaUsage?.enter();
            return DS_OK;
        },

        /**
         * HRESULT VerifyCertification(LPDWORD)
         *
         * DS_UNCERTIFIED, the answer GetCaps already gives by leaving out
         * DSCAPS_CERTIFIED: there is no driver behind this device to certify.
         */
        VerifyCertification(root, [out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writeU32(out, DS_UNCERTIFIED);
            return DS_OK;
        },
    };

    // An object a class factory made answers nothing but Initialize until
    // Initialize names its device (Wine's dsound IDirectSound_test).
    for (const [name, method] of Object.entries(soundMethods))
    {
        if (name !== 'Initialize')
        {
            soundMethods[name] = (root, args)=>(root.initialized === false
                ? DSERR_UNINITIALIZED
                : method(root, args));
        }
    }

    const soundInterfaces = [describe(IID_IDirectSound, IDIRECTSOUND_SLOTS, soundMethods)];
    const sound8Interfaces = [
        ...soundInterfaces,
        describe(IID_IDirectSound8, IDIRECTSOUND8_SLOTS, soundMethods),
    ];

    /**
     * A new object for every call, as on Windows, each counting its own
     * references. DirectSoundCreate's is IDirectSound and refuses
     * IDirectSound8; DirectSoundCreate8's is both, published as the one the
     * entry point promises, so a program calls it through IDirectSound8's
     * table, slot eleven included, without asking for it again.
     *
     * The count is a real one: the bridge frees an interface pointer whose
     * release answers zero, so a zero while the program holds another
     * reference frees a pointer it is still using.
     *
     * @param {number} out @param {boolean} eight
     */
    const createInto = (out, eight, initialized = true)=>{
        if ((out >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        let references = 1;
        if (initialized)
        {
            mtaUsage?.enter();
        }
        const device = {
            initialized,
            addRef: ()=>++references,
            release(){
                if (references === 1 && device.initialized)
                {
                    mtaUsage?.leave();
                }
                references = Math.max(0, references - 1);
                return references;
            },
            get references(){
                return references;
            },
            get destroyed(){
                return references === 0;
            },
            eight,
            /**
             * This object's primary buffer, once asked for: another object's
             * is another buffer (Wine's dsound test_primary_independent).
             *
             * @type {any}
             */
            primary: null,
        };
        writePointer(out, eight
            ? publisher.publish(device, sound8Interfaces, IID_IDirectSound8,
                DEVICE_COUNTED_ON_ITS_OWN)
            : publisher.publish(device, soundInterfaces, IID_IDirectSound,
                DEVICE_COUNTED_ON_ITS_OWN));
        return DS_OK;
    };

    const factoryInterfaces = [describe(IID_IClassFactory, ICLASSFACTORY_SLOTS, {
        /** HRESULT CreateInstance(IUnknown *outer, REFIID, void **ppv) */
        CreateInstance(factory, [outer, iid, out]){
            if ((out >>> 0) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            writePointer(out, 0);
            if ((outer >>> 0) !== 0)
            {
                return DSERR_NOAGGREGATION;
            }
            const wanted = (iid >>> 0) === 0 ? '' : readGuid(memory, iid >>> 0);
            if (Object.hasOwn(plainInterfaces, factory.kind))
            {
                return createPlain(factory.kind, wanted, out);
            }
            const interfaces = factory.eight ? sound8Interfaces : soundInterfaces;
            if (!interfaces.some(entry=>entry.id === wanted) && wanted !== IID_IUNKNOWN)
            {
                return E_NOINTERFACE;
            }
            const made = createInto(out, factory.eight, false);
            if (made !== DS_OK || wanted === (factory.eight ? IID_IDirectSound8 : IID_IDirectSound))
            {
                return made;
            }
            // Asked for another of its interfaces: that one is handed back,
            // holding the one reference the object was made with.
            const object = publisher.objectAt(readU32(out >>> 0));
            writePointer(out, publisher.publish(object, interfaces, wanted));
            if (wanted === IID_IUNKNOWN)
            {
                publisher.hand(object, factory.eight ? IID_IDirectSound8 : IID_IDirectSound,
                    IID_IUNKNOWN);
            }
            return DS_OK;
        },
        /** HRESULT LockServer(BOOL): nothing here is unloaded to be kept. */
        LockServer: ()=>DS_OK,
    })];

    /**
     * Whether a device GUID names the one playback device: no GUID, GUID_NULL,
     * the device's own, or a playback default.
     *
     * @param {number} guid
     */
    const namesPlayback = guid=>{
        if ((guid >>> 0) === 0)
        {
            return true;
        }
        const asked = memory.readMemory(guid >>> 0, 16);
        const names = (/** @type {readonly number[]} */ id)=>id.every((byte, at)=>asked[at] === byte);
        // GUID_NULL is the default device as much as no GUID is: it is what
        // a sound library copies for the "Primary Sound Driver" entry an
        // enumeration hands over with no GUID.
        return asked.every((/** @type {number} */ byte)=>byte === 0)
            || names(DEVICE_GUID) || DEFAULT_PLAYBACK_IDS.some(names);
    };

    /**
     * A device GUID that names no playback device here: DSERR_NODRIVER, as
     * Windows answers, said aloud -- a program refused its device plays
     * nothing and says so only in its own log.
     *
     * @param {number} guid
     */
    const refuseDevice = guid=>{
        divergence?.('DirectSoundCreate', `no playback device ${readGuid(memory, guid >>> 0)}`);
        return DSERR_NODRIVER;
    };

    /** @param {number[]} args */
    const noCaptureDevice = ([, out, outer])=>{
        if ((outer >>> 0) !== 0)
        {
            return DSERR_NOAGGREGATION;
        }
        if ((out >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        writePointer(out, 0);
        return DSERR_NODRIVER;
    };

    /**
     * The objects a class factory makes that are not a playback device.
     * Capture and full duplex, over a machine with no capture device: the
     * object is made, and initializing it is DSERR_NODRIVER, as Windows
     * answers without a microphone (Wine's capture.c and duplex.c). The
     * private property set: IKsPropertySet over DSPROPSETID_DirectSoundDevice.
     */
    const plainInterfaces = {
        capture: [describe(IID_IDirectSoundCapture, IDIRECTSOUNDCAPTURE_SLOTS, {
            CreateCaptureBuffer: ()=>DSERR_UNINITIALIZED,
            GetCaps: ()=>DSERR_UNINITIALIZED,
            Initialize: ()=>DSERR_NODRIVER,
        })],
        duplex: [describe(IID_IDirectSoundFullDuplex, IDIRECTSOUNDFULLDUPLEX_SLOTS, {
            /** The two buffers it would hand back must have somewhere to go. */
            Initialize(_object, [, , , , , , captureOut, renderOut]){
                if ((captureOut >>> 0) === 0 || (renderOut >>> 0) === 0)
                {
                    return DSERR_INVALIDPARAM;
                }
                writePointer(captureOut, 0);
                writePointer(renderOut, 0);
                return DSERR_NODRIVER;
            },
        })],
        private: [describe(IID_IKsPropertySet, IKSPROPERTYSET_SLOTS, {
            Get: (_object, args)=>getDeviceProperty(args),
            Set: ()=>E_PROP_ID_UNSUPPORTED,
            /** HRESULT QuerySupport(REFGUID, ULONG id, PULONG pTypeSupport) */
            QuerySupport(_object, [set, id, support]){
                const known = namesDeviceSet(set) && DEVICE_PROPERTIES.has(id >>> 0);
                writeU32(support, known ? KSPROPERTY_SUPPORT_GET : 0);
                return known ? DS_OK : E_PROP_ID_UNSUPPORTED;
            },
        })],
    };

    /**
     * @param {'capture' | 'duplex' | 'private'} kind @param {string} wanted @param {number} out
     */
    const createPlain = (kind, wanted, out)=>{
        const interfaces = plainInterfaces[kind];
        const own = interfaces[0].id;
        if (wanted !== own && wanted !== IID_IUNKNOWN)
        {
            return E_NOINTERFACE;
        }
        let references = 1;
        const object = {
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get references(){
                return references;
            },
            get destroyed(){
                return references === 0;
            },
        };
        publisher.publish(object, interfaces, own, DEVICE_COUNTED_ON_ITS_OWN);
        if (wanted === IID_IUNKNOWN)
        {
            writePointer(out, publisher.publish(object, interfaces, IID_IUNKNOWN));
            publisher.hand(object, own, IID_IUNKNOWN);
            return DS_OK;
        }
        writePointer(out, publisher.publish(object, interfaces, own));
        return DS_OK;
    };

    /** A class object, counting its own references. @param {string} kind */
    const classFactory = kind=>{
        let references = 1;
        return {
            kind,
            eight: kind === 'sound8',
            addRef: ()=>++references,
            release: ()=>(references = Math.max(0, references - 1)),
            get destroyed(){
                return references === 0;
            },
        };
    };

    /** @type {Map<string, number>} */
    const placedAt = new Map();
    /**
     * Bytes put where guest code can read them, at one address per key for
     * the session: what an enumeration hands a program is written afresh each
     * time and never allocated twice, so a program that asks every frame does
     * not grow the heap.
     *
     * @param {string} key @param {Uint8Array} bytes
     */
    const place = (key, bytes)=>{
        let address = placedAt.get(key);
        if (address === undefined)
        {
            address = allocate(bytes.length);
            placedAt.set(key, address);
        }
        memory.writeMemory(address, bytes);
        return address;
    };

    /**
     * A string as guest code reads it, terminated, in the width the caller of
     * an A or W entry point expects.
     *
     * @param {string} text @param {boolean} wide
     */
    const encodeText = (text, wide)=>{
        const units = wide ? 2 : 1;
        const bytes = new Uint8Array((text.length + 1) * units);
        for (let index = 0; index < text.length; index++)
        {
            const code = text.charCodeAt(index);
            bytes[index * units] = code & 0xff;
            if (wide)
            {
                bytes[index * units + 1] = code >>> 8 & 0xff;
            }
        }
        return bytes;
    };

    /** @param {string} text @param {boolean} wide @returns {number} its address */
    const stringForGuest = (text, wide)=>
        place(`${wide ? 'W' : 'A'}:${text}`, encodeText(text, wide));

    /** How many times a program has asked what sound devices there are. */
    let enumerations = 0;

    /**
     * Hands each entry to a program's callback in turn, as Windows does, until
     * it answers FALSE: TRUE asks for the next one, and a program that has
     * seen enough is obeyed rather than handed a list it did not want.
     *
     * The callback is guest code, so answering means running the guest from
     * inside a host call; the bridge parks the caller while that happens, and
     * this returns a promise it hands back rather than a value.
     *
     * @param {number} callback @param {number[][]} entries  each call's arguments
     */
    const callEach = (callback, entries)=>{
        enumerations++;
        if (!callGuest)
        {
            // No route to guest code - a test harness, or an engine assembled
            // without a bridge. Saying so is better than reporting no devices,
            // which a program reads as a machine that cannot play sound.
            return DS_OK;
        }
        // Named once, before the loop's first await - see the parameter doc.
        const thread = callerThread?.();
        return (async()=>{
            for (const args of entries)
            {
                if ((await callGuest(callback >>> 0, args, thread) | 0) === 0)
                {
                    break;
                }
            }
            return DS_OK;
        })();
    };

    /**
     * Describes the devices to a program's own callback, as Windows does.
     *
     * The primary driver comes first and always, with a null GUID -- that entry
     * is what a program takes as "this machine can play sound", and a machine
     * with hardware then describes each device after it. One device follows
     * here because that is what this engine has: a single output that whoever
     * assembles it opened.
     *
     * @param {number} callback @param {number} context @param {boolean} wide
     */
    const enumerate = (callback, context, wide)=>{
        if ((callback >>> 0) === 0)
        {
            return DSERR_INVALIDPARAM;
        }
        const blank = stringForGuest('', wide);
        // A GUID is sixteen bytes and a program keeps it to open that device by
        // name later.
        const guid = place('device guid', Uint8Array.from(DEVICE_GUID));
        return callEach(callback, [
            [0, stringForGuest('Primary Sound Driver', wide), blank, context >>> 0],
            [guid, stringForGuest(SOUND_ADAPTER_NAME, wide), blank, context >>> 0],
        ]);
    };

    /** @param {number} set  a property set's GUID, as the program passed it */
    const namesDeviceSet = set=>(set >>> 0) !== 0
        && readGuid(memory, set >>> 0) === DSPROPSETID_DirectSoundDevice;

    /**
     * The one device, as DSPROPERTY_DIRECTSOUNDDEVICE_DESCRIPTION describes it
     * in the given form: what DirectSoundEnumerate says of it - its GUID, its
     * name, no module - and the interface name winmm gives the same device.
     *
     * @param {'A' | 'W' | '1'} form
     */
    const deviceDescription = form=>{
        if (form === '1')
        {
            const bytes = new Uint8Array(DESCRIPTION_1.SIZE);
            const view = new DataView(bytes.buffer);
            bytes.set(DEVICE_GUID, DESCRIPTION_1.DeviceId);
            bytes.set(encodeText(SOUND_ADAPTER_NAME, false), DESCRIPTION_1.DescriptionA);
            bytes.set(encodeText(SOUND_ADAPTER_NAME, true), DESCRIPTION_1.DescriptionW);
            view.setUint32(DESCRIPTION_1.Type, DEVICE_TYPE_WDM, true);
            view.setUint32(DESCRIPTION_1.DataFlow, DATAFLOW_RENDER, true);
            return bytes;
        }
        const layout = long ? DESCRIPTION_64 : DESCRIPTION;
        const wide = form === 'W';
        const bytes = new Uint8Array(layout.SIZE);
        const view = new DataView(bytes.buffer);
        view.setUint32(layout.Type, DEVICE_TYPE_WDM, true);
        view.setUint32(layout.DataFlow, DATAFLOW_RENDER, true);
        bytes.set(DEVICE_GUID, layout.DeviceId);
        // Below 4 GiB in either width, so a 64-bit pointer's high half stays zero.
        view.setUint32(layout.Description, stringForGuest(SOUND_ADAPTER_NAME, wide), true);
        view.setUint32(layout.Module, stringForGuest('', wide), true);
        view.setUint32(layout.Interface, stringForGuest(SOUND_DEVICE_INTERFACE, wide), true);
        return bytes;
    };

    /**
     * IKsPropertySet::Get over DSPROPSETID_DirectSoundDevice.
     *
     * Every property answers in the shape Wine's propset test sees Windows
     * answer: a structure shorter than its form is E_INVALIDARG with the size
     * it needs in *pcbReturned, a description asked for with no structure is
     * that size alone, and a GUID_NULL device is the default of the flow named.
     *
     * HRESULT Get(REFGUID set, ULONG id, LPVOID instance, ULONG instanceLength,
     *     LPVOID data, ULONG dataLength, PULONG returned)
     *
     * @param {number[]} args
     */
    const getDeviceProperty = ([set, id, , , data, size, returned])=>{
        const known = namesDeviceSet(set) ? DEVICE_PROPERTIES.get(id >>> 0) : undefined;
        if (!known)
        {
            writeU32(returned, 0);
            return E_PROP_ID_UNSUPPORTED;
        }
        const { property, form } = known;
        const at = data >>> 0;
        if (property === 'mapping')
        {
            const layout = long ? WAVEDEVICEMAPPING_64 : WAVEDEVICEMAPPING;
            writeU32(returned, layout.SIZE);
            if (at === 0 || (size >>> 0) < layout.SIZE || readU32(at + layout.DeviceName) === 0)
            {
                return DSERR_INVALIDPARAM;
            }
            // The wave device's name, as waveOutGetDevCaps gives it: there is
            // one, and it is the render device; a capture name finds nothing.
            const wanted = encodeText(SOUND_ADAPTER_NAME, form === 'W');
            const asked = memory.readMemory(readU32(at + layout.DeviceName), wanted.length);
            if (readU32(at + layout.DataFlow) !== DATAFLOW_RENDER
                || !wanted.every((byte, index)=>asked[index] === byte))
            {
                return DSERR_INVALIDPARAM;
            }
            memory.writeMemory(at + layout.DeviceId, Uint8Array.from(DEVICE_GUID));
            return DS_OK;
        }
        if (property === 'description')
        {
            const layout = form === '1' ? DESCRIPTION_1 : long ? DESCRIPTION_64 : DESCRIPTION;
            writeU32(returned, layout.SIZE);
            if (at === 0)
            {
                return DS_OK;
            }
            if ((size >>> 0) < layout.SIZE)
            {
                return DSERR_INVALIDPARAM;
            }
            const flow = readU32(at + layout.DataFlow);
            const device = at + layout.DeviceId;
            const unnamed = memory.readMemory(device, 16).every((/** @type {number} */ byte)=>
                byte === 0);
            if (unnamed && flow > DATAFLOW_CAPTURE)
            {
                return E_PROP_ID_UNSUPPORTED;
            }
            // GUID_NULL is the flow's default device; there is no capture one.
            if (unnamed ? flow !== DATAFLOW_RENDER : !namesPlayback(device))
            {
                return DSERR_INVALIDPARAM;
            }
            memory.writeMemory(at, deviceDescription(form));
            return DS_OK;
        }
        const layout = long ? ENUMERATE_64 : ENUMERATE;
        writeU32(returned, layout.SIZE);
        if (at === 0 || (size >>> 0) < layout.SIZE)
        {
            return DSERR_INVALIDPARAM;
        }
        const callback = readU32(at + layout.Callback);
        if (callback === 0)
        {
            return E_PROP_ID_UNSUPPORTED;
        }
        // The devices DirectSoundEnumerate lists, without its primary driver
        // entry: this set names devices, and that entry is none.
        return callEach(callback, [
            [place(`description ${form}`, deviceDescription(form)), readU32(at + layout.Context)],
        ]);
    };

    return {
        publisher,
        /** How many times a program asked what sound devices there are. */
        enumerations: ()=>enumerations,
        /** For tests and for whoever wants to look at a buffer without a guest. */
        buffers: ()=>buffers,

        /**
         * The buffers a look has something to do with (`awake` above). Each is
         * let back to sleep by `rest` once a look found it idle and still held.
         */
        awakeBuffers: ()=>[...awake],

        /** @param {any} buffer  idle and reachable: nothing to do until it is called */
        rest: buffer=>{
            awake.delete(buffer);
        },

        /**
         * Drops every buffer the program has fully released (`references`
         * reached zero, and for a primary buffer its device gone as well)
         * from the walk. Without this, a buffer a program
         * created, played and released stays in this array for the rest of
         * the session -- harmless on its own, but every caller that walks
         * `buffers()` once a turn was walking a list that only ever grew.
         */
        pruneReleased(){
            // A buffer's references move only by a call that wakes it.
            for (const buffer of [...awake])
            {
                if (!buffer.reachable())
                {
                    awake.delete(buffer);
                    buffers.splice(buffers.indexOf(buffer), 1);
                }
            }
        },

        /** What a program last asked for: DSSCL_WRITEPRIMARY makes the primary buffer heard. */
        cooperativeLevel: ()=>cooperativeLevel,

        libraries: {
            'DSOUND.dll': {
                /** HRESULT DirectSoundCreate(LPCGUID, LPDIRECTSOUND*, IUnknown*) */
                DirectSoundCreate: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([guid, out])=>(namesPlayback(guid) ? createInto(out, false)
                        : refuseDevice(guid)),
                },
                /** HRESULT DirectSoundCreate8(LPCGUID, LPDIRECTSOUND8*, IUnknown*) */
                DirectSoundCreate8: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([guid, out])=>(namesPlayback(guid) ? createInto(out, true)
                        : refuseDevice(guid)),
                },
                /**
                 * HRESULT DirectSoundEnumerateA(LPDSENUMCALLBACKA, LPVOID)
                 *
                 * Windows always describes the primary driver first, with a
                 * null GUID, before any device of its own -- so a program that
                 * counts the callbacks and gets none concludes the machine has
                 * no sound hardware at all. Succeeding while calling back never
                 * is therefore not a harmless simplification: it is an answer,
                 * and the answer is "there is nothing here".
                 */
                DirectSoundEnumerateA: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([callback, context])=>enumerate(callback, context, false),
                },
                DirectSoundEnumerateW: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([callback, context])=>enumerate(callback, context, true),
                },
                /**
                 * HRESULT GetDeviceID(LPCGUID src, LPGUID dest)
                 *
                 * Which device a default names. A playback default names the
                 * one device there is, and a device names itself; a capture
                 * default names a device that is not there, which is
                 * DSERR_NODRIVER as DirectSoundCreate answers for one; anything
                 * else is no device.
                 */
                GetDeviceID: {
                    argBytes: 8,
                    /** @param {number[]} args */
                    handler: ([source, dest])=>{
                        if ((source >>> 0) === 0 || (dest >>> 0) === 0)
                        {
                            return DSERR_INVALIDPARAM;
                        }
                        const asked = memory.readMemory(source >>> 0, 16);
                        const names = (/** @type {readonly number[]} */ guid)=>
                            guid.every((byte, at)=>asked[at] === byte);
                        if (DEFAULT_CAPTURE_IDS.some(names))
                        {
                            return DSERR_NODRIVER;
                        }
                        if (!names(DEVICE_GUID) && !DEFAULT_PLAYBACK_IDS.some(names))
                        {
                            return DSERR_INVALIDPARAM;
                        }
                        memory.writeMemory(dest >>> 0, new Uint8Array(DEVICE_GUID));
                        return DS_OK;
                    },
                },
                /**
                 * HRESULT DirectSoundCaptureCreate(LPCGUID, LPDIRECTSOUNDCAPTURE*, IUnknown*)
                 *
                 * There is no capture device, which a program is told as
                 * Windows tells a machine without one: DSERR_NODRIVER, the
                 * pointer cleared -- after an aggregation, which is refused
                 * first with the pointer left alone (Wine's capture test_COM).
                 */
                DirectSoundCaptureCreate: { argBytes: 12, handler: noCaptureDevice },
                DirectSoundCaptureCreate8: { argBytes: 12, handler: noCaptureDevice },
                /**
                 * HRESULT DirectSoundFullDuplexCreate(LPCGUID capture, LPCGUID render,
                 *     LPCDSCBUFFERDESC, LPCDSBUFFERDESC, HWND, DWORD level,
                 *     LPDIRECTSOUNDFULLDUPLEX*, LPDIRECTSOUNDCAPTUREBUFFER8*,
                 *     LPDIRECTSOUNDBUFFER8*, LPUNKNOWN outer)
                 *
                 * Full duplex needs the capture device there is not.
                 */
                DirectSoundFullDuplexCreate: {
                    argBytes: 40,
                    /** @param {number[]} args */
                    handler: ([, , , , , , out, captureOut, renderOut, outer])=>{
                        if ((outer >>> 0) !== 0)
                        {
                            return DSERR_NOAGGREGATION;
                        }
                        if ((out >>> 0) === 0)
                        {
                            return DSERR_INVALIDPARAM;
                        }
                        for (const at of [out, captureOut, renderOut])
                        {
                            writePointer(at, 0);
                        }
                        return DSERR_NODRIVER;
                    },
                },
                /** HRESULT DirectSoundCaptureEnumerateA/W(callback, context): there is none. */
                DirectSoundCaptureEnumerateA: { argBytes: 8, handler: ()=>DS_OK },
                DirectSoundCaptureEnumerateW: { argBytes: 8, handler: ()=>DS_OK },
                /**
                 * HRESULT DllGetClassObject(REFCLSID, REFIID, LPVOID *ppv)
                 *
                 * The class objects for DirectSound and DirectSound8, which
                 * CoCreateInstance reaches through the class's InprocServer32
                 * key and whose objects wait for Initialize; for capture and
                 * full duplex; and for the private property set, which a
                 * program asks this entry point for directly. Any other class
                 * is not one this library hands out.
                 */
                DllGetClassObject: {
                    argBytes: 12,
                    /** @param {number[]} args */
                    handler: ([clsid, iid, out])=>{
                        if ((out >>> 0) === 0)
                        {
                            return DSERR_INVALIDPARAM;
                        }
                        writePointer(out, 0);
                        const asked = (clsid >>> 0) === 0 ? '' : readGuid(memory, clsid >>> 0);
                        const kind = CLASS_KINDS.get(asked);
                        if (!kind)
                        {
                            return CLASS_E_CLASSNOTAVAILABLE;
                        }
                        const wanted = (iid >>> 0) === 0 ? '' : readGuid(memory, iid >>> 0);
                        if (wanted !== IID_IClassFactory && wanted !== IID_IUNKNOWN)
                        {
                            return E_NOINTERFACE;
                        }
                        writePointer(out,
                            publisher.publish(classFactory(kind), factoryInterfaces, wanted));
                        return DS_OK;
                    },
                },
                /** HRESULT DllCanUnloadNow(void), which COM asks for. */
                DllCanUnloadNow: { argBytes: 0, handler: ()=>DS_OK },
            },
        },

        /** The numbers `libraries` is imported by, keyed the same way. */
        ordinals: { 'DSOUND.dll': DSOUND_ORDINALS },

        diagnostics: ()=>({
            buffers: buffers.length,
            calls,
            events: [...events],
            refusedInterfaces: publisher.refused(),
            creations: [...creations],
            cooperativeLevel,
            // Asking what devices there are and being told none is how a
            // program concludes the machine cannot play sound, so how often it
            // asked is worth seeing beside what it did next.
            enumerations,
            playing: buffers.filter(buffer=>(buffer.status() & 1) !== 0).length,
            published: publisher.count(),
            // Bytes the mixer was handed that the program had not written
            // since they were last played: a looping buffer whose refill came
            // late, heard as a short repeat. Per buffer as well, because the
            // one that streams music is the one that matters.
            staleBytes: buffers.reduce((sum, buffer)=>sum + buffer.stale.bytes, 0),
            staleDrains: buffers.reduce((sum, buffer)=>sum + buffer.stale.drains, 0),
            staleByBuffer: buffers.map(buffer=>buffer.stale.bytes),
            // The host times of the last ones, merged across buffers.
            staleAt: buffers.flatMap(buffer=>buffer.stale.at).sort((a, b)=>a - b).slice(-64),
            // The last repeat of the buffer that repeated most, with the
            // unlocks that led up to it (`buffers.js`, `trail`).
            staleTrail: [...buffers].sort((a, b)=>b.stale.bytes - a.stale.bytes)[0]
                ?.stale.trail ?? [],
            // And the cause, counted where it happens: a refill that began
            // past where the previous one ended, leaving a lap-old region in
            // between for the mixer to play.
            skippedBytes: buffers.reduce((sum, buffer)=>sum + buffer.skipped.bytes, 0),
            skips: buffers.reduce((sum, buffer)=>sum + buffer.skipped.count, 0),
            // What each playing buffer holds now: whether a stream the program
            // writes is sound or silence, which nothing else here can say. Only
            // the playing ones: every byte of every loaded sound, copied and
            // scanned, was 99 ms of the engine's thread for four hundred
            // buffers of 64 KB, and a sound nobody plays is not heard either way.
            contents: buffers
                .filter(buffer=>!buffer.destroyed && !buffer.primary && buffer.bytes > 0
                    && (buffer.status() & 1) !== 0)
                .map(buffer=>{
                    const held = memory.readMemory(buffer.address >>> 0, buffer.bytes);
                    const sixteen = buffer.format?.bitsPerSample === 16;
                    let peak = 0;
                    let nonzero = 0;
                    if (sixteen)
                    {
                        const samples = new Int16Array(held.buffer, held.byteOffset,
                            held.byteLength >> 1);
                        for (const sample of samples)
                        {
                            peak = Math.max(peak, Math.abs(sample));
                            nonzero += sample !== 0 ? 1 : 0;
                        }
                    }
                    return { address: buffer.address >>> 0, bytes: buffer.bytes,
                        format: buffer.format ? `${buffer.format.sampleRate}/`
                            + `${buffer.format.bitsPerSample}/${buffer.format.channels}` : '-',
                        status: buffer.status(), volume: buffer.volume, pan: buffer.pan,
                        frequency: buffer.frequency, peak: sixteen ? peak : null,
                        nonzero: sixteen ? nonzero : null };
                }),
        }),
    };
}
