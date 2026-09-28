/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * The identifiers and structure offsets DirectMusic's ABI is made of.
 *
 * These are facts about somebody else's binary layout: a CLSID a program asks
 * for, an IID it receives, and where in a structure a field sits. There is no
 * room for a "close enough" value in any of them -- a wrong IID is an interface
 * a program is told does not exist, and a wrong offset is a time read out of
 * the middle of a neighbouring field -- so they are written once here and
 * referenced, never inlined.
 */

/** CLSID_DirectMusic, the object InitAudio makes; IID_IDirectMusic and 8. */
export const CLSID_DIRECTMUSIC = '{636B9F10-0C7D-11D1-95B2-0020AFDC7421}';
export const IID_DIRECTMUSIC = '{6536115A-7B2D-11D2-BA18-0000F875AC12}';
export const IID_DIRECTMUSIC8 = '{2D3629F7-813D-4939-8508-F05C6B75FD97}';

/** The performance and the loader. */
export const CLSID_DIRECTMUSIC_PERFORMANCE = '{D2AC2881-B39B-11D1-8704-00600893B1BD}';
export const CLSID_DIRECTMUSIC_LOADER = '{D2AC2892-B39B-11D1-8704-00600893B1BD}';
export const IID_DIRECTMUSIC_PERFORMANCE = '{07D43D03-6523-11D2-871D-00600893B1BD}';
export const IID_DIRECTMUSIC_PERFORMANCE8 = '{679C4137-C62E-4147-B2B4-9D569ACB254C}';
export const IID_DIRECTMUSIC_LOADER = '{2FFAACA2-5DCA-11D2-AFA6-00AA0024D8B6}';
export const IID_DIRECTMUSIC_LOADER8 = '{19E7C08C-0A44-4E6A-A116-595A7CD5DE8C}';

/** A segment and its play state. */
export const CLSID_DIRECTMUSIC_SEGMENT = '{D2AC2882-B39B-11D1-8704-00600893B1BD}';
export const IID_DIRECTMUSIC_SEGMENT = '{F96029A2-4282-11D2-8717-00600893B1BD}';
export const IID_DIRECTMUSIC_SEGMENT8 = '{C6784488-41A3-418F-AA15-B35093BA42D4}';
export const CLSID_DIRECTMUSIC_SEGMENTSTATE = '{D2AC2883-B39B-11D1-8704-00600893B1BD}';
export const IID_DIRECTMUSIC_SEGMENTSTATE = '{A3AFDCC7-D3EE-11D1-BC8D-00A0C922E6EB}';
export const IID_DIRECTMUSIC_SEGMENTSTATE8 = '{A50E4730-0AE4-48A7-9839-BC04BFE07772}';

/** The audio path a performance plays through. */
export const IID_DIRECTMUSIC_AUDIOPATH = '{C87631F5-23BE-4986-8836-05832FCC48F9}';

/** The object and persistence interfaces every loadable thing answers. */
export const IID_DIRECTMUSIC_OBJECT = '{D2AC28B5-B39B-11D1-8704-00600893B1BD}';
export const IID_IPERSIST_STREAM = '{00000109-0000-0000-C000-000000000046}';
export const IID_DIRECTMUSIC_GETLOADER = '{68A04844-D13D-11D1-AFA6-00AA0024D8B6}';

/** The class a wave reference names, and the one a collection uses. */
export const CLSID_DIRECTSOUND_WAVE = '{8A667154-F9CB-11D2-AD8A-0060B0575ABC}';

/** The one master-volume parameter a program sets through SetGlobalParam. */
export const GUID_PERF_MASTER_VOLUME = '{D2AC28B1-B39B-11D1-8704-00600893B1BD}';

/**
 * GUID_NOTIFICATION_SEGMENT, the type a performance sends when a segment
 * starts, loops, is about to end or has ended. A program that queues its
 * music adds this type and reads the performance's notification messages.
 */
export const GUID_NOTIFICATION_SEGMENT = '{D2AC2899-B39B-11D1-8704-00600893B1BD}';

/**
 * DMUS_NOTIFICATION_*, the option on a segment notification. The low three
 * are the whole life of a segment, which is what a music manager of this era
 * chains its pieces on.
 */
export const DMUS_NOTIFICATION_SEGSTART = 0;
export const DMUS_NOTIFICATION_SEGEND = 1;
export const DMUS_NOTIFICATION_SEGALMOSTEND = 2;
export const DMUS_NOTIFICATION_SEGLOOP = 3;
export const DMUS_NOTIFICATION_SEGABORT = 4;

/** DMUS_PMSGT_NOTIFICATION, the PMSG type a notification is. */
export const DMUS_PMSGT_NOTIFICATION = 3;

/**
 * DMUS_NOTIFICATION_PMSG, the message GetNotificationPMsg hands out.
 *
 * The offsets are the packed-8 layout of the SDK header, which is not a sum
 * of the declared fields: `rtTime` is eight-byte aligned, so `dwSize` is
 * followed by four bytes of padding, and everything after shifts by that.
 * The engine reads back the same offsets the program writes at.
 */
export const DMUS_NOTIFICATION_PMSG = Object.freeze({
    dwSize: 0x00,
    rtTime: 0x08,
    mtTime: 0x10,
    dwFlags: 0x14,
    pChannel: 0x18,
    dwType: 0x28,
    punkUser: 0x34,
    guidNotificationType: 0x38,
    dwNotificationOption: 0x48,
    dwField1: 0x4c,
    dwField2: 0x50,
    SIZE: 0x54,
});

/** DMUS_PMSG's own flags: the time fields that are set. */
export const DMUS_PMSGF_REFTIME = 0x1;
export const DMUS_PMSGF_MUSICTIME = 0x2;

/** GUID_DirectMusicAllTypes, the class wildcard SetSearchDirectory takes. */
export const GUID_DIRECTMUSIC_ALL_TYPES = '{D2AC2893-B39B-11D1-8704-00600893B1BD}';

/** GUID_TempoParam, which a segment answers its tempo through. */
export const GUID_TEMPO_PARAM = '{D2AC28A5-B39B-11D1-8704-00600893B1BD}';

/**
 * DMUS_OBJECTDESC, which is where a program says what it wants loaded.
 *
 * Packed to eight, as the SDK declares it: the two GUIDs keep their natural
 * sixteens, the three wide buffers are fixed size, and the length and pointers
 * at the tail are reached through the offsets below rather than by adding up
 * the fields in a reader, where one forgotten term is a pointer read as a
 * length.
 */
export const DMUS_OBJECTDESC = Object.freeze({
    dwSize: 0x000,
    dwValidData: 0x004,
    guidObject: 0x008,
    guidClass: 0x018,
    ftDate: 0x028,
    vVersion: 0x030,
    wszName: 0x038,
    wszCategory: 0x0b8,
    wszFileName: 0x138,
    llMemLength: 0x340,
    pbMemData: 0x348,
    pStream: 0x34c,
    SIZE: 0x350,
});

/** DMUS_OBJECTDESC.dwValidData. */
export const DMUS_OBJ = Object.freeze({
    OBJECT: 0x001,
    CLASS: 0x002,
    NAME: 0x004,
    CATEGORY: 0x008,
    FILENAME: 0x010,
    FULLPATH: 0x020,
    URL: 0x040,
    VERSION: 0x080,
    DATE: 0x100,
    LOADED: 0x200,
    MEMORY: 0x400,
    STREAM: 0x800,
});


