FFmpeg for Win-Box — media compatibility component
==================================================

Build:     FFmpeg 8.0 (master @ 894da5c), built by wang-bin/avbuild
Package:   ffmpeg-8.0-windows-desktop-vs2022-gpl-lite.7z
Source:    https://sourceforge.net/projects/avbuild/files/windows-desktop/
           (project: https://github.com/wang-bin/avbuild)
License:   GPL v2+ — configure used --enable-gpl --enable-libx264 --enable-libx265
           Full text: COPYING.GPLv2.1
Toolchain: Microsoft (R) C/C++ Optimizing Compiler 19.44.35219 for x64

Contents (x64 only, shared build):
  ffmpeg.exe, ffprobe.exe
  avcodec-62.dll, avformat-62.dll, avfilter-11.dll, avutil-60.dll,
  swscale-9.dll, swresample-6.dll, avdevice-62.dll, ffmpeg-8.dll
  vcruntime140.dll, vcruntime140_1.dll, msvcp140.dll   <- MSVC build's CRT,
      bundled app-local so the binaries run without the VC++ Redistributable
      (Windows loads them from the exe's own directory). UCRT
      (api-ms-win-crt-*, ucrtbase) ships with Windows 10+.


Usage in this app: only the "incompatible stream -> H264/AAC HLS" fallback and
stream probing, both in src/main/player/HtmlMedia.ts. Verified capabilities:
  decoders  h264/hevc/av1/vp9/aac/ac3/eac3/mp1-3/...
  encoders  libx264 (+ aac)
  muxers    mpegts / hls / mp4
  filters   scale / format
  protocols file / http / https
The full configure line and capability dump are in config.txt (copied verbatim
from the package).
