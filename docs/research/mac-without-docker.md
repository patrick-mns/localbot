# Linux devices on the Mac without Docker Desktop

Status: research (branch `research-no-docker`). Goal: keep the same device —
the `trycua/xfce-cua` image with Cua Driver inside — but stop asking users to
install Docker Desktop.

## What the brain needs from a container runtime

`brain/src/computers/docker.ts` and `brain/src/hands/docker-cua.ts` use a
small part of Docker:

| Need | Docker today |
|---|---|
| Get the image (once, ~1–2 GB) | `docker pull trycua/xfce-cua`, `docker image inspect` |
| Create a device | `docker run -d --name … -p 127.0.0.1:<port>:6901 -e VNC_PW=… --shm-size=1g --label …` |
| List / start / stop / remove | `docker ps -a --filter label=…`, `start`, `stop`, `rm -f` |
| Hands (Cua Driver), shell, files | `docker exec [-d] -u cua -e DISPLAY=:1 <name> …` |
| Health | `docker info` |

The screen is noVNC on port 6901 inside the container; the app only needs to
reach that port from the Mac. `trycua/xfce-cua:latest` is multi-arch and has
a native **linux/arm64** build, so Apple silicon runs it without emulation.

## Options

| | Apple Containerization (embedded) | Apple `container` CLI | Lima (+ containerd) | Lume Linux VM |
|---|---|---|---|---|
| Runs the same OCI image | Yes | Yes | Yes (`nerdctl`) | No: a whole Linux VM we'd build and host |
| User installs | Nothing (inside Local Bot) | A signed `.pkg` (admin) | Nothing if bundled (~100 MB) | Nothing (Lume is ours already) |
| Isolation | One lightweight VM per device | Same | One VM, devices are containers in it | One VM per device |
| Reaching the screen | Each container gets its own IP from the Mac | Own IP, or `-p 127.0.0.1:…` | Port forwards through the VM | VM IP |
| Requirements | Apple silicon, **macOS 26** | Apple silicon, macOS 26 | macOS 13+, Intel too | Apple silicon |
| Boot / overhead | Sub-second VM, only the container | Same | Full Ubuntu VM + containerd | Full distro boot |
| License | Apache-2.0 | Apache-2.0 | Apache-2.0 | MIT |
| Work for us | Swift helper (pull, rootfs, run, exec) + bundle a kernel | Mostly swap `docker` → `container` in the brain | Bundle limactl + template; `nerdctl` is docker-compatible | Build/publish a disk image, VNC, guest agent |

Notes:
- **Apple Containerization** (`apple/containerization`) is the Swift package
  under Apple's `container` CLI: OCI image pull, ext4 root filesystems,
  `LinuxContainer` (one VM per container via Virtualization.framework),
  processes inside it (`LinuxProcess`, `vminitd`), a dedicated IP per
  container, Rosetta for amd64. It needs a Linux kernel with VirtIO built in
  (Kata's `vmlinux.container` or the one the repo builds) that we'd ship
  inside the app. Embedding without installing the CLI looks supported (the
  Virtualization backend "needs no extra binaries") but must be proven.
- **Apple `container` 1.0** (June 2026): `container run -d -p 127.0.0.1:8080:8000 …`,
  `container exec`, `container ls`/`inspect` (shows the IP). Its services are
  started with `container system start`; the usual install is a `.pkg` in
  `/usr/local`, which needs an admin password. Whether its binaries can run
  from inside our app bundle is open.
- **Lima** (already on this Mac via Homebrew): VZ VMs with containerd and
  `nerdctl`, which takes Docker's flags. Works on Intel and macOS 13+, at the
  cost of a full VM (a few hundred MB more and slower start).
- **Lume** creates Linux VMs (`lume create --os linux`), but not from an OCI
  image: we'd have to build, host and update our own Linux disk image with
  XFCE, noVNC and Cua Driver. More work and a second image to maintain.

## Recommendation

1. **Default on macOS 26 + Apple silicon: Apple Containerization, embedded.**
   A small Swift helper shipped in the app (`localbot-runtime`) with the same
   verbs the brain uses today: `pull`, `run`, `exec`, `ls`, `start`, `stop`,
   `rm`. The brain picks it instead of `docker` through one runtime
   interface; the device, the image, noVNC and Cua Driver stay the same. No
   install, no admin password, a VM per device.
2. **Fallback: Docker** (what we have) for Intel Macs and macOS < 26. Lima is
   the option if we later want "no Docker" there too.

## Proof of concept: done (Apple `container` 1.6.0, macOS 26.5, M-series)

The device runs outside Docker with no change to the image:

| Step | Result |
|---|---|
| `container image pull trycua/xfce-cua` | 1.17 GB, linux/arm64, 53 s |
| `container run -d --name lb-poc -m 4G -c 4 -e VNC_PW=… --shm-size=1g -l … trycua/xfce-cua` | running in 11 s (first start) |
| noVNC at `http://<container IP>:6901/vnc_lite.html` | 200, XFCE desktop up |
| `container exec -u cua -e DISPLAY=:1 …` | works (as in `docker exec`) |
| Cua Driver install (`cua.ai/driver/install.sh`) | 0.37.0 in 5 s; `serve` running |
| `cua-driver call get_desktop_state` (screenshot) | 1280×900 PNG |
| `cua-driver call click` on "Applications" | menu opened |
| `container stop` / `start` | 2 s / 1 s; installed driver kept |

Findings:
- Every flag the brain passes to `docker run` / `exec` exists with the same
  name (`-d --name -p -e -l --shm-size`, `exec -d -u -e`). Default memory is
  small: pass `-m 4G -c 4`.
- `-p 127.0.0.1:6950:6901` listens on the Mac but resets connections (1.6.0);
  the container's own IP works and is Apple's recommended path.
- **The IP changes on every start** (`.2` → `.3`): read it from
  `container ls --format json` (`status.networks[0].ipv4Address`) each time.
- `container system start` downloads Kata's kernel (664 MB) on first run.

Next:
1. Brain: a `ContainerRuntime` interface (Docker / Apple) under
   `computers/docker.ts` and `hands/docker-cua.ts`; the display URL from the
   container IP. Could start with the `container` CLI (fast to ship, needs the
   `.pkg`) and move to embedded Containerization (no install) after.
2. Onboarding: on macOS 26 + Apple silicon, offer this instead of Docker.

## Spike: embedded Containerization (apps/runtime), no CLI

`apps/runtime` (Swift, macOS 26, `apple/containerization` 0.52.1, signed with
`com.apple.security.virtualization` only) runs the device by itself:

| Step | Result |
|---|---|
| Image pull + unpack to a 16 GB ext4 rootfs (debug build) | ~2.5 min the first time |
| Recreate from the existing rootfs (a restart) | 0 s |
| Boot + supervisord, exec `whoami` as `cua` | seconds; `uid=1000(cua)` |
| noVNC at `http://<IP>:6901` | 200, "Connected to lb-spike:1 (cua)", XFCE up |

What the CLI did for us and the framework doesn't:
- **/etc/hosts**: without it TigerVNC exits at start (supervisord gives up).
  Set `config.hosts = Hosts.default` plus `<IP> <hostname>`.
- **/dev/shm**: 64 MB by default; replace the tmpfs with `size=1g`
  (docker `--shm-size=1g`).
- **Memory/CPUs**: set them (4 GB, 4 CPUs).
- The process comes from the image config (supervisord as root, its env),
  plus `VNC_PW`.
- Each run gets a new subnet/IP from `VmnetNetwork`; the IP is known when the
  container is configured (`config.interfaces[0].ipv4Address`).
- A VM lives in the process that started it: the runtime must be a
  long-running helper (like `container`'s API server), not a one-shot CLI.
- Kernel: Kata's `vmlinux` (29 MB, GPL-2.0, source from kata-containers);
  init image `ghcr.io/apple/containerization/vminit:0.52.1` is pulled once.

## Sources

- Apple Containerization: https://github.com/apple/containerization
- Apple container networking (publish, per-container IP): https://github.com/apple/container/blob/main/docs/networking.md
- Apple container 1.0: https://cloudnativenow.com/features/apple-ships-stable-1-0-of-its-native-container-tool-for-macos/
- Lima VZ: https://lima-vm.io/docs/config/vmtype/
- Lume: https://github.com/trycua/cua/tree/main/libs/lume
