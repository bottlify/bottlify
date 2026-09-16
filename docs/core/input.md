# input

Keyboard, mouse and gamepad, delivered to a Win32 program both ways it reads them at once. See
[README.md](README.md) for the layer map, [system.md](system.md) for the module contract and
[host.md](host.md) for how a page attaches a canvas.

## Purpose

A program of this era reads input twice over and expects both readings to describe the same
world: the window message queue says a key went down, DirectInput says the key is down, and a
program commonly steers with one and takes commands with the other. This layer owns DirectInput
(`DINPUT.dll`, `DINPUT8.dll`) and posts into `win32`'s message queue, so there is exactly one
place an event arrives and it feeds both. What arrives is a normalised host event -- a physical
key, a pointer motion, a button, a wheel notch -- and nothing about it is a browser's: a page
produces those events through `attach`, a test produces them directly, and neither can tell the
difference. Only keyboard and mouse ever cross from the browser to the guest; focus, tab
visibility and page lifecycle do not.

## Contract

| field | value |
|---|---|
| `name` | `input` |
| `version` | `0.2.0` |
| `requires` | `win32`, `bridge`, `memory` |

Source: `src/layers/input/module.js`. The DirectInput seam imports `IUNKNOWN_METHODS` and
`readGuid` from `src/layers/win32/ole32/`, which `requires` admits.

### Configuration

| option | type | default | meaning |
|---|---|---|---|
| `now` | `() => ms` | `Date.now` | The guest's clock, for message and DirectInput timestamps. |
| `publishInterface` | `(object, iid) => address` | `() => 0` | The bridge's vtable publisher; the default refuses rather than publishing into nowhere. |
| `signal` | `(eventHandle) => void` | absent | Sets the event a device's `SetEventNotification` named when data arrives. |
| `foreground` | `() => hwnd` | `() => 0` | Which window messages are for. Only the assembling caller knows which one a person is looking at. |
| `bounds` | `() => { width, height }` or null | null | The client area the cursor is confined to before a canvas is attached. |

### Provided API

| member | what it is |
|---|---|
| `libraries()` | `{ 'DINPUT.dll', 'DINPUT8.dll' }`, shaped like a `win32` library's tables. |
| `send(event)` | One `HostInputEvent` in; a window message and a DirectInput state change out, both or neither. Returns whether anything came of it. |
| `post(event)` | One event straight to a DirectInput device in its own codes; false when no device is created or acquired. |
| `attach(canvas, { pointerLock?, listen? })` | Listens to one canvas (a second call detaches the first), arms the program's one activation, confines the cursor to the canvas's own pixels. `listen: false` takes the canvas as the picture only, for an `OffscreenCanvas` whose events live on the page. |
| `detach()` | Removes every listener and releases whatever was held. |
| `poll()` | Reads the gamepad, which has no events of its own; nothing when no canvas is attached. |
| `clip(rect)` | The coordinate space the program declared with `ClipCursor`; null or a degenerate rect clears it. |
| `keyState(vk)` | `0x8000` when the virtual key is down, as `GetKeyState` answers. |
| `asyncKeyState(vk)` | The same high bit, plus the low bit while a press is pending, as `GetAsyncKeyState` answers; the read clears the low bit. |
| `keyboardState()` | A fresh 256-byte table, as `GetKeyboardState` fills: high bit down, low bit the toggle for CapsLock/NumLock/ScrollLock. |
| `setKeyboardState(bytes)` | Makes a 256-byte table the synchronous state, as `SetKeyboardState` does. |
| `cursor()` | `{ x, y }` in the program's client coordinates. |
| `pad()` | `{ axes, buttons }` as the last poll left them. |
| `device(guid)` | A created DirectInput device, for whoever is measuring. |
| `dinput()`, `router()` | The seam and the router objects. |

`src/app.js` hands `win32`'s user32 `cursor`, `clipCursor`, `keyState`, `asyncKeyState`,
`keyboardState` and `setKeyboardState` from this API, so `GetCursorPos`, `ClipCursor`,
`GetKeyState`, `GetAsyncKeyState`, `GetKeyboardState` and `SetKeyboardState` read the router's
state.

### The event model

`HostInputEvent` (`src/layers/input/router.js`):

| `kind` | fields | becomes |
|---|---|---|
| `key` | `code` (a `KeyboardEvent.code`), `down` | `WM_KEYDOWN`/`WM_KEYUP` or the `SYS` pair when ALT is held or the key is ALT or F10, with a full lParam (scan code, extended bit, context bit, previous-state bit, transition bit); a DirectInput key event. |
| `text` | `text` | Handed to the queue's `compose` for `TranslateMessage` to turn into `WM_CHAR`, one per UTF-16 code unit, carrying the last key's lParam. Never posted directly, so a program sees exactly one character. |
| `pointerMove` | `x`, `y` (client) and/or `dx`, `dy` | `WM_MOUSEMOVE` with the button and modifier mask; a relative DirectInput mouse event. Whichever of position or delta is missing is derived from the other. |
| `pointerButton` | `button` (`left`, `right`, `middle`, `x1`, `x2`), `down` | The matching `WM_*BUTTONDOWN/UP` (with the XBUTTON id in the high word), preceded by one `WM_SETCURSOR`; a DirectInput button event. |
| `wheel` | `delta` (multiples of `WHEEL_DELTA`) | `WM_MOUSEWHEEL`; a DirectInput wheel event. |
| `focus` | `gained` | Loss releases every held key and button so nothing stays down for ever; gain marks the cursor question dirty. Nothing else. |
| `padAxis`, `padButton` | `axis`/`value`, `index`/`down` | Stored for `pad()`. No DirectInput joystick device reads them. |

### Published libraries

| library | entry points | what they are |
|---|---|---|
| `DINPUT.dll` | 4 | `DirectInputCreateA`, `DirectInputCreateW`, `DirectInputCreateEx`, `DllCanUnloadNow`. |
| `DINPUT8.dll` | 2 | `DirectInput8Create`, `DllCanUnloadNow`. |

Interfaces (`src/layers/input/dinput/seam.js`): `IDirectInput` through `IDirectInput8`, A and W
(5, 6, 7 and 8 slots after `IUnknown`), and `IDirectInputDevice` through `IDirectInputDevice8`,
A and W (15, 24, 26 and 29 slots). Every slot is declared; unimplemented ones answer `E_NOTIMPL`
from the right index.

### `diagnostics()`

| metric | meaning |
|---|---|
| `libraries` | Library names published. |
| `devices[]` | Per DirectInput device: `guid`, `kind`, `acquired`, `buffered` (the `DIPROP_BUFFERSIZE`), `queued`. |
| `published` | Interfaces published. |
| `enumerations` | How often a program asked what DirectInput devices there are. |
| `posted`, `dropped` | Messages posted; events with an unmapped key, unknown button or unknown kind. |
| `keysDown`, `buttonsDown` | What is held right now, by code and by name. |
| `cursor` | Where the cursor is. |
| `viewport`, `clip` | The two spaces a pointer travels between: the confining viewport and the declared clip rect. A cursor that lands short of where it was aimed is these two disagreeing. |

## How it works

### `dom.js`: the browser half

`src/layers/input/dom.js` attaches to the canvas and to nothing else -- not `window`, not
`document`. Keyboard events reach the focused element, so a page carrying a game behaves like an
ordinary page until the person clicks into it; the canvas is given a tab stop if it has none and a
2 px outline while focused, so a machine swallowing keystrokes and one ignoring them do not look
alike. Pointer motion is reported whether or not the canvas has focus, because a click on a panel
beside the viewport is a fact about the page, not the mouse.

- **Keys.** `keydown`/`keyup` send `code` with `preventDefault` only for keys the guest maps and
  never for `Escape`, `F5`, `F11`, `F12` or anything with Ctrl or Meta held; ALT combinations are
  taken, since programs bind alt-enter and the browser's ALT menu is recoverable. A printable
  `key`, or `Enter`/`Tab`/`Backspace`/`Escape` as their control characters, is sent as `text`. Two
  Escapes within 600 ms blur the canvas and hand focus back to the page; both still reach the
  guest first.
- **Pointer.** Every move projects `clientX/Y` through the canvas's bounding rect minus its border
  and padding (re-read only when the drawn size changes) and the ratio of the picture's pixels to
  the drawn size, so a canvas displayed at any size lands the cursor where the person is pointing.
  Relative motion is the difference of two projected positions rather than `movementX/Y`, which a
  browser reports in different units on a scaled display; fractions left by rounding are carried.
  A locked pointer has no position, so it is the one case that uses `movementX/Y`, and no `x`/`y`
  are sent. A press or release that arrives without a preceding move -- a touch, a pen, a
  synthesised click -- moves the cursor to its own position first. `pointerdown` focuses the
  canvas, captures the pointer, and requests pointer lock only when `attach` asked for it;
  `contextmenu` is suppressed.
- **Wheel.** Only while focused, so scrolling over an idle game scrolls the page; pixel deltas
  accumulate at 100 px per notch, line and page deltas count as notches; the sign is inverted to
  Windows' convention; one `wheel` event per whole notch.
- **Focus.** `focus` and `blur` send the `focus` event, whose only guest-visible effect is the
  release of held keys on loss.
- **Gamepad.** `poll()` reads `navigator.getGamepads()` while focused, takes the first pad
  present, and sends an axis when it moved more than 0.02 or a button when it changed. It starts
  no timer of its own; whoever ticks the engine calls it.
- **Detach** removes every listener, clears the outline, and sends a focus loss if focused.

### `router.js`: one event, two readings

`src/layers/input/router.js` turns each event into the messages above and a DirectInput event.
It keeps the 256-entry virtual-key array (both the paired key such as `VK_SHIFT` and the sided
one such as `VK_LSHIFT`; releasing one shift with the other held keeps `VK_SHIFT` down), the set
of held physical keys, the pressed buttons, and the cursor. `src/layers/input/keys.js` maps 105
`KeyboardEvent.code` values to a set-1 scan code, its E0 prefix, the virtual key and the sided
virtual key, from which both the message lParam and the DirectInput code (scan code with E0 folded
into bit 7) are derived.

`WM_SETCURSOR` is posted when the answer could have changed -- focus arriving, a button either way
-- rather than on every move, because this queue posts rather than sends and one per move would
double the busiest traffic there is. `WM_MOUSEWHEEL`'s lParam is in screen coordinates, which
equal client coordinates here because there is no desktop for a window to sit on.

**Viewport and clip.** The cursor is confined to `bounds` until `attach` supplies the canvas's own
pixels through `confineTo`. When the program has declared a rect through `ClipCursor`, the router
scales pointer travel across the real viewport into that space -- a menu built for 640x480 shown in
a larger back buffer moves its cursor by DirectInput counts that span exactly 640x480 -- carrying
the fractional remainder so a slow drag through a shrinking scale is not rounded to nothing, and
confines the cursor to the rect; DirectInput reports the scaled motion whether or not it was
clipped, as hardware does. Undeclared, the viewport is the space and the scale is one.

**Activation.** The program is told it is active exactly once, when `attach` arms the router:
`WM_ACTIVATEAPP`, `WM_ACTIVATE` and `WM_SETFOCUS`. It is never taken back. A page's focus is a
page concern -- a person clicking a button beside the canvas, a browser taking focus for its own
reasons -- and forwarding it as `WM_ACTIVATEAPP` or `WM_KILLFOCUS` would make a program pause or
abandon a cinematic because something happened to a web page. In this machine there is one window
and it is the active one.

### DirectInput

`src/layers/input/dinput/devices.js` is a device without the COM. A mouse's axes are deltas
consumed by reading, so `GetDeviceState` reports motion since the previous call; the buffered
queue is a ring of the size `DIPROP_BUFFERSIZE` stated (unbuffered until it is), and running it
over is remembered and reported once as `DI_BUFFEROVERFLOW`, the `S_FALSE` a program has to look
at; an unacquired device answers `DIERR_NOTACQUIRED`, never zeroes.

`src/layers/input/dinput/seam.js` hands out two devices, `GUID_SysKeyboard` and `GUID_SysMouse`;
any other GUID is `DIERR_DEVICENOTREG`. `SetDataFormat` does not walk the caller's
`DIOBJECTDATAFORMAT` array: it recognises the layout by `dwDataSize` -- 256 for `c_dfDIKeyboard`,
16 for `c_dfDIMouse`, 20 for `c_dfDIMouse2` -- and answers `DIERR_UNSUPPORTED` to any other size
rather than writing at the wrong offsets, and `DIERR_INVALIDPARAM` to a keyboard format on a mouse
or the reverse. `GetDeviceState` must be asked for exactly the size the format set. `SetProperty`
takes `DIPROP_BUFFERSIZE` and accepts axis mode, ranges and dead zones without acting (the device
is already relative and unscaled); `GetProperty` answers only the buffer size. `EnumDevices`
describes the two attached devices to the program's own callback, as Windows does: the pointer's
class first and then the keyboard's, each written into a `DIDEVICEINSTANCE` in guest memory in the
width of the vtable the call arrived on, with `DI8DEVTYPE_*` codes on an interface from 8 and the
older `DIDEVTYPE_*` codes before it. The callback runs through the bridge, the caller parked while
it does; `DIENUM_STOP` ends the enumeration and `DIEDFL_FORCEFEEDBACK` lists nothing. A null
callback is `DIERR_INVALIDPARAM`. `SetCooperativeLevel`,
`RunControlPanel`, `Initialize` succeed; `FindDevice` and `GetDeviceStatus` for an unknown GUID
answer `DIERR_DEVICENOTREG`; `Poll` succeeds with nothing to do.

## Limitations and divergences

- **No joystick device.** `padAxis`/`padButton` are stored for `pad()` and nothing in DirectInput
  reads them; `GetDeviceState` knows keyboard and mouse layouts only. The seam's header names "a
  joystick's" layout among the four it recognises; the `FORMATS` table holds three.
- **Only two devices, and enumeration is static.** `EnumDevices` names `GUID_SysKeyboard` and
  `GUID_SysMouse`; a device plugged in while the process runs is never reported, and the product
  GUID of each is the device's own instance GUID, as Windows reports the system pair.
- **Data formats are recognised by size**, not by walking the description; a hand-rolled format of
  an unfamiliar size is refused.
- **Force feedback, effects, action maps, `GetObjectInfo`, `GetDeviceInfo`, `EnumObjects`,
  `SendDeviceData`, `Escape`, `GetImageInfo`** are declared and answer `E_NOTIMPL`.
- **`SetProperty` for anything but the buffer size is accepted and ignored**; `GetProperty` for
  anything else is `DIERR_UNSUPPORTED`.
- **Two-pad play** is not modelled; the first pad present is the pad.
- **One canvas at a time**; a second `attach` detaches the first.
- **Pointer lock** is only requested from a `pointerdown`, and the browser may refuse it.
- **Force feedback is absent**, so `EnumDevices` with `DIEDFL_FORCEFEEDBACK` lists nothing.

There is no `divergence` hook in this layer; what is reported is `dropped` (unmapped keys and
unknown buttons), `viewport` against `clip`, and each device's `acquired`, `buffered` and
`queued`.

## Tests

All under `npm test` from `modules/core` (`node --test "src/**/*.test.js"`); 140 `test()` cases.

| file | kind | what it pins |
|---|---|---|
| `src/layers/input/module.test.js` | Wiring, over the real `win32` message queue | A key sent to the layer arrives in the queue the program pumps; DirectInput is published beside the message path; a build without `win32` still takes input; diagnostics report both halves. |
| `src/layers/input/router.test.js` | Contract | Message and lParam encoding for keys, modifiers and system keys; mouse messages and masks; `WM_SETCURSOR` timing; text composition; clip scaling and confinement; the one activation; focus loss releasing everything; the keyboard-state table, its toggles and the async press bit. |
| `src/layers/input/dom.test.js` | Unit, against a stand-in canvas | Which keys are taken from the page, what a press becomes, where a click is in the game's own pixels through border and scale, wheel accumulation, double-Escape release, that nothing stays attached. |
| `src/layers/input/dinput/devices.test.js` | Contract | Delta consumption, ring overflow reporting, unacquired refusal, key state layout. |
| `src/layers/input/dinput/seam.test.js` | Contract, over a flat guest memory | Every slot's argument count for all eight interface generations, `SetDataFormat` by size, `GetDeviceState` size checks, `GetDeviceData` in both structure sizes, properties, creation and refusals; `EnumDevices` describing both devices to a recorded guest callback, in both widths and both device-type generations. |

What a real browser does with a `KeyboardEvent` or a `PointerEvent` is not covered by the unit
suite; the `dom.js` tests settle only what the adapter decides for itself. No tracked CDP scenario
asserts on input.
