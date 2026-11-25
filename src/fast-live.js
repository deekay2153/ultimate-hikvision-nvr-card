/* Fast live view for the Hikvision NVR playback card (custom:hikvision-nvr-card).
 *
 * The card's own live view falls back to HLS pulled from the NVR, which takes
 * several seconds to start. This add-on swaps the live stage for an Advanced
 * Camera Card playing a go2rtc stream (the same path the old Cameras tab
 * used), for every channel listed in the card's `fast_live` option. Channels
 * not listed keep the card's original behaviour. History/playback is untouched.
 *
 * Card options read here (ultimate-nvr-card fills `fast_live` by itself from
 * the integration when it is not given):
 *   go2rtc_url: http://<go2rtc host>:1984   # optional: play go2rtc streams
 *   fast_live:
 *     1: { entity: camera.driveway, stream: driveway_main }  # stream: go2rtc only
 *     3: { entity: camera.front_gate,
 *          name: Front Gate,      # overrides the NVR's channel name
 *          thumb: true }          # thumbnail from the HA camera entity, not the NVR
 * Without go2rtc_url (or without a stream name) the camera plays through Home
 * Assistant's own camera streaming.
 *
 * Selected camera: unmuted, no loading spinner (the tile's still is shown
 * behind the player), no browser video bar, one tap = full screen.
 *
 * Taps and gestures are caught by a layer of our own on top of the player, so
 * the camera card's menu never appears and the gestures are ours:
 *   - pinch / wheel: zoom anywhere (up to 8x); drag: pan; double-tap: reset
 *   - swipe left / right (when not zoomed), or arrow keys: next / previous camera
 *
 * Full screen must be instant and must not reload the stream. Order tried:
 * the Fullscreen API (PC, iPad), then a `popover` in the browser's top layer
 * (iPhone: nothing moves in the page, so nothing reconnects), then, as a last
 * resort only, a body-level overlay the player is moved into.
 *
 * Deployed as an inline dashboard resource; this file is the source of truth.
 */
customElements.whenDefined("hikvision-nvr-card").then(() => {
  const proto = customElements.get("hikvision-nvr-card").prototype;
  if (proto.__fastLive) return;
  proto.__fastLive = true;

  // ---- one look for the whole card ---------------------------------------------
  // Added after the card's own stylesheet, so on a tie these rules win. One
  // accent (the theme's), one colour each for people and vehicles, one corner
  // size for pictures, pills for everything you press, the dashboard's font.
  const LOOK = `
    :host {
      --fl-accent: var(--primary-color, #03a9f4);
      --fl-on-accent: var(--text-primary-color, #fff);
      --fl-person: #6ee7a8;
      --fl-vehicle: #ffc15e;
      --fl-live: #ff5a52;
      --fl-ink: #0a0c11;
      --fl-panel: #131720;
      --fl-raised: #1d2330;
      --fl-raised-2: #2b3345;
      --fl-text: #eef1f6;
      --fl-muted: #8a93a6;
      --fl-line: rgba(255,255,255,.08);
      --fl-surface: var(--fl-raised);
      --fl-r: 12px;
      --fl-tap: 40px;
    }
    @media (pointer: coarse) { :host { --fl-tap: 44px; } }

    /* A control-room surface of its own: deep ink whatever the dashboard theme. */
    ha-card {
      background: linear-gradient(180deg, #11141c 0%, var(--fl-ink) 100%);
      color: var(--fl-text); border: 0; font-size: 14px; line-height: 1.3;
      -webkit-font-smoothing: antialiased;
    }
    ha-card button, ha-card select, ha-card input { font-family: inherit; }
    ha-card :focus-visible { outline: 2px solid var(--fl-accent); outline-offset: 2px; }

    /* ---- header: camera name with a status line under it ---- */
    .head { padding: 10px 12px 10px 18px; border-bottom: 0; gap: 8px; }
    .head .title {
      font-size: 19px; font-weight: 650; letter-spacing: -.015em; line-height: 1.15;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
    }
    /* ---- LIVE / RECORDING, top right of the live picture ---- */
    .stage > .fl-status {
      position: absolute; top: max(12px, env(safe-area-inset-top));
      right: max(12px, env(safe-area-inset-right)); width: auto; height: auto; z-index: 2;
      display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
      pointer-events: none;
    }
    .stage.fl-full > .fl-status { right: calc(max(12px, env(safe-area-inset-right)) + 56px); }
    .fl-badge {
      display: inline-flex; align-items: center; gap: 7px; height: 26px; padding: 0 11px 0 9px;
      border-radius: 999px; border: 1px solid rgba(255,255,255,.16);
      background: rgba(16,19,26,.62);
      -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
      color: #fff; font-size: 11.5px; font-weight: 700; letter-spacing: .08em; line-height: 1;
    }
    .fl-badge[hidden] { display: none; }
    .fl-badge i { width: 8px; height: 8px; border-radius: 50%; background: var(--fl-live); flex: none; }
    .fl-live-badge i { animation: fl-live 2s ease-out infinite; }
    .fl-rec-badge { background: rgba(255,90,82,.92); border-color: rgba(255,255,255,.28); }
    .fl-rec-badge i { background: #fff; border-radius: 2px; animation: fl-rec 1.2s steps(2, jump-none) infinite; }
    @keyframes fl-live {
      0% { box-shadow: 0 0 0 0 rgba(255,90,82,.7); }
      100% { box-shadow: 0 0 0 7px rgba(255,90,82,0); }
    }
    @keyframes fl-rec { 0% { opacity: 1; } 100% { opacity: .25; } }
    @media (prefers-reduced-motion: reduce) { .fl-badge i { animation: none; } }

    /* ---- segmented switches (Live / History, All / People / Vehicles) ---- */
    .modes, .fl-seg {
      display: inline-flex; flex: none; padding: 3px; gap: 2px; border: 0; border-radius: 12px;
      background: var(--fl-raised); box-shadow: inset 0 0 0 1px var(--fl-line); overflow: visible;
    }
    .modes button, .fl-seg button {
      height: calc(var(--fl-tap) - 8px); padding: 0 15px; border: 0; border-radius: 9px;
      background: none; color: var(--fl-muted); font-size: 14px; font-weight: 550;
      display: inline-flex; align-items: center; gap: 6px; white-space: nowrap; cursor: pointer;
      font-variant-numeric: tabular-nums; transition: background .16s, color .16s;
    }
    .modes button[aria-pressed="true"], .fl-seg button[aria-pressed="true"] {
      background: var(--fl-raised-2); color: var(--fl-text);
      box-shadow: 0 1px 2px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.07);
    }
    .fl-n { color: var(--fl-muted); font-weight: 500; }

    .fl-icon {
      flex: none; width: var(--fl-tap); height: var(--fl-tap); padding: 0; border: 0;
      border-radius: 999px; background: none; color: var(--fl-text); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center;
      transition: background .16s;
    }
    .fl-icon:hover { background: var(--fl-raised); }
    .fl-btn {
      flex: none; height: calc(var(--fl-tap) - 8px); box-sizing: border-box; padding: 0 13px;
      display: inline-flex; align-items: center; gap: 6px; border-radius: 999px; border: 0;
      background: var(--fl-raised); color: var(--fl-text); font-size: 13px; font-weight: 550;
      white-space: nowrap; cursor: pointer;
    }
    .fl-icon[disabled], .fl-btn[disabled] { opacity: .3; cursor: default; }
    .fl-icon[disabled]:hover { background: none; }
    .fl-grow { flex: 1; min-width: 0; }

    /* ---- the player deck: day on the left, transport in the middle ---- */
    .fl-deck {
      display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 8px;
      padding: 12px 14px 10px;
    }
    .fl-day { display: inline-flex; align-items: center; gap: 2px; justify-self: start; }
    .fl-daylabel {
      position: relative; display: flex; flex-direction: column; min-width: 96px;
      padding: 3px 8px; border-radius: 10px; text-align: center; cursor: pointer;
      transition: background .16s;
    }
    .fl-daylabel:hover { background: var(--fl-raised); }
    .fl-dayname { font-size: 15px; font-weight: 600; letter-spacing: -.01em; }
    .fl-daydate { font-size: 12px; color: var(--fl-muted); }
    .fl-daylabel input {
      position: absolute; inset: 0; width: 100%; height: 100%; margin: 0; padding: 0;
      border: 0; opacity: 0; cursor: pointer;
    }
    .fl-transport { display: inline-flex; align-items: center; gap: 2px; justify-self: center; }
    .fl-clock { min-width: 132px; padding: 0 6px; text-align: center; }
    .fl-time {
      display: block; font-size: 27px; font-weight: 600; letter-spacing: -.02em;
      line-height: 1.05; font-variant-numeric: tabular-nums;
    }
    .fl-sub { display: block; margin-top: 3px; font-size: 12px; color: var(--fl-muted); white-space: nowrap; }
    .fl-tools { display: inline-flex; align-items: center; gap: 2px; justify-self: end; }
    .fl-quiet {
      appearance: none; -webkit-appearance: none; height: var(--fl-tap);
      padding: 0 28px 0 12px; border: 0; border-radius: 10px; cursor: pointer;
      background: transparent url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%238a93a6' d='M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z'/%3E%3C/svg%3E") no-repeat right 7px center / 16px;
      color: var(--fl-muted); font-size: 13px; font-weight: 550;
    }
    .fl-quiet:hover { background-color: var(--fl-raised); color: var(--fl-text); }
    .fl-quiet option { background: #1d2330; color: #eef1f6; }
    @media (max-width: 599px) {
      .fl-deck {
        grid-template-columns: 1fr auto; grid-template-areas: "day tools" "transport transport";
        row-gap: 6px; padding: 10px 8px 8px;
      }
      .fl-day { grid-area: day; }
      .fl-tools { grid-area: tools; }
      .fl-transport { grid-area: transport; }
      .fl-time { font-size: 25px; }
      .fl-wide { display: none; }
    }

    /* ---- the day ruler ---- */
    .fl-tl { position: relative; margin: 0 14px 12px; }
    .timeline {
      height: 92px; margin: 0; border-radius: 14px; background: var(--fl-panel);
      box-shadow: inset 0 0 0 1px var(--fl-line); cursor: crosshair;
    }
    .timeline.dragging { cursor: grabbing; }
    .fl-sky, .fl-track, .fl-tick, .fl-hour, .fl-rec, .fl-pin, .fl-needle, .fl-now { position: absolute; pointer-events: none; }
    .fl-sky { inset: 0; }
    .fl-tick { bottom: 24px; width: 1px; height: 5px; background: rgba(255,255,255,.16); }
    .fl-tick.major { top: 0; bottom: 0; height: auto; background: rgba(255,255,255,.06); }
    .fl-hour {
      top: 8px; transform: translateX(-50%); font-size: 11px; font-weight: 500;
      color: var(--fl-muted); font-variant-numeric: tabular-nums; white-space: nowrap;
    }
    .fl-hour.first { transform: none; margin-left: 9px; }
    .fl-hour.last { transform: translateX(-100%); margin-left: -9px; }
    .fl-track { left: 0; right: 0; bottom: 12px; height: 6px; background: rgba(255,255,255,.05); }
    .fl-rec {
      bottom: 12px; height: 6px; min-width: 3px; border-radius: 3px; background: var(--fl-accent);
      box-shadow: 0 0 10px color-mix(in srgb, var(--fl-accent) 60%, transparent);
    }
    .fl-pin { bottom: 18px; width: 1px; }
    .fl-pin.person { height: 42px; color: var(--fl-person); background: linear-gradient(var(--fl-person), rgba(110,231,168,0)); }
    .fl-pin.vehicle { height: 24px; color: var(--fl-vehicle); background: linear-gradient(var(--fl-vehicle), rgba(255,193,94,0)); }
    .fl-pin::before {
      content: ""; position: absolute; top: -4px; left: -3.5px; width: 8px; height: 8px;
      border-radius: 50%; background: currentColor; box-shadow: 0 0 0 2px rgba(10,12,17,.8);
    }
    .fl-pin.icon::before { display: none; }
    .fl-pin.icon svg { position: absolute; top: -17px; left: -8px; }
    .fl-needle {
      top: 0; bottom: 0; width: 2px; margin-left: -1px; border-radius: 1px; background: #fff;
      box-shadow: 0 0 12px rgba(255,255,255,.6); z-index: 2;
    }
    .fl-now {
      top: 5px; z-index: 3; padding: 2px 8px; border-radius: 999px; background: #fff;
      color: #0a0c11; font-size: 11px; font-weight: 700; font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .fl-ghost {
      position: absolute; top: 0; bottom: 0; width: 1px; display: none; z-index: 1;
      background: rgba(255,255,255,.35); pointer-events: none;
    }
    .fl-ghost span {
      position: absolute; left: 7px; bottom: 26px; padding: 1px 7px; border-radius: 999px;
      background: rgba(10,12,17,.82); color: var(--fl-text); font-size: 11px; font-weight: 600;
      font-variant-numeric: tabular-nums; white-space: nowrap;
    }

    .fast-filter { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 0 14px 12px; }
    .fl-zoom { display: inline-flex; align-items: center; gap: 2px; }
    .fl-zoom button[disabled] { display: none; }
    @media (max-width: 599px) {
      .fl-tl { margin: 0 8px 10px; }
      .fast-filter { padding: 0 8px 10px; flex-wrap: nowrap; }
      .fl-zoom .fl-icon { display: none; } /* a finger drags the ruler instead */
      .modes button, .fl-seg button { padding: 0 13px; }
    }

    /* ---- snapshots ---- */
    .fast-strip {
      gap: 8px; padding: 0 14px 14px; overflow-x: auto; scrollbar-width: none;
      -webkit-overflow-scrolling: touch;
      -webkit-mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 36px), transparent 100%);
      mask-image: linear-gradient(to right, transparent 0, #000 14px, #000 calc(100% - 36px), transparent 100%);
    }
    .fast-strip::-webkit-scrollbar { display: none; }
    .fl-thumb {
      flex: none; position: relative; width: 152px; height: 86px; padding: 0; border: 0;
      border-radius: 10px; overflow: hidden; background: #000; cursor: pointer;
      outline: 1px solid var(--fl-line); outline-offset: -1px;
    }
    .fl-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .fl-thumb span {
      position: absolute; inset: auto auto 6px 6px; display: flex; align-items: center; gap: 5px;
      padding: 3px 9px 3px 7px; border-radius: 999px; background: rgba(10,12,17,.72);
      color: #fff; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .fl-thumb.current { outline: 2px solid var(--fl-accent); outline-offset: -2px; }

    /* ---- camera tiles ---- */
    .grid { gap: 8px; padding: 10px 14px 14px; background: none; }
    .tile {
      border-radius: var(--fl-r); outline: 1px solid var(--fl-line); outline-offset: -1px;
      transition: box-shadow .16s;
    }
    .tile.active {
      outline: 2px solid var(--fl-accent); outline-offset: -2px;
      box-shadow: 0 0 0 4px color-mix(in srgb, var(--fl-accent) 24%, transparent);
    }
    /* The camera's name is a small dark capsule in the corner of its picture,
       not a strip of text across it. The camera being watched gets the accent. */
    .tile .label {
      display: block; inset: auto auto 7px 7px; box-sizing: border-box;
      max-width: calc(100% - 14px); padding: 4px 10px; border-radius: 999px;
      background: rgba(10,12,17,.7); color: #fff;
      font-size: 12.5px; font-weight: 600; letter-spacing: .01em; line-height: 1.25;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .tile.active .label { background: var(--fl-accent); color: var(--fl-on-accent); }
    .tile .label .dot { display: none; vertical-align: 1px; margin-right: 6px; }
    .tile.offline .label .dot { display: inline-block; }
    .tile.fl-motion:not(.active) { outline: 2px solid #fff; outline-offset: -2px; }
    .tile.fl-motion .label .dot { display: inline-block; background: #fff; animation: fl-pulse 1.4s ease-out infinite; }
    @keyframes fl-pulse {
      0% { box-shadow: 0 0 0 0 rgba(255,255,255,.7); }
      100% { box-shadow: 0 0 0 7px rgba(255,255,255,0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .tile.fl-motion .label .dot { animation: none; }
      .modes button, .fl-seg button, .fl-icon, .tile { transition: none; }
    }
    /* REC marker, top left of a tile, while the recorder is recording it. */
    .tile.fl-recording::after {
      content: "REC"; position: absolute; left: 7px; top: 7px; height: 20px; box-sizing: border-box;
      padding: 0 8px 0 19px; border-radius: 999px; color: #fff;
      font-size: 10.5px; font-weight: 700; letter-spacing: .08em; line-height: 20px;
      background: radial-gradient(circle at 10px 50%, #fff 0 3px, transparent 3.5px), rgba(255,90,82,.92);
      pointer-events: none;
    }
    /* ---- wall layout (card option layout: wall): icon rail, big picture with
       the other cameras around it, detections down the side, one timeline ---- */
    :host([wall]) ha-card { flex-direction: row; align-items: stretch; }
    .fl-rail {
      flex: none; width: 52px; display: flex; flex-direction: column; align-items: center;
      gap: 6px; padding: 10px 0; background: #07090d;
    }
    .fl-rail button {
      width: 38px; height: 38px; padding: 0; border: 0; border-radius: 10px; background: none;
      color: var(--fl-muted); cursor: pointer; display: flex; align-items: center;
      justify-content: center; --mdc-icon-size: 22px;
    }
    .fl-rail button[aria-pressed="true"] {
      background: color-mix(in srgb, var(--fl-accent) 22%, transparent); color: var(--fl-accent);
    }
    .fl-main {
      flex: 1; min-width: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr));
      grid-auto-flow: row dense; gap: 4px; padding: 0 4px 6px; align-content: start;
    }
    .fl-main > .head { grid-column: 1 / -1; padding: 8px 6px 6px 10px; }
    .fl-main > .stage { grid-column: span 3; grid-row: span 3; border-radius: 6px; max-height: none !important; }
    .fl-main > .grid { display: contents; }
    :host([wall]) .tile { border-radius: 6px; }
    :host([wall]) .tile.active { display: none; }
    .fl-main > .fl-deck, .fl-main > .fl-tl, .fl-main > .fast-filter, .fl-main > .err { grid-column: 1 / -1; order: 2; }
    .fl-main > .fast-strip { display: none !important; }
    :host([wall]) .modes { display: none; }
    :host([wall]) .timeline { height: 76px; }
    :host([wall]) .fl-tl { margin: 2px 0 0; }
    :host([wall]) .fl-deck { padding: 6px 6px 2px; }
    :host([wall]) .fast-filter { padding: 6px 0 0; }
    .fl-livetl .timeline { cursor: pointer; }
    .fl-now.fl-now-live { background: var(--fl-live); color: #fff; }
    .fl-headinfo { color: var(--fl-muted); font-size: 13px; white-space: nowrap; }
    .fl-sum {
      border-radius: 6px; background: var(--fl-panel); box-shadow: inset 0 0 0 1px var(--fl-line);
      display: flex; align-items: center; justify-content: center; gap: 16px;
      font-size: 15px; font-weight: 600; font-variant-numeric: tabular-nums;
    }
    .fl-sum-t { color: var(--fl-muted); font-size: 13px; font-weight: 500; }
    .fl-sum-n { display: inline-flex; align-items: center; gap: 6px; }
    .fl-side { flex: none; width: 250px; position: relative; background: #07090d; }
    :host([side-off]) .fl-side { display: none; }
    .fl-side-head { padding: 14px 12px 8px; font-size: 14px; font-weight: 600; }
    .fl-side-list {
      position: absolute; inset: 44px 0 0 0; overflow-y: auto; padding: 0 8px 8px;
      display: flex; flex-direction: column; gap: 2px; scrollbar-width: thin;
    }
    .fl-ev {
      flex: none; display: grid; grid-template-columns: 76px minmax(0, 1fr); column-gap: 9px;
      align-items: center; padding: 4px; border: 0; border-radius: 8px; background: none;
      color: var(--fl-text); text-align: left; cursor: pointer;
    }
    .fl-ev:hover { background: var(--fl-raised); }
    .fl-ev.fl-picked { background: color-mix(in srgb, var(--fl-accent) 20%, transparent); box-shadow: inset 3px 0 0 var(--fl-accent); }
    .fl-ev img { grid-row: span 2; width: 76px; height: 43px; object-fit: cover; border-radius: 5px; background: #000; display: block; }
    .fl-ev-what { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; align-self: end; }
    .fl-ev-meta { font-size: 12px; color: var(--fl-muted); align-self: start; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .fl-side-empty { margin: 8px 6px; color: var(--fl-muted); font-size: 13px; }
    /* PTZ controls on the big picture: the joystick, and the saved views. */
    .stage > .fl-ptz {
      position: absolute; left: max(12px, env(safe-area-inset-left));
      bottom: max(12px, env(safe-area-inset-bottom)); width: auto; height: auto; z-index: 3;
    }
    .stage > .fl-presets {
      position: absolute; right: max(12px, env(safe-area-inset-right));
      bottom: max(12px, env(safe-area-inset-bottom)); width: auto; height: auto; z-index: 3;
      display: flex; flex-direction: column-reverse; align-items: flex-end; gap: 6px;
      max-height: calc(100% - 96px);
    }
    .fl-preset-btn, .fl-preset-list button {
      flex: none; height: 34px; padding: 0 12px 0 9px; display: inline-flex; align-items: center; gap: 6px;
      border-radius: 999px; border: 1px solid rgba(255,255,255,.18); background: rgba(16,19,26,.74);
      color: #fff; font-size: 13px; font-weight: 600; cursor: pointer; white-space: nowrap;
      --mdc-icon-size: 18px;
    }
    .fl-preset-list { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; overflow-y: auto; scrollbar-width: none; }
    .fl-preset-list[hidden] { display: none; }
    @media (max-width: 899px) {
      :host([wall]) ha-card { flex-direction: column; }
      .fl-rail, .fl-sum, .fl-headinfo { display: none; }
      :host([wall]) .modes { display: inline-flex; }
      .fl-main { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .fl-main > .stage { grid-column: 1 / -1; grid-row: auto; }
      .fl-side { width: auto; }
      .fl-side-list { position: static; max-height: 320px; }
    }
    /* Live video over a tile's still; shown only once it is really playing. */
    .fl-tile-live { position: absolute; inset: 0; opacity: 0; transition: opacity .3s; pointer-events: none; }
    .fl-tile-live.on { opacity: 1; }
    .fl-tile-live > * { display: block; width: 100%; height: 100%; }
    .fast-badge {
      position: absolute; right: 7px; top: 7px; display: flex; align-items: center; gap: 4px;
      padding: 3px 8px; border-radius: 999px; background: rgba(10,12,17,.7);
      color: #fff; font-size: 12px; font-weight: 600; line-height: 1.25;
      font-variant-numeric: tabular-nums; pointer-events: none;
    }
    @media (max-width: 599px) { .grid { gap: 6px; padding: 8px 8px 10px; } }

    /* ---- on the picture ---- */
    .overlay {
      font-size: 14px; font-weight: 500;
      background: linear-gradient(rgba(10,12,17,.3), rgba(10,12,17,.72));
    }
    .stage > .fast-buttons {
      position: absolute; left: max(12px, env(safe-area-inset-left));
      bottom: max(12px, env(safe-area-inset-bottom)); width: auto; height: auto;
      z-index: 2; display: flex; gap: 8px; flex-wrap: wrap;
    }
    .fl-act {
      height: var(--fl-tap); padding: 0 15px; display: inline-flex; align-items: center; gap: 7px;
      border-radius: 999px; border: 1px solid rgba(255,255,255,.18); background: rgba(16,19,26,.62);
      -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
      color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
    }
    .fl-act[data-armed="1"] { background: #fff; border-color: #fff; color: #111; }
  `;
  const ensureLook = (host) => {
    const root = host.shadowRoot;
    if (!root || root.querySelector("#fl-look")) return;
    const style = document.createElement("style");
    style.id = "fl-look";
    style.textContent = LOOK;
    const card = root.querySelector("ha-card");
    if (card) root.insertBefore(style, card);
    else root.appendChild(style);
  };
  const CHEVRON = {
    left: "M15.41,16.58L10.83,12L15.41,7.41L14,6L8,12L14,18L15.41,16.58Z",
    right: "M8.59,16.58L13.17,12L8.59,7.41L10,6L16,12L10,18L8.59,16.58Z",
    save: "M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z",
    prevEvent: "M6,18V6H8V18H6M9.5,12L18,6V18L9.5,12Z",
    nextEvent: "M16,18H18V6H16M6,18L14.5,12L6,6V18Z",
    back10:
      "M12.5,3C17.15,3 21.08,6.03 22.47,10.22L20.1,11C19.05,7.81 16.04,5.5 12.5,5.5C10.54,5.5 8.77,6.22 7.38,7.38L10,10H3V3L5.6,5.6C7.45,4 9.85,3 12.5,3M10,12V22H8V14H6V12H10M18,14V20C18,21.11 17.11,22 16,22H14A2,2 0 0,1 12,20V14A2,2 0 0,1 14,12H16C17.11,12 18,12.9 18,14M14,14V20H16V14H14Z",
    forward10:
      "M10,12V22H8V14H6V12H10M18,14V20C18,21.11 17.11,22 16,22H14A2,2 0 0,1 12,20V14A2,2 0 0,1 14,12H16C17.11,12 18,12.9 18,14M14,14V20H16V14H14M11.5,3C14.15,3 16.55,4 18.4,5.6L21,3V10H14L16.62,7.38C15.23,6.22 13.46,5.5 11.5,5.5C7.96,5.5 4.95,7.81 3.9,11L1.53,10.22C2.92,6.03 6.85,3 11.5,3Z",
  };
  const glyph = (path, size) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;fill:currentColor">` +
    `<path d="${path}"/></svg>`;
  const CLIP_LENGTHS = [
    [30, "30 sec"], [60, "1 min"], [120, "2 min"], [300, "5 min"],
    [600, "10 min"], [1800, "30 min"], [3600, "1 hour"],
  ];

  // Faint night and day light behind the day ruler: indigo before sunrise and
  // after sunset, a warm wash in between. Times come from the house's own sun.
  const dayFraction = (iso, fallback) => {
    const when = new Date(iso);
    if (Number.isNaN(when.getTime())) return fallback;
    return (when.getHours() * 60 + when.getMinutes()) / 1440;
  };
  const skyGradient = (host, pos) => {
    let rise = 0.25;
    let set = 0.79;
    try {
      const sun = host._hass.states["sun.sun"];
      if (sun) {
        rise = dayFraction(sun.attributes.next_rising, rise);
        set = dayFraction(sun.attributes.next_setting, set);
      }
    } catch (_) {
      /* keep the usual hours */
    }
    const night = "rgba(74,90,178,.20)";
    const day = "rgba(255,206,140,.10)";
    const stop = (colour, fraction) => `${colour} ${pos(fraction).toFixed(2)}%`;
    return (
      `linear-gradient(to right, ${stop(night, rise - 0.035)}, ${stop(day, rise + 0.035)}, ` +
      `${stop(day, set - 0.035)}, ${stop(night, set + 0.035)})`
    );
  };

  // While a recording plays, the playhead and the big clock follow it.
  const movePlayhead = (host) => {
    try {
      const at = host._flPlayAt;
      if (!at || !host._dayStart || !host._dayEnd) return;
      const root = host.shadowRoot;
      const text = clock(at.getTime());
      const time = root.querySelector(".fl-time");
      // Nothing on the page is touched unless the second shown has changed.
      if (time && time.textContent === text) return;
      if (time) time.textContent = text;
      const span = host._dayEnd.getTime() - host._dayStart.getTime();
      const left =
        (((at.getTime() - host._dayStart.getTime()) / span - host._view.from) /
          (host._view.to - host._view.from)) *
        100;
      const needle = root.querySelector(".fl-needle");
      const bubble = root.querySelector(".fl-now");
      if (needle && bubble && left >= 0 && left <= 100) {
        needle.style.left = `${left.toFixed(3)}%`;
        bubble.style.left = `${left.toFixed(3)}%`;
        bubble.textContent = text;
      } else {
        host._paintTimeline();
      }
    } catch (_) {
      /* cosmetic */
    }
  };

  // The recorder shouts its camera names ("BACK DOOR"). Show them as names:
  // "Back Door". Short forms that really are initials stay as they are.
  const INITIALS = ["PTZ", "NVR", "CCTV"];
  const pretty = (name) => {
    const text = String(name || "");
    if (!text || text !== text.toUpperCase()) return text; // already mixed case
    return text
      .split(" ")
      .map((word) =>
        INITIALS.includes(word) ? word : word.charAt(0) + word.slice(1).toLowerCase()
      )
      .join(" ");
  };

  // In full screen the live picture is as large as fits (16:9), in the middle
  // of the screen both ways, whichever way the screen is turned.
  const fitFull = (host, box, layer) => {
    try {
      const card = layer.card;
      if (!card || !host._fastFull) return;
      if (layer.plain) {
        // A recording is a plain video: it letterboxes and centres itself.
        card.style.width = "100%";
        card.style.height = "100%";
        return;
      }
      const boxWidth = box.clientWidth || window.innerWidth;
      const boxHeight = box.clientHeight || window.innerHeight;
      const width = Math.floor(Math.min(boxWidth, (boxHeight * 16) / 9));
      card.style.position = "absolute";
      card.style.inset = "0";
      card.style.margin = "auto";
      card.style.width = `${width}px`;
      card.style.height = `${Math.floor((width * 9) / 16)}px`;
    } catch (_) {
      /* layout nicety only */
    }
  };
  const unfitFull = (layer) => {
    const card = layer.card;
    if (!card) return;
    for (const property of ["position", "inset", "margin", "width", "height"]) {
      card.style[property] = "";
    }
  };

  let rulerHtml = () => ""; // set further down, once the timeline code is in
  const MAX_ZOOM = 8;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const entryFor = (host, channel) =>
    (host._config && host._config.fast_live && host._config.fast_live[channel]) || null;
  const keyFor = (channel, entry) => `fast:${channel}:${entry.stream}`;
  const stillBackground = (host, channel) => {
    const still = host._snapshotUrls.get(channel);
    return still ? `#000 center / contain no-repeat url("${still}")` : "#000";
  };

  // ---- fit the big picture to the screen ---------------------------------------
  // The stage is 16:9 of the card's width, which on a wide screen is taller
  // than the window. Cap it so the title, the picture and (in History) the
  // controls, timeline and snapshot strip all fit without scrolling, with a
  // strip of the camera tiles peeking in below. Scrolling is only for tiles.
  // Nothing here is a fixed size: the room is measured from whatever actually
  // scrolls the page (a container, or the window) and from the real heights of
  // everything above and below the picture, and it is re-measured whenever any
  // of those change size.
  const scrollParent = (node) => {
    let current = node;
    while (current) {
      const root = current.getRootNode();
      const parent = current.parentElement || (root && root.host) || null;
      if (!parent || parent === document.body || parent === document.documentElement) break;
      const overflow = getComputedStyle(parent).overflowY;
      if (overflow === "auto" || overflow === "scroll") return parent;
      current = parent;
    }
    return null; // the window itself scrolls
  };
  const fitStage = (host) => {
    try {
      if (host._fastFull) return;
      if (isWall(host)) {
        // The wall layout sizes the big picture by its grid, not by the window.
        const wallStage = host.shadowRoot.querySelector("#stage");
        if (wallStage) wallStage.style.maxHeight = "";
        return;
      }
      const root = host.shadowRoot;
      const stage = root.querySelector("#stage");
      const grid = root.querySelector(".grid");
      if (!stage || !grid) return;
      stage.style.maxHeight = "";
      const hostBox = host.getBoundingClientRect();
      const stageBox = stage.getBoundingClientRect();
      const gridBox = grid.getBoundingClientRect();
      // The visible height, and where the card starts inside it when the page
      // is scrolled to the top.
      const scroller = scrollParent(host);
      let visible;
      let cardTop;
      if (scroller) {
        const box = scroller.getBoundingClientRect();
        visible = scroller.clientHeight;
        cardTop = hostBox.top - box.top + scroller.scrollTop;
      } else {
        visible = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        cardTop = hostBox.top + window.scrollY;
      }
      const above = stageBox.top - hostBox.top;
      const below = gridBox.top - stageBox.bottom;
      const room = visible - cardTop - above - below;
      const limit = Math.max(120, Math.floor(room));
      const capped = stageBox.height > limit + 1;
      stage.style.maxHeight = capped ? `${limit}px` : "";
      // Keep the live player 16:9 inside the shorter stage, centred.
      const card = host._fastLiveCard;
      if (card && card.parentElement === stage) {
        card.style.width = capped ? `${Math.floor((limit * 16) / 9)}px` : "";
        card.style.margin = capped ? "0 auto" : "";
      }
    } catch (_) {
      /* layout nicety only */
    }
  };

  // ---- the embedded camera player ------------------------------------------
  const subStream = (entry) => entry.sub || String(entry.stream || "").replace(/_main$/, "_sub");
  const buildCard = async (host, entry, tile) => {
    const helpers = await window.loadCardHelpers();
    const card = await helpers.createCardElement({
      type: "custom:advanced-camera-card",
      cameras: [
        {
          camera_entity: entry.entity,
          live_provider: host._config.go2rtc_url && entry.stream ? "go2rtc" : "ha",
          go2rtc: {
            // A tile plays the small stream, and only the ways that need no
            // converting on the Home Assistant box.
            stream: tile ? subStream(entry) : entry.stream,
            url: host._config.go2rtc_url,
            // Firefox decodes WebRTC video in software: nine tiles at once froze it.
            modes: tile ? (/firefox/i.test(navigator.userAgent) ? ["mse"] : ["webrtc", "mse"]) : ["webrtc", "mse", "mp4", "mjpeg"],
          },
        },
      ],
      live: {
        show_image_during_load: !tile,
        draggable: false,
        zoomable: false,
        // Sound on by default, unless the viewer has muted it this session.
        auto_unmute: tile || host._muted ? [] : ["visible", "selected"],
        // No browser video bar (pause / mute / PiP / settings) over the picture.
        // ... and no pull-out drawer of clips (its handle is three lines on
        // the right edge of the picture). History is this card's own job.
        controls: { builtin: false, thumbnails: { mode: "none" } },
      },
      menu: { mode: "none", buttons: { iris: { enabled: false, show: false } } },
      // No "NVR channel 6 / 3200x1800" bar popping up over the picture.
      status_bar: { style: "none" },
      performance: { features: { animated_progress_indicator: false } },
      // On a wall that fills the screen the big picture's box is not 16:9:
      // let the player take the box and show the whole picture inside it.
      // On the wall the big picture fills whatever box the layout gives it
      // (16:9, or taller / shorter when the wall fills the screen) and shows
      // the whole picture inside it.
      dimensions: !tile && isWall(host)
        ? { aspect_ratio_mode: "unconstrained" }
        : { aspect_ratio: "16:9" },
      views: ["live"],
      // A tile crops to fill itself, like its still picture underneath.
      cameras_global: { dimensions: { layout: { fit: tile ? "cover" : "contain" } } },
    });
    card.style.setProperty("--advanced-camera-card-loading-foreground-color", "transparent");
    card.style.setProperty("--advanced-camera-card-loading-background-color", "transparent");
    card.style.setProperty("--ha-card-background", "transparent");
    card.style.setProperty("--card-background-color", "transparent");
    card.hass = host._hass;
    return card;
  };

  // ---- next / previous camera, in place --------------------------------------
  const flashLabel = (stage, text) => {
    const old = stage.querySelector(".fast-live-label");
    if (old) old.remove();
    const label = document.createElement("div");
    label.className = "fast-live-label";
    label.textContent = text;
    label.style.cssText =
      "position:absolute;left:50%;top:max(16px,env(safe-area-inset-top));" +
      "transform:translateX(-50%);width:auto;height:auto;z-index:2;display:block;" +
      "padding:6px 16px;border-radius:16px;background:rgba(0,0,0,.6);color:#fff;" +
      "font-size:14px;font-weight:600;line-height:1.2;pointer-events:none;" +
      "transition:opacity .4s;opacity:1;white-space:nowrap;";
    stage.appendChild(label);
    setTimeout(() => { label.style.opacity = "0"; }, 1200);
    setTimeout(() => label.remove(), 1700);
  };

  const swapCamera = async (host, stage, layer, direction) => {
    const list = (host._channels || []).filter((c) => entryFor(host, c.id));
    if (list.length < 2) return;
    const index = list.findIndex((c) => c.id === host._selected);
    const next = list[(index + direction + list.length) % list.length];
    const entry = entryFor(host, next.id);
    const old = layer.card;
    const width = old.style.width;
    const height = old.style.height;

    host._selected = next.id;
    host._playbackUrl = null;
    const key = keyFor(next.id, entry);
    stage.dataset.url = key;
    layer.resetZoom();
    old.remove();
    // Full screen is a different shape from the still, so stay black there.
    stage.style.background = host._fastFull ? "#000" : stillBackground(host, next.id);
    flashLabel(stage, next.name || "");
    renderButtons(host, stage, entry);
    renderPtz(host, stage);
    hook("ptz", host, stage);
    paintStatus(host);

    // Keep the page underneath in step, without re-rendering it (a re-render
    // would rebuild the stage and drop out of full screen).
    try {
      const root = host.shadowRoot;
      const title = root.querySelector(".head .title");
      if (title) title.textContent = next.name || "";
      root.querySelectorAll(".tile").forEach((tile) =>
        tile.classList.toggle("active", Number(tile.dataset.channel) === next.id)
      );
    } catch (_) {}

    try {
      const card = await buildCard(host, entry);
      if (!stage.isConnected || stage.dataset.url !== key) return; // swiped again
      card.style.width = width;
      card.style.height = height;
      stage.insertBefore(card, layer.parentElement === stage ? layer : null);
      layer.card = card;
      host._fastLiveCard = card;
      if (host._fastRefit) host._fastRefit();
    } catch (err) {
      console.warn("nvr fast-live: could not switch camera", err);
    }
  };

  // ---- mute / unmute ---------------------------------------------------------------
  const toggleMute = (host, stage) => {
    host._muted = !host._muted;
    const stack = [stage];
    while (stack.length) {
      const node = stack.pop();
      if (node.tagName === "VIDEO") node.muted = host._muted;
      if (node.shadowRoot) stack.push(...node.shadowRoot.children);
      if (node.children) stack.push(...node.children);
    }
    paintMuteButton(host);
    flashLabel(stage, host._muted ? "Muted" : "Sound on");
  };
  const paintMuteButton = (host) => {
    try {
      const button = host.shadowRoot.querySelector("#mute");
      if (!button) return;
      button.innerHTML = symbol(host._muted ? "muted" : "sound", 22);
      button.title = host._muted ? "Unmute" : "Mute";
      button.setAttribute("aria-label", button.title);
    } catch (_) {}
  };
  // The card's speaker is an emoji with its own click handler. Swap in a
  // drawn icon that goes through the same mute path as a tap in full screen.
  const dressMute = (host) => {
    const old = host.shadowRoot.querySelector("#mute");
    if (!old) return;
    const button = document.createElement("button");
    button.id = "mute";
    button.className = "fl-icon";
    old.replaceWith(button);
    paintMuteButton(host);
    button.addEventListener("click", () => {
      const stage = host.shadowRoot.querySelector("#stage");
      if (stage) toggleMute(host, stage);
    });
  };

  // ---- tap + gesture layer ------------------------------------------------------
  const makeLayer = (host, stage, card, options) => {
    const layer = document.createElement("div");
    layer.card = card;
    // A replay layer: a tap in full screen is handed to the caller (pause /
    // play), there is no camera to swipe to, and the backdrop stays black.
    const replayTap = options && options.onTap;
    layer.plain = !!replayTap;
    layer.style.cssText =
      "position:absolute;inset:0;width:auto;height:auto;z-index:1;display:block;" +
      "background:transparent;cursor:pointer;touch-action:manipulation;" +
      "-webkit-tap-highlight-color:transparent;-webkit-user-select:none;user-select:none;";

    let scale = 1;
    let x = 0;
    let y = 0;
    const pointers = new Map();
    let pinchDistance = 0;
    let swipe = null; // {x, y, t} while a single finger is down and not zoomed
    const isFull = () => !!host._fastFull;

    const apply = () => {
      const target = layer.card;
      scale = clamp(scale, 1, MAX_ZOOM);
      const width = target.offsetWidth;
      const height = target.offsetHeight;
      x = clamp(x, width - width * scale, 0);
      y = clamp(y, height - height * scale, 0);
      target.style.transformOrigin = "0 0";
      target.style.transform = scale === 1 ? "" : `translate(${x}px, ${y}px) scale(${scale})`;
    };
    const zoomAt = (clientX, clientY, factor) => {
      const box = layer.getBoundingClientRect();
      const px = clientX - (box.left + layer.card.offsetLeft);
      const py = clientY - (box.top + layer.card.offsetTop);
      const next = clamp(scale * factor, 1, MAX_ZOOM);
      x = px - (px - x) * (next / scale);
      y = py - (py - y) * (next / scale);
      scale = next;
      apply();
    };
    layer.resetZoom = () => {
      scale = 1;
      x = 0;
      y = 0;
      pointers.clear();
      swipe = null;
      layer.card.style.transform = "";
    };
    layer.setFull = (full) => {
      layer.style.touchAction = full ? "none" : "manipulation";
      layer.style.cursor = full ? "grab" : "pointer";
      stage.classList.toggle("fl-full", !!full); // badges make room for the close button
    };
    layer.swap = replayTap
      ? () => {}
      : (direction) => swapCamera(host, stage, layer, direction);

    let downAt = null; // where the current single touch started
    let suppressClick = false; // the touch moved: it was a drag or swipe, not a tap
    layer.addEventListener("click", (event) => {
      event.stopPropagation();
      if (suppressClick) {
        // The end of a drag or swipe (a mouse fires a click after those).
        suppressClick = false;
        return;
      }
      if (!isFull()) {
        enterFull(host, stage, layer);
        return;
      }
      // In full screen a tap mutes / unmutes (live) or pauses / plays (replay).
      if (replayTap) replayTap();
      else toggleMute(host, stage);
    });
    layer.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (isFull()) layer.resetZoom();
    });
    layer.addEventListener("pointerdown", (event) => {
      suppressClick = false;
      if (!isFull()) return;
      try { layer.setPointerCapture(event.pointerId); } catch (_) {}
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      pinchDistance = 0;
      downAt = pointers.size === 1 ? { x: event.clientX, y: event.clientY } : null;
      swipe =
        pointers.size === 1 && scale === 1
          ? { x: event.clientX, y: event.clientY, t: Date.now() }
          : null;
    });
    layer.addEventListener("pointermove", (event) => {
      if (!isFull() || !pointers.has(event.pointerId)) return;
      const previous = pointers.get(event.pointerId);
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 1) {
        if (scale > 1) {
          x += event.clientX - previous.x;
          y += event.clientY - previous.y;
          apply();
        }
        return;
      }
      swipe = null;
      const [a, b] = [...pointers.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinchDistance > 0 && distance > 0) {
        zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, distance / pinchDistance);
      }
      pinchDistance = distance;
    });
    layer.addEventListener("pointerup", (event) => {
      const start = swipe;
      pointers.delete(event.pointerId);
      pinchDistance = 0;
      swipe = null;
      if (downAt) {
        suppressClick =
          Math.hypot(event.clientX - downAt.x, event.clientY - downAt.y) > 10;
        downAt = null;
      }
      if (!isFull() || !start || scale !== 1) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Date.now() - start.t > 900) return;
      if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) {
        // Sideways: next / previous camera.
        layer.swap(dx < 0 ? 1 : -1);
      } else if (Math.abs(dy) > 70 && Math.abs(dy) > 1.5 * Math.abs(dx)) {
        // Up or down: leave full screen.
        if (host._fastFull) host._fastFull.exit();
      }
    });
    layer.addEventListener("pointercancel", (event) => {
      pointers.delete(event.pointerId);
      pinchDistance = 0;
      swipe = null;
    });
    layer.addEventListener(
      "wheel",
      (event) => {
        if (!isFull()) return;
        event.preventDefault();
        zoomAt(event.clientX, event.clientY, event.deltaY < 0 ? 1.15 : 1 / 1.15);
      },
      { passive: false }
    );
    // Stop the page itself scrolling or zooming under a full-screen gesture.
    layer.addEventListener(
      "touchmove",
      (event) => {
        if (isFull()) event.preventDefault();
      },
      { passive: false }
    );
    return layer;
  };

  // ---- full screen ----------------------------------------------------------------
  const closeButton = () => {
    const button = document.createElement("button");
    button.textContent = "✕";
    button.setAttribute("aria-label", "Close full screen");
    button.style.cssText =
      "position:absolute;top:max(12px,env(safe-area-inset-top));" +
      "right:max(12px,env(safe-area-inset-right));width:44px;height:44px;" +
      "border-radius:22px;border:1px solid rgba(255,255,255,.3);" +
      "background:rgba(0,0,0,.55);color:#fff;font:20px/1 sans-serif;" +
      "z-index:3;cursor:pointer;display:block;padding:0;";
    return button;
  };

  const enterFull = (host, stage, layer) => {
    if (host._fastFull) return;
    const close = closeButton();
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      if (host._fastFull) host._fastFull.exit();
    });
    const onKey = (event) => {
      if (event.key === "ArrowRight") layer.swap(1);
      else if (event.key === "ArrowLeft") layer.swap(-1);
    };
    // Keep the picture fitted and centred, also when the screen is turned.
    let box = stage;
    const refit = () => fitFull(host, box, layer);
    const refitSoon = () => {
      refit();
      setTimeout(refit, 150);
    };
    // Each way into full screen arms these itself: when the first way is
    // refused, leave() has already taken them off again.
    const arm = () => {
      host._fastRefit = refit;
      document.addEventListener("keydown", onKey);
      window.addEventListener("resize", refitSoon);
      if (window.visualViewport) window.visualViewport.addEventListener("resize", refitSoon);
    };
    const leave = () => {
      host._fastFull = null;
      host._fastRefit = null;
      window.removeEventListener("resize", refitSoon);
      if (window.visualViewport) window.visualViewport.removeEventListener("resize", refitSoon);
      document.removeEventListener("keydown", onKey);
      layer.resetZoom();
      layer.setFull(false);
      unfitFull(layer);
      close.remove();
      setTimeout(() => fitStage(host), 60);
    };

    // Last resort: move the player into a body-level overlay (reconnects it).
    const overlayMode = () => {
      const overlay = document.createElement("div");
      overlay.style.cssText =
        "position:fixed;inset:0;z-index:100000;background:#000;display:flex;" +
        "align-items:center;justify-content:center;overflow:hidden;";
      layer.card.style.width = "100%";
      overlay.append(layer.card, layer, close);
      document.body.appendChild(overlay);
      box = overlay;
      arm();
      host._fastFull = {
        exit() {
          leave();
          layer.card.style.width = "";
          if (stage.isConnected) stage.append(layer.card, layer);
          overlay.remove();
        },
      };
      layer.setFull(true);
      refitSoon();
    };

    // iPhone path: lift the stage into the browser's top layer as a popover.
    // Nothing moves in the page, so the stream keeps playing with no reload.
    const popoverMode = () => {
      const savedStyle = stage.getAttribute("style") || "";
      stage.setAttribute("popover", "manual");
      stage.style.cssText =
        savedStyle +
        ";position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;" +
        "max-height:none;margin:0;border:0;padding:0;overflow:hidden;" +
        "display:flex;align-items:center;justify-content:center;aspect-ratio:auto;";
      stage.style.background = "#000";
      layer.card.style.height = "auto";
      layer.card.style.width = "100%";
      stage.appendChild(close);
      stage.showPopover();
      arm();
      host._fastFull = {
        exit() {
          leave();
          try { stage.hidePopover(); } catch (_) {}
          stage.removeAttribute("popover");
          stage.setAttribute("style", savedStyle);
          stage.style.background = layer.plain
            ? "#000"
            : stillBackground(host, host._selected);
          layer.card.style.height = "";
          layer.card.style.width = "";
        },
      };
      layer.setFull(true);
      refitSoon();
    };
    const fallback = () => {
      if (typeof stage.showPopover === "function") {
        try {
          popoverMode();
          return;
        } catch (err) {
          stage.removeAttribute("popover");
          host._fastFull = null;
        }
      }
      overlayMode();
    };

    if (document.fullscreenEnabled && stage.requestFullscreen) {
      const onChange = () => {
        if (stage.matches(":fullscreen")) {
          refitSoon();
          return;
        }
        stage.removeEventListener("fullscreenchange", onChange);
        leave();
        stage.style.background = layer.plain
          ? "#000"
          : stillBackground(host, host._selected);
      };
      stage.addEventListener("fullscreenchange", onChange);
      stage.style.background = "#000";
      stage.appendChild(close);
      arm();
      host._fastFull = {
        exit() {
          if (document.fullscreenElement) document.exitFullscreen();
          else onChange();
        },
      };
      layer.setFull(true);
      stage.requestFullscreen().catch(() => {
        stage.removeEventListener("fullscreenchange", onChange);
        leave();
        fallback();
      });
    } else {
      fallback();
    }
  };

  // ---- live stage ---------------------------------------------------------------------
  const originalLive = proto._renderLive;
  proto._renderLive = async function (stage) {
    const entry = entryFor(this, this._selected);
    if (!entry || !customElements.get("advanced-camera-card")) {
      const result = await originalLive.call(this, stage);
      const dress = () => {
        try {
          if (!isWall(this) || !stage.isConnected || this._mode !== "live") return;
          if (stage.querySelector(":scope > .fl-status")) return;
          renderStatus(this, stage);
          renderPtz(this, stage);
          hook("ptz", this, stage);
        } catch (err) {
          console.warn("nvr fast-live: controls on the plain live view failed", err);
        }
      };
      dress();
      // The plain view can switch player a few seconds in (and empties the
      // stage to do it): dress it again when that happens.
      if (stage._flPlainObs) stage._flPlainObs.disconnect();
      stage._flPlainObs = new MutationObserver(() => {
        if (!stage.isConnected) return stage._flPlainObs.disconnect();
        dress();
      });
      stage._flPlainObs.observe(stage, { childList: true });
      return result;
    }
    const key = keyFor(this._selected, entry);
    if (stage.dataset.url === key) return;
    if (this._fastFull) this._fastFull.exit();
    stage.dataset.url = key;
    stage.innerHTML = "";
    stage.style.position = "relative";
    stage.style.overflow = "hidden";
    // Show the tile's still straight away, so there is a picture, not a spinner.
    stage.style.background = stillBackground(this, this._selected);

    try {
      const card = await buildCard(this, entry);
      // The user may have picked another camera or mode while this loaded.
      if (!stage.isConnected || stage.dataset.url !== key) return;
      stage.append(card, makeLayer(this, stage, card));
      this._fastLiveCard = card;
      renderButtons(this, stage, entry);
      renderStatus(this, stage);
      renderPtz(this, stage);
      hook("ptz", this, stage);
      wallLive(this);
      fitStage(this);
    } catch (err) {
      console.warn("nvr fast-live: falling back to the card's own live view", err);
      stage.dataset.url = "";
      return originalLive.call(this, stage);
    }
  };

  // ---- channel names + speaker icon ------------------------------------------------------
  // ---- person / vehicle markers on the History timeline -------------------------
  // The patched integration exposes the NVR's own detections (the ones the
  // Hik-Connect app shows) at .../detections. Green dot = person, amber dot =
  // vehicle. Purely additive: any failure just means no dots.
  const ICON_PATHS = {
    person:
      "M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z",
    vehicle:
      "M5,11L6.5,6.5H17.5L19,11M17.5,16A1.5,1.5 0 0,1 16,14.5A1.5,1.5 0 0,1 17.5,13A1.5,1.5 0 0,1 19,14.5A1.5,1.5 0 0,1 17.5,16M6.5,16A1.5,1.5 0 0,1 5,14.5A1.5,1.5 0 0,1 6.5,13A1.5,1.5 0 0,1 8,14.5A1.5,1.5 0 0,1 6.5,16M18.92,6C18.72,5.42 18.16,5 17.5,5H6.5C5.84,5 5.28,5.42 5.08,6L3,12V20A1,1 0 0,0 4,21H5A1,1 0 0,0 6,20V19H18V20A1,1 0 0,0 19,21H20A1,1 0 0,0 21,20V12L18.92,6Z",
  };
  const KIND_COLOR = { person: "var(--fl-person,#6fcf7f)", vehicle: "var(--fl-vehicle,#ffb84d)" };
  const iconSvg = (kind, size, onAccent) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;flex:none;` +
    `fill:${onAccent ? "currentColor" : KIND_COLOR[kind]}">` +
    `<path d="${ICON_PATHS[kind]}"/></svg>`;
  const filterOf = (host) => host._detectionFilter || "all";
  const CHIP_WORD = { person: "People", vehicle: "Vehicles" };
  const CHIP_WORD_ONE = { person: "Person", vehicle: "Vehicle" };
  const chipLabel = (host, id) => {
    if (id === "all") return "All";
    const count = (host._detections || []).filter((d) => d.kind === id).length;
    return (
      iconSvg(id, 18, false) +
      `<span class="fl-wide">${CHIP_WORD[id]}</span><span class="fl-n">${count}</span>`
    );
  };
  const updateChips = (host) => {
    try {
      host.shadowRoot
        .querySelectorAll(".fast-filter button[data-filter]")
        .forEach((button) => {
          button.setAttribute("aria-pressed", String(button.dataset.filter === filterOf(host)));
          button.innerHTML = chipLabel(host, button.dataset.filter);
        });
    } catch (_) {}
  };

  // ---- detection snapshots: a strip of the NVR's own stills, tap to jump ----------
  const clock = (ms) => {
    const d = new Date(ms);
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  // Signed thumbnail addresses are kept for a day (in this browser), so the
  // same photo keeps the same address and comes straight from the browser's
  // own cache after leaving the app and coming back.
  const SIGN_STORE = "nvrFastLiveThumbs";
  const SIGN_LIFE = 86400;
  let signed = null;
  let signedSave = null;
  const signedMap = () => {
    if (signed) return signed;
    signed = new Map();
    try {
      const now = Date.now();
      const saved = JSON.parse(localStorage.getItem(SIGN_STORE) || "[]");
      for (const [key, path, until] of saved) if (until > now) signed.set(key, { path, until });
    } catch (_) {
      /* no storage: the map still works for this visit */
    }
    return signed;
  };
  const forgetSigned = () => {
    signedMap().clear();
    try {
      localStorage.removeItem(SIGN_STORE);
    } catch (_) {
      /* optional */
    }
  };
  const signPicture = async (host, channel, picture) => {
    const map = signedMap();
    const key = `${channel}/${picture}`;
    const known = map.get(key);
    if (known && known.until > Date.now()) return known.path;
    const { path } = await host._hass.callWS({
      type: "auth/sign_path",
      // The small cached copy, not the recorder's full-size still.
      path: `/api/hikvision_nvr/${host._device.id}/${channel}/detection_thumb/${picture}.jpg`,
      expires: SIGN_LIFE,
    });
    map.set(key, { path, until: Date.now() + (SIGN_LIFE - 3600) * 1000 });
    clearTimeout(signedSave);
    signedSave = setTimeout(() => {
      try {
        const rows = [...map].map(([k, v]) => [k, v.path, v.until]).slice(-400);
        localStorage.setItem(SIGN_STORE, JSON.stringify(rows));
      } catch (_) {
        /* optional */
      }
    }, 1500);
    return path;
  };
  const paintStrip = (host) => {
    try {
      const strip = host.shadowRoot.querySelector(".fast-strip");
      if (!strip) return;
      if (host._stripObserver) host._stripObserver.disconnect();
      const filter = filterOf(host);
      const channel = host._selected;
      // One still per visit: a detection of the same kind that follows the
      // previous one within the gap is folded into it (the tile keeps a count).
      const gap = (Number(host._config.snapshot_gap) || 60) * 1000;
      const lastKept = {};
      const items = [];
      for (const d of host._detections || []) {
        if (!d.picture || (filter !== "all" && d.kind !== filter)) continue;
        const previous = lastKept[d.kind];
        if (previous && d.time - previous.last < gap) {
          previous.last = d.time;
          previous.item.more += 1;
          continue;
        }
        const item = { ...d, more: 0 };
        lastKept[d.kind] = { last: d.time, item };
        items.push(item);
      }
      if (items.length > 150) items.splice(0, items.length - 150);
      items.reverse(); // newest on the left
      strip.innerHTML = "";
      strip.style.display = items.length ? "flex" : "none";
      // With a mouse: click, hold and drag sideways to scroll the strip.
      // (Touch already scrolls it natively.)
      if (!strip.dataset.drag) {
        strip.dataset.drag = "1";
        strip.style.cursor = "grab";
        strip.style.userSelect = "none";
        let down = null;
        const move = (event) => {
          if (!down) return;
          const dx = event.clientX - down.x;
          if (Math.abs(dx) > 5) {
            down.moved = true;
            strip.dataset.dragged = "1";
          }
          if (down.moved) strip.scrollLeft = down.left - dx;
        };
        const up = () => {
          down = null;
          strip.style.cursor = "grab";
          document.removeEventListener("pointermove", move);
          document.removeEventListener("pointerup", up);
        };
        strip.addEventListener("pointerdown", (event) => {
          if (event.pointerType !== "mouse" || event.button !== 0) return;
          strip.dataset.dragged = "";
          down = { x: event.clientX, left: strip.scrollLeft, moved: false };
          strip.style.cursor = "grabbing";
          document.addEventListener("pointermove", move);
          document.addEventListener("pointerup", up);
        });
        // The click that ends a drag must not also play a snapshot.
        strip.addEventListener(
          "click",
          (event) => {
            if (!strip.dataset.dragged) return;
            strip.dataset.dragged = "";
            event.stopPropagation();
            event.preventDefault();
          },
          true
        );
      }
      fitStage(host);
      if (!items.length) return;
      // Only fetch a still once its thumbnail is near the visible part, and
      // never more than three at a time: each one is a full-size photo pulled
      // off the recorder.
      const pending = [];
      let active = 0;
      const pump = () => {
        while (active < 6 && pending.length) {
          active += 1;
          pending
            .shift()()
            .catch(() => {})
            .then(() => {
              active -= 1;
              pump();
            });
        }
      };
      const loadVisible = () => {
        const view = strip.getBoundingClientRect();
        for (const button of strip.children) {
          if (button.dataset.loaded) continue;
          const box = button.getBoundingClientRect();
          if (box.right < view.left - 600 || box.left > view.right + 600) continue;
          button.dataset.loaded = "1";
          const img = button.querySelector("img");
          pending.push(() =>
            signPicture(host, channel, button.dataset.picture).then(
              (url) =>
                new Promise((done) => {
                  img.onload = done;
                  // A remembered address stops working when Home Assistant
                  // restarts, and each refusal is logged as a failed login.
                  // On the first refusal forget every remembered address, so
                  // the rest are asked for afresh, and try this one once more.
                  img.onerror = () => {
                    if (img.dataset.retried) return done();
                    img.dataset.retried = "1";
                    forgetSigned();
                    signPicture(host, channel, button.dataset.picture).then((fresh) => {
                      img.onerror = done;
                      img.src = fresh;
                    }, done);
                  };
                  img.src = url;
                })
            )
          );
        }
        pump();
      };
      let scrollTimer = null;
      strip.onscroll = () => {
        clearTimeout(scrollTimer);
        scrollTimer = setTimeout(loadVisible, 120);
      };
      host._stripObserver = { disconnect() { strip.onscroll = null; } };
      const observer = { observe() {} };
      const cursor = host._cursor ? host._cursor.getTime() : null;
      let current = null;
      for (const detection of items) {
        const button = document.createElement("button");
        button.dataset.picture = detection.picture;
        button.className = "fl-thumb";
        button.innerHTML =
          '<img alt="" draggable="false">' +
          `<span>${iconSvg(detection.kind, 14, false)}${clock(detection.time)}${
            detection.more ? ` +${detection.more}` : ""
          }</span>`;
        button.addEventListener("click", () =>
          host._playFrom(new Date(detection.time - 5000))
        );
        strip.appendChild(button);
        observer.observe(button);
        if (!current && cursor !== null && detection.time <= cursor + 6000) current = button;
      }
      if (current) {
        current.classList.add("current");
        strip.scrollLeft = Math.max(0, current.offsetLeft - strip.clientWidth / 2 + 64);
      } else {
        strip.scrollLeft = 0; // start at the most recent
      }
      loadVisible();
      setTimeout(loadVisible, 300);
    } catch (_) {
      /* the strip is optional */
    }
  };

  // ---- skip 10 s back / forward in a recording -----------------------------------
  const findVideo = (root) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.tagName === "VIDEO") return node;
      if (node.shadowRoot) stack.push(...node.shadowRoot.children);
      if (node.children) stack.push(...node.children);
    }
    return null;
  };
  const skip = (host, seconds) => {
    const stage = host.shadowRoot.querySelector("#stage");
    const video = stage && findVideo(stage);
    if (!video || !host._cursor) return;
    const target = video.currentTime + seconds;
    let reachable = false;
    try {
      const ranges = seconds < 0 ? video.seekable : video.buffered;
      for (let i = 0; i < ranges.length; i += 1) {
        if (target >= ranges.start(i) && target <= ranges.end(i)) reachable = true;
      }
    } catch (_) {}
    if (reachable) {
      video.currentTime = target;
      return;
    }
    // Outside what is loaded: ask the recorder for that moment instead.
    host._playFrom(new Date(host._cursor.getTime() + target * 1000));
  };

  // ---- action buttons on the live picture (gate, garage ...) ----------------------
  // Two taps, so a stray touch on the picture can never open anything.
  const renderButtons = (host, stage, entry) => {
    const old = stage.querySelector(".fast-buttons");
    if (old) old.remove();
    const list = (entry && entry.buttons) || [];
    if (!list.length) return;
    const box = document.createElement("div");
    box.className = "fast-buttons";
    for (const item of list) {
      const button = document.createElement("button");
      button.className = "fl-act";
      let timer = null;
      const idle = () => {
        button.dataset.armed = "";
        button.innerHTML =
          `<ha-icon icon="${item.icon || "mdi:gesture-tap"}" style="--mdc-icon-size:18px"></ha-icon>` +
          `<span>${item.label}</span>`;
      };
      idle();
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        clearTimeout(timer);
        if (!button.dataset.armed) {
          button.dataset.armed = "1";
          button.innerHTML = `<span>Tap again: ${item.label}</span>`;
          timer = setTimeout(idle, 3000);
          return;
        }
        idle();
        const domain = item.entity.split(".")[0];
        host._hass
          .callService(domain, domain === "button" ? "press" : "turn_on", {
            entity_id: item.entity,
          })
          .catch((err) => console.warn("nvr fast-live: button failed", err));
        flashLabel(stage, item.label);
      });
      for (const type of ["pointerdown", "pointerup", "dblclick"]) {
        button.addEventListener(type, (event) => event.stopPropagation());
      }
      box.appendChild(button);
    }
    stage.appendChild(box);
  };

  // ---- live activity on the tiles ----------------------------------------------
  // A tile is outlined in green while any of its camera's sensors is on, and
  // carries today's person / vehicle visit counts (detections within a minute
  // of each other count as one visit).
  const activitySignature = (host) => {
    const parts = [];
    for (const channel of host._channels || []) {
      const entry = entryFor(host, channel.id);
      for (const id of (entry && entry.motion) || []) {
        const state = host._hass.states[id];
        parts.push(state && state.state === "on" ? "1" : "0");
      }
    }
    return parts.join("");
  };
  const applyActivity = (host) => {
    try {
      const root = host.shadowRoot;
      for (const channel of host._channels || []) {
        const entry = entryFor(host, channel.id);
        if (!entry) continue;
        const tile = root.querySelector(`.tile[data-channel="${channel.id}"]`);
        if (!tile) continue;
        const active = (entry.motion || []).some((id) => {
          const state = host._hass.states[id];
          return state && state.state === "on";
        });
        tile.classList.toggle("fl-motion", active);
        const counts = host._counts && host._counts[channel.id];
        const text = counts
          ? (counts.person ? `${iconSvg("person", 14, false)}${counts.person}` : "") +
            (counts.vehicle ? `${iconSvg("vehicle", 14, false)}${counts.vehicle}` : "")
          : "";
        let badge = tile.querySelector(".fast-badge");
        if (!text) {
          if (badge) badge.remove();
          continue;
        }
        if (!badge) {
          badge = document.createElement("div");
          badge.className = "fast-badge";
          if (getComputedStyle(tile).position === "static") tile.style.position = "relative";
          tile.appendChild(badge);
        }
        if (badge.dataset.text !== text) {
          badge.dataset.text = text;
          badge.innerHTML = text;
        }
      }
    } catch (_) {
      /* cosmetic */
    }
  };
  const loadCounts = async (host) => {
    const now = Date.now();
    const every = isWall(host) ? 120000 : 600000;
    if (host._countsBusy || (host._countsAt && now - host._countsAt < every)) return;
    if (!host._device || !(host._channels || []).length || !host._api) return;
    host._countsBusy = true;
    host._countsAt = now;
    hook("counts", host);
    host._counts = host._counts || {};
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    try {
      for (const channel of host._channels) {
        const entry = entryFor(host, channel.id);
        if (entry && entry.thumb) continue; // gate / door stations are not recorded
        try {
          const data = await host._api(
            `${host._device.id}/${channel.id}/detections` +
              `?start=${encodeURIComponent(start.toISOString())}` +
              `&end=${encodeURIComponent(new Date().toISOString())}`
          );
          const counts = { person: 0, vehicle: 0 };
          const last = { person: 0, vehicle: 0 };
          for (const d of data.detections || []) {
            if (counts[d.kind] === undefined) continue;
            const time = new Date(d.time).getTime();
            if (time - last[d.kind] > 60000) counts[d.kind] += 1;
            last[d.kind] = time;
          }
          host._counts[channel.id] = counts;
          host._detLists = host._detLists || {};
          host._detLists[channel.id] = (data.detections || []).map((d) => ({
            time: new Date(d.time).getTime(),
            kind: d.kind,
            picture: d.picture || null,
          }));
          applyActivity(host);
          wallData(host);
        } catch (_) {
          /* one camera failing must not stop the rest */
        }
      }
    } finally {
      host._countsBusy = false;
    }
  };

  if (proto._loadTimeline && proto._timelineInner) {
    const originalLoadTimeline = proto._loadTimeline;
    // The last list seen for each camera and day, kept for as long as the page
    // lives, so coming back to a camera shows its markers and photos at once.
    const detectionMemory = new Map();
    proto._loadTimeline = function () {
      this._detections = [];
      const token = (this._detectionToken = (this._detectionToken || 0) + 1);
      this._flEmpty = false;
      this._flPlayAt = null;
      const done = originalLoadTimeline.call(this);
      // Say so when the day has nothing recorded (only once it has loaded).
      Promise.resolve(done)
        .then(() => {
          if (token !== this._detectionToken) return;
          this._flEmpty = !(this._blocks || []).length && !this._error;
          const note = this.shadowRoot.querySelector(".fl-sub");
          if (note && this._flEmpty) note.textContent = "No recordings this day";
        })
        .catch(() => {});
      // Never make the card wait for the detections: its own timeline, the
      // camera tiles and the buttons must work straight away.
      (async () => {
        try {
          const start = this._dayStart;
          const end = this._dayEnd;
          const key = `${this._device.id}/${this._selected}/${start.getTime()}`;
          const signature = (list) =>
            `${list.length}/${list.length ? list[list.length - 1].time : 0}`;
          const apply = (list) => {
            if (token !== this._detectionToken) return;
            this._detections = list;
            this._paintTimeline();
            updateChips(this);
            paintStrip(this);
            paintSide(this);
          };
          const request = this._api(
            `${this._device.id}/${this._selected}/detections` +
              `?start=${encodeURIComponent(start.toISOString())}` +
              `&end=${encodeURIComponent(end.toISOString())}`
          );
          request.catch(() => {});
          await Promise.resolve(done).catch(() => {});
          const remembered = detectionMemory.get(key);
          if (remembered) apply(remembered);
          const data = await request;
          const list = (data.detections || []).map((d) => ({
            time: new Date(d.time).getTime(),
            kind: d.kind,
            picture: d.picture || null,
          }));
          detectionMemory.set(key, list);
          if (detectionMemory.size > 40) {
            detectionMemory.delete(detectionMemory.keys().next().value);
          }
          if (!remembered || signature(remembered) !== signature(list)) apply(list);
        } catch (err) {
          console.warn("nvr fast-live: no person/vehicle markers", err);
        }
      })();
      return done;
    };

    // The timeline is drawn here in full: a ruler of the day. Faint night / day
    // light behind it, hour marks, the recorded stretches as a glowing band
    // along the bottom, each person and vehicle as a pin standing on that band
    // (people tall, vehicles short), and a white playhead carrying the time.
    const originalTimelineInner = proto._timelineInner;
    proto._timelineInner = function () {
      try {
        if (!this._dayStart || !this._dayEnd) return originalTimelineInner.call(this);
        return rulerHtml({
          host: this,
          dayStart: this._dayStart.getTime(),
          dayEnd: this._dayEnd.getTime(),
          view: this._view,
          blocks: this._blocks,
          detections: this._detections,
          filter: filterOf(this),
          at: this._flPlayAt || this._cursor,
        });
      } catch (_) {
        return originalTimelineInner.call(this);
      }
    };
    // s = { host, dayStart, dayEnd, view, blocks, detections, filter, at, label, live }
    rulerHtml = (s) => {
      {
        const host = s.host;
        const dayStart = s.dayStart;
        const daySpan = s.dayEnd - dayStart;
        const { from, to } = s.view;
        const width = to - from;
        const pos = (fraction) => ((fraction - from) / width) * 100;
        const two = (n) => String(n).padStart(2, "0");
        const parts = [
          `<div class="fl-sky" style="background:${skyGradient(host, pos)}"></div>`,
          '<div class="fl-track"></div>',
        ];

        // Hour marks: how fine they are follows the zoom.
        const visible = width * 24;
        const roomy = window.innerWidth >= 700;
        const [label, minor] =
          visible > 12 ? [roomy ? 3 : 6, 1]
          : visible > 6 ? [2, 0.5]
          : visible > 2 ? [1, 0.25]
          : visible > 0.75 ? [0.25, 1 / 12]
          : visible > 0.15 ? [1 / 12, 1 / 60]
          : [1 / 60, 1 / 360];
        const perLabel = Math.round(label / minor);
        const first = Math.ceil((from * 24) / minor - 1e-6);
        const last = Math.floor((to * 24) / minor + 1e-6);
        for (let i = first; i <= last; i += 1) {
          const left = pos((i * minor) / 24);
          const major = i % perLabel === 0;
          parts.push(
            `<div class="fl-tick${major ? " major" : ""}" style="left:${left.toFixed(3)}%"></div>`
          );
          if (!major) continue;
          const seconds = Math.round(i * minor * 3600);
          const edge = left < 1 ? " first" : left > 99 ? " last" : "";
          parts.push(
            `<span class="fl-hour${edge}" style="left:${left.toFixed(3)}%">` +
              `${two(Math.floor(seconds / 3600))}:${two(Math.floor((seconds % 3600) / 60))}</span>`
          );
        }

        // Recorded stretches.
        for (const block of s.blocks || []) {
          const left = Math.max(pos((block.start.getTime() - dayStart) / daySpan), 0);
          const right = Math.min(pos((block.end.getTime() - dayStart) / daySpan), 100);
          if (right <= 0 || left >= 100) continue;
          parts.push(
            `<div class="fl-rec" style="left:${left.toFixed(3)}%;width:${(right - left).toFixed(3)}%"></div>`
          );
        }

        // People and vehicles. Pins that would land on top of each other are
        // drawn once; zoomed in close, each pin carries its symbol.
        const filter = s.filter || "all";
        const symbols = visible <= 3;
        // About ten pixels apart at least, whatever the screen's width.
        const apart = 1000 / Math.max(320, window.innerWidth - 28);
        const lastLeft = { person: -99, vehicle: -99 };
        for (const detection of s.detections || []) {
          const kind = detection.kind;
          if (lastLeft[kind] === undefined || (filter !== "all" && kind !== filter)) continue;
          const left = pos((detection.time - dayStart) / daySpan);
          if (left < 0 || left > 100 || left - lastLeft[kind] < apart) continue;
          lastLeft[kind] = left;
          parts.push(
            `<div class="fl-pin ${kind}${symbols ? " icon" : ""}" style="left:${left.toFixed(3)}%">` +
              `${symbols ? iconSvg(kind, 16, false) : ""}</div>`
          );
        }

        // The playhead, with the time written on it.
        const at = s.at;
        if (at) {
          const left = pos((at.getTime() - dayStart) / daySpan);
          if (left >= 0 && left <= 100) {
            const shift = left < 8 ? "0" : left > 92 ? "-100%" : "-50%";
            parts.push(
              `<div class="fl-needle" style="left:${left.toFixed(3)}%"></div>` +
                `<div class="fl-now${s.live ? " fl-now-live" : ""}" style="left:${left.toFixed(3)}%;` +
                `transform:translateX(${shift})">${s.label || clock(at.getTime())}</div>`
            );
          }
        }
        return parts.join("");
      }
    };
  }

  // Filter chips under the timeline: All / People / Vehicles. The filter hides
  // the other markers, and makes Prev / Next jump between detections of that
  // kind (starting a few seconds before each) instead of between recordings.
  if (proto._playbackControls && proto._wirePlaybackControls) {
    // The whole History control area is drawn here as a player deck. The ids
    // are the card's own, so its wiring (date, prev / next, clip length, pan,
    // whole day, download) carries on working.
    //   deck:     < Today >        |<  -10   12:03:00   +10  >|        length, save
    //   ruler:    the day, with recordings, people, vehicles and the playhead
    //   filter:   All / People / Vehicles                         (zoom controls)
    //   strip:    snapshots
    const originalControls = proto._playbackControls;
    proto._playbackControls = function () {
      try {
        const zoomed = this._view.to - this._view.from < 0.999;
        const off = zoomed ? "" : "disabled";
        const pad = (n) => String(n).padStart(2, "0");
        const now = new Date();
        const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
        const [year, month, date] = String(this._date).split("-").map(Number);
        const day = new Date(year, month - 1, date);
        const daysAgo = Math.round(
          (new Date(now.getFullYear(), now.getMonth(), now.getDate()) - day) / 86400000
        );
        const dayName =
          daysAgo === 0 ? "Today"
          : daysAgo === 1 ? "Yesterday"
          : day.toLocaleDateString(undefined, { weekday: "long" });
        const dayDate = day.toLocaleDateString(undefined, { day: "numeric", month: "short" });

        const at = this._flPlayAt || this._cursor;
        let sub = "Pick a moment below";
        if (this._flEmpty) sub = "No recordings this day";
        else if (this._cursor) {
          const start = this._cursor.getTime();
          const near = (this._detections || []).find((d) => Math.abs(d.time - 5000 - start) < 6000);
          sub = near ? CHIP_WORD_ONE[near.kind] : "Recording";
        }

        const chips = ["all", "person", "vehicle"]
          .map(
            (id) =>
              `<button data-filter="${id}" aria-pressed="${id === filterOf(this)}"` +
              `${CHIP_WORD[id] ? ` title="${CHIP_WORD[id]}"` : ""}>${chipLabel(this, id)}</button>`
          )
          .join("");
        const lengths = CLIP_LENGTHS.map(
          ([seconds, label]) =>
            `<option value="${seconds}"${seconds === this._clipSeconds ? " selected" : ""}>` +
            `Play ${label}</option>`
        ).join("");
        const icon = (id, label, path, size, extra) =>
          `<button class="fl-icon" ${id} title="${label}" aria-label="${label}" ${extra || ""}>` +
          `${glyph(path, size)}</button>`;
        return (
          '<div class="fl-deck">' +
          '<div class="fl-day">' +
          icon('data-day="-1"', "Previous day", CHEVRON.left, 24) +
          `<label class="fl-daylabel"><span class="fl-dayname">${dayName}</span>` +
          `<span class="fl-daydate">${dayDate}</span>` +
          `<input type="date" id="date" aria-label="Day" value="${this._date}" max="${today}"></label>` +
          icon('data-day="1"', "Next day", CHEVRON.right, 24, daysAgo <= 0 ? "disabled" : "") +
          "</div>" +
          '<div class="fl-transport">' +
          icon('id="prev"', "Previous event", CHEVRON.prevEvent, 26) +
          icon('data-skip="-10"', "Back 10 seconds", CHEVRON.back10, 24) +
          `<div class="fl-clock"><span class="fl-time">${at ? clock(at.getTime()) : "--:--:--"}</span>` +
          `<span class="fl-sub">${sub}</span></div>` +
          icon('data-skip="10"', "Forward 10 seconds", CHEVRON.forward10, 24) +
          icon('id="next"', "Next event", CHEVRON.nextEvent, 26) +
          "</div>" +
          '<div class="fl-tools">' +
          `<select class="fl-quiet" id="len" title="How much video to play and save" aria-label="Clip length">${lengths}</select>` +
          icon('id="download"', "Save clip", CHEVRON.save, 22, this._downloadUrl ? "" : "disabled") +
          "</div>" +
          "</div>" +
          `<div class="fl-tl"><div class="timeline" id="timeline">${this._timelineInner()}</div>` +
          '<div class="fl-ghost"><span></span></div></div>' +
          `<div class="fast-filter"><div class="fl-seg">${chips}</div>` +
          '<span class="fl-grow"></span>' +
          '<span class="fl-zoom">' +
          icon('id="panleft"', "Move the view earlier", CHEVRON.left, 20, off) +
          icon('id="panright"', "Move the view later", CHEVRON.right, 20, off) +
          `<button class="fl-btn" id="zoomout" ${off}>Whole day</button>` +
          "</span>" +
          "</div>" +
          '<div class="fast-strip" style="display:none"></div>'
        );
      } catch (_) {
        return originalControls.call(this);
      }
    };

    const originalWire = proto._wirePlaybackControls;
    proto._wirePlaybackControls = function (card) {
      originalWire.call(this, card);
      try {
        card.querySelectorAll(".fast-filter button[data-filter]").forEach((button) =>
          button.addEventListener("click", () => {
            this._detectionFilter = button.dataset.filter;
            updateChips(this);
            this._paintTimeline();
            paintStrip(this);
          })
        );
        card.querySelectorAll("button[data-skip]").forEach((button) =>
          button.addEventListener("click", () => skip(this, Number(button.dataset.skip)))
        );
        paintStrip(this);
        // Day stepper: the arrows move a day; the label opens the calendar.
        const dateInput = card.querySelector("#date");
        if (dateInput) {
          card.querySelectorAll("button[data-day]").forEach((button) =>
            button.addEventListener("click", () => {
              const [year, month, date] = String(this._date).split("-").map(Number);
              const next = new Date(year, month - 1, date + Number(button.dataset.day));
              if (next.getTime() > Date.now()) return;
              const two = (n) => String(n).padStart(2, "0");
              dateInput.value = `${next.getFullYear()}-${two(next.getMonth() + 1)}-${two(next.getDate())}`;
              dateInput.dispatchEvent(new Event("change"));
            })
          );
          dateInput.addEventListener("click", () => {
            try {
              dateInput.showPicker();
            } catch (_) {
              /* the browser opens it its own way */
            }
          });
        }
        // With a mouse: a faint line under the pointer says what time it is on.
        const ruler = card.querySelector("#timeline");
        const ghost = card.querySelector(".fl-ghost");
        if (ruler && ghost) {
          ruler.addEventListener("pointermove", (event) => {
            if (event.pointerType !== "mouse" || !this._dayStart) return;
            const box = ruler.getBoundingClientRect();
            const ratio = clamp((event.clientX - box.left) / box.width, 0, 1);
            const fraction = this._view.from + ratio * (this._view.to - this._view.from);
            ghost.style.display = "block";
            ghost.style.left = `${ratio * box.width}px`;
            ghost.firstChild.textContent = clock(
              this._dayStart.getTime() + fraction * (this._dayEnd.getTime() - this._dayStart.getTime())
            );
            ghost.firstChild.style.left = ratio > 0.9 ? "auto" : "7px";
            ghost.firstChild.style.right = ratio > 0.9 ? "7px" : "auto";
          });
          ruler.addEventListener("pointerleave", () => {
            ghost.style.display = "none";
          });
        }
        const jump = (direction) => (event) => {
          const filter = filterOf(this);
          if (filter === "all") return; // the card's own Prev / Next
          event.stopImmediatePropagation();
          event.preventDefault();
          const times = (this._detections || [])
            .filter((d) => d.kind === filter)
            .map((d) => d.time)
            .sort((a, b) => a - b);
          if (!times.length) return;
          const now = this._cursor
            ? this._cursor.getTime()
            : direction > 0
              ? -Infinity
              : Infinity;
          // Playback starts 5 s before a detection, hence the margins.
          const target =
            direction > 0
              ? times.find((t) => t > now + 6000)
              : [...times].reverse().find((t) => t < now + 4000);
          if (target !== undefined) this._playFrom(new Date(target - 5000));
        };
        const next = card.querySelector("#next");
        const prev = card.querySelector("#prev");
        if (next) next.addEventListener("click", jump(1), true);
        if (prev) prev.addEventListener("click", jump(-1), true);
      } catch (_) {
        /* the filter is optional */
      }
    };
  }

  // Recordings on Apple devices. The card plays history as a live-remuxed MP4,
  // which iPhones refuse (H.265 tagged the non-Apple way, and no byte ranges).
  // Where the browser plays HLS natively (Safari / iOS), ask the integration
  // for its HLS playback URL instead. Any failure falls back to the MP4 path.
  const nativeHls = (() => {
    try {
      return !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
    } catch (_) {
      return false;
    }
  })();
  // ---- replay player: the same touch controls as live ---------------------------
  // No browser control bar. Tap = full screen; in full screen tap = pause /
  // play, pinch = free zoom, swipe up or down = leave. A speaker button sits
  // in the corner.
  const SYMBOLS = {
    play: "M8,5.14V19.14L19,12.14L8,5.14Z",
    pause: "M14,19H18V5H14M6,19H10V5H6V19Z",
    sound:
      "M14,3.23V5.29C16.89,6.15 19,8.83 19,12C19,15.17 16.89,17.84 14,18.7V20.77C18,19.86 21,16.28 21,12C21,7.72 18,4.14 14,3.23M16.5,12C16.5,10.23 15.5,8.71 14,7.97V16C15.5,15.29 16.5,13.76 16.5,12M3,9V15H7L12,20V4L7,9H3Z",
    muted:
      "M12,4L9.91,6.09L12,8.18M4.27,3L3,4.27L7.73,9H3V15H7L12,20V13.27L16.25,17.53C15.58,18.04 14.83,18.46 14,18.7V20.77C15.38,20.45 16.63,19.82 17.68,18.96L19.73,21L21,19.73L12,10.73M19,12C19,12.94 18.8,13.82 18.46,14.64L19.97,16.15C20.62,14.91 21,13.5 21,12C21,7.72 18,4.14 14,3.23V5.29C16.89,6.15 19,8.83 19,12M16.5,12C16.5,10.23 15.5,8.71 14,7.97V10.18L16.45,12.63C16.5,12.43 16.5,12.21 16.5,12Z",
  };
  const symbol = (name, size) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block">` +
    `<path fill="currentColor" d="${SYMBOLS[name]}"/></svg>`;
  const dressReplay = (host, stage) => {
    const video = stage.querySelector("video");
    if (!video || video.__fastDressed) return;
    video.__fastDressed = true;
    video.controls = false;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.disablePictureInPicture = true;
    stage.style.position = "relative";
    stage.style.overflow = "hidden";
    stage.style.background = "#000";
    stage.querySelectorAll(".fast-replay").forEach((node) => node.remove());

    // Big symbol in the middle: pause stays while paused, play flashes.
    const state = document.createElement("div");
    state.className = "fast-replay";
    state.style.cssText =
      "position:absolute;left:50%;top:50%;width:76px;height:76px;margin:-38px 0 0 -38px;" +
      "border-radius:38px;background:rgba(0,0,0,.55);color:#fff;display:none;align-items:center;" +
      "justify-content:center;z-index:2;pointer-events:none;transition:opacity .35s;";
    let stateTimer = null;
    const showState = (name, stay) => {
      clearTimeout(stateTimer);
      state.innerHTML = symbol(name, 44);
      state.style.display = "flex";
      state.style.opacity = "1";
      if (stay) return;
      stateTimer = setTimeout(() => {
        state.style.opacity = "0";
        stateTimer = setTimeout(() => {
          state.style.display = "none";
        }, 360);
      }, 600);
    };

    const mute = document.createElement("button");
    mute.className = "fast-replay";
    mute.style.cssText =
      "position:absolute;right:max(12px,env(safe-area-inset-right));" +
      "bottom:max(12px,env(safe-area-inset-bottom));width:44px;height:44px;" +
      "border-radius:22px;border:1px solid rgba(255,255,255,.3);" +
      "background:rgba(0,0,0,.55);color:#fff;z-index:3;cursor:pointer;display:flex;" +
      "align-items:center;justify-content:center;padding:0;";
    const paintMute = () => {
      mute.innerHTML = symbol(video.muted ? "muted" : "sound", 24);
      mute.title = video.muted ? "Unmute" : "Mute";
      mute.setAttribute("aria-label", mute.title);
    };
    mute.addEventListener("click", (event) => {
      event.stopPropagation();
      video.muted = !video.muted;
      host._muted = video.muted;
      paintMute();
    });
    video.addEventListener("volumechange", paintMute);
    // Carry the playhead and the clock along with the recording.
    let lastTick = 0;
    video.addEventListener("timeupdate", () => {
      if (!host._cursor || !video.isConnected) return;
      const now = Date.now();
      if (now - lastTick < 500) return;
      lastTick = now;
      host._flPlayAt = new Date(host._cursor.getTime() + video.currentTime * 1000);
      movePlayhead(host);
    });

    const layer = makeLayer(host, stage, video, {
      onTap: () => {
        if (video.paused && !holding) {
          userPaused = false;
          video.play().catch(() => {});
          showState("play", false);
        } else {
          userPaused = true;
          holding = false;
          video.pause();
          showState("pause", true);
        }
      },
    });
    stage.append(layer, state, mute);

    // A recording sent as one long MP4 (every browser but Apple's) arrives at
    // the speed it was filmed, one chunk per second or so. Played the instant
    // it arrives, the picture runs dry between chunks and stutters. So hold
    // the picture until a few seconds are in hand, then play; and if it ever
    // runs dry again, do the same. (Apple's stream does its own buffering.)
    let userPaused = false;
    let holding = false;
    const CUSHION = 3;
    const inHand = () => {
      try {
        const ranges = video.buffered;
        return ranges.length ? ranges.end(ranges.length - 1) - video.currentTime : 0;
      } catch (_) {
        return 0;
      }
    };
    const hold = () => {
      if (holding || userPaused || video.ended || inHand() >= CUSHION) return;
      holding = true;
      video.pause();
      const started = Date.now();
      const timer = setInterval(() => {
        if (!video.isConnected || !holding) {
          clearInterval(timer);
          holding = false;
        } else if (inHand() >= CUSHION || Date.now() - started > 12000) {
          // (Twelve seconds without a cushion: play what there is.)
          clearInterval(timer);
          holding = false;
          video.play().catch(() => {});
        }
      }, 200);
    };
    if (!/m3u8/i.test(video.currentSrc || video.src || "")) {
      video.addEventListener("playing", hold, { once: true });
      video.addEventListener("waiting", hold);
    }

    // Sound follows the speaker setting. If the browser refuses to start with
    // sound (phones often do), carry on muted; the speaker button turns it on.
    video.muted = !!host._muted;
    paintMute();
    const attempt = video.play();
    if (attempt && attempt.catch) {
      attempt.catch(() => {
        video.muted = true;
        paintMute();
        video.play().catch(() => {});
      });
    }
  };

  const originalPlayback = proto._renderPlayback;
  proto._renderPlayback = async function (stage) {
    const url = this._playbackUrl;
    // A different recording rebuilds the picture, so leave full screen first.
    if (this._fastFull && stage.dataset.url !== url) this._fastFull.exit();
    // ... and the recording that was in it is stopped, not just removed.
    if (stage.dataset.url !== url) releaseReplays(this);
    const plain = async () => {
      const result = await originalPlayback.call(this, stage);
      try {
        // Nothing picked yet: the camera's latest still, dimmed, behind the
        // hint, instead of an empty black box.
        if (!url && stage.isConnected) stage.style.background = stillBackground(this, this._selected);
        dressReplay(this, stage);
      } catch (err) {
        console.warn("nvr fast-live: replay controls unavailable", err);
      }
      return result;
    };
    const match = nativeHls && url && /\/clip\/(\d+)\/(\d+)\.mp4$/.exec(url);
    if (!match) return plain();
    if (stage.dataset.url === url) return;
    stage.dataset.url = url;
    stage.innerHTML = '<div class="overlay">Loading recording…</div>';
    try {
      const from = new Date(Number(match[1]) * 1000).toISOString();
      const to = new Date(Number(match[2]) * 1000).toISOString();
      // `client` names this page, so the recorder integration can end the
      // clip this page was on before, instead of leaving it running unseen.
      this._hlsSeq = (this._hlsSeq || 0) + 1;
      this._hlsLive = true;
      const data = await this._api(
        `${this._device.id}/${this._selected}/playback` +
          `?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}&hls=1&client=${PAGE_ID}`
      );
      if (!stage.isConnected || stage.dataset.url !== url) return;
      if (!data.hls_url) throw new Error("no HLS URL returned");
      stage.innerHTML = "";
      const video = document.createElement("video");
      video.src = this._absolute(data.hls_url);
      video.autoplay = true;
      video.muted = true;
      video.controls = false;
      video.playsInline = true;
      stage.appendChild(video);
      dressReplay(this, stage);
    } catch (err) {
      console.warn("nvr fast-live: HLS playback failed, using the MP4 path", err);
      stage.dataset.url = "";
      return plain();
    }
  };

  // One card for every screen: `columns_narrow` is the tiles-per-row on a
  // narrow screen (a phone held upright), `columns` everywhere else. Turning
  // the phone only re-flows the tiles; the card, its mode and what is playing
  // all stay as they were.
  const applyColumns = (host, repaint) => {
    const config = host._config;
    if (!config || !Number(config.columns_narrow)) return;
    if (config.__wideColumns === undefined) config.__wideColumns = config.columns;
    const narrow = window.matchMedia("(max-width: 767px)").matches;
    config.columns = narrow ? Number(config.columns_narrow) : config.__wideColumns;
    if (!repaint) return;
    const grid = host.shadowRoot && host.shadowRoot.querySelector(".grid");
    if (grid) grid.style.gridTemplateColumns = `repeat(${config.columns},1fr)`;
  };

  // ---- live tiles (trial: card option `live_tiles: true`) ----------------------
  // In the Live view each camera tile plays its small stream over its still.
  // The still stays underneath: a tile only shows video once a frame is really
  // decoding, and a tile that has produced nothing after ten seconds goes back
  // to being a still (and is left alone for five minutes). Not on phones
  // (`live_tiles: all` includes them), not in History, not while the page is
  // hidden, and not for the camera already playing in the big picture.
  const TILE_WAIT = 10000;
  const TILE_RETRY = 300000;
  const TILE_LINGER = 30000;
  const tilesWanted = (host) => {
    const option = host._config && host._config.live_tiles;
    if (!option || host._mode !== "live" || document.hidden || !host.isConnected) return false;
    if (!customElements.get("advanced-camera-card")) return false;
    return option === "all" || window.matchMedia("(min-width: 768px) and (min-height: 600px)").matches;
  };
  const syncTiles = (host) => {
    try {
      const root = host.shadowRoot;
      const on = tilesWanted(host);
      host._tileFailed = host._tileFailed || {};
      let order = 0;
      for (const channel of host._channels || []) {
        const entry = entryFor(host, channel.id);
        const tile = root.querySelector(`.tile[data-channel="${channel.id}"]`);
        if (!entry || !tile) continue;
        const have = tile.querySelector(".fl-tile-live");
        const failed = host._tileFailed[channel.id];
        // A camera marked `tile: motion` stays a still until one of its
        // motion sensors is on, plays while it is, and for a short while after.
        let awake = true;
        if (entry.tile === "motion") {
          host._tileMotion = host._tileMotion || {};
          const moving = (entry.motion || []).some((id) => {
            const state = host._hass.states[id];
            return state && state.state === "on";
          });
          if (moving) host._tileMotion[channel.id] = Date.now();
          const since = Date.now() - (host._tileMotion[channel.id] || 0);
          awake = moving || since < TILE_LINGER;
          if (awake && !moving) {
            host._tileTimers = host._tileTimers || {};
            clearTimeout(host._tileTimers[channel.id]);
            host._tileTimers[channel.id] = setTimeout(
              () => syncTiles(host),
              TILE_LINGER - since + 500
            );
          }
        }
        const want =
          on &&
          awake &&
          channel.id !== host._selected &&
          !(failed && Date.now() - failed < TILE_RETRY);
        if (!want) {
          if (have) have.remove();
          continue;
        }
        if (have || tile.dataset.liveBusy) continue;
        tile.dataset.liveBusy = "1";
        // One after another, not nine at the same instant.
        setTimeout(async () => {
          try {
            const card = await buildCard(host, entry, true);
            if (!tile.isConnected || !tilesWanted(host) || channel.id === host._selected) return;
            const wrap = document.createElement("div");
            wrap.className = "fl-tile-live";
            wrap.appendChild(card);
            tile.insertBefore(wrap, tile.querySelector(".label"));
            const started = Date.now();
            const watch = setInterval(() => {
              if (!wrap.isConnected) {
                clearInterval(watch);
              } else if (host._hasLiveVideo(card)) {
                clearInterval(watch);
                wrap.classList.add("on");
              } else if (Date.now() - started > TILE_WAIT) {
                clearInterval(watch);
                wrap.remove();
                host._tileFailed[channel.id] = Date.now();
              }
            }, 500);
          } catch (err) {
            console.warn("nvr fast-live: live tile unavailable", err);
          } finally {
            tile.dataset.liveBusy = "";
          }
        }, 250 * order);
        order += 1;
      }
    } catch (_) {
      /* the stills carry on */
    }
  };
  // With live tiles on, picking another camera swaps the big picture in place
  // instead of redrawing the whole card, so the other tiles keep playing.
  const selectInPlace = (host, stage, id) => {
    const channel = (host._channels || []).find((c) => c.id === id);
    host._selected = id;
    host._playbackUrl = null;
    const root = host.shadowRoot;
    const title = root.querySelector(".head .title");
    if (title) title.textContent = channel ? channel.name : "";
    root.querySelectorAll(".tile").forEach((tile) =>
      tile.classList.toggle("active", Number(tile.dataset.channel) === id)
    );
    host._renderLive(stage);
    syncTiles(host);
  };
  const wireTiles = (host) => {
    const root = host.shadowRoot;
    root.querySelectorAll(".tile").forEach((tile) =>
      tile.addEventListener(
        "click",
        (event) => {
          if (!tilesWanted(host)) return;
          const id = Number(tile.dataset.channel);
          const stage = root.querySelector("#stage");
          const next = (host._channels || []).find((c) => c.id === id);
          const now = (host._channels || []).find((c) => c.id === host._selected);
          if (!stage || !next || !entryFor(host, id)) return;
          // The speaker button in the header depends on the camera: if that
          // changes, let the card redraw itself as it always has.
          if (!!(now && now.has_audio) !== !!next.has_audio) {
            // The wall swaps in place anyway (a full redraw there left tiles dead).
            if (!isWall(host)) return;
            const mute = root.querySelector("#mute");
            if (mute) mute.hidden = !next.has_audio;
          }
          event.stopImmediatePropagation();
          if (id !== host._selected) selectInPlace(host, stage, id);
        },
        true
      )
    );
  };

  // ---- LIVE / RECORDING badges on the live picture ---------------------------
  // Top right of the picture: LIVE always, RECORDING under it while the
  // recorder itself says it is recording that camera. The recorder is asked
  // every few seconds (its working status lists every camera), through the
  // card option `recorder_entry` (the Hikvision device to ask). Only while the
  // Live view is on screen.
  const paintStatus = (host) => {
    // Each small tile carries a REC marker while the recorder is recording
    // that camera (Live view only: the recorder is not asked in History).
    try {
      const live = host._mode === "live";
      host.shadowRoot.querySelectorAll(".tile").forEach((tile) =>
        tile.classList.toggle(
          "fl-recording",
          live && !!(host._recording && host._recording[Number(tile.dataset.channel)])
        )
      );
    } catch (_) {
      /* cosmetic */
    }
    try {
      const stage = host.shadowRoot.querySelector("#stage");
      const box = stage && stage.querySelector(".fl-status");
      if (!box) return;
      const recording = !!(host._recording && host._recording[host._selected]);
      const badge = box.querySelector(".fl-rec-badge");
      if (badge) badge.hidden = !recording;
      paintSummary(host);
    } catch (_) {
      /* cosmetic */
    }
  };
  const renderStatus = (host, stage) => {
    const old = stage.querySelector(".fl-status");
    if (old) old.remove();
    const box = document.createElement("div");
    box.className = "fl-status";
    box.innerHTML =
      '<span class="fl-badge fl-live-badge"><i></i>LIVE</span>' +
      '<span class="fl-badge fl-rec-badge" hidden><i></i>RECORDING</span>';
    stage.appendChild(box);
    paintStatus(host);
  };
  const pollRecording = async (host) => {
    const entry = host._config && host._config.recorder_entry;
    if (host._recBusy || (host._recFails || 0) >= 3) return;
    if (!host.isConnected || host._mode !== "live" || document.hidden) return;
    if (!host._hass || host._hass.connected === false) return;
    host._recBusy = true;
    try {
      if (!entry) {
        // The integration's own answer: which channels are recording right now.
        if (!host._device) return;
        const data = await host._api(`${host._device.id}/recording`);
        const now = {};
        for (const [channel, on] of Object.entries(data.channels || {})) now[Number(channel)] = !!on;
        host._recording = now;
        host._recFails = 0;
        paintStatus(host);
        wallTick(host);
        return;
      }
      const reply = await host._hass.callService(
        "hikvision_next",
        "isapi_request",
        { config_entry_id: entry, method: "GET", path: "/System/workingstatus?format=json" },
        undefined,
        false,
        true
      );
      const data = JSON.parse(reply.response.data);
      const now = {};
      for (const channel of data.WorkingStatus.ChanStatus || []) {
        now[channel.chanNo] = channel.record === 1;
      }
      host._recording = now;
      host._recFails = 0;
      paintStatus(host);
      wallTick(host);
    } catch (err) {
      host._recFails = (host._recFails || 0) + 1;
      if (host._recFails >= 3) console.warn("nvr fast-live: recording status unavailable", err);
    } finally {
      host._recBusy = false;
    }
  };
  const armRecording = (host) => {
    if (host._recTimer || !host._config || host._config.recording === false) return;
    host._recTimer = setInterval(() => pollRecording(host), 4000);
    pollRecording(host);
  };
  // The card's connected / disconnected callbacks are fixed when it is defined,
  // so they cannot be patched here. They call _startSnapshots and _stopTimers
  // (as does its page-shown / page-hidden handler), which can.
  const originalStart = proto._startSnapshots;
  proto._startSnapshots = function () {
    originalStart.call(this);
    armRecording(this);
    syncTiles(this);
  };

  // A recording that is taken off the page must also be told to stop. A video
  // that is merely removed keeps playing, unseen, and keeps its stream from
  // the recorder open; a few of those and the browser has no connections left
  // for anything else (the page then shows "Request error").
  // On iPhone and iPad a recording comes through Home Assistant's own stream,
  // which keeps pulling from the recorder for minutes after the picture is
  // gone. Tell it to stop, unless another clip was asked for in the meantime
  // (asking for a clip already ends this page's previous one).
  const PAGE_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const stopHlsSoon = (host, wait) => {
    if (!host._hlsLive) return;
    const seq = host._hlsSeq;
    setTimeout(() => {
      if (host._hlsSeq !== seq || !host._hlsLive) return;
      host._hlsLive = false;
      try {
        host
          ._api(`${host._device.id}/${host._selected}/playback?stop=1&client=${PAGE_ID}`)
          .catch(() => {});
      } catch (_) {
        /* the idle timer will end it */
      }
    }, wait);
  };
  const releaseReplays = (host) => {
    try {
      const root = host.shadowRoot;
      if (!root) return;
      root.querySelectorAll("#stage > video").forEach((video) => {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch (_) {
          /* already gone */
        }
      });
      stopHlsSoon(host, 1500);
    } catch (_) {
      /* nothing to release */
    }
  };
  const originalStop = proto._stopTimers;
  proto._stopTimers = function () {
    if (!this.isConnected) {
      releaseReplays(this); // the card has left the page
      clearInterval(this._recTimer);
      this._recTimer = null;
    }
    syncTiles(this); // hidden or gone: the live tiles stop too
    originalStop.call(this);
  };

  // A new moment was picked: the playhead starts again from there.
  const originalPlayFrom = proto._playFrom;
  if (originalPlayFrom) {
    proto._playFrom = function (...args) {
      this._flPlayAt = null;
      return originalPlayFrom.apply(this, args);
    };
  }

  const originalRender = proto._render;
  proto._render = function () {
    try {
      applyColumns(this, false);
      // Live starts unmuted here, so the speaker button should say so.
      if (!this.__fastMuteInit) {
        this.__fastMuteInit = true;
        this._muted = false;
      }
      for (const channel of this._channels || []) {
        const entry = entryFor(this, channel.id);
        channel.name = entry && entry.name ? entry.name : pretty(channel.name);
      }
    } catch (err) {
      /* cosmetic; never block the render */
    }
    // The card is about to rebuild its picture: stop the recording in it first.
    releaseReplays(this);
    const result = originalRender.call(this);
    try {
      ensureLook(this);
      dressMute(this);
      wallAfterRender(this);
      armRecording(this);
      paintStatus(this); // the tiles were just redrawn
      if (this._mode === "live") pollRecording(this);
    } catch (_) {
      /* cosmetic */
    }
    try {
      applyActivity(this);
      loadCounts(this);
      fitStage(this);
      wireTiles(this);
      syncTiles(this);
      if (!this._fitResize) {
        this._fitResize = () => {
          if (!this.isConnected) return;
          try {
            applyColumns(this, true);
          } catch (_) {
            /* cosmetic */
          }
          fitStage(this);
          syncTiles(this);
        };
        window.addEventListener("resize", this._fitResize);
        if (window.visualViewport) {
          window.visualViewport.addEventListener("resize", this._fitResize);
        }
      }
      // Re-fit whenever the card, or anything above / below the picture,
      // changes size (controls wrapping, the snapshot strip appearing ...).
      if (window.ResizeObserver) {
        if (this._fitObserver) this._fitObserver.disconnect();
        this._fitObserver = new ResizeObserver(() => fitStage(this));
        this._fitObserver.observe(this);
        const stage = this.shadowRoot.querySelector("#stage");
        const grid = this.shadowRoot.querySelector(".grid");
        const parent = stage && stage.parentElement;
        for (const child of (parent && parent.children) || []) {
          if (child !== stage && child !== grid) this._fitObserver.observe(child);
        }
      }
    } catch (_) {}
    return result;
  };

  // ---- thumbnails for cameras the NVR cannot snapshot ---------------------------------------
  const originalSnapshot = proto._refreshSnapshot;
  proto._refreshSnapshot = async function (channel) {
    const entry = entryFor(this, channel);
    // A tile that is playing live needs no new still.
    try {
      if (this.shadowRoot.querySelector(`.tile[data-channel="${channel}"] .fl-tile-live.on`)) return;
    } catch (_) {
      /* carry on */
    }
    if (!entry || !entry.thumb) return originalSnapshot.call(this, channel);
    try {
      // While Home Assistant is restarting the camera token is stale, and a
      // request with it is logged as a failed login. Wait for the reconnect.
      if (this._hass.connected === false) return;
      const state = this._hass.states[entry.entity];
      const picture = state && state.attributes.entity_picture;
      if (!picture) return;
      // If Home Assistant refused this camera token once (it expires across a
      // restart), do not keep asking with it: every refusal is logged as a
      // failed login. Wait until the camera publishes a new token.
      this._thumbRefused = this._thumbRefused || {};
      if (this._thumbRefused[channel] === picture) return;
      const url = `${picture}${picture.includes("?") ? "&" : "?"}t=${Date.now()}`;
      this._snapshotUrls.set(channel, url);
      const img = this.shadowRoot.querySelector(`img[data-channel="${channel}"]`);
      if (img) {
        img.onerror = () => {
          this._thumbRefused[channel] = picture;
          this._snapshotUrls.delete(channel);
        };
        img.src = url;
      }
    } catch (err) {
      /* a single failed thumbnail must not break the card */
    }
  };

  // ---- keep the embedded camera card supplied with fresh state ------------------------------
  const hassProp = Object.getOwnPropertyDescriptor(proto, "hass");
  Object.defineProperty(proto, "hass", {
    configurable: true,
    get: hassProp.get,
    set(hass) {
      hassProp.set.call(this, hass);
      const card = this._fastLiveCard;
      if (card && card.isConnected) card.hass = hass;
      if (this._ptzEl && this._ptzEl.isConnected) this._ptzEl.hass = hass;
      try {
        this.shadowRoot.querySelectorAll(".fl-tile-live > *").forEach((tile) => {
          tile.hass = hass;
        });
      } catch (_) {}
      try {
        const signature = activitySignature(this);
        if (signature !== this._activitySignature) {
          this._activitySignature = signature;
          applyActivity(this);
          syncTiles(this); // a motion-only tile may need to wake or rest
        }
      } catch (_) {}
    },
  });
  // ======================================================================================
  // Wall layout (card option `layout: wall`): an icon rail on the left, the chosen
  // camera large with the others around it, today's detections down the right,
  // and one timeline along the bottom. Everything above (live picture, live
  // tiles, REC, History) is reused; this only rearranges it and adds the rail,
  // the list, the Live timeline and, for the PTZ, its controls on the picture.
  // ======================================================================================
  function isWall(host) {
    return !!(host._config && host._config.layout === "wall");
  }
  const isoDay = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  // Jump into History for a camera at a moment (from the list or the Live timeline).
  const goHistory = async (host, channel, time) => {
    try {
      const sameDay = host._mode === "playback" && host._selected === channel &&
        host._date === isoDay(new Date(time)) && (host._blocks || []).length;
      if (!sameDay) {
        host._selected = channel;
        host._mode = "playback";
        host._playbackUrl = null;
        host._cursor = null;
        host._date = isoDay(new Date(time));
        await host._loadTimeline();
      }
      host._playFrom(new Date(time));
    } catch (err) {
      console.warn("nvr fast-live: could not open that moment", err);
    }
  };

  function paintSummary(host) {
    try {
      if (!isWall(host)) return;
      const root = host.shadowRoot;
      const info = root.querySelector(".fl-headinfo");
      if (info) {
        const recording = Object.keys(host._recording || {}).filter(
          (ch) => host._recording[ch] && entryFor(host, ch)
        ).length;
        const total = (host._channels || []).length;
        info.textContent = `${total} cameras${recording ? `, ${recording} recording` : ""}`;
      }
      const sum = root.querySelector(".fl-sum");
      if (sum) {
        let people = 0;
        let vehicles = 0;
        for (const counts of Object.values(host._counts || {})) {
          people += counts.person || 0;
          vehicles += counts.vehicle || 0;
        }
        const text = `${people}/${vehicles}`;
        if (sum.dataset.text !== text) {
          sum.dataset.text = text;
          sum.innerHTML =
            '<span class="fl-sum-t">Today</span>' +
            `<span class="fl-sum-n">${iconSvg("person", 18, false)}${people}</span>` +
            `<span class="fl-sum-n">${iconSvg("vehicle", 18, false)}${vehicles}</span>`;
        }
      }
    } catch (_) {
      /* cosmetic */
    }
  }

  // The list down the right: Live = today, every camera; History = the day
  // and camera being looked at. One row per visit, newest first.
  function paintSide(host) {
    try {
      if (!isWall(host)) return;
      const root = host.shadowRoot;
      const list = root.querySelector(".fl-side-list");
      const head = root.querySelector(".fl-side-head");
      if (!list || !head) return;
      const live = host._mode === "live";
      const names = {};
      for (const channel of host._channels || []) names[channel.id] = channel.name;
      let rows = [];
      if (live) {
        for (const ch of Object.keys(host._detLists || {})) {
          for (const d of host._detLists[ch]) if (d.picture) rows.push({ ...d, ch: Number(ch) });
        }
        rows.push(...(host._flRings || [])); // gate / door rings, from wall-extras.js
        head.textContent = "Detections today";
      } else {
        const filter = filterOf(host);
        for (const d of host._detections || []) {
          if (d.picture && (filter === "all" || d.kind === filter)) rows.push({ ...d, ch: host._selected });
        }
        head.textContent = `Detections, ${names[host._selected] || ""}`;
      }
      rows.sort((a, b) => b.time - a.time);
      const kept = [];
      const last = {};
      for (const row of rows) {
        const key = `${row.ch}/${row.kind}`;
        const fold = last[key] !== undefined && last[key] - row.time < 60000;
        last[key] = row.time;
        if (fold) continue;
        kept.push(row);
        if (kept.length >= 40) break;
      }
      const signature = `${host._mode}|${kept.map((r) => `${r.ch}:${r.time}`).join(",")}`;
      if (list.dataset.signature === signature) return;
      list.dataset.signature = signature;
      list.innerHTML = "";
      if (!kept.length) {
        const empty = document.createElement("p");
        empty.className = "fl-side-empty";
        empty.textContent = live ? "Nothing detected yet today." : "No people or vehicles this day.";
        list.appendChild(empty);
        return;
      }
      // The row last tapped stays lit, so you can see which one you opened.
      const pick = (button) => {
        host._flPicked = button.dataset.key;
        list.querySelectorAll(".fl-ev.fl-picked").forEach((b) => b.classList.remove("fl-picked"));
        button.classList.add("fl-picked");
      };
      for (const row of kept) {
        const button = document.createElement("button");
        button.className = "fl-ev";
        button.dataset.key = `${row.ch}:${row.time}`;
        if (host._flPicked === button.dataset.key) button.classList.add("fl-picked");
        button.addEventListener("click", () => pick(button));
        if (row.ring) {
          hook("ring", host, button, row, names);
          list.appendChild(button);
          continue;
        }
        button.innerHTML =
          '<img alt="" draggable="false">' +
          `<span class="fl-ev-what">${iconSvg(row.kind, 16, false)}${CHIP_WORD_ONE[row.kind] || ""}</span>` +
          '<span class="fl-ev-meta"></span>';
        button.lastChild.textContent = `${names[row.ch] || ""}, ${clock(row.time).slice(0, 5)}`;
        button.addEventListener("click", () => goHistory(host, row.ch, row.time - 5000));
        list.appendChild(button);
        signPicture(host, row.ch, row.picture)
          .then((url) => {
            button.firstChild.src = url;
          })
          .catch(() => {});
      }
    } catch (_) {
      /* the list is optional */
    }
  }

  // The Live timeline: today for the camera in the big picture, a red Live
  // marker at now. Tapping an earlier moment opens it in History.
  const paintLiveRuler = (host) => {
    try {
      const ruler = host.shadowRoot.querySelector("#livetl");
      if (!ruler) return;
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setHours(23, 59, 59, 0);
      const mine = host._liveBlocks && host._liveBlocks.ch === host._selected;
      ruler.innerHTML = rulerHtml({
        host,
        dayStart: start.getTime(),
        dayEnd: end.getTime(),
        view: { from: 0, to: 1 },
        blocks: mine ? host._liveBlocks.blocks : [],
        detections: (host._detLists || {})[host._selected] || [],
        filter: "all",
        at: new Date(),
        label: "Live",
        live: true,
      });
    } catch (_) {
      /* cosmetic */
    }
  };
  const refreshLiveRuler = async (host) => {
    if (!isWall(host) || host._mode !== "live" || !host._device) return;
    host._liveRulerAt = Date.now();
    const ch = host._selected;
    paintLiveRuler(host);
    const entry = entryFor(host, ch);
    if (entry && entry.thumb) {
      host._liveBlocks = { ch, blocks: [] }; // gate / door stations are not recorded
      return;
    }
    try {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const data = await host._api(
        `${host._device.id}/${ch}/timeline` +
          `?start=${encodeURIComponent(start.toISOString())}` +
          `&end=${encodeURIComponent(new Date().toISOString())}&gap=120`
      );
      host._liveBlocks = {
        ch,
        blocks: (data.blocks || []).map((b) => ({ start: new Date(b.start), end: new Date(b.end) })),
      };
      if (host._selected === ch) paintLiveRuler(host);
    } catch (_) {
      /* the band is optional */
    }
  };

  // Called when the big picture changes camera, when new counts arrive, and on
  // the recorder's 4 s tick.
  function wallLive(host) {
    if (!isWall(host)) return;
    refreshLiveRuler(host);
    paintSummary(host);
  }
  function wallData(host) {
    if (!isWall(host)) return;
    paintSide(host);
    paintSummary(host);
    paintLiveRuler(host);
  }
  function wallTick(host) {
    if (!isWall(host)) return;
    loadCounts(host);
    if (Date.now() - (host._liveRulerAt || 0) > 30000) refreshLiveRuler(host);
  }

  // PTZ controls on the big picture, only while the PTZ is the camera in it:
  // the joystick from the PTZ tab (move, zoom, tap-to-aim) and the saved views.
  function renderPtz(host, stage) {
    try {
      stage.querySelectorAll(".fl-ptz, .fl-presets").forEach((node) => node.remove());
      host._ptzEl = null;
      const ptz = host._config && host._config.ptz;
      if (!ptz || Number(ptz.channel) !== host._selected) return;
      if (customElements.get("arcane-ptz-joystick")) {
        const stick = document.createElement("arcane-ptz-joystick");
        stick.className = "fl-ptz";
        stick.setConfig({
          script: "script.ptz_move",
          max_speed: 70,
          size: 120,
          zoom: true,
          aim: true,
          card: false,
          zoom_out_full_script: "script.ptz_zoom_out_full",
          ...(ptz.joystick || {}),
        });
        stick.hass = host._hass;
        stage.appendChild(stick);
        host._ptzEl = stick;
      }
      const presets = ptz.presets || [];
      if (!presets.length) return;
      const box = document.createElement("div");
      box.className = "fl-presets";
      const open = document.createElement("button");
      open.className = "fl-preset-btn";
      open.title = "Saved views";
      open.innerHTML = '<ha-icon icon="mdi:bookmark-outline"></ha-icon><span>Views</span>';
      const list = document.createElement("div");
      list.className = "fl-preset-list";
      list.hidden = true;
      for (const preset of presets) {
        const button = document.createElement("button");
        const icon = document.createElement("ha-icon");
        icon.setAttribute("icon", preset.icon || "mdi:target");
        const name = document.createElement("span");
        name.textContent = preset.name || "";
        button.append(icon, name);
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          list.hidden = true;
          // A preset number goes straight to the camera through the integration;
          // an entity (a script or scene of your own) is turned on instead.
          const call = preset.preset != null
            ? host._hass.callService("hikvision_nvr", "ptz", {
                channel: Number(ptz.channel),
                preset: Number(preset.preset),
                ...(host._device ? { device_id: host._device.id } : {}),
              })
            : host._hass.callService("script", "turn_on", { entity_id: preset.entity });
          call.catch((err) => console.warn("nvr fast-live: saved view failed", err));
          flashLabel(stage, preset.name || "");
        });
        list.appendChild(button);
      }
      open.addEventListener("click", (event) => {
        event.stopPropagation();
        list.hidden = !list.hidden;
      });
      box.append(open, list);
      stage.appendChild(box);
    } catch (err) {
      console.warn("nvr fast-live: PTZ controls unavailable", err);
    }
  }

  // After every redraw of the card: wrap its parts into the wall's three
  // columns and add the rail, the list, the summary tile and the Live timeline.
  function wallAfterRender(host) {
    if (!isWall(host)) return;
    const root = host.shadowRoot;
    const card = root.querySelector("ha-card");
    host.setAttribute("wall", "");
    host.toggleAttribute("side-off", !!host._sideOff);
    if (!card || card.querySelector(".fl-main")) return;
    const stage = card.querySelector("#stage");
    const grid = card.querySelector(".grid");
    if (!stage || !grid) return;

    const main = document.createElement("div");
    main.className = "fl-main";
    while (card.firstChild) main.appendChild(card.firstChild);

    const head = main.querySelector(".head");
    const modes = main.querySelector(".modes");
    if (head && modes) {
      const info = document.createElement("span");
      info.className = "fl-headinfo";
      head.insertBefore(info, modes);
    }

    // The tile that fills the cells left over beside the last row of cameras.
    const shown = grid.querySelectorAll(".tile").length; // the picked camera keeps its tile
    const over = Math.max(0, shown - 6) % 5;
    if (over) {
      const sum = document.createElement("div");
      sum.className = "fl-sum";
      sum.style.gridColumn = `span ${5 - over}`;
      grid.appendChild(sum);
    }

    if (host._mode === "live") {
      const wrap = document.createElement("div");
      wrap.className = "fl-tl fl-livetl";
      wrap.innerHTML = '<div class="timeline" id="livetl"></div>';
      wrap.firstChild.addEventListener("click", (event) => {
        const box = wrap.firstChild.getBoundingClientRect();
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const time = start.getTime() + clamp((event.clientX - box.left) / box.width, 0, 1) * 86399000;
        if (time < Date.now() - 15000 && entryFor(host, host._selected) && !entryFor(host, host._selected).thumb) {
          goHistory(host, host._selected, time);
        }
      });
      main.appendChild(wrap);
    }

    const rail = document.createElement("div");
    rail.className = "fl-rail";
    const railButton = (id, label, icon, pressed) =>
      `<button data-rail="${id}" title="${label}" aria-label="${label}" aria-pressed="${pressed}">` +
      `<ha-icon icon="${icon}"></ha-icon></button>`;
    rail.innerHTML =
      railButton("live", "Live", "mdi:view-grid", host._mode === "live") +
      railButton("playback", "History", "mdi:history", host._mode === "playback") +
      railButton("side", "Detections", "mdi:format-list-bulleted", !host._sideOff);
    rail.querySelectorAll("button").forEach((button) =>
      button.addEventListener("click", () => {
        const id = button.dataset.rail;
        if (id === "side") {
          host._sideOff = !host._sideOff;
          host.toggleAttribute("side-off", host._sideOff);
          button.setAttribute("aria-pressed", String(!host._sideOff));
          return;
        }
        const target = main.querySelector(`.modes button[data-mode="${id}"]`);
        if (target && host._mode !== id) target.click();
      })
    );

    const side = document.createElement("div");
    side.className = "fl-side";
    side.innerHTML = '<div class="fl-side-head"></div><div class="fl-side-list"></div>';

    card.append(rail, main, side);
    paintSummary(host);
    paintSide(host);
    if (host._mode === "live") refreshLiveRuler(host);
    hook("after", host);
  }

  // What wall-extras.js (a second resource, loaded in any order) needs from
  // here. It adds W.counts / ring / ptz / after, which hook() calls if present.
  const refreshPtz = (host) => {
    const stage = host.shadowRoot && host.shadowRoot.querySelector("#stage");
    if (!stage || host._mode !== "live") return;
    renderPtz(host, stage);
    hook("ptz", host, stage);
  };
  const W = (proto.__flWall = {
    isWall, entryFor, goHistory, clock, isoDay, paintSide, buildCard, iconSvg, refreshPtz,
  });
  function hook(name, ...args) {
    try {
      if (W[name]) W[name](...args);
    } catch (err) {
      console.warn("nvr fast-live: wall extra failed", err);
    }
  }
});
