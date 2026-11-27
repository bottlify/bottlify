# Direct3D 11 and 12

Status, 2026-11-07. What ships and its limits are in [`docs/core/limits.md`](../docs/core/limits.md).

Today: DirectDraw and Direct3D 7 to 11 on WebGPU, recorded in the process and played in the
graphics worker; DXGI 1.0 to 1.6; shader models 4 and 5 to WGSL, geometry shaders, stream output
and tessellation as compute passes. Direct3D 11 makes devices at feature levels 11.0, 10.1 and
10.0.

- **Left in Direct3D 11:** video (`D3D11_CREATE_DEVICE_VIDEO_SUPPORT`, ID3D11VideoDevice: decision
  A80), feature level 11.1 and the 9.x levels, a 64-bit process's command ring (it traps every
  call), deferred contexts' command lists played by the device.
- **Direct3D 12:** after 11. No code.
