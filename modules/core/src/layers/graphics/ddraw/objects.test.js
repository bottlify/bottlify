/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    CLASS_E_NOAGGREGATION,
    DDCKEY_DESTBLT,
    DDCKEY_SRCBLT,
    DDERR_CANNOTATTACHSURFACE,
    DDERR_CANNOTDETACHSURFACE,
    DDERR_CLIPPERISUSINGHWND,
    DDERR_DCALREADYCREATED,
    DDERR_INVALIDCAPS,
    DDERR_INVALIDMODE,
    DDERR_INVALIDPARAMS,
    DDERR_NOCLIPPERATTACHED,
    DDERR_NOCOLORKEY,
    DDERR_NOCOOPERATIVELEVELSET,
    DDERR_NODC,
    DDERR_NOEXCLUSIVEMODE,
    DDERR_NOPALETTEATTACHED,
    DDERR_NOTFLIPPABLE,
    DDERR_NOTFOUND,
    DDERR_NOTLOCKED,
    DDERR_SURFACEALREADYATTACHED,
    DDERR_SURFACEBUSY,
    DDERR_SURFACELOST,
    DDERR_SURFACENOTATTACHED,
    DDERR_NOTONMIPMAPSUBLEVEL,
    DDPCAPS_4BIT,
    DDPCAPS_8BIT,
    DDPCAPS_ALLOW256,
    DDPCAPS_PRIMARYSURFACE,
    DDPF_PALETTEINDEXED8,
    DDPF_RGB,
    DDSCAPS2_MIPMAPSUBLEVEL,
    DDSCAPS2_TEXTUREMANAGE,
    DDSCAPS_BACKBUFFER,
    DDSCAPS_COMPLEX,
    DDSCAPS_FLIP,
    DDSCAPS_FRONTBUFFER,
    DDSCAPS_MIPMAP,
    DDSCAPS_OFFSCREENPLAIN,
    DDSCAPS_PRIMARYSURFACE,
    DDSCAPS_SYSTEMMEMORY,
    DDSCAPS_TEXTURE,
    DDSCAPS_VISIBLE,
    DDSCAPS_ZBUFFER,
    DDSCL_EXCLUSIVE,
    DDSCL_FULLSCREEN,
    DDSCL_NORMAL,
    DDSD_BACKBUFFERCOUNT,
    DDSD_CAPS,
    DDSD_HEIGHT,
    DDSD_MIPMAPCOUNT,
    DDSD_PIXELFORMAT,
    DDSD_WIDTH,
    DD_OK,
    E_NOINTERFACE,
} from './constants.js';
import { createDirectDraw } from './objects.js';

const HWND = 0x00010044;

/** The descriptor flags an ordinary sized surface arrives with. */
const SIZED = DDSD_CAPS | DDSD_WIDTH | DDSD_HEIGHT;

/** A 32-bit RGB format, so the lock arithmetic has a real bytes-per-pixel. */
const RGB32 = Object.freeze({
    size: 0x20,
    flags: DDPF_RGB,
    fourCC: 0,
    bitCount: 32,
    redMask: 0x00ff0000,
    greenMask: 0x0000ff00,
    blueMask: 0x000000ff,
    alphaMask: 0,
});

/**
 * A ddraw object under a cooperative level, which almost everything below
 * needs before it can create anything at all.
 *
 * @param {{ level?: number, version?: 1 | 2 | 4 | 7 }} [options]
 */
function withLevel(options = {}){
    const ddraw = createDirectDraw({ version: options.version ?? 7 });
    ddraw.setCooperativeLevel(HWND, options.level ?? DDSCL_NORMAL);
    return ddraw;
}

/**
 * @param {ReturnType<typeof createDirectDraw>} ddraw
 * @param {{ caps?: number, caps2?: number, width?: number, height?: number,
 *   backBufferCount?: number, version?: 1 | 2 | 4 | 7 }} [options]
 */
function makeOffscreen(ddraw, options = {}){
    const request = {
        flags: SIZED | DDSD_PIXELFORMAT
            | (options.backBufferCount === undefined ? 0 : DDSD_BACKBUFFERCOUNT),
        caps: options.caps ?? DDSCAPS_OFFSCREENPLAIN,
        caps2: options.caps2 ?? 0,
        width: options.width ?? 64,
        height: options.height ?? 64,
        backBufferCount: options.backBufferCount ?? 0,
        pixelFormat: RGB32,
    };
    const result = ddraw.createSurface(request, { version: options.version ?? 7 });
    assert.equal(result.hr, DD_OK, 'the fixture surface must have been created');
    return /** @type {NonNullable<typeof result.surface>} */ (result.surface);
}

/** A four-deep flip chain under exclusive full screen: front plus three backs. */
function withFlipChain(){
    const ddraw = withLevel({ level: DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN });
    const created = ddraw.createSurface({
        flags: DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
        backBufferCount: 3,
    });
    assert.equal(created.hr, DD_OK);
    const front = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    /** @param {any} surface */
    const behind = surface=>{
        const found = surface.getAttachedSurface(DDSCAPS_FLIP);
        assert.equal(found.hr, DD_OK);
        found.surface.release();
        return found.surface;
    };
    const back1 = behind(front);
    const back2 = behind(back1);
    const back3 = behind(back2);
    return { ddraw, front, back1, back2, back3 };
}

// --- interface generations and their reference counts ---

test('each interface generation carries its own reference count', ()=>{
    const ddraw = createDirectDraw({ version: 7 });
    assert.equal(ddraw.refCount('IDirectDraw7'), 1);

    for (const id of ['IDirectDraw4', 'IDirectDraw2', 'IDirectDraw'])
    {
        assert.equal(ddraw.queryInterface(id, 'IDirectDraw7').hr, DD_OK);
    }

    // The COM rule would make this four; DirectDraw gives each generation a
    // count of its own, and this is the single biggest trap in the API.
    for (const id of ['IDirectDraw7', 'IDirectDraw4', 'IDirectDraw2', 'IDirectDraw'])
    {
        assert.equal(ddraw.refCount(id), 1, `${id} starts with one reference of its own`);
    }

    ddraw.addRef('IDirectDraw4');
    assert.equal(ddraw.refCount('IDirectDraw4'), 2);
    assert.equal(ddraw.refCount('IDirectDraw7'), 1, 'an AddRef reaches one generation only');
    assert.equal(ddraw.refCount('IDirectDraw2'), 1);
    assert.equal(ddraw.refCount('IDirectDraw'), 1);
    ddraw.release('IDirectDraw4');

    for (const id of ['IDirectDraw7', 'IDirectDraw4', 'IDirectDraw2', 'IDirectDraw'])
    {
        assert.equal(ddraw.release(id), 0);
    }
    assert.ok(ddraw.destroyed, 'the object dies only once every generation is at zero');
});

test('querying one interface twice answers with the same record', ()=>{
    const ddraw = createDirectDraw({ version: 7 });
    const first = ddraw.queryInterface('IDirectDraw4', 'IDirectDraw7');
    const second = ddraw.queryInterface('IDirectDraw4', 'IDirectDraw7');

    assert.equal(first.iface, second.iface, 'interface identity is what a program compares');
    assert.equal(ddraw.refCount('IDirectDraw4'), 2, 'but each query still takes a reference');

    ddraw.release('IDirectDraw4');
    ddraw.release('IDirectDraw4');
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('IDirect3D7 shares IDirectDraw7\'s count, in both directions', ()=>{
    const ddraw = createDirectDraw({ version: 7 });
    const d3d = ddraw.queryInterface('IDirect3D7', 'IDirectDraw7');
    assert.equal(d3d.hr, DD_OK);

    assert.equal(ddraw.refCount('IDirectDraw7'), 2, 'the query raised the ddraw count');
    ddraw.addRef('IDirectDraw7');
    assert.equal(ddraw.refCount('IDirectDraw7'), 3, 'and a ddraw AddRef raises the shared one');
    ddraw.release('IDirectDraw7');

    assert.equal(ddraw.release('IDirectDraw7'), 1, 'releasing the d3d interface lowers it again');
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('IDirect3D7 is reachable from the newest generation only', ()=>{
    const ddraw = createDirectDraw({ version: 1 });
    assert.equal(ddraw.queryInterface('IDirect3D7', 'IDirectDraw').hr, E_NOINTERFACE);
    assert.equal(ddraw.refCount('IDirectDraw'), 1, 'a refused query takes no reference');

    assert.equal(ddraw.release('IDirectDraw'), 0);
    assert.ok(ddraw.destroyed);
});

test('the older Direct3D interfaces bind to whichever generation asked first', ()=>{
    const ddraw = createDirectDraw({ version: 1 });
    ddraw.queryInterface('IDirectDraw2', 'IDirectDraw');
    ddraw.queryInterface('IDirectDraw4', 'IDirectDraw');

    assert.equal(ddraw.queryInterface('IDirect3D', 'IDirectDraw').hr, DD_OK);
    assert.equal(ddraw.refCount('IDirectDraw'), 2);

    // Queried through a different generation, but still counted against the
    // first one: the binding is made once and never revisited.
    assert.equal(ddraw.queryInterface('IDirect3D3', 'IDirectDraw4').hr, DD_OK);
    assert.equal(ddraw.refCount('IDirectDraw'), 3);
    assert.equal(ddraw.refCount('IDirectDraw4'), 1);

    ddraw.release('IDirectDraw');
    ddraw.release('IDirectDraw');
    assert.equal(ddraw.release('IDirectDraw'), 0);
    ddraw.release('IDirectDraw2');
    assert.equal(ddraw.release('IDirectDraw4'), 0);
    assert.ok(ddraw.destroyed);
});

// --- what creating a child costs the ddraw object ---

test('a surface and a palette each take a reference, on the newer generations', ()=>{
    const ddraw = withLevel({ version: 7 });
    assert.equal(ddraw.refCount('IDirectDraw7'), 1);

    const surface = makeOffscreen(ddraw);
    assert.equal(ddraw.refCount('IDirectDraw7'), 2);
    assert.equal(surface.refCount, 1, 'a surface starts with one reference of its own');

    const created = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, [], { version: 7 });
    const palette = /** @type {NonNullable<typeof created.palette>} */ (created.palette);
    assert.equal(ddraw.refCount('IDirectDraw7'), 3);
    assert.equal(palette.refCount, 1);

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.refCount('IDirectDraw7'), 2);
    assert.equal(palette.release(), 0);
    assert.equal(ddraw.refCount('IDirectDraw7'), 1);

    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('the two older generations create without taking a reference', ()=>{
    const ddraw = withLevel({ version: 1 });
    ddraw.queryInterface('IDirectDraw2', 'IDirectDraw');

    const first = makeOffscreen(ddraw, { version: 1 });
    assert.equal(ddraw.refCount('IDirectDraw'), 1,
        'IDirectDraw hands back a surface it does not own');
    const second = makeOffscreen(ddraw, { version: 2 });
    assert.equal(ddraw.refCount('IDirectDraw2'), 1);

    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(ddraw.release('IDirectDraw'), 0);
    assert.equal(ddraw.release('IDirectDraw2'), 0);
    assert.ok(ddraw.destroyed);
});

test('a clipper takes no reference on the object that made it', ()=>{
    const ddraw = withLevel();
    const created = ddraw.createClipper(0);
    const clipper = /** @type {NonNullable<typeof created.clipper>} */ (created.clipper);

    assert.equal(created.hr, DD_OK);
    assert.equal(clipper.refCount, 1);
    assert.equal(ddraw.refCount('IDirectDraw7'), 1);

    assert.equal(clipper.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- the order the creation checks run in ---

test('aggregation is refused before the missing cooperative level is noticed', ()=>{
    const ddraw = createDirectDraw({ version: 7 });

    const palette = ddraw.createPalette(DDPCAPS_8BIT, [], { outer: 0xdeadbeef });
    assert.equal(palette.hr, CLASS_E_NOAGGREGATION,
        'the outer unknown is checked first, with no cooperative level set at all');
    assert.equal(ddraw.createPalette(DDPCAPS_8BIT, []).hr, DDERR_NOCOOPERATIVELEVELSET);

    const surface = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE },
        { outer: 0xdeadbeef });
    assert.equal(surface.hr, CLASS_E_NOAGGREGATION);

    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a missing cooperative level hides a malformed descriptor', ()=>{
    const ddraw = createDirectDraw({ version: 7 });

    assert.equal(ddraw.createSurface(null).hr, DDERR_NOCOOPERATIVELEVELSET,
        'the descriptor is not even looked at until a level has been set');

    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL);
    assert.equal(ddraw.createSurface(null).hr, DDERR_INVALIDPARAMS);

    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- palettes belong to surfaces, not the other way round ---

test('SetPalette raises the palette\'s count and leaves the surface alone', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);
    const created = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, []);
    const palette = /** @type {NonNullable<typeof created.palette>} */ (created.palette);

    assert.equal(surface.setPalette(palette), DD_OK);
    assert.equal(palette.refCount, 2, 'the surface now holds a reference on the palette');
    assert.equal(surface.refCount, 1, 'and the palette holds none on the surface');

    const got = surface.getPalette();
    assert.equal(got.hr, DD_OK);
    assert.equal(got.palette, palette);
    assert.equal(palette.refCount, 3, 'GetPalette hands back a reference of its own');
    got.palette?.release();

    // Releasing the surface detaches the palette rather than leaking it.
    assert.equal(surface.release(), 0);
    assert.equal(palette.refCount, 1);

    assert.equal(palette.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a surface with no palette says so instead of answering with nothing', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);

    const got = surface.getPalette();
    assert.equal(got.hr, DDERR_NOPALETTEATTACHED);
    assert.equal(got.palette, null);

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a palette on the primary surface reports that it is on the primary', ()=>{
    const ddraw = withLevel();
    const created = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    const primary = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    const madePalette = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, []);
    const palette = /** @type {NonNullable<typeof madePalette.palette>} */ (madePalette.palette);

    primary.setPalette(palette);
    assert.equal(palette.caps, DDPCAPS_8BIT | DDPCAPS_ALLOW256 | DDPCAPS_PRIMARYSURFACE);

    primary.setPalette(null);
    assert.equal(palette.caps, DDPCAPS_8BIT | DDPCAPS_ALLOW256);
    assert.equal(palette.refCount, 1);

    assert.equal(primary.release(), 0);
    assert.equal(palette.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a surface holds a reference on its clipper and drops it on release', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);
    const created = ddraw.createClipper(0);
    const clipper = /** @type {NonNullable<typeof created.clipper>} */ (created.clipper);

    assert.equal(surface.getClipper().hr, DDERR_NOCLIPPERATTACHED);

    surface.setClipper(clipper);
    assert.equal(clipper.refCount, 2);
    const got = surface.getClipper();
    assert.equal(got.clipper, clipper);
    assert.equal(clipper.refCount, 3);
    got.clipper?.release();

    surface.setClipper(null);
    assert.equal(clipper.refCount, 1);
    surface.setClipper(clipper);
    assert.equal(clipper.refCount, 2);

    assert.equal(surface.release(), 0);
    assert.equal(clipper.refCount, 1);

    assert.equal(clipper.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- lock discipline ---

test('a second lock of the same area is busy, and hands back no pointer', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);

    const first = surface.lock(null);
    assert.equal(first.hr, DD_OK);
    assert.ok(first.surfacePointer !== null);

    const second = surface.lock(null);
    assert.equal(second.hr, DDERR_SURFACEBUSY, 'busy, not an invalid parameter');
    assert.equal(second.surfacePointer, null,
        'a failed lock leaves the pointer null so a caller ignoring the code faults');

    assert.equal(surface.unlock(null), DD_OK);
    assert.equal(surface.unlock(null), DDERR_NOTLOCKED, 'unlocking twice is not locked');

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a partial lock points at its own corner and does not change the pitch', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw, { width: 128, height: 128 });

    const whole = surface.lock(null);
    const base = /** @type {number} */ (whole.surfacePointer);
    assert.equal(surface.unlock(null), DD_OK);

    const rect = { left: 12, top: 7, right: 20, bottom: 15 };
    const partial = surface.lock(rect);
    assert.equal(partial.hr, DD_OK);
    assert.equal(partial.pitch, whole.pitch, 'the pitch is the surface\'s, not the rectangle\'s');
    assert.equal(/** @type {number} */ (partial.surfacePointer) - base,
        (rect.top * whole.pitch) + (rect.left * 4));

    assert.equal(surface.unlock(rect), DD_OK);
    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a malformed lock rectangle is refused, except by a texture with its own copy', ()=>{
    const ddraw = withLevel();
    const plain = makeOffscreen(ddraw);
    const managed = makeOffscreen(ddraw, {
        caps: DDSCAPS_TEXTURE,
        caps2: DDSCAPS2_TEXTUREMANAGE,
    });

    const inverted = { left: 20, top: 4, right: 8, bottom: 12 };
    const outside = { left: 4, top: 4, right: 200, bottom: 12 };
    for (const rect of [inverted, outside])
    {
        const refused = plain.lock(rect);
        assert.equal(refused.hr, DDERR_INVALIDPARAMS);
        assert.equal(refused.surfacePointer, null);
    }

    // The lenient answer is the one a program may have been written against.
    assert.equal(managed.lock(inverted).hr, DD_OK);
    assert.equal(managed.unlock(inverted), DD_OK);

    // An empty rectangle is well formed: it locks nothing, successfully.
    const empty = { left: 8, top: 8, right: 8, bottom: 16 };
    assert.equal(plain.lock(empty).hr, DD_OK);
    assert.equal(plain.unlock(empty), DD_OK);

    assert.equal(plain.release(), 0);
    assert.equal(managed.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- Lock and GetDC are not a symmetric mutex ---

test('a held device context blocks a lock, but a held lock does not block GetDC', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);

    const first = surface.getDC();
    assert.equal(first.hr, DD_OK);
    assert.ok(first.dc !== null);

    const second = surface.getDC();
    assert.equal(second.hr, DDERR_DCALREADYCREATED);
    assert.equal(second.dc, null, 'the caller\'s handle is left exactly as it was');

    assert.equal(surface.lock(null).hr, DDERR_SURFACEBUSY, 'a DC makes the surface busy');
    assert.equal(surface.releaseDC(/** @type {number} */ (first.dc)), DD_OK);
    assert.equal(surface.releaseDC(/** @type {number} */ (first.dc)), DDERR_NODC);

    // The other order works: this asymmetry is what a single busy flag gets wrong.
    assert.equal(surface.lock(null).hr, DD_OK);
    const held = surface.getDC();
    assert.equal(held.hr, DD_OK, 'a lock does not block a DC');
    assert.equal(surface.releaseDC(/** @type {number} */ (held.dc)), DD_OK);
    assert.equal(surface.unlock(null), DD_OK);

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

/**
 * An eight-bit exclusive mode with a primary, and the attributes every DC
 * taken on its surfaces was made from.
 */
function indexedWithDcs(){
    /** @type {import('./objects.js').DcAttributes[]} */
    const made = [];
    const ddraw = createDirectDraw({
        version: 7,
        createDc: attributes=>{
            made.push(attributes);
            return 0x0100 + made.length;
        },
    });
    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    assert.equal(ddraw.setDisplayMode(320, 240, 8), DD_OK);
    const primary = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    const offscreen = ddraw.createSurface({
        flags: SIZED, caps: DDSCAPS_OFFSCREENPLAIN, width: 16, height: 16,
    });
    /** @param {number[]} entries */
    const palette = entries=>{
        const created = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, entries);
        return /** @type {NonNullable<typeof created.palette>} */ (created.palette);
    };
    return {
        ddraw, made, palette,
        primary: /** @type {NonNullable<typeof primary.surface>} */ (primary.surface),
        offscreen: /** @type {NonNullable<typeof offscreen.surface>} */ (offscreen.surface),
    };
}

test('an indexed surface with no palette of its own draws in the primary\'s', ()=>{
    const { made, palette, primary, offscreen } = indexedWithDcs();
    const colours = palette([0x00000080]);
    primary.setPalette(colours);

    assert.equal(offscreen.getDC().hr, DD_OK);
    assert.equal(made[0].palette?.[0], 0x00800000);
    colours.setEntries(0, [0x00008000]);
    assert.equal(made[0].palette?.[0], 0x00008000);
});

test('a device context on one surface says nothing about another', ()=>{
    const ddraw = withLevel();
    const first = makeOffscreen(ddraw);
    const second = makeOffscreen(ddraw);

    const dc = first.getDC();
    assert.equal(dc.hr, DD_OK);
    assert.equal(second.lock(null).hr, DD_OK, 'busy is per surface, not per object');
    assert.equal(second.unlock(null), DD_OK);
    assert.equal(second.unlock(null), DDERR_NOTLOCKED);
    assert.equal(first.releaseDC(/** @type {number} */ (dc.dc)), DD_OK);

    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- flip chains ---

test('a flip chain runs front to back and closes the loop', ()=>{
    const { ddraw, front, back1, back2, back3 } = withFlipChain();

    const wanted = DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP;
    assert.equal(front.caps & (wanted | DDSCAPS_FRONTBUFFER | DDSCAPS_VISIBLE),
        wanted | DDSCAPS_FRONTBUFFER | DDSCAPS_VISIBLE);
    assert.equal(front.backBufferCount, 3);

    for (const back of [back1, back2, back3])
    {
        assert.equal(back.backBufferCount, 0, 'only the front buffer counts the chain');
        assert.equal(
            back.caps & (DDSCAPS_PRIMARYSURFACE | DDSCAPS_VISIBLE | DDSCAPS_FRONTBUFFER), 0);
        assert.ok(back.caps & DDSCAPS_FLIP);
    }
    assert.ok(back1.caps & DDSCAPS_BACKBUFFER, 'the buffer behind the front is the back buffer');
    assert.equal(back2.caps & DDSCAPS_BACKBUFFER, 0);
    assert.equal(back3.caps & DDSCAPS_BACKBUFFER, 0);

    const closing = back3.getAttachedSurface(DDSCAPS_FLIP);
    assert.equal(closing.hr, DD_OK);
    assert.equal(closing.surface, front, 'the walk from the last back buffer arrives at the front');
    closing.surface?.release();

    assert.equal(front.release(), 0, 'releasing the front collapses the whole chain');
    assert.ok(back1.destroyed && back2.destroyed && back3.destroyed);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('GetAttachedSurface finds the attached surface that has every capability asked for', ()=>{
    // Wine's ddraw7 test_gdi_surface asks a flip chain's front for
    // DDSCAPS_BACKBUFFER and is handed the buffer behind it.
    const { ddraw, front, back1, back2 } = withFlipChain();
    /** @param {any} surface @param {number} wanted */
    const lookFor = (surface, wanted)=>{
        const found = surface.getAttachedSurface(wanted);
        found.surface?.release();
        return found;
    };

    assert.equal(lookFor(front, DDSCAPS_BACKBUFFER).surface, back1);
    assert.equal(lookFor(front, DDSCAPS_BACKBUFFER | DDSCAPS_FLIP).surface, back1);
    assert.equal(lookFor(back1, DDSCAPS_FLIP).surface, back2);
    assert.equal(lookFor(back1, DDSCAPS_BACKBUFFER).hr, DDERR_NOTFOUND,
        'only the first buffer behind the front is the back buffer');
    assert.equal(lookFor(front, DDSCAPS_ZBUFFER).hr, DDERR_NOTFOUND);

    const depth = makeOffscreen(ddraw, { caps: DDSCAPS_ZBUFFER, width: 640, height: 480 });
    assert.equal(front.addAttachedSurface(depth), DD_OK);
    assert.equal(lookFor(front, DDSCAPS_ZBUFFER).surface, depth);
    assert.equal(lookFor(front, DDSCAPS_ZBUFFER | DDSCAPS_FLIP).hr, DDERR_NOTFOUND,
        'every capability asked for, not any one of them');

    assert.equal(depth.release(), 1);
    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
});

test('only the front of a chain flips, and only to a buffer of its own', ()=>{
    const { ddraw, front, back1, back2, back3 } = withFlipChain();
    const stranger = makeOffscreen(ddraw, { width: 640, height: 480 });

    for (const back of [back1, back2, back3])
    {
        assert.equal(back.flip(null), DDERR_NOTFLIPPABLE, 'a back buffer does not flip');
    }
    assert.equal(front.flip(front), DDERR_NOTFLIPPABLE, 'nor does a surface flip with itself');
    assert.equal(front.flip(stranger), DDERR_NOTFLIPPABLE, 'nor with a surface of another chain');

    assert.equal(stranger.release(), 0);
    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a flip rotates the buffers and an explicit target swaps with one', ()=>{
    const { ddraw, front, back1, back2, back3 } = withFlipChain();
    const before = [front.buffer, back1.buffer, back2.buffer, back3.buffer];

    assert.equal(front.flip(null), DD_OK);
    assert.deepEqual([front.buffer, back1.buffer, back2.buffer, back3.buffer],
        [before[1], before[2], before[3], before[0]]);

    assert.equal(front.flip(back2), DD_OK);
    assert.equal(front.buffer, before[3], 'an explicit target swaps rather than rotating');
    assert.equal(back2.buffer, before[1]);
    assert.equal(back1.buffer, before[2], 'and leaves the rest of the chain where it was');

    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- cooperative level and surface loss ---

test('taking the screen exclusively loses the surfaces already on it', ()=>{
    const { ddraw, front } = withFlipChain();

    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL | DDSCL_FULLSCREEN);
    assert.equal(front.isLost(), DD_OK, 'giving the screen back does not lose anything');
    assert.equal(front.flip(null), DDERR_NOEXCLUSIVEMODE,
        'but a primary in video memory will not flip without the screen');

    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    assert.equal(front.isLost(), DDERR_SURFACELOST, 'claiming it again is what loses them');

    assert.equal(ddraw.restoreAllSurfaces(), DD_OK);
    assert.equal(front.isLost(), DD_OK);
    assert.equal(front.flip(null), DD_OK);

    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a lost surface refuses to be locked and hands back no pointer', ()=>{
    const ddraw = withLevel({ level: DDSCL_NORMAL });
    const surface = makeOffscreen(ddraw);

    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const attempt = surface.lock(null);
    assert.equal(attempt.hr, DDERR_SURFACELOST);
    assert.equal(attempt.surfacePointer, null);

    assert.equal(surface.restore(), DD_OK);
    assert.equal(surface.lock(null).hr, DD_OK);
    assert.equal(surface.unlock(null), DD_OK);

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a primary held in system memory flips without the screen', ()=>{
    const ddraw = withLevel({ level: DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN });
    const created = ddraw.createSurface({
        flags: DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP | DDSCAPS_SYSTEMMEMORY,
        backBufferCount: 1,
    });
    const front = /** @type {NonNullable<typeof created.surface>} */ (created.surface);

    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL);
    assert.equal(front.flip(null), DD_OK, 'a system-memory primary is a copy, not the screen');

    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- attachments made by hand ---

test('attaching a surface takes a reference and detaching gives it back', ()=>{
    const ddraw = withLevel();
    const first = makeOffscreen(ddraw);
    const second = makeOffscreen(ddraw);

    assert.equal(first.addAttachedSurface(second), DD_OK);
    assert.equal(second.refCount, 2, 'the attachment is a reference');
    assert.ok(first.caps & DDSCAPS_FLIP);
    assert.ok(second.caps & DDSCAPS_FLIP);

    const found = first.getAttachedSurface(DDSCAPS_FLIP);
    assert.equal(found.surface, second);
    found.surface?.release();

    assert.equal(first.deleteAttachedSurface(second), DD_OK);
    assert.equal(second.refCount, 1);
    assert.equal(first.caps & DDSCAPS_FLIP, 0, 'a surface with nothing attached is not flippable');
    assert.equal(second.caps & DDSCAPS_FLIP, 0);
    assert.equal(first.getAttachedSurface(DDSCAPS_FLIP).hr, DDERR_NOTFOUND);

    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('an attachment refuses the reverse, a mismatched size, and itself', ()=>{
    const ddraw = withLevel();
    const first = makeOffscreen(ddraw);
    const second = makeOffscreen(ddraw);
    const smaller = makeOffscreen(ddraw, { width: 32, height: 32 });

    assert.equal(first.addAttachedSurface(first), DDERR_CANNOTATTACHSURFACE);
    assert.equal(first.addAttachedSurface(smaller), DDERR_CANNOTATTACHSURFACE);

    assert.equal(first.addAttachedSurface(second), DD_OK);
    assert.equal(second.addAttachedSurface(first), DDERR_SURFACEALREADYATTACHED,
        'attached the other way round is still attached');
    assert.equal(second.deleteAttachedSurface(first), DDERR_CANNOTDETACHSURFACE,
        'and cannot be taken apart from the far end');
    assert.equal(first.deleteAttachedSurface(smaller), DDERR_SURFACENOTATTACHED);
    assert.equal(first.deleteAttachedSurface(second), DD_OK);

    assert.equal(first.release(), 0);
    assert.equal(second.release(), 0);
    assert.equal(smaller.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('detaching from the middle of a chain splices rather than truncates', ()=>{
    const ddraw = withLevel();
    const head = makeOffscreen(ddraw);
    const middle = makeOffscreen(ddraw);
    const tail = makeOffscreen(ddraw);

    assert.equal(head.addAttachedSurface(middle), DD_OK);
    assert.equal(middle.addAttachedSurface(tail), DD_OK);
    assert.equal(head.addAttachedSurface(tail), DDERR_CANNOTATTACHSURFACE,
        'a chain is a line: nothing takes a second buffer behind it');

    // The loop closes for the walk without a stored link, so the far end is
    // attached to the head and yet cannot be detached from there.
    const closing = tail.getAttachedSurface(DDSCAPS_FLIP);
    assert.equal(closing.surface, head);
    closing.surface?.release();
    assert.equal(tail.deleteAttachedSurface(head), DDERR_CANNOTDETACHSURFACE);
    assert.equal(head.deleteAttachedSurface(tail), DDERR_SURFACENOTATTACHED);

    assert.equal(head.deleteAttachedSurface(middle), DD_OK);
    assert.equal(middle.refCount, 1, 'the surface taken out drops its reference');
    assert.equal(tail.refCount, 2, 'the one behind it keeps the reference it already had');
    const spliced = head.getAttachedSurface(DDSCAPS_FLIP);
    assert.equal(spliced.surface, tail, 'and moves up to take its place');
    spliced.surface?.release();
    assert.ok(head.caps & DDSCAPS_FLIP, 'the head still has something attached');

    assert.equal(head.release(), 0);
    assert.equal(tail.refCount, 1, 'and the head\'s release gives that reference back');
    assert.equal(tail.release(), 0);
    assert.equal(middle.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a chain the runtime built cannot be taken apart by hand', ()=>{
    const { ddraw, front, back1 } = withFlipChain();

    assert.equal(front.deleteAttachedSurface(back1), DDERR_CANNOTDETACHSURFACE,
        'the buffers of a complex surface are not the guest\'s to detach');
    assert.equal(front.deleteAttachedSurface(front), DDERR_SURFACENOTATTACHED);
    assert.equal(back1.refCount, 1);

    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a depth buffer attaches in its own slot, beside the flip chain', ()=>{
    const ddraw = withLevel();
    const target = makeOffscreen(ddraw);
    const behind = makeOffscreen(ddraw);
    const depth = makeOffscreen(ddraw, { caps: DDSCAPS_ZBUFFER });

    assert.equal(target.addAttachedSurface(behind), DD_OK);
    assert.equal(target.addAttachedSurface(depth), DD_OK,
        'a depth buffer does not compete with the buffer behind');
    assert.equal(depth.refCount, 2);
    assert.deepEqual(target.enumAttachedSurfaces(), [behind, depth]);

    const found = target.getAttachedSurface(DDSCAPS_ZBUFFER);
    assert.equal(found.surface, depth);
    found.surface?.release();

    assert.equal(target.deleteAttachedSurface(depth), DD_OK);
    assert.equal(depth.refCount, 1);
    assert.equal(target.getAttachedSurface(DDSCAPS_ZBUFFER).hr, DDERR_NOTFOUND);

    assert.equal(target.release(), 0);
    assert.equal(behind.release(), 0);
    assert.equal(depth.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('detaching null detaches everything the surface attached, and nothing the runtime did',
    ()=>{
        const ddraw = withLevel();
        const head = makeOffscreen(ddraw);
        const middle = makeOffscreen(ddraw);
        const tail = makeOffscreen(ddraw);
        const depth = makeOffscreen(ddraw, { caps: DDSCAPS_ZBUFFER });
        assert.equal(head.addAttachedSurface(middle), DD_OK);
        assert.equal(middle.addAttachedSurface(tail), DD_OK);
        assert.equal(head.addAttachedSurface(depth), DD_OK);

        assert.equal(head.deleteAttachedSurface(null), DD_OK);
        assert.deepEqual(head.enumAttachedSurfaces(), []);
        assert.equal(head.caps & DDSCAPS_FLIP, 0, 'nothing is attached, so nothing flips');
        for (const surface of [middle, tail, depth])
        {
            assert.equal(surface.refCount, 1, 'each gave back the reference the head held');
        }

        const chain = withFlipChain();
        assert.equal(chain.front.deleteAttachedSurface(null), DD_OK);
        const behind = chain.front.getAttachedSurface(DDSCAPS_FLIP);
        assert.equal(behind.surface, chain.back1, 'a complex surface keeps its buffers');
        behind.surface?.release();

        for (const surface of [head, middle, tail, depth])
        {
            assert.equal(surface.release(), 0);
        }
        assert.equal(chain.front.release(), 0);
        assert.equal(chain.ddraw.release('IDirectDraw7'), 0);
        assert.equal(ddraw.release('IDirectDraw7'), 0);
        assert.ok(ddraw.destroyed);
    });

// --- what CreateSurface refuses, through the object ---

test('a primary flip chain needs the screen, and says so only once it is well formed', ()=>{
    const ddraw = withLevel({ level: DDSCL_NORMAL });
    const chain = {
        flags: DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
        backBufferCount: 1,
    };

    assert.equal(ddraw.createSurface({ ...chain, backBufferCount: 0 }).hr, DDERR_INVALIDCAPS,
        'a chain of no buffers is malformed, and the missing screen is never reached');
    assert.equal(ddraw.createSurface({ ...chain, flags: DDSD_CAPS }).hr, DDERR_INVALIDCAPS);
    assert.equal(ddraw.createSurface(chain).hr, DDERR_NOEXCLUSIVEMODE);

    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a surface with no size is refused, and a primary takes the screen\'s', ()=>{
    const ddraw = withLevel();

    assert.equal(ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_OFFSCREENPLAIN }).hr,
        DDERR_INVALIDPARAMS);
    assert.equal(ddraw.createSurface({
        flags: SIZED, caps: DDSCAPS_OFFSCREENPLAIN, width: 0, height: 64,
    }).hr, DDERR_INVALIDPARAMS);

    const created = ddraw.createSurface({
        flags: SIZED, caps: DDSCAPS_PRIMARYSURFACE, width: 128, height: 128,
    });
    const primary = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    assert.equal(primary.width, 640, 'a primary ignores the size it was asked for');
    assert.equal(primary.height, 480);
    assert.ok(primary.caps & DDSCAPS_VISIBLE);

    assert.equal(primary.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- mip chains ---

/**
 * @param {ReturnType<typeof createDirectDraw>} ddraw
 * @param {{ caps: number, width: number, height: number, count?: number,
 *   version?: 1 | 2 | 4 | 7 }} options
 */
function requestMips(ddraw, options){
    return ddraw.createSurface({
        flags: SIZED | DDSD_PIXELFORMAT | (options.count === undefined ? 0 : DDSD_MIPMAPCOUNT),
        caps: options.caps,
        width: options.width,
        height: options.height,
        mipMapCount: options.count ?? 0,
        pixelFormat: RGB32,
    }, { version: options.version ?? 7 });
}

/** @param {any} top @returns {any[]} the chain from its top, by DDSCAPS2_MIPMAPSUBLEVEL */
function levelsOf(top){
    const levels = [top];
    for (;;)
    {
        const found = levels[levels.length - 1].getAttachedSurface(0, DDSCAPS2_MIPMAPSUBLEVEL);
        if (found.hr !== DD_OK)
        {
            assert.equal(found.hr, DDERR_NOTFOUND);
            return levels;
        }
        found.surface.release();
        levels.push(found.surface);
    }
}

const MIPPED = DDSCAPS_TEXTURE | DDSCAPS_COMPLEX | DDSCAPS_MIPMAP;

test('CreateSurface refuses a mip chain that is not a complex texture, or has no levels', ()=>{
    // Wine's ddraw1, ddraw2, ddraw4 and ddraw7 test_mipmap, row by row.
    const ddraw = withLevel();
    /** @type {[{ caps: number, count?: number }, number][]} */
    const refused = [
        [{ caps: DDSCAPS_MIPMAP }, DDERR_INVALIDCAPS],
        [{ caps: DDSCAPS_COMPLEX }, DDERR_INVALIDCAPS],
        [{ caps: DDSCAPS_MIPMAP | DDSCAPS_COMPLEX }, DDERR_INVALIDCAPS],
        [{ caps: DDSCAPS_TEXTURE | DDSCAPS_COMPLEX }, DDERR_INVALIDCAPS],
        [{ caps: DDSCAPS_TEXTURE | DDSCAPS_MIPMAP, count: 1 }, DDERR_INVALIDCAPS],
        [{ caps: DDSCAPS_TEXTURE | DDSCAPS_MIPMAP, count: 3 }, DDERR_INVALIDCAPS],
        [{ caps: MIPPED, count: 0 }, DDERR_INVALIDPARAMS],
        [{ caps: MIPPED, count: 9 }, DDERR_INVALIDPARAMS],
    ];
    for (const [options, hr] of refused)
    {
        const made = requestMips(ddraw, { width: 128, height: 32, ...options });
        assert.equal(made.hr, hr, JSON.stringify(options));
        assert.equal(made.surface, null);
    }
    assert.equal(ddraw.surfaceCount, 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
});

test('a complex mip-mapped texture is a chain of halving levels, as long as asked or full', ()=>{
    const ddraw = withLevel();
    /** @type {[number, number, number | undefined, number][]} */
    const chains = [
        [128, 32, undefined, 8], [32, 64, undefined, 7], [128, 32, 3, 3], [128, 128, 8, 8],
    ];
    for (const [width, height, count, expected] of chains)
    {
        const made = requestMips(ddraw, { caps: MIPPED, width, height, count });
        assert.equal(made.hr, DD_OK);
        const levels = levelsOf(made.surface);
        assert.equal(levels.length, expected, `${width}x${height}`);
        levels.forEach((level, index)=>{
            assert.equal(level.width, Math.max(1, width >> index));
            assert.equal(level.height, Math.max(1, height >> index));
            assert.equal(level.pitch, level.width * 4);
            assert.equal(level.mipMapCount, expected - index, 'each level counts itself and below');
            assert.equal(level.caps & MIPPED, MIPPED);
            assert.equal(level.caps2 & DDSCAPS2_MIPMAPSUBLEVEL,
                index === 0 ? 0 : DDSCAPS2_MIPMAPSUBLEVEL, 'every level but the top is a sublevel');
            if (index > 0)
            {
                assert.notEqual(level.buffer, levels[index - 1].buffer);
            }
        });
        assert.deepEqual(made.surface?.enumAttachedSurfaces(), [levels[1]]);
        assert.equal(made.surface?.getAttachedSurface(DDSCAPS_COMPLEX).surface, levels[1],
            'the level below is found by the caps the chain shares, as Wine\'s walks ask');
        levels[1].release();
        assert.equal(made.surface?.release(), 0, 'releasing the top releases the chain');
        assert.ok(levels.every(level=>level.destroyed));
    }

    const single = requestMips(ddraw,
        { caps: DDSCAPS_TEXTURE | DDSCAPS_MIPMAP, width: 128, height: 32 });
    assert.equal(single.hr, DD_OK);
    assert.equal(single.surface?.mipMapCount, 1, 'not complex: a chain of the one level');
    assert.equal(levelsOf(single.surface).length, 1);
    assert.equal(single.surface?.release(), 0);

    assert.equal(ddraw.surfaceCount, 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
});

test('before IDirectDraw7 a full mip chain ends when the shorter side reaches one', ()=>{
    // Wine's ddraw1, ddraw2 and ddraw4 test_mipmap expect six levels of
    // 128x32 and of 32x64, where ddraw7 expects eight and seven.
    for (const version of /** @type {const} */ ([1, 2, 4]))
    {
        const ddraw = withLevel({ version });
        for (const [width, height] of [[128, 32], [32, 64]])
        {
            const made = requestMips(ddraw, { caps: MIPPED, width, height, version });
            assert.equal(made.hr, DD_OK);
            assert.equal(made.surface?.mipMapCount, 6, `version ${version}, ${width}x${height}`);
            assert.equal(levelsOf(made.surface).length, 6);
            assert.equal(made.surface?.release(), 0);
        }
    }
});

test('a mip sublevel takes no palette, no colour key and no detaching of its own', ()=>{
    // Wine's ddraw7 test_palette_complex, test_ckey_complex and
    // test_device_load: DDERR_NOTONMIPMAPSUBLEVEL, and nothing attached.
    const ddraw = withLevel();
    const top = /** @type {any} */ (requestMips(ddraw, { caps: MIPPED, width: 16, height: 16 })
        .surface);
    const [, level1] = levelsOf(top);
    const palette = /** @type {any} */ (ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256,
        new Array(256).fill(0)).palette);

    assert.equal(level1.setPalette(palette), DDERR_NOTONMIPMAPSUBLEVEL);
    assert.equal(level1.getPalette().hr, DDERR_NOPALETTEATTACHED);
    assert.equal(level1.setColorKey(DDCKEY_SRCBLT, { low: 0xff, high: 0xff }),
        DDERR_NOTONMIPMAPSUBLEVEL);
    assert.equal(level1.getColorKey(DDCKEY_SRCBLT).hr, DDERR_NOCOLORKEY);
    assert.equal(top.setColorKey(DDCKEY_SRCBLT, { low: 0xff, high: 0xff }), DD_OK,
        'the top level is the texture, and takes both');
    assert.equal(top.setPalette(palette), DD_OK);
    assert.equal(top.deleteAttachedSurface(level1), DDERR_CANNOTDETACHSURFACE,
        'a level the chain was made with stays');
    assert.equal(top.deleteAttachedSurface(null), DD_OK);
    assert.equal(levelsOf(top).length, 5);

    assert.equal(top.release(), 0);
    assert.equal(palette.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
});

// --- the display mode, and the surfaces that take their shape from it ---

test('a fresh object shows the screen at 32 bits, and a mode change needs a level first', ()=>{
    const ddraw = createDirectDraw({ version: 7 });
    assert.deepEqual(ddraw.displayMode,
        { width: 640, height: 480, bitCount: 32, refreshRate: 0 });
    assert.equal(ddraw.setDisplayMode(320, 240, 8), DD_OK, 'a mode needs no cooperative level');
    assert.equal(ddraw.restoreDisplayMode(), DD_OK);
    assert.equal(ddraw.displayMode.width, 640, 'and restoring puts the screen back');

    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL);
    assert.equal(ddraw.setDisplayMode(320, 240, 24), DDERR_INVALIDMODE, 'no 24-bit mode');
    assert.equal(ddraw.setDisplayMode(0, 240, 32), DD_OK, 'a zero extent is accepted');
    assert.equal(ddraw.displayMode.width, 640, 'and sets nothing');
    assert.equal(ddraw.displayMode.width, 640, 'a refused mode changes nothing');

    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a primary takes the mode\'s size and format, whatever it asked for', ()=>{
    const ddraw = withLevel({ level: DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN });
    assert.equal(ddraw.setDisplayMode(320, 240, 8), DD_OK);

    const created = ddraw.createSurface({
        flags: SIZED | DDSD_PIXELFORMAT,
        caps: DDSCAPS_PRIMARYSURFACE,
        width: 999,
        height: 999,
        pixelFormat: RGB32,
    });
    assert.equal(created.hr, DD_OK);
    const primary = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    assert.equal(primary.width, 320);
    assert.equal(primary.height, 240);
    assert.equal(primary.pixelFormat.bitCount, 8);
    assert.ok(primary.pixelFormat.flags & DDPF_PALETTEINDEXED8, 'eight bits is an index');
    assert.equal(primary.pitch, 320, 'one byte a pixel');
    assert.equal(primary.bytesPerPixel, 1);

    assert.equal(ddraw.restoreDisplayMode(), DD_OK);
    assert.deepEqual(ddraw.displayMode,
        { width: 640, height: 480, bitCount: 32, refreshRate: 0 });

    assert.equal(primary.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('an offscreen surface with no format takes the mode\'s, and one with a format keeps it', ()=>{
    const ddraw = withLevel();
    assert.equal(ddraw.setDisplayMode(640, 480, 16), DD_OK);

    const bare = ddraw.createSurface({
        flags: SIZED, caps: DDSCAPS_OFFSCREENPLAIN, width: 8, height: 8,
    });
    assert.equal(bare.hr, DD_OK);
    const unformatted = /** @type {NonNullable<typeof bare.surface>} */ (bare.surface);
    assert.equal(unformatted.pixelFormat.bitCount, 16);
    assert.equal(unformatted.pixelFormat.redMask, 0xf800, 'five-six-five');
    assert.equal(unformatted.pitch, 16);

    const explicit = makeOffscreen(ddraw, { width: 8, height: 8 });
    assert.equal(explicit.pixelFormat.bitCount, 32, 'a stated format is not overridden');
    assert.equal(explicit.pitch, 32);

    assert.equal(unformatted.release(), 0);
    assert.equal(explicit.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- palette entries ---

test('a palette holds every entry from the start and reads back what was set', ()=>{
    const ddraw = withLevel();
    const made = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, [0x00112233, 0x00445566]);
    assert.equal(made.hr, DD_OK);
    const palette = /** @type {NonNullable<typeof made.palette>} */ (made.palette);

    assert.equal(palette.entries.length, 256);
    assert.deepEqual(palette.getEntries(0, 3).entries, [0x00112233, 0x00445566, 0],
        'the ones not given are zero, not absent');

    assert.equal(palette.setEntries(250, [1, 2, 3, 4, 5, 6]), DD_OK);
    assert.deepEqual(palette.getEntries(250, 6).entries, [1, 2, 3, 4, 5, 6]);
    assert.equal(palette.setEntries(251, [1, 2, 3, 4, 5, 6]), DDERR_INVALIDPARAMS,
        'one past the end refuses the whole write');
    assert.deepEqual(palette.getEntries(250, 6).entries, [1, 2, 3, 4, 5, 6], 'and wrote nothing');
    assert.equal(palette.getEntries(255, 2).hr, DDERR_INVALIDPARAMS);

    const small = ddraw.createPalette(DDPCAPS_4BIT, []);
    const sixteen = /** @type {NonNullable<typeof small.palette>} */ (small.palette);
    assert.equal(sixteen.entries.length, 16);
    assert.equal(sixteen.setEntries(0, new Array(17).fill(0)), DDERR_INVALIDPARAMS);

    assert.equal(palette.release(), 0);
    assert.equal(sixteen.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- the clipper's window ---

test('a clipper bound to a window takes its list from the window, not from a call', ()=>{
    const ddraw = withLevel();
    const made = ddraw.createClipper(0);
    const clipper = /** @type {NonNullable<typeof made.clipper>} */ (made.clipper);

    assert.equal(clipper.window, 0);
    assert.deepEqual(clipper.clipList, []);
    assert.equal(clipper.isClipListChanged(), false, 'nothing has moved yet');

    assert.equal(clipper.setClipList([{ left: 0, top: 0, right: 4, bottom: 4 }]), DD_OK);
    assert.equal(clipper.isClipListChanged(), true);
    assert.equal(clipper.isClipListChanged(), false, 'asking is what clears it');

    assert.equal(clipper.setHWnd(HWND), DD_OK);
    assert.equal(clipper.window, HWND);
    assert.equal(clipper.setClipList([]), DDERR_CLIPPERISUSINGHWND);
    assert.equal(clipper.clipList.length, 1, 'the refused call changed nothing');

    assert.equal(clipper.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- colour keys ---

test('a surface has no colour key until one is set, and each kind is its own', ()=>{
    const ddraw = withLevel();
    const surface = makeOffscreen(ddraw);

    assert.deepEqual(surface.getColorKey(DDCKEY_SRCBLT), { hr: DDERR_NOCOLORKEY, key: null });

    assert.equal(surface.setColorKey(DDCKEY_SRCBLT, { low: 0xff00ff, high: 0xff00ff }), DD_OK);
    assert.deepEqual(surface.getColorKey(DDCKEY_SRCBLT),
        { hr: DD_OK, key: { low: 0xff00ff, high: 0xff00ff } });
    assert.equal(surface.getColorKey(DDCKEY_DESTBLT).hr, DDERR_NOCOLORKEY,
        'the destination key is a different key');

    assert.equal(surface.setColorKey(DDCKEY_DESTBLT, { low: 1, high: 2 }), DD_OK);
    assert.deepEqual(surface.getColorKey(DDCKEY_DESTBLT).key, { low: 1, high: 1 },
        'a range named without DDCKEY_COLORSPACE is its low value');

    assert.equal(surface.setColorKey(DDCKEY_SRCBLT, null), DD_OK);
    assert.equal(surface.getColorKey(DDCKEY_SRCBLT).hr, DDERR_NOCOLORKEY, 'null removes it');
    assert.deepEqual(surface.getColorKey(DDCKEY_DESTBLT).key, { low: 1, high: 1 },
        'and leaves the other alone');

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- when the screen is told it changed ---

test('the primary reports a change on a flip, an unlock and a released DC; others never', ()=>{
    /** @type {any[]} */
    const presented = [];
    const ddraw = createDirectDraw({ version: 7, onPresent: surface=>presented.push(surface) });
    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    const created = ddraw.createSurface({
        flags: DDSD_CAPS | DDSD_BACKBUFFERCOUNT,
        caps: DDSCAPS_PRIMARYSURFACE | DDSCAPS_COMPLEX | DDSCAPS_FLIP,
        backBufferCount: 1,
    });
    const front = /** @type {NonNullable<typeof created.surface>} */ (created.surface);

    assert.equal(front.flip(null), DD_OK);
    assert.equal(presented.length, 1, 'a flip is one report');
    assert.equal(presented[0], front, 'and it names the front');

    assert.equal(front.lock(null).hr, DD_OK);
    assert.equal(presented.length, 1, 'locking shows nothing yet');
    assert.equal(front.unlock(null), DD_OK);
    assert.equal(presented.length, 2, 'unlocking is when the pixels may have changed');

    const dc = front.getDC();
    assert.equal(dc.hr, DD_OK);
    assert.equal(front.releaseDC(/** @type {number} */ (dc.dc)), DD_OK);
    assert.equal(presented.length, 3);

    const offscreen = makeOffscreen(ddraw);
    assert.equal(offscreen.lock(null).hr, DD_OK);
    assert.equal(offscreen.unlock(null), DD_OK);
    const other = offscreen.getDC();
    assert.equal(offscreen.releaseDC(/** @type {number} */ (other.dc)), DD_OK);
    assert.equal(presented.length, 3, 'an offscreen surface is not on the screen');

    assert.equal(offscreen.release(), 0);
    assert.equal(front.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

// --- the device context, as whoever makes one is told about it ---

test('a device context is asked for over the surface\'s own pixels, and given back', ()=>{
    /** @type {any[]} */
    const made = [];
    /** @type {number[]} */
    const returned = [];
    const ddraw = createDirectDraw({
        version: 7,
        createDc: attributes=>{
            made.push(attributes);
            return 0x7700 + made.length;
        },
        releaseDc: handle=>returned.push(handle),
    });
    ddraw.setCooperativeLevel(HWND, DDSCL_NORMAL);
    const surface = makeOffscreen(ddraw, { width: 10, height: 6 });

    assert.equal(surface.dc, null);
    assert.equal(surface.locked, false);
    assert.equal(ddraw.surfaceWithDc(0x7701), null, 'no DC yet');

    const dc = surface.getDC();
    assert.equal(dc.hr, DD_OK);
    assert.equal(dc.dc, 0x7701, 'the handle is the one the maker chose');
    assert.deepEqual(made, [{
        width: 10, height: 6, pitch: 40, bitCount: 32, bits: surface.buffer, palette: null,
        format: '555',
    }]);
    assert.equal(surface.dc, 0x7701);
    assert.equal(ddraw.surfaceWithDc(0x7701), surface);

    assert.equal(surface.lock(null).hr, DDERR_SURFACEBUSY);
    assert.equal(surface.locked, false, 'a refused lock is not a lock');

    assert.equal(surface.releaseDC(0x7701), DD_OK);
    assert.deepEqual(returned, [0x7701]);
    assert.equal(surface.dc, null);
    assert.equal(ddraw.surfaceWithDc(0x7701), null, 'and the handle no longer names it');

    assert.equal(surface.lock(null).hr, DD_OK);
    assert.equal(surface.locked, true);
    assert.equal(surface.unlock(null), DD_OK);
    assert.equal(surface.locked, false);

    assert.equal(surface.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a device context over an indexed surface sees the palette change while it is held', ()=>{
    // A program that animates its palette while drawing text through the DC
    // expects the new colours: the DC is given the palette's live table, not
    // a copy made when it was asked for.
    /** @type {any[]} */
    const made = [];
    const ddraw = createDirectDraw({
        version: 7,
        createDc: attributes=>{
            made.push(attributes);
            return 0x7700 + made.length;
        },
    });
    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    assert.equal(ddraw.setDisplayMode(320, 240, 8), DD_OK);
    const created = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    const primary = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    const madePalette = ddraw.createPalette(DDPCAPS_8BIT | DDPCAPS_ALLOW256, []);
    const palette = /** @type {NonNullable<typeof madePalette.palette>} */ (madePalette.palette);
    assert.equal(primary.setPalette(palette), DD_OK);

    assert.equal(primary.getDC().hr, DD_OK);
    const table = made[0].palette;
    assert.equal(table[3], 0, 'an entry never written is black');
    // A PALETTEENTRY is red in its low byte; the pixel is 0x00RRGGBB.
    assert.equal(palette.setEntries(3, [0x00112233]), DD_OK);
    assert.equal(made[0].palette[3], 0x00332211, 'the held DC reads the new entry');
    assert.equal(made[0].palette, table, 'through the same table');
});

// --- what the object knows about its primary, and a surface about its changes ---

test('the primary is found once made, and a surface counts its own changes', ()=>{
    const ddraw = withLevel();
    assert.equal(ddraw.primarySurface(), null);

    const offscreen = makeOffscreen(ddraw);
    assert.equal(ddraw.primarySurface(), null, 'an offscreen surface is not it');
    const created = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    const primary = /** @type {NonNullable<typeof created.surface>} */ (created.surface);
    assert.equal(ddraw.primarySurface(), primary);

    assert.equal(offscreen.uniquenessValue(), 1);
    offscreen.changeUniquenessValue();
    assert.equal(offscreen.uniquenessValue(), 2);
    assert.equal(primary.uniquenessValue(), 1, 'each surface counts alone');

    assert.equal(primary.release(), 0);
    assert.equal(ddraw.primarySurface(), null, 'released is gone');
    assert.equal(offscreen.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a device context on a palettised surface carries its palette as pixels', ()=>{
    /** @type {any[]} */
    const made = [];
    const ddraw = createDirectDraw({
        version: 7,
        createDc: attributes=>{
            made.push(attributes);
            return 0x7701;
        },
    });
    ddraw.setCooperativeLevel(HWND, DDSCL_EXCLUSIVE | DDSCL_FULLSCREEN);
    assert.equal(ddraw.setDisplayMode(64, 32, 8), DD_OK);
    const primary = ddraw.createSurface({ flags: DDSD_CAPS, caps: DDSCAPS_PRIMARYSURFACE });
    assert.equal(primary.hr, DD_OK);
    const surface = /** @type {NonNullable<typeof primary.surface>} */ (primary.surface);
    // PALETTEENTRY is red, green, blue, flags: entry one is (0x12, 0x34, 0x56).
    const palette = ddraw.createPalette(DDPCAPS_8BIT, [0, 0x00563412]);
    assert.equal(palette.hr, DD_OK);
    assert.equal(surface.setPalette(palette.palette), DD_OK);

    assert.equal(surface.getDC().hr, DD_OK);
    assert.equal(made[0].bitCount, 8);
    assert.equal(made[0].pitch, 64);
    assert.equal(made[0].palette.length, 256);
    assert.equal(made[0].palette[1], 0x00123456, 'a pixel is red, green, blue from the top');
    assert.equal(surface.releaseDC(0x7701), DD_OK);

    /** @type {any} */
    const held = palette.palette;
    assert.equal(surface.release(), 0);
    assert.equal(held.release(), 0);
    assert.equal(ddraw.release('IDirectDraw7'), 0);
    assert.ok(ddraw.destroyed);
});

test('a copy of a surface\'s pixels kept elsewhere is asked for them, and told of every write',
    async()=>{
        // A device rendering into a surface on the GPU holds its pixels; the
        // guest's bytes are brought up to date before they are read, and the
        // device hears when the program wrote them.
        const ddraw = withLevel();
        const surface = makeOffscreen(ddraw);
        const other = makeOffscreen(ddraw);
        /** @type {string[]} */
        const heard = [];
        let resolve = ()=>{};
        const stop = ddraw.watchPixels({
            readBack: target=>{
                if (target !== surface)
                {
                    return null;
                }
                heard.push('read');
                return new Promise(done=>{
                    resolve = ()=>done(undefined);
                });
            },
            written: target=>{
                heard.push(target === surface ? 'written' : 'written elsewhere');
            },
        });

        assert.equal(other.pixelsCurrent(), null, 'a surface nobody holds a copy of is current');
        const pending = surface.pixelsCurrent();
        assert.ok(pending, 'the holder is asked');
        let settled = false;
        void pending?.then(()=>{
            settled = true;
        });
        await Promise.resolve();
        assert.equal(settled, false, 'and the bytes are current only once it answers');
        resolve();
        await pending;
        assert.equal(settled, true);

        // A lock that only reads leaves the copy as it was; any other lock,
        // a device context and a change the program announces are writes.
        assert.equal(surface.lock(null, 0x10).hr, DD_OK);
        assert.equal(surface.unlock(null), DD_OK);
        assert.deepEqual(heard, ['read']);
        assert.equal(surface.lock(null, 0).hr, DD_OK);
        assert.equal(surface.unlock(null), DD_OK);
        assert.equal(surface.getDC().hr, DD_OK);
        assert.equal(surface.releaseDC(0), DD_OK);
        surface.changeUniquenessValue();
        assert.deepEqual(heard, ['read', 'written', 'written', 'written']);

        stop();
        assert.equal(surface.pixelsCurrent(), null, 'and nobody is asked once it stops');
        assert.equal(surface.release(), 0);
        assert.equal(other.release(), 0);
        assert.equal(ddraw.release('IDirectDraw7'), 0);
    });
