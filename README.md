# Ultimate Hikvision NVR card

**Sick of the boring Hikvision layout and its limits?** This card gives your
Hikvision recorder a modern camera wall in Home Assistant, with extra abilities
and proper integration with the rest of your home. Inspired by UniFi Protect,
built for Hikvision.

- **A camera wall.** One big live picture, every other camera as a live tile
  beside it. Tap a tile and it swaps in instantly. LIVE and REC badges show
  what the recorder is actually doing.
- **PERSON / VEHICLE tags** on a camera while it records something.
- **PTZ that is usable.** A joystick that moves in any direction, hold-to-zoom,
  **tap the picture to aim the camera there**, and the camera's named presets
  as saved views.
- **A timeline with person and vehicle markers for every camera.** Jump
  straight to the moment someone walked up the driveway: day stepper,
  previous / next event, ±10 s, zoom, and saving a clip.
- **Detections list** down the side: today's people, vehicles and doorbell
  rings across every camera; tap one to watch it.
- **Phones and tablets too:** portrait and landscape layouts.

<!-- screenshots / GIF go here -->

## What you need

| | |
|---|---|
| **[Ultimate Hikvision NVR](https://github.com/deekay2153/ultimate-hikvision-nvr)** | The integration (a fork of `hikvision-nvr-ha`). It finds the cameras, plays the recordings and does the person / vehicle search. |
| **[Advanced Camera Card](https://github.com/dermotduffy/advanced-camera-card)** | Plays the live video. |
| A Hikvision NVR with ISAPI | Person / vehicle markers need a recorder with AcuSense (smart search); without it you get the timeline without markers. |

## Install

1. Install the integration and add your recorder (see its README).
2. HACS → ⋮ → **Custom repositories** → add
   `https://github.com/deekay2153/ultimate-hikvision-nvr-card`, category **Dashboard**,
   then install **Ultimate Hikvision NVR card**.
3. Add the card. That is all it needs:

```yaml
type: custom:ultimate-nvr-card
```

It finds the recorder, its cameras, their Home Assistant camera entities and
motion sensors, and the first PTZ camera by itself. For the camera wall a
panel view (one card, whole page) looks best.

## Options

Everything is optional; anything you set wins over what the card works out.

```yaml
type: custom:ultimate-nvr-card
device: DS-7608NI-…        # which recorder, if you have more than one
channels: [1, 2, 5]        # which cameras, in this order (default: all)
default_mode: live         # or: playback
columns: 5                 # tiles per row (a wall that fills the screen picks 3 to 7 itself)
columns_narrow: 2          # ... on a phone
live_tiles: true           # live video on the small tiles (all: phones too)
fill: true                 # fill the screen on wide screens (false: keep 16:9 rows)
show_offline: false        # show recorder slots with no camera
go2rtc_url: http://<go2rtc host>:1984   # optional, see below
fast_live:                 # per camera, only what you want to change
  3:
    name: Front Gate
    ring: binary_sensor.gate_ringing   # doorbell rings in the detections list
    buttons:                           # buttons on the big picture
      - { label: Open, icon: mdi:gate, entity: script.open_gate }
ptz:
  channel: 1               # default: the first PTZ camera
  presets:                 # default: the camera's named presets
    - { name: Driveway, icon: mdi:car, preset: 3 }       # a camera preset
    - { name: Night watch, entity: script.night_watch }   # or your own script
```

**Saved views** come from the presets you have *named* in the camera's own web
page. Hikvision PTZs report every slot as in use with a default name, and some
numbers are commands (94 reboots the camera), so unnamed slots and command
numbers are never listed.

**go2rtc:** by default live video goes through Home Assistant's own camera
streaming. If you run go2rtc with one stream per camera, set `go2rtc_url` and a
`stream:` name per camera in `fast_live` (`<name>_main`; tiles use
`<name>_sub`) for faster starts.

## Tested on

| Recorder | Cameras | Browsers |
|---|---|---|
| 10-channel Hikvision NVR (AcuSense) | dual-lens PTZ, bullets and turrets (H.265 main, H.264 sub), HiLook turret | Chrome, Edge, Firefox (PC); Safari / HA app (iPhone, iPad) |

That is one install. Other models should work as far as their firmware offers
the same ISAPI features; please open an issue with your model and firmware
either way.

## Known limits

- **Firefox + H.265+ (SmartCodec):** live video freezes after a few seconds.
  Turn H.265+ off for that camera's stream on the recorder (plain H.265 is fine).
- **H.265 in desktop Chrome / Firefox** depends on hardware decoding; the
  sub stream in H.264 is the safe choice for tiles.
- **iPhone / iPad replays** take 10-20 s to start (Home Assistant's HLS route).
- Live tiles are off on phones unless you set `live_tiles: all`.

## Building

`python build.py` joins `src/` into `dist/ultimate-nvr-card.js`.
`preview/index.html` runs the built card against a made-up recorder
(`python -m http.server` in the repo root, then open `/preview/`).

## Licence

MIT. Contains the Hikvision NVR card by
[techmarkai](https://github.com/techmarkai/hikvision-nvr-ha) (MIT) and the
[Arcane PTZ joystick](https://github.com/deekay2153/arcane-ptz-joystick) (MIT).
Not affiliated with or endorsed by Hikvision or Ubiquiti.
