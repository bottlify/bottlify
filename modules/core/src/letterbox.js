/*
 * Copyright © 2026 Bottlify Project
 * Licensed under the Mozilla Public License, version 2.0
 * See LICENSE for details
 */

/**
 * Fitting a picture onto a display that is not its shape, or into the window
 * a program placed it in.
 *
 * A cinematic is authored at its own dimensions and they are rarely the
 * display's. Presenting it at those dimensions resizes the surface everything
 * else is drawn on, and a display does not change shape because a film started
 * -- so a film with the screen to itself is scaled to fit, centred, and the
 * margins left black, which is what a video renderer does with a destination
 * rectangle it does not fill. A film whose video window the program placed in
 * one of its own windows goes where it was put instead.
 */

/**
 * @typedef {Object} Picture
 * @property {Uint8Array} bgra   Four bytes a pixel, top row first.
 * @property {number} width
 * @property {number} height
 */

/**
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Rect
 */

/**
 * IVideoWindow as a frame carries it: where the program put the window, in
 * its owner's client coordinates, and whether it shows.
 *
 * @typedef {Object} VideoWindow
 * @property {number} left
 * @property {number} top
 * @property {number} width
 * @property {number} height
 * @property {boolean} visible
 * @property {boolean} [fullScreen]
 */

/**
 * Where a placed film goes on the screen: the video window's whole rectangle,
 * which the picture is scaled over, and the part of it that shows -- null
 * when none does.
 *
 * @typedef {{ target: Rect, visible: Rect | null }} Placement
 */

/**
 * Draws a picture into a screen-sized buffer, scaled to fit and centred.
 *
 * Nearest neighbour rather than anything better: this runs once per film frame
 * on the same thread as the guest, and a cinematic is watched rather than
 * inspected. A filter here would be paid for out of the program's own time.
 *
 * @param {Picture} picture
 * @param {Uint8Array} out   `width * height * 4` bytes, overwritten whole.
 * @param {number} width
 * @param {number} height
 */
export function fitFrame(picture, out, width, height){
    out.fill(0);
    if (picture.width <= 0 || picture.height <= 0 || width <= 0 || height <= 0)
    {
        return;
    }
    const scale = Math.min(width / picture.width, height / picture.height);
    const drawnWidth = Math.max(1, Math.min(width, Math.floor(picture.width * scale)));
    const drawnHeight = Math.max(1, Math.min(height, Math.floor(picture.height * scale)));
    const left = (width - drawnWidth) >> 1;
    const top = (height - drawnHeight) >> 1;
    for (let y = 0; y < drawnHeight; y++)
    {
        const from = Math.min(picture.height - 1, Math.floor(y / scale)) * picture.width * 4;
        let to = ((top + y) * width + left) * 4;
        for (let x = 0; x < drawnWidth; x++, to += 4)
        {
            const at = from + Math.min(picture.width - 1, Math.floor(x / scale)) * 4;
            out[to] = picture.bgra[at];
            out[to + 1] = picture.bgra[at + 1];
            out[to + 2] = picture.bgra[at + 2];
            out[to + 3] = 0xff;
        }
    }
}

/**
 * Whether a film frame belongs on the screen at all. A program that hides its
 * video window (IVideoWindow's Visible) still plays the film -- its sound runs
 * and its clock advances -- and expects nothing drawn; a frame from a source
 * with no window record is shown as it always was.
 *
 * @param {Picture & { window?: { visible: boolean } }} frame
 * @returns {boolean}
 */
export function isShown(frame){
    return frame.window?.visible !== false;
}

/**
 * Where on the screen a film frame goes, when the program placed its video
 * window: IVideoWindow's rectangle is in its owner's client coordinates -- the
 * window is a child of the owner -- so it is moved by where that client area
 * begins on the screen, and cut to it as a child window is cut to its parent.
 *
 * Null when the film has the screen instead: a window with no owner is a
 * top-level window of its own, which on one screen is the whole of it;
 * full-screen mode covers the screen whatever the rectangle says; and an owner
 * that names no window, or a source with no window record, leaves nowhere else.
 *
 * @param {{ hwnd: number, window?: VideoWindow }} frame
 * @param {(hwnd: number) => Rect | null} clientOf  A window's client area on the screen.
 * @param {{ width: number, height: number }} screen
 * @returns {Placement | null}
 */
export function placementOf(frame, clientOf, screen){
    const window = frame.window;
    if (!window || window.fullScreen === true || (frame.hwnd >>> 0) === 0)
    {
        return null;
    }
    const client = clientOf(frame.hwnd >>> 0);
    if (!client)
    {
        return null;
    }
    const left = client.left + window.left;
    const top = client.top + window.top;
    const target = { left, top, right: left + window.width, bottom: top + window.height };
    const visible = {
        left: Math.max(target.left, client.left, 0),
        top: Math.max(target.top, client.top, 0),
        right: Math.min(target.right, client.right, screen.width),
        bottom: Math.min(target.bottom, client.bottom, screen.height),
    };
    return {
        target,
        visible: visible.right > visible.left && visible.bottom > visible.top ? visible : null,
    };
}

/**
 * Draws a picture into a screen-sized buffer, stretched over a placed video
 * window: the whole picture over the whole window, on both axes whatever the
 * two shapes, which is what a video renderer does with the destination it
 * starts with -- its window's client area. Only the part that shows is drawn,
 * at the scale of the whole; everything else is black.
 *
 * Nearest neighbour, for the reason `fitFrame` gives.
 *
 * @param {Picture} picture
 * @param {Uint8Array} out   `width * height * 4` bytes, overwritten whole.
 * @param {number} width
 * @param {number} height
 * @param {Placement} placement  With `visible` inside the screen.
 */
export function stretchFrame(picture, out, width, height, { target, visible }){
    out.fill(0);
    const targetWidth = target.right - target.left;
    const targetHeight = target.bottom - target.top;
    if (!visible || picture.width <= 0 || picture.height <= 0
        || targetWidth <= 0 || targetHeight <= 0)
    {
        return;
    }
    for (let y = visible.top; y < visible.bottom; y++)
    {
        const row = Math.min(picture.height - 1,
            Math.floor((y - target.top) * picture.height / targetHeight));
        const from = row * picture.width * 4;
        let to = (y * width + visible.left) * 4;
        for (let x = visible.left; x < visible.right; x++, to += 4)
        {
            const at = from + Math.min(picture.width - 1,
                Math.floor((x - target.left) * picture.width / targetWidth)) * 4;
            out[to] = picture.bgra[at];
            out[to + 1] = picture.bgra[at + 1];
            out[to + 2] = picture.bgra[at + 2];
            out[to + 3] = 0xff;
        }
    }
}
