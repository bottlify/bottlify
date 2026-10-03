# Roadmap

- **[`v2/`](v2/README.md)** — the plan: the engine becomes a multi-worker platform whose capacity
  follows the load, single-thread mode first and exactly as today; then x86-64 on that platform,
  Direct3D 11, and ARM and ARM64. Start there.

The documents before v2 — the phase history, cork's design and integration plan, and the register
of decisions — were retired when v2 was written. They remain in git history.

The `00-*` files beside these are **not in git** (`.gitignore` excludes `roadmap/00-*`):
`00-TODO-list.md` is an index of them -- the week's goal and one file per area (cork, v86,
graphics, win32 and kernel, audio and input, installers and bundles, diagnostics), each holding
that area's open work and then its pitfalls, the ones that each cost weeks and are required reading
before touching the kernel, bridge, graphics or audio layers -- beside `00-product-plan.md`, what
is decided and not yet built around the engine, and `00-references.md`.
A fresh clone has everything here except those files.
