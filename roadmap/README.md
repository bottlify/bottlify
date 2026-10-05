# Roadmap

- **[`v2/`](v2/README.md)** — the plan: the engine becomes a multi-worker platform whose capacity
  follows the load, single-thread mode first and exactly as today; then x86-64 on that platform,
  Direct3D 11, and ARM and ARM64. Start there; in Russian, [`v2/README.ru.md`](v2/README.ru.md).
- **[`bottles/`](bottles/README.md)** — bottles made, kept, changed and started on the device, and
  the bottle editor: entries, arguments, mode and network; the server is where a bottle is shared.
  In Russian, [`bottles/README.ru.md`](bottles/README.ru.md).
- **[`steam/`](steam/README.md)** — Steam in a bottle: SteamCMD signs in and downloads on the
  person's own account, the download becomes a bottle, and titles that need the client wait on v2.
  In Russian, [`steam/README.ru.md`](steam/README.ru.md).
- **[`decisions.md`](decisions.md)** — behaviour this project chose rather than derived from a
  specification, each entry dated and defended on its merits; the ones v2 will replace say so.
- **[`negative-results.md`](negative-results.md)** — what was measured and did not pay, with the
  conditions of each measurement, so it is not tried again for nothing.

The documents before v2 — the phase history and cork's design and integration plan — were retired
when v2 was written. They remain in git history.

The `00-*` files beside these are **not in git** (`.gitignore` excludes `roadmap/00-*`):
`00-TODO-list.md` is an index of them -- the week's goal and one file per area (cork,
graphics, win32 and kernel, audio and input, installers and bundles, diagnostics), each holding
that area's open work and then its pitfalls, the ones that each cost weeks and are required reading
before touching the kernel, bridge, graphics or audio layers -- beside `00-product-plan.md`, what
is decided and not yet built around the engine, and `00-references.md`.
A fresh clone has everything here except those files.
