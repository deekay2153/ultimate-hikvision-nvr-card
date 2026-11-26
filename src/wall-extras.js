/* Wall extras for the Hikvision NVR card's wall layout (card option `layout: wall`).
 *
 * A second inline dashboard resource next to fast-live.js (the first is near
 * its size limit). Loads in any order: it waits for the card and for the hooks
 * fast-live.js publishes on the card (`__flWall`). Nothing here touches the
 * Cameras tab (no `layout: wall`), and nothing here redraws the card or moves
 * the big picture or its camera.
 *
 *   1. PTZ controls under the picture on narrow screens (on it when wide, and
 *      always on it in full screen).
 *   2. Gate and doorbell rings in the detections list, from Home Assistant's
 *      history of each camera's `ring` sensor, with the photo the automation
 *      "Doorbell - save a photo of each ring" took (media folder
 *      doorbell/<date>/<camera>_<HHMMSS>.jpg; with card option
 *      `ring_photo_days: N`, an admin's wall deletes photos older than N days):
 *        fast_live:
 *          3: { ..., ring: binary_sensor.gate_ringing }
 *          4: { ..., ring: binary_sensor.doorbell_ringing }
 *      (optional `ring_label:` to word a row; by default a sensor with "gate"
 *      in its id says "Gate rang", any other "Doorbell rang").
 *   3. The time and date in the header on wide screens.
 *   4. A tile's REC marker opens History for that camera where the recording
 *      started.
 *   5. PERSON / VEHICLE tags on a camera's tile (and on the big picture)
 *      while the recorder is recording an event on it.
 *   6. A layout switch in the header (wide screens): Focus (the big picture
 *      and the tiles), Grid (every camera the same size) and Single (one
 *      camera). Remembered per browser; card option `view:` sets the default.
 *   7. The detections bar slides away and back (wide screens): swipe it to
 *      the right, or tap its handle; swipe in from the right edge, or tap the
 *      handle, to bring it back. Remembered per browser.
 *   8. The 24-hour bar under the live wall does the same: swipe it down, or
 *      tap its handle; swipe up from the bottom edge, or tap the handle, to
 *      bring it back. History always keeps it (it is how you scrub).
 *   9. In the detections list, a row from a camera linked to the PTZ
 *      (`ptz.linked`, e.g. the Panoramic lens of a twin-lens camera) gets a
 *      PTZ pill: the row opens that camera, the pill opens the PTZ's own
 *      recording of the same moment. So does a doorbell ring from a camera in
 *      `ptz.ring_follow` (e.g. [3, 4]: an automation turns the PTZ to that
 *      door and records it when it rings): its pill plays from the ring.
 *  10. Privacy blur for screenshots: add ?blur to the page address and every
 *      camera picture and photo is blurred, while the wall itself stays sharp.
 *  11. Replays in browsers without built-in HLS (Firefox, desktop Chrome):
 *      played from the recorder's fast download instead of its real-time
 *      playback stream, so the video stays well ahead instead of arriving one
 *      keyframe-gap (often 2 s) at a time and skipping.
 *
 * Deployed as an inline dashboard resource; this file is the source of truth.
 */
customElements.whenDefined("hikvision-nvr-card").then(() => {
  const proto = customElements.get("hikvision-nvr-card").prototype;
  if (proto.__flWallExtras) return;
  proto.__flWallExtras = true;
  let tries = 0;
  const begin = () => {
    if (proto.__flWall) install(proto.__flWall);
    else if (tries++ < 300) setTimeout(begin, tries < 40 ? 50 : 250); // fast-live.js not in yet
  };
  begin();

  function install(W) {
    const { isWall, goHistory, clock, isoDay, paintSide } = W;
    // The same breakpoint as the wall's own stacked layout in fast-live.js.
    const NARROW = window.matchMedia("(max-width: 899px)");
    // A phone on its side: too short for the wall's columns, however wide.
    const SHORT = window.matchMedia("(max-height: 500px)");
    // How the PTZ controls are laid out: "dock" = a panel under the picture
    // (phone upright), "short" = on the picture, next to the video (phone on
    // its side), "wide" = on the picture (iPad, computer, and full screen).
    const ptzMode = (host, stage) => {
      if (stage.classList.contains("fl-full")) return "wide";
      if (SHORT.matches) return "short";
      return NARROW.matches ? "dock" : "wide";
    };
    const STICK = {
      wide: { size: 120, arrange: "side" },
      dock: { size: 96, arrange: "row" },
      short: { size: 88, arrange: "stack" },
    };
    // The page's scroller: a scrolling ancestor (across shadow roots), else the window.
    const scrollParent = (node) => {
      for (let current = node; current; ) {
        const root = current.getRootNode();
        const parent = current.parentElement || (root && root.host) || null;
        if (!parent || parent === document.body || parent === document.documentElement) break;
        const overflow = getComputedStyle(parent).overflowY;
        if (overflow === "auto" || overflow === "scroll") return parent;
        current = parent;
      }
      return null;
    };
    // Phone on its side: the picture is as tall as the screen has room for
    // below the header (measured, at the top of the page), never taller.
    const fitShort = (host) => {
      const stage = host.shadowRoot && host.shadowRoot.querySelector("#stage");
      if (!stage) return;
      if (!SHORT.matches || !isWall(host) || stage.classList.contains("fl-full")) {
        host.style.removeProperty("--flx-pic-h");
        return;
      }
      const scroller = scrollParent(host);
      const box = stage.getBoundingClientRect();
      let visible;
      let top;
      if (scroller) {
        visible = scroller.clientHeight;
        top = box.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      } else {
        visible = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
        top = box.top + window.scrollY;
      }
      const room = Math.floor(visible - top - 6);
      const natural = Math.floor((stage.clientWidth * 9) / 16);
      host.style.setProperty("--flx-pic-h", `${Math.max(140, Math.min(room, natural))}px`);
    };

    const CSS = `
      /* Phone upright: the PTZ controls in a dock joined to the bottom of the
         picture, so they read as part of the player. */
      .flx-ptzrow {
        grid-column: 1 / -1; display: flex; align-items: center; gap: 12px;
        margin-top: -4px; padding: 10px 12px; border-radius: 0 0 8px 8px;
        background: var(--fl-panel); box-shadow: inset 0 -1px 0 var(--fl-line), inset 1px 0 0 var(--fl-line), inset -1px 0 0 var(--fl-line);
      }
      .fl-main > .stage:has(+ .flx-ptzrow) { border-radius: 6px 6px 0 0; }
      .flx-ptzrow > .fl-presets { position: relative; flex: none; margin-left: auto; }
      .flx-ptzrow .fl-preset-btn { height: 40px; }
      .flx-ptzrow .fl-preset-list { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 5; }
      /* Phone on its side: one column, the picture as tall as there is room
         for, the video centred in it, and the controls in the dark space
         either side of the video. */
      @media (max-height: 500px) {
        :host([wall]) ha-card { flex-direction: column; }
        :host([wall]) .fl-rail, :host([wall]) .fl-sum, :host([wall]) .fl-headinfo, .flx-clock { display: none; }
        :host([wall]) .modes { display: inline-flex; }
        :host([wall]) .fl-main { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        :host([wall]) .fl-main > .stage {
          grid-column: 1 / -1; grid-row: auto; aspect-ratio: auto;
          height: var(--flx-pic-h, auto); border-radius: 6px;
        }
        :host([wall]) .fl-main > .stage:not(.fl-full) > :is(advanced-camera-card, video) {
          width: min(100%, calc(var(--flx-pic-h, 9999px) * 16 / 9)); height: 100%; margin: 0 auto;
        }
        :host([wall]) .fl-side { width: auto; }
        :host([wall]) .fl-side-list { position: static; max-height: 320px; }
        .stage[data-ptz="short"] > .fl-presets { bottom: auto; top: max(12px, env(safe-area-inset-top)); }
        .stage[data-ptz="short"] > .fl-status { right: max(12px, env(safe-area-inset-right)); top: auto;
          bottom: max(12px, env(safe-area-inset-bottom)); }
      }
      /* A ring in the detections list: a bell where the photo would be. */
      .flx-bell {
        grid-row: span 2; width: 76px; height: 43px; border-radius: 5px; box-sizing: border-box;
        display: flex; align-items: center; justify-content: center;
        background: var(--fl-panel); box-shadow: inset 0 0 0 1px var(--fl-line); color: var(--fl-accent);
      }
      .flx-ring .fl-ev-what svg { color: var(--fl-accent); }
      /* Time and date at the end of the header (wide screens). */
      .flx-clock {
        flex: none; display: inline-flex; align-items: baseline; gap: 8px; margin-left: 6px;
        white-space: nowrap; font-variant-numeric: tabular-nums; line-height: 1.15;
      }
      .flx-clock b { font-size: 17px; font-weight: 600; letter-spacing: -.01em; }
      .flx-clock span { font-size: 13px; color: var(--fl-muted); }
      @media (max-width: 899px) { .flx-clock { display: none; } }
      /* The camera on the big picture, top left: a type chip, the name, and a
         status line (channel, PTZ, live / recording / history). */
      :host([wall]) .fl-main > .head .title {
        display: flex; align-items: center; gap: 11px; min-width: 0;
        font-size: 0; letter-spacing: 0; /* the name is drawn by .flx-name */
      }
      .flx-chip {
        flex: none; width: 34px; height: 34px; border-radius: 10px; display: grid; place-items: center;
        color: #fff; background: linear-gradient(140deg, color-mix(in srgb, var(--fl-accent) 92%, #fff 8%),
          color-mix(in srgb, var(--fl-accent) 55%, #000 45%));
        box-shadow: 0 6px 16px -8px color-mix(in srgb, var(--fl-accent) 80%, transparent),
          inset 0 1px 0 rgba(255,255,255,.22);
      }
      .flx-chip svg { width: 19px; height: 19px; fill: currentColor; display: block; }
      .flx-titletext { display: flex; flex-direction: column; min-width: 0; line-height: 1.12; }
      .flx-name {
        font-size: 19px; font-weight: 700; letter-spacing: -.015em; color: var(--primary-text-color, #fff);
        white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .flx-sub {
        display: flex; align-items: center; gap: 6px; margin-top: 3px;
        font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
        color: var(--fl-muted, #8a93a6); white-space: nowrap;
      }
      .flx-sub i { width: 6px; height: 6px; border-radius: 50%; background: var(--fl-live, #ff5a52); flex: none; }
      .flx-sub i.rec { animation: flx-sub-pulse 1.6s ease-in-out infinite; }
      .flx-sub i.hist { background: var(--fl-accent); }
      .flx-sub em { font-style: normal; opacity: .55; }
      @keyframes flx-sub-pulse { 50% { opacity: .35; } }
      @media (prefers-reduced-motion: reduce) { .flx-sub i.rec { animation: none; } }
      @media (max-height: 500px) { :host([wall]) .flx-sub { display: none; } :host([wall]) .flx-chip { width: 28px; height: 28px; } }
      /* 7. The detections bar slides away (wide screens). */
      @media (min-width: 900px) and (min-height: 501px) {
        :host([wall]) ha-card { position: relative; }
        :host([wall]) .fl-side {
          display: block !important; overflow: hidden; touch-action: pan-y;
          transition: width .28s cubic-bezier(.2, .8, .2, 1);
        }
        :host([wall][side-off]) .fl-side { width: 0; visibility: hidden; transition: width .28s cubic-bezier(.2, .8, .2, 1), visibility 0s .28s; }
        :host([wall]) .fl-side > * { width: 250px; }
        .flx-side-tab {
          position: absolute; top: 50%; right: 250px; z-index: 6; transform: translateY(-50%);
          width: 18px; height: 64px; padding: 0; border: 0; border-radius: 10px 0 0 10px; cursor: pointer;
          display: grid; place-items: center; color: rgba(255,255,255,.8);
          background: rgba(20,23,31,.9); box-shadow: -4px 0 14px -6px rgba(0,0,0,.6);
          transition: right .28s cubic-bezier(.2, .8, .2, 1), background .2s; touch-action: none;
        }
        .flx-side-tab:hover { background: rgba(32,36,47,.96); }
        .flx-side-tab::before { content: ""; position: absolute; inset: -10px -4px -10px -18px; }
        .flx-side-tab svg { width: 14px; height: 14px; fill: currentColor; transition: transform .28s; }
        :host([wall][side-off]) .flx-side-tab { right: 0; }
        :host([wall][side-off]) .flx-side-tab svg { transform: rotate(180deg); }
        @media (prefers-reduced-motion: reduce) {
          :host([wall]) .fl-side, .flx-side-tab, .flx-side-tab svg { transition: none; }
        }
      }
      @media (max-width: 899px), (max-height: 500px) {
        .flx-side-tab { display: none; }
        :host([wall][side-off]) .fl-side { display: block; }
      }
      /* 8. The 24-hour bar slides away (wide screens, live only). */
      @media (min-width: 900px) and (min-height: 501px) {
        :host([wall]) .fl-livetl {
          touch-action: pan-x; overflow: hidden; max-height: 120px;
          transition: max-height .28s cubic-bezier(.2, .8, .2, 1), opacity .2s, margin .28s;
        }
        :host([wall][tl-off]) .fl-livetl { max-height: 0; opacity: 0; margin-top: 0; margin-bottom: 0; visibility: hidden; transition: max-height .28s cubic-bezier(.2, .8, .2, 1), opacity .2s, margin .28s, visibility 0s .28s; }
        :host([wall]) { --flx-side-w: 250px; }
        :host([wall][side-off]) { --flx-side-w: 0px; }
        /* A pull tab on the bar's top edge, in the middle (above 12:00): half
           on the bar, half in the gap above it, clear of the hour labels.
           With the bar away it becomes a tab on the bottom edge, same place. */
        .flx-tl-tab {
          position: absolute; z-index: 6; left: calc((100% - var(--flx-side-w, 250px)) / 2);
          bottom: calc(var(--flx-tl-h, 78px) - 3px); transform: translateX(-50%);
          width: 48px; height: 14px; padding: 0; border: 0; border-radius: 8px; cursor: pointer;
          display: grid; place-items: center; color: rgba(255,255,255,.8);
          background: rgba(20,23,31,.95); box-shadow: 0 2px 10px -4px rgba(0,0,0,.7);
          transition: bottom .28s cubic-bezier(.2, .8, .2, 1), left .28s cubic-bezier(.2, .8, .2, 1),
            width .28s, border-radius .28s, background .2s;
          touch-action: none;
        }
        :host([wall][tl-off]) .flx-tl-tab {
          bottom: 0; width: 64px; height: 16px; border-radius: 10px 10px 0 0;
          box-shadow: 0 -4px 14px -6px rgba(0,0,0,.6);
        }
        .flx-tl-tab:hover { background: rgba(32,36,47,.98); color: #fff; }
        .flx-tl-tab::before { content: ""; position: absolute; inset: -12px -10px -6px -10px; }
        .flx-tl-tab svg { width: 14px; height: 14px; fill: currentColor; transform: rotate(90deg); transition: transform .28s; }
        :host([wall][tl-off]) .flx-tl-tab svg { transform: rotate(-90deg); }
        :host([wall]:not([tl-live])) .flx-tl-tab { display: none; }
        @media (prefers-reduced-motion: reduce) {
          :host([wall]) .fl-livetl, .flx-tl-tab, .flx-tl-tab svg { transition: none; }
        }
      }
      @media (max-width: 899px), (max-height: 500px) { .flx-tl-tab { display: none; } }
      /* 10. ?blur: camera pictures and photos blurred, the wall stays sharp. */
      :host([flx-blur]) advanced-camera-card,
      :host([flx-blur]) video,
      :host([flx-blur]) .tile img,
      :host([flx-blur]) .fl-ev img,
      :host([flx-blur]) .fast-strip img { filter: blur(22px) saturate(1.15); }
      :host([flx-blur]) #stage,
      :host([flx-blur]) .tile { background-image: none !important; }
      /* 9. PTZ pill on rows from the PTZ's linked cameras. */
      :host([wall]) .fl-ev.flx-has-ptz { position: relative; padding-right: 50px; }
      .flx-ev-ptz {
        position: absolute; right: 8px; top: 50%; transform: translateY(-50%);
        display: inline-flex; align-items: center; gap: 3px; padding: 3px 7px 3px 5px;
        border-radius: 999px; font-size: 10.5px; font-weight: 700; letter-spacing: .04em;
        color: #fff; background: rgba(255,255,255,.1); box-shadow: inset 0 0 0 1px rgba(255,255,255,.14);
        cursor: pointer; transition: background .15s;
      }
      .flx-ev-ptz svg { width: 12px; height: 12px; fill: currentColor; }
      .flx-ev-ptz::before { content: ""; position: absolute; inset: -12px -8px -12px -10px; }
      .flx-ev-ptz:hover, .flx-ev-ptz:focus-visible { background: var(--fl-accent, #3b82f6); outline: none; }
      /* 6. Layout switch: Focus / Grid / Single, beside Live / History. */
      .flx-lm { margin-right: 8px; }
      .flx-lm button { width: 36px; padding: 0 !important; display: grid; place-items: center; }
      .flx-lm svg { width: 17px; height: 17px; fill: currentColor; display: block; }
      .flx-lm button:disabled { opacity: .35; cursor: default; }
      @media (max-width: 899px), (max-height: 500px) { .flx-lm { display: none !important; } }
      @media (min-width: 900px) and (min-height: 501px) {
        :host([wall][lm="single"]) .fl-main .tile,
        :host([wall][lm="single"]) .fl-main .fl-sum { display: none !important; }
        :host([wall][lm="single"]) .fl-main > .stage { grid-column: 1 / -1; }
        :host([wall][lm="grid"]) .fl-main > .stage { grid-column: span 1; grid-row: span 1; }
        :host([wall][lm="grid"]) .fl-main .tile.active { display: none !important; }
        :host([wall][lm="grid"]) .fl-main > .head { order: -1; }
        :host([wall][lm="grid"]) .fl-main .fl-sum { order: 9998; }
        :host([wall][lm="grid"]) .fl-main > .fl-tl,
        :host([wall][lm="grid"]) .fl-main > .fl-deck,
        :host([wall][lm="grid"]) .fl-main > .fast-filter,
        :host([wall][lm="grid"]) .fl-main > .err { order: 9999; }
        /* The joystick sets its own display, so hide it this way instead. */
        :host([wall][lm="grid"]) .stage:not(.fl-full) > .fl-ptz,
        :host([wall][lm="grid"]) .stage:not(.fl-full) > .fl-presets,
        :host([wall][lm="grid"]) .flx-ptzrow { visibility: hidden !important; pointer-events: none !important; }
      }
      /* The tile's REC marker as a real button, drawn exactly as before. */
      .flx-rec {
        display: none; position: absolute; left: 7px; top: 7px; height: 20px; box-sizing: border-box;
        margin: 0; padding: 0 8px 0 19px; border: 0; border-radius: 999px; color: #fff;
        font-family: inherit; font-size: 10.5px; font-weight: 700; letter-spacing: .08em; line-height: 20px;
        background: radial-gradient(circle at 10px 50%, #fff 0 3px, transparent 3.5px), rgba(255,90,82,.92);
        text-align: left; -webkit-appearance: none; appearance: none;
        cursor: pointer; -webkit-tap-highlight-color: transparent;
      }
      .flx-rec::before { content: ""; position: absolute; inset: -7px; } /* a finger-sized target */
      .tile.fl-recording > .flx-rec { display: block; }
      .tile.fl-recording:has(> .flx-rec)::after { display: none; }

      /* Fill the screen (wide screens): the wall is exactly as tall as the room
         under the page header. The number of tile columns is picked so the
         natural 16:9 layout comes closest to that room (3 to 7 columns); the camera rows then
         share the small remainder, so there is no gap at the bottom and tiles
         are only slightly cropped. The big picture is always shown whole. */
      :host([wall][flx-fill]) ha-card { height: var(--flx-fill-h); }
      :host([wall][flx-fill]) .fl-main {
        grid-template-columns: repeat(var(--flx-cols, 5), minmax(0, 1fr));
        grid-template-rows: var(--flx-rows); align-content: stretch;
      }
      :host([wall][flx-fill]) .fl-main > .stage,
      :host([wall][flx-fill]) .fl-main .tile,
      :host([wall][flx-fill]) .fl-main .fl-sum { aspect-ratio: auto; height: auto; min-height: 0; }
      :host([wall][flx-fill]) .fl-main > .stage { overflow: hidden; }
      /* ---- polish: tiles ---------------------------------------------------
         The name sits on a soft fade at the foot of the picture instead of a
         box laid over it; counts and REC are small frosted chips; a tile
         answers a press with a little spring. */
      :host([wall]) .tile {
        --flx-spring: cubic-bezier(.34,1.56,.64,1);
        transition: transform .32s var(--flx-spring), box-shadow .2s, outline-color .2s;
        -webkit-tap-highlight-color: transparent;
      }
      :host([wall]) .tile:active { transform: scale(.975); }
      @media (hover: hover) { :host([wall]) .tile:hover { box-shadow: 0 8px 22px -10px rgba(0,0,0,.8); } }
      :host([wall]) .tile .label {
        inset: auto 0 0 0; max-width: none; border-radius: 0;
        padding: 26px 10px 7px; background: linear-gradient(to top, rgba(5,7,11,.82), rgba(5,7,11,.42) 45%, rgba(5,7,11,0));
        font-size: 12.5px; font-weight: 600; letter-spacing: .01em; line-height: 1.2;
        text-shadow: 0 1px 2px rgba(0,0,0,.55); pointer-events: none;
        display: flex; align-items: center; gap: 6px;
      }
      :host([wall]) .tile .label .dot { flex: none; width: 6px; height: 6px; margin: 0; border-radius: 50%; }
      :host([wall]) .tile.fl-motion:not(.active) {
        outline: 1.5px solid color-mix(in srgb, var(--fl-accent) 80%, #fff); outline-offset: -1.5px;
        box-shadow: 0 0 0 3px color-mix(in srgb, var(--fl-accent) 22%, transparent);
      }
      :host([wall]) .tile.fl-motion .label .dot { background: var(--fl-accent); }
      :host([wall]) .fast-badge {
        right: 6px; top: 6px; gap: 3px; padding: 2px 7px 2px 5px;
        font-size: 11.5px; font-weight: 600; letter-spacing: .01em;
        background: rgba(12,14,20,.72); border: .5px solid rgba(255,255,255,.14);
      }
      :host([wall]) .fast-badge svg { width: 12px; height: 12px; }
      :host([wall]) .fast-badge svg:not(:first-child) { margin-left: 4px; }
      :host([wall]) .flx-rec {
        left: 6px; top: 6px; height: 19px; padding: 0 7px 0 17px; font-size: 10px; letter-spacing: .09em;
        background: rgba(12,14,20,.72); border: .5px solid rgba(255,255,255,.14);
        transition: transform .28s cubic-bezier(.34,1.56,.64,1);
      }
      :host([wall]) .flx-rec::after {
        content: ""; position: absolute; left: 7px; top: 50%; width: 6px; height: 6px; margin-top: -3px;
        border-radius: 50%; background: #ff5a52; animation: flx-rec 1.8s ease-in-out infinite;
      }
      :host([wall]) .flx-rec:active { transform: scale(.92); }
      @keyframes flx-rec { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }
      /* No live blur over playing video on the wall: Firefox redraws a blur on
         every video frame and fell behind (frozen pictures, choppy sound). */
      :host([wall]) .fl-badge, :host([wall]) .fl-act {
        -webkit-backdrop-filter: none; backdrop-filter: none; background: rgba(16,19,26,.84);
      }
      #mute[hidden] { display: none !important; }
      /* Live / History is the same switch in the header on every screen; the
         icon rail down the left side is gone (it was clutter on a PC). */
      :host([wall]) .fl-rail { display: none; }
      :host([wall]) .modes { display: inline-flex; }
      /* The camera on the big picture keeps its place in the grid and lights
         up (it used to vanish, so every tile after it shuffled along). */
      :host([wall]) .tile.active {
        display: block;
        outline: 2px solid var(--fl-accent); outline-offset: -2px;
        box-shadow: 0 0 0 4px color-mix(in srgb, var(--fl-accent) 26%, transparent),
          0 12px 28px -12px color-mix(in srgb, var(--fl-accent) 70%, transparent);
      }
      :host([wall]) .tile::before {
        content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none; border-radius: inherit;
        background: color-mix(in srgb, var(--fl-accent) 18%, transparent);
        opacity: 0; transition: opacity .25s;
      }
      :host([wall]) .tile.active::before { opacity: 1; }
      :host([wall]) .tile > .label, :host([wall]) .tile > .fast-badge, :host([wall]) .tile > .flx-rec { z-index: 3; }
      :host([wall]) .tile.active .label {
        color: #fff;
        background: linear-gradient(to top, color-mix(in srgb, var(--fl-accent) 62%, #05070b),
          color-mix(in srgb, var(--fl-accent) 22%, transparent) 55%, transparent);
      }
      :host([wall]) .tile.active .label .dot { display: inline-block; background: #fff;
        box-shadow: 0 0 0 3px color-mix(in srgb, #fff 25%, transparent); }

      /* LIVE tucked into the bottom-left corner of the big picture (the
         camera's own name is printed bottom right), RECORDING just above it.
         Controls already in that corner push it up above them. */
      :host([wall]) .stage > .fl-status {
        top: auto; right: auto; left: max(8px, env(safe-area-inset-left));
        bottom: max(8px, env(safe-area-inset-bottom));
        flex-direction: column-reverse; align-items: flex-start;
      }
      :host([wall]) .stage:has(> .fast-buttons) > .fl-status { bottom: calc(max(12px, env(safe-area-inset-bottom)) + 52px); }
      :host([wall]) .stage[data-ptz="wide"]:has(> .fl-ptz) > .fl-status { bottom: calc(max(12px, env(safe-area-inset-bottom)) + 128px); }
      /* Phone on its side: the joystick fills the left bar, so LIVE takes the right one. */
      :host([wall]) .stage[data-ptz="short"]:has(> .fl-ptz) > .fl-status {
        left: auto; right: max(8px, env(safe-area-inset-right)); align-items: flex-end;
      }
      :host([wall]) .stage[data-ptz="wide"] > .fl-presets, :host([wall]) .stage[data-ptz="short"] > .fl-presets {
        bottom: auto; top: max(12px, env(safe-area-inset-top)); flex-direction: column;
      }
      :host([wall]) .stage.fl-full > .fl-presets { right: calc(max(12px, env(safe-area-inset-right)) + 56px); }
      /* First arrival on the tab: the tiles rise in, one after another. */
      :host([wall]:not([flx-shown])) .fl-main > .tile, :host([wall]:not([flx-shown])) .fl-main .grid > .tile {
        animation: flx-in .5s cubic-bezier(.2,.8,.2,1) both;
      }
      ${Array.from({ length: 12 }, (_, i) => `:host([wall]:not([flx-shown])) .tile:nth-child(${i + 1}) { animation-delay: ${60 + i * 45}ms; }`).join("\n      ")}
      @keyframes flx-in { from { opacity: 0; transform: translateY(10px) scale(.985); } to { opacity: 1; transform: none; } }

      /* ---- polish: the PTZ dock and Views -----------------------------------
         Same raised material as the joystick, so the controls read as a set. */
      .flx-ptzrow {
        background: linear-gradient(180deg, color-mix(in srgb, var(--fl-panel) 100%, #fff 2%), var(--fl-panel));
        padding: 12px 14px;
      }
      :host([wall]) .fl-preset-btn {
        height: 40px; padding: 0 14px 0 12px; gap: 7px; color: #fff;
        background: linear-gradient(180deg, rgba(40,45,57,.94), rgba(17,20,27,.96));
        border: 1px solid rgba(255,255,255,.09);
        box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 10px 24px -10px rgba(0,0,0,.7), 0 2px 6px rgba(0,0,0,.35);
        transition: transform .28s cubic-bezier(.34,1.56,.64,1), background .2s;
        -webkit-tap-highlight-color: transparent; --mdc-icon-size: 17px;
      }
      :host([wall]) .fl-preset-btn:active { transform: scale(.94); }
      :host([wall]) .fl-presets:has(> .fl-preset-list:not([hidden])) > .fl-preset-btn { background: var(--fl-accent); color: var(--fl-on-accent, #fff); border-color: transparent; }
      /* The saved views unfold one by one. */
      :host([wall]) .fl-preset-list:not([hidden]) button {
        animation: flx-pop .32s cubic-bezier(.34,1.56,.64,1) both;
        background: rgba(20,23,31,.94); border-color: rgba(255,255,255,.10);
      }
      ${Array.from({ length: 12 }, (_, i) => `:host([wall]) .fl-preset-list:not([hidden]) button:nth-last-child(${i + 1}) { animation-delay: ${i * 28}ms; }`).join("\n      ")}
      @keyframes flx-pop { from { opacity: 0; transform: translateY(8px) scale(.94); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) {
        :host([wall]) .tile, :host([wall]) .fl-preset-btn, :host([wall]) .flx-rec { transition: none; }
        :host([wall]) .flx-rec::after, :host([wall]) .tile, :host([wall]) .fl-preset-list button { animation: none !important; }
      }
      /* 5. PERSON / VEHICLE while an event is being recorded: a chip just above
         the tile's name, and one above LIVE / RECORDING on the big picture. */
      :host([wall]) .flx-tag {
        position: absolute; left: 8px; bottom: 30px; z-index: 3; pointer-events: none;
        display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px 2px 5px; border-radius: 999px;
        background: var(--flx-kind); color: #0b0d12; box-shadow: 0 2px 8px rgba(0,0,0,.35);
        font-size: 10.5px; font-weight: 700; letter-spacing: .04em; line-height: 1.35; text-transform: uppercase;
        animation: flx-tag-in .35s cubic-bezier(.34,1.56,.64,1) both;
      }
      :host([wall]) .flx-tag svg { fill: currentColor !important; }
      :host([wall]) .stage > .fl-status > .flx-tag {
        position: static; font-size: 11.5px; padding: 4px 10px 4px 8px; gap: 5px;
      }
      @keyframes flx-tag-in { from { opacity: 0; transform: translateY(4px) scale(.9); } to { opacity: 1; transform: none; } }
      @media (prefers-reduced-motion: reduce) { :host([wall]) .flx-tag { animation: none; } }
    `;
    const ensureStyle = (host) => {
      const root = host.shadowRoot;
      if (!root || root.querySelector("#flx-look")) return;
      const style = document.createElement("style");
      style.id = "flx-look";
      style.textContent = CSS;
      const card = root.querySelector("ha-card");
      if (card) root.insertBefore(style, card); // after fast-live's look, so it wins ties
      else root.appendChild(style);
    };
    const BELL =
      "M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 " +
      "14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21";
    const bell = (size) =>
      `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;flex:none;fill:currentColor">` +
      `<path d="${BELL}"/></svg>`;

    // ---- 1. PTZ controls: on the picture, or in a row under it ------------------
    // Only the joystick and the Views button move; the picture and its camera
    // stay where they are (moving those would reconnect the stream).
    const placePtz = (host) => {
      const root = host.shadowRoot;
      if (!root) return;
      const stage = root.querySelector("#stage");
      let row = root.querySelector(".flx-ptzrow");
      const parts = [...root.querySelectorAll(".fl-ptz, .fl-presets")];
      if (!stage || !isWall(host) || host._mode !== "live") {
        if (row) row.remove();
        return;
      }
      fitShort(host);
      // In full screen only the picture is on screen, so the controls go on it.
      const mode = ptzMode(host, stage);
      stage.dataset.ptz = mode;
      const stick = parts.find((part) => part.localName === "arcane-ptz-joystick");
      if (stick && stick._flxMode !== mode && stick._flxBase) {
        stick._flxMode = mode;
        stick.setConfig({ ...stick._flxBase, ...STICK[mode] });
      }
      const parent = stage.parentElement;
      const under = mode === "dock" && parts.length && parent && parent.classList.contains("fl-main");
      if (under) {
        if (!row) {
          row = document.createElement("div");
          row.className = "flx-ptzrow";
          // The saved views open upwards over the picture: as tall as there is room.
          row.addEventListener(
            "click",
            () => {
              const list = row.querySelector(".fl-preset-list");
              const open = row.querySelector(".fl-preset-btn");
              const picture = root.querySelector("#stage");
              if (!list || !open || !picture) return;
              const room = open.getBoundingClientRect().top - picture.getBoundingClientRect().top - 12;
              list.style.maxHeight = `${Math.max(0, Math.floor(room))}px`;
            },
            true
          );
        }
        if (row.previousElementSibling !== stage) {
          const fresh = !row.isConnected;
          stage.after(row); // the stage itself stays put
          if (fresh && row.animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
            row.animate([{ opacity: 0, transform: "translateY(-8px)" }, { opacity: 1, transform: "none" }],
              { duration: 320, easing: "cubic-bezier(.2,.8,.2,1)" });
          }
        }
        for (const part of parts) if (part.parentElement !== row) row.appendChild(part);
      } else {
        for (const part of parts) {
          const list = part.querySelector && part.querySelector(".fl-preset-list");
          if (list) list.style.maxHeight = "";
          if (part.parentElement !== stage) stage.appendChild(part);
        }
        if (row) row.remove();
      }
    };
    // Re-place (and re-fit) when the screen turns or changes size.
    const watchNarrow = (host) => {
      if (host._flxNarrow) return;
      host._flxNarrow = () => {
        placePtz(host);
        setTimeout(() => placePtz(host), 250); // after the page has settled
      };
      for (const query of [NARROW, SHORT]) {
        if (query.addEventListener) query.addEventListener("change", host._flxNarrow);
        else query.addListener(host._flxNarrow);
      }
      window.addEventListener("resize", host._flxNarrow);
    };
    // ---- 7. detections bar: swipe / handle --------------------------------------------
    const SIDE_KEY = "ultimate-nvr-side";
    const DRAGGABLE = ".timeline, .fl-tl, .fl-deck, .fl-ptz, .fl-presets, .fast-buttons, .flx-side-tab, .flx-tl-tab";
    const edgeOk = (host, event) => {
      const root = host.shadowRoot;
      if (root && root.querySelector(".stage.fl-full")) return false;
      const path = event.composedPath ? event.composedPath() : [event.target];
      return !path.some((node) => node instanceof Element && node.matches(DRAGGABLE));
    };
    const wideScreen = () => !NARROW.matches && !SHORT.matches;
    const setSide = (host, open, remember = true) => {
      host._sideOff = !open;
      host.toggleAttribute("side-off", !open);
      if (remember) {
        try {
          window.localStorage.setItem(SIDE_KEY, open ? "open" : "closed");
        } catch (_) {
          /* not remembered in a private window */
        }
      }
      const tab = host.shadowRoot && host.shadowRoot.querySelector(".flx-side-tab");
      if (tab) tab.setAttribute("aria-label", open ? "Hide detections" : "Show detections");
      haptic("light");
      // The wall gets wider or narrower as the bar slides: fit it again after.
      clearTimeout(host._flxSideFit);
      host._flxSideFit = setTimeout(() => fillScreen(host), 320);
    };
    const swipe = (el, onSwipe, startOk = () => true, capture = false) => {
      let start = null;
      el.addEventListener(
        "click",
        (event) => {
          if (Date.now() - (el._flxSwipedAt || 0) < 400) {
            event.stopImmediatePropagation();
            event.preventDefault();
          }
        },
        true
      );
      el.addEventListener("pointerdown", (event) => {
        start = event.isPrimary && startOk(event) ? { x: event.clientX, y: event.clientY, t: Date.now() } : null;
        if (start && capture && el.setPointerCapture) {
          try {
            el.setPointerCapture(event.pointerId);
          } catch (_) {
            /* the pointer is already gone */
          }
        }
      });
      el.addEventListener("pointerup", (event) => {
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const quick = Date.now() - start.t < 700;
        start = null;

        let direction = null;
        if (quick && Math.abs(dx) > 50 && Math.abs(dy) < 40) direction = dx > 0 ? "right" : "left";
        else if (quick && Math.abs(dy) > 40 && Math.abs(dx) < 50) direction = dy > 0 ? "down" : "up";
        if (direction) {
          el._flxSwipedAt = Date.now();
          onSwipe(direction, event);
        }
      });
      el.addEventListener("pointercancel", () => {
        start = null;
      });
    };
    const ensureSideBar = (host) => {
      const root = host.shadowRoot;
      const card = root && root.querySelector("ha-card");
      const side = root && root.querySelector(".fl-side");
      if (!card || !side) return;
      if (!host._flxSideInit) {
        host._flxSideInit = true;
        let saved = null;
        try {
          saved = window.localStorage.getItem(SIDE_KEY);
        } catch (_) {
          /* private window */
        }
        if (saved === "closed") host._sideOff = true;
      }
      host.toggleAttribute("side-off", !!host._sideOff && wideScreen());
      if (!card.querySelector(":scope > .flx-side-tab")) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "flx-side-tab";
        tab.setAttribute("aria-label", host._sideOff ? "Show detections" : "Hide detections");
        tab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z"/></svg>';
        tab.addEventListener("click", (event) => {
          event.stopPropagation();
          if (Date.now() - (tab._flxSwipedAt || 0) < 400) return;
          setSide(host, !!host._sideOff);
        });
        // Drag the handle itself: left opens, right closes.
        swipe(
          tab,
          (direction) => {
            if (direction === "left" || direction === "right") setSide(host, direction === "left");
          },
          undefined,
          true
        );
        card.appendChild(tab);
      }
      if (!side._flxSwipe) {
        side._flxSwipe = true;
        // Swipe the bar to the right to tuck it away.
        swipe(side, (direction) => {
          if (wideScreen() && direction === "right" && !host._sideOff) setSide(host, false);
        });
      }
      if (!card._flxEdgeSwipe) {
        card._flxEdgeSwipe = true;
        // With the bar away: swipe in from the right edge to bring it back.
        swipe(
          card,
          (direction) => {
            if (wideScreen() && direction === "left" && host._sideOff) setSide(host, true);
          },
          (event) => host._sideOff && card.getBoundingClientRect().right - event.clientX < 40 && edgeOk(host, event)
        );
      }
    };

    // ---- 8. 24-hour bar: swipe / handle ------------------------------------------------
    const TL_KEY = "ultimate-nvr-timeline";
    const setTimelineBar = (host, open, remember = true) => {
      host._tlOff = !open;
      host.toggleAttribute("tl-off", !open);
      if (remember) {
        try {
          window.localStorage.setItem(TL_KEY, open ? "open" : "closed");
        } catch (_) {
          /* not remembered in a private window */
        }
      }
      const tab = host.shadowRoot && host.shadowRoot.querySelector(".flx-tl-tab");
      if (tab) tab.setAttribute("aria-label", open ? "Hide the 24-hour bar" : "Show the 24-hour bar");
      haptic("light");
      clearTimeout(host._flxTlFit);
      host._flxTlFit = setTimeout(() => {
        fillScreen(host);
        measureTimelineBar(host, host.shadowRoot && host.shadowRoot.querySelector(".fl-main > .fl-livetl"));
      }, 320);
    };
    const measureTimelineBar = (host, bar) => {
      const height = bar && (host._tlOff ? bar.scrollHeight : bar.offsetHeight);
      if (height) host.style.setProperty("--flx-tl-h", `${height + 2}px`);
    };
    const ensureTimelineBar = (host) => {
      const root = host.shadowRoot;
      const card = root && root.querySelector("ha-card");
      if (!card) return;
      if (!host._flxTlInit) {
        host._flxTlInit = true;
        let saved = null;
        try {
          saved = window.localStorage.getItem(TL_KEY);
        } catch (_) {
          /* private window */
        }
        if (saved === "closed") host._tlOff = true;
      }
      host.toggleAttribute("tl-off", !!host._tlOff && wideScreen());
      const bar = root.querySelector(".fl-main > .fl-livetl");
      // The handle only shows while there is a live 24-hour bar to hide.
      host.toggleAttribute("tl-live", !!bar);
      if (!bar) return;
      measureTimelineBar(host, bar);
      if (!card.querySelector(":scope > .flx-tl-tab")) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "flx-tl-tab";
        tab.setAttribute("aria-label", host._tlOff ? "Show the 24-hour bar" : "Hide the 24-hour bar");
        tab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z"/></svg>';
        tab.addEventListener("click", (event) => {
          event.stopPropagation();
          if (Date.now() - (tab._flxSwipedAt || 0) < 400) return;
          setTimelineBar(host, !!host._tlOff);
        });
        swipe(
          tab,
          (direction) => {
            if (direction === "up" || direction === "down") setTimelineBar(host, direction === "up");
          },
          undefined,
          true
        );
        card.appendChild(tab);
      }
      if (!bar._flxSwipe) {
        bar._flxSwipe = true;
        // Swipe the bar down to tuck it away. A swipe is not a tap on the
        // timeline: swallow the click that follows it.
        swipe(bar, (direction) => {
          if (wideScreen() && direction === "down" && !host._tlOff) setTimelineBar(host, false);
        });
      }
      if (!card._flxTlEdgeSwipe) {
        card._flxTlEdgeSwipe = true;
        // With the bar away: swipe up from the bottom edge to bring it back.
        swipe(
          card,
          (direction) => {
            if (wideScreen() && direction === "up" && host._tlOff && host.hasAttribute("tl-live")) setTimelineBar(host, true);
          },
          (event) => host._tlOff && card.getBoundingClientRect().bottom - event.clientY < 40 && edgeOk(host, event)
        );
      }
    };

    // ---- 9. PTZ pill in the detections list -------------------------------------------
    const PTZ_ICON =
      '<svg viewBox="0 0 24 24"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.4-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>';
    const ptzLinked = (host) => {
      const ptz = host._config && host._config.ptz;
      if (!ptz || ptz.channel === undefined) return null;
      const linked = (ptz.linked || []).map(Number).filter((ch) => ch !== Number(ptz.channel));
      const rings = (ptz.ring_follow || []).map(Number);
      return linked.length || rings.length ? { channel: Number(ptz.channel), linked, rings } : null;
    };
    const decorateSide = (host) => {
      const link = ptzLinked(host);
      const list = host.shadowRoot && host.shadowRoot.querySelector(".fl-side-list");
      if (!link || !list) return;
      list.querySelectorAll(".fl-ev[data-key]:not(.flx-has-ptz)").forEach((row) => {
        const [ch, time] = row.dataset.key.split(":").map(Number);
        const ring = row.classList.contains("flx-ring");
        const wanted = ring ? link.rings.includes(ch) : link.linked.includes(ch);
        if (!wanted || !time || row.querySelector(".flx-ev-ptz")) return;
        row.classList.add("flx-has-ptz");
        const pill = document.createElement("span");
        pill.className = "flx-ev-ptz";
        pill.setAttribute("role", "button");
        pill.tabIndex = 0;
        pill.title = "Watch the PTZ's recording of this moment";
        pill.setAttribute("aria-label", pill.title);
        pill.innerHTML = `${PTZ_ICON}PTZ`;
        const open = (event) => {
          event.stopPropagation();
          event.preventDefault();
          host._flPicked = row.dataset.key;
          list.querySelectorAll(".fl-ev.fl-picked").forEach((b) => b.classList.remove("fl-picked"));
          row.classList.add("fl-picked");
          haptic("light");
          // A ring: the PTZ only starts recording as it turns to the door.
          W.goHistory(host, link.channel, ring ? time + 1000 : time - 5000);
        };
        pill._flxOpen = open;
        pill.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") open(event);
        });
        row.appendChild(pill);
      });
    };
    const watchSide = (host) => {
      const list = host.shadowRoot && host.shadowRoot.querySelector(".fl-side-list");
      if (!list) return;
      if (!list._flxPtzWatch) {
        list._flxPtzWatch = new MutationObserver(() => decorateSide(host));
        list._flxPtzWatch.observe(list, { childList: true });
        // Decide by where the tap landed, not by the click's target: some
        // browsers hand a click on a button's child to the button itself.
        // The pill's area includes its invisible margin (the ::before).
        list.addEventListener(
          "click",
          (event) => {
            const pill = [...list.querySelectorAll(".flx-ev-ptz")].find((p) => {
              const box = p.getBoundingClientRect();
              return (
                event.clientX >= box.left - 10 && event.clientX <= box.right + 8 &&
                event.clientY >= box.top - 12 && event.clientY <= box.bottom + 12 &&
                p.closest(".fl-ev").contains(event.target)
              );
            });
            if (pill && pill._flxOpen) pill._flxOpen(event);
          },
          true
        );
      }
      decorateSide(host);
    };

    // ---- 6. layout switch -------------------------------------------------------------
    const LAYOUT_KEY = "ultimate-nvr-layout";
    const LAYOUTS = [
      ["focus", "Focus: big picture and tiles", "M3 4h11v11H3zM16 4h5v5h-5zM16 11h5v4h-5zM3 17h5v3H3zM10 17h5v3h-5zM17 17h4v3h-4z"],
      ["grid", "Grid: every camera the same size", "M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"],
      ["single", "Single: one camera", "M3 5h18v14H3z"],
    ];
    const layoutOf = (host) => {
      if (NARROW.matches || SHORT.matches) return "focus"; // phones keep their own layout
      if (!host._flxLayout) {
        let saved = null;
        try {
          saved = window.localStorage.getItem(LAYOUT_KEY);
        } catch (_) {
          /* private window: use the default */
        }
        const option = host._config && host._config.view;
        const wanted = LAYOUTS.some(([id]) => id === option) ? option : "focus";
        host._flxLayout = LAYOUTS.some(([id]) => id === saved) ? saved : wanted;
      }
      // History plays on the big picture: Grid gives way to Focus there.
      if (host._mode === "playback" && host._flxLayout === "grid") return "focus";
      return host._flxLayout;
    };
    const paintLayoutSwitch = (host) => {
      const head = host.shadowRoot && host.shadowRoot.querySelector(".fl-main > .head");
      if (!head) return;
      let box = head.querySelector(".flx-lm");
      if (!box) {
        box = document.createElement("div");
        box.className = "fl-seg flx-lm";
        box.setAttribute("role", "group");
        box.setAttribute("aria-label", "Wall layout");
        box.innerHTML = LAYOUTS.map(
          ([id, label, icon]) =>
            `<button type="button" data-lm="${id}" title="${label}" aria-label="${label}">` +
            `<svg viewBox="0 0 24 24"><path d="${icon}"/></svg></button>`
        ).join("");
        box.addEventListener("click", (event) => {
          const button = event.target.closest("button[data-lm]");
          if (button) setLayout(host, button.dataset.lm);
        });
        head.insertBefore(box, head.querySelector(".modes") || null);
      }
      const current = host.getAttribute("lm") || "focus";
      box.querySelectorAll("button").forEach((b) => {
        b.setAttribute("aria-pressed", String(b.dataset.lm === current));
        b.disabled = b.dataset.lm === "grid" && host._mode === "playback";
      });
    };
    // `remember: false` for the automatic switch (a camera opened from Grid):
    // the wall still opens in Grid next time.
    const setLayout = (host, layout, remember = true) => {
      if (!LAYOUTS.some(([id]) => id === layout)) return;
      host._flxLayout = layout;
      if (remember) {
        try {
          window.localStorage.setItem(LAYOUT_KEY, layout);
        } catch (_) {
          /* not remembered in a private window */
        }
      }
      const glide = captureGlide(host);
      host.setAttribute("lm", layout);
      paintLayoutSwitch(host);
      // Measure from the natural layout, not the previous layout's sizes.
      host.removeAttribute("flx-fill");
      fillScreen(host);
      glide();
      requestAnimationFrame(() => fillScreen(host));
      if (W.syncTiles) W.syncTiles(host); // Single pauses the hidden tiles, the others bring them back
      haptic("light");
    };
    const orderCells = (host, layout) => {
      const root = host.shadowRoot;
      const ids = (host._channels || []).map((c) => c.id);
      root.querySelectorAll(".fl-main .tile").forEach((tile) => {
        tile.style.order = layout === "grid" ? String(ids.indexOf(Number(tile.dataset.channel)) + 1) : "";
      });
      const stage = root.querySelector(".fl-main > .stage");
      if (stage) stage.style.order = layout === "grid" ? String(ids.indexOf(host._selected) + 1) : "";
    };
    const applyLayout = (host) => {
      const layout = layoutOf(host);
      if (host.getAttribute("lm") !== layout) host.setAttribute("lm", layout);
      paintLayoutSwitch(host);
      if (!host._flxGridTap) {
        // In Grid, tapping a camera opens it in Focus (the card picks it as usual).
        host._flxGridTap = true;
        host.shadowRoot.addEventListener(
          "click",
          (event) => {
            if (host.getAttribute("lm") !== "grid" || NARROW.matches || SHORT.matches) return;
            const target = event.target;
            if (!target.closest) return;
            // Buttons keep their own jobs (a gate's Open, mute, REC, PTZ, views).
            if (target.closest("button, a, select, input, .fast-buttons, .flx-rec, .fl-ptz, .fl-presets, .fl-status")) return;
            if (target.closest(".tile")) {
              // The card picks the camera as usual; then open it in Focus.
              setTimeout(() => setLayout(host, "focus", false), 0);
              return;
            }
            const stage = target.closest(".stage");
            if (stage && !stage.classList.contains("fl-full")) {
              // The picked camera's own cell: Focus, not full screen.
              event.stopPropagation();
              setLayout(host, "focus", false);
            }
          },
          true
        );
      }
    };

    // ---- fill the screen -------------------------------------------------------------
    // Wide screens only (not phones, not a phone on its side, not full screen),
    // and not with `fill: false`. Never squashes: when even the most compact
    // layout is taller than the room, the page scrolls as before.
    const FILL_COLUMNS = [7, 6, 5, 4, 3]; // more columns let big systems fit
    const GAP = 4; // .fl-main gap
    const fillRoom = (host) => {
      const scroller = scrollParent(host);
      const box = host.getBoundingClientRect();
      if (scroller) {
        const top = box.top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        return scroller.clientHeight - top;
      }
      const visible = (window.visualViewport && window.visualViewport.height) || window.innerHeight;
      return visible - (box.top + window.scrollY);
    };
    // Where the Today cell goes so a layout has no holes, or null when that
    // layout cannot avoid one. Beside the 3 x 3 big picture are 3 rows of
    // (columns - 3) cells; the other cameras fill them first, then rows below.
    const sumFor = (columns, tiles) => {
      const beside = columns - 3;
      const room = 3 * beside;
      if (tiles >= room) {
        const left = (columns - ((9 + tiles) % columns)) % columns;
        return { span: left, rows: 1 };
      }
      if (beside === 1) return { span: 1, rows: room - tiles }; // a tall cell down the side
      if (tiles >= room - beside) return { span: room - tiles, rows: 1 }; // one short last row
      return null;
    };
    const placeSum = (main, tiles, columns, layout = "focus") => {
      // Grid: the big picture is one cell like the rest, so the leftover is
      // simply what the last row is short of.
      const place = layout === "grid"
        ? { span: (columns - ((tiles + 1) % columns)) % columns, rows: 1 }
        : layout === "single"
          ? { span: 0, rows: 1 }
          : sumFor(columns, tiles) || { span: 0, rows: 1 };
      const left = place.span;
      let sum = main.querySelector(".fl-sum");
      if (!sum && left) {
        sum = document.createElement("div");
        sum.className = "fl-sum";
        (main.querySelector(".grid") || main).appendChild(sum);
      }
      if (!sum) return;
      sum.style.gridColumn = left ? `span ${left}` : "";
      sum.style.gridRow = left && place.rows > 1 ? `span ${place.rows}` : "";
      sum.style.display = left ? "" : "none";
    };
    const fillScreen = (host) => {
      try {
        const root = host.shadowRoot;
        const main = root && root.querySelector(".fl-main");
        const stage = root && root.querySelector(".fl-main > .stage");
        const layout = layoutOf(host);
        if (host.getAttribute("lm") !== layout) {
          // The screen crossed the phone / wide line (an iPad turned), or
          // History started: bring the layout in step before measuring.
          host.setAttribute("lm", layout);
          paintLayoutSwitch(host);
          if (W.syncTiles) W.syncTiles(host);
        }
        orderCells(host, layout);
        host.toggleAttribute("side-off", !!host._sideOff && wideScreen());
        host.toggleAttribute("tl-off", !!host._tlOff && wideScreen());
        if (stage && stage.classList.contains("fl-full")) return; // leave the wall underneath alone
        const tiles = main
          ? [...main.querySelectorAll(".tile")].filter((el) => getComputedStyle(el).display !== "none").length
          : 0;
        const giveUp = () => {
          placeSum(main, tiles, 5, layout);
          host.removeAttribute("flx-fill");
        };
        const wide = !NARROW.matches && !SHORT.matches;
        if (!main || !stage || !wide || (host._config && host._config.fill === false)) {
          if (main) giveUp();
          else host.removeAttribute("flx-fill");
          return;
        }
        const room = Math.floor(fillRoom(host) - 8);
        // What is not camera rows: the header row, and History's controls and
        // the timeline under the cameras.
        let fixed = 6; // .fl-main bottom padding
        for (const el of main.children) {
          if (el === stage || el.classList.contains("tile") || el.classList.contains("fl-sum") ||
              el.classList.contains("grid") || getComputedStyle(el).display === "none") continue;
          fixed += el.getBoundingClientRect().height + GAP;
        }
        const width = main.clientWidth - 8; // .fl-main side padding
        if (layout === "single") {
          // One camera: the big picture takes the whole width and height.
          host.style.setProperty("--flx-cols", "5");
          host.style.setProperty("--flx-fill-h", `${room}px`);
          host.style.setProperty("--flx-rows", "auto repeat(3, minmax(0, 1fr))");
          placeSum(main, tiles, 5, layout);
          host.setAttribute("flx-fill", "");
          return;
        }
        if (layout === "grid") {
          // Every camera one cell (the big picture is the selected one's cell).
          const cells = tiles + 1;
          let pick = null;
          for (const columns of [6, 5, 4, 3, 2]) {
            const cell = (width - (columns - 1) * GAP) / columns;
            if (cell < 170) continue;
            const rows = Math.ceil(cells / columns);
            const natural = fixed + rows * ((cell * 9) / 16) + (rows - 1) * GAP;
            if (natural <= room && (!pick || natural > pick.natural)) pick = { columns, rows, natural };
          }
          if (!pick || room < 360) {
            giveUp();
            return;
          }
          host.style.setProperty("--flx-cols", String(pick.columns));
          host.style.setProperty("--flx-fill-h", `${room}px`);
          host.style.setProperty("--flx-rows", `auto repeat(${pick.rows}, minmax(0, 1fr))`);
          placeSum(main, tiles, pick.columns, layout);
          host.setAttribute("flx-fill", "");
          return;
        }
        let best = null;
        for (const columns of FILL_COLUMNS) {
          if (!sumFor(columns, tiles)) continue; // this layout would leave a hole
          const cell = (width - (columns - 1) * GAP) / columns;
          if (cell < 170) continue; // tiles this small: better to scroll
          const rows = Math.max(3, Math.ceil((9 + tiles) / columns));
          const natural = fixed + rows * ((cell * 9) / 16) + (rows - 1) * GAP;
          if (natural <= room && (!best || natural > best.natural)) best = { columns, rows, natural };
        }
        if (!best || room < 360) {
          giveUp();
          return;
        }
        host.style.setProperty("--flx-cols", String(best.columns));
        host.style.setProperty("--flx-fill-h", `${room}px`);
        host.style.setProperty("--flx-rows", `auto repeat(${best.rows}, minmax(0, 1fr))`);
        placeSum(main, tiles, best.columns);
        host.setAttribute("flx-fill", "");
      } catch (err) {
        console.warn("nvr wall: fill the screen failed", err);
      }
    };
    const watchFill = (host) => {
      if (host._flxFill) return;
      let queued = false;
      host._flxFill = () => {
        if (queued) return;
        queued = true;
        requestAnimationFrame(() => {
          queued = false;
          fillScreen(host);
        });
      };
      window.addEventListener("resize", host._flxFill);
      // The page header can change height without the window resizing (edit
      // mode, a tab bar appearing): watch the box the card sits in.
      if (window.ResizeObserver && host.parentElement) {
        host._flxFillObs = new ResizeObserver(host._flxFill);
        host._flxFillObs.observe(host.parentElement);
      }
    };
    const unwatchFill = (host) => {
      if (!host._flxFill) return;
      window.removeEventListener("resize", host._flxFill);
      if (host._flxFillObs) host._flxFillObs.disconnect();
      host._flxFillObs = null;
      host._flxFill = null;
    };
    const unwatchNarrow = (host) => {
      if (!host._flxNarrow) return;
      for (const query of [NARROW, SHORT]) {
        if (query.removeEventListener) query.removeEventListener("change", host._flxNarrow);
        else query.removeListener(host._flxNarrow);
      }
      window.removeEventListener("resize", host._flxNarrow);
      host._flxNarrow = null;
    };
    // Called by fast-live.js right after it has (re)built the PTZ controls on the
    // picture. Controls left in the row belong to the picture before: drop them.
    const watchStage = (host, stage) => {
      if (host._flxObs) host._flxObs.disconnect();
      // Going in or out of full screen toggles the picture's `fl-full` class.
      host._flxObs = new MutationObserver(() => placePtz(host));
      host._flxObs.observe(stage, { attributes: true, attributeFilter: ["class"] });
      watchNarrow(host);
      placePtz(host);
    };
    // When the PTZ dock comes or goes (picking another camera), the tiles under
    // it glide to their new place instead of jumping.
    const captureGlide = (host) => {
      const els = [...host.shadowRoot.querySelectorAll(".fl-main .tile, .fl-main > .fl-tl, .fl-main .fl-sum")];
      const before = els.map((el) => el.getBoundingClientRect().top);
      return () => {
        if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        els.forEach((el, i) => {
          if (!el.isConnected || !el.animate) return;
          const d = before[i] - el.getBoundingClientRect().top;
          if (Math.abs(d) < 2 || Math.abs(d) > 400) return;
          el.animate([{ transform: `translateY(${d}px)` }, { transform: "none" }],
            { duration: 420, easing: "cubic-bezier(.2,.8,.2,1)" });
        });
      };
    };
    W.ptz = (host, stage) => {
      if (!isWall(host)) return;
      ensureStyle(host);
      const glide = captureGlide(host);
      const old = host.shadowRoot.querySelector(".flx-ptzrow");
      if (old) old.remove();
      // The joystick's own settings, so its size and button layout can be
      // changed to suit where it sits without losing them.
      const stick = stage.querySelector("arcane-ptz-joystick");
      if (stick && !stick._flxBase) {
        const ptz = (host._config && host._config.ptz) || {};
        stick._flxBase = {
          script: "script.ptz_move",
          max_speed: 70,
          zoom: true,
          aim: true,
          card: false,
          zoom_out_full_script: "script.ptz_zoom_out_full",
          ...(ptz.joystick || {}),
        };
        stick._flxMode = "wide";
      }
      watchStage(host, stage);
      glide();
      waitForStick(host);
    };
    // On a phone the joystick's own file can arrive after the wall is drawn, and
    // the card only builds a joystick that is already defined: the first visit
    // showed Views but no joystick. Add it the moment it is defined.
    const waitForStick = (host) => {
      const ptz = host._config && host._config.ptz;
      if (!ptz || customElements.get("arcane-ptz-joystick") || host._flxWaitStick) return;
      host._flxWaitStick = true;
      customElements.whenDefined("arcane-ptz-joystick").then(() => {
        host._flxWaitStick = false;
        const root = host.shadowRoot;
        const stage = root && root.querySelector("#stage");
        if (!stage || !isWall(host) || host._mode !== "live" || Number(ptz.channel) !== host._selected) return;
        if (root.querySelector("arcane-ptz-joystick")) return;
        const base = { script: "script.ptz_move", max_speed: 70, size: 120, zoom: true, aim: true, card: false, zoom_out_full_script: "script.ptz_zoom_out_full", ...(ptz.joystick || {}) };
        const stick = document.createElement("arcane-ptz-joystick");
        stick.className = "fl-ptz";
        stick.setConfig(base);
        stick.hass = host._hass;
        stick._flxBase = base;
        stick._flxMode = "wide";
        const row = root.querySelector(".flx-ptzrow");
        if (row) row.prepend(stick);
        else stage.appendChild(stick);
        host._ptzEl = stick;
        placePtz(host);
      });
    };

    // ---- 2. gate and doorbell rings in the detections list ----------------------
    const ringSensors = (host) => {
      const out = [];
      const all = (host._config && host._config.fast_live) || {};
      const have = new Set((host._channels || []).map((c) => c.id));
      for (const key of Object.keys(all)) {
        const entry = all[key];
        const ch = Number(key);
        if (!entry || !have.has(ch)) continue;
        for (const id of [].concat(entry.ring || [])) {
          if (typeof id !== "string" || !id.includes(".")) continue;
          const label = entry.ring_label || (/gate/i.test(id) ? "Gate rang" : "Doorbell rang");
          out.push({ ch, id, label });
        }
      }
      return out;
    };
    // History rows come compressed ({s, lu, lc}, seconds) or in full
    // ({state, last_changed}, ISO text). Anything else: no time.
    const whenOf = (row) => {
      const value = row.lc !== undefined ? row.lc : row.lu !== undefined ? row.lu : row.last_changed || row.last_updated;
      if (typeof value === "number") return value * 1000;
      const ms = Date.parse(value);
      return Number.isNaN(ms) ? null : ms;
    };
    // Called by fast-live.js each time it fetches today's detections (every
    // 2 minutes on the wall), so the rings refresh no more often than those.
    W.counts = async (host) => {
      if (!isWall(host) || host._flxRingBusy) return;
      const sensors = ringSensors(host);
      if (!sensors.length || !host._hass || typeof host._hass.callWS !== "function") return;
      host._flxRingBusy = true;
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const data = await host._hass.callWS({
          type: "history/history_during_period",
          start_time: start.toISOString(),
          end_time: new Date().toISOString(),
          entity_ids: [...new Set(sensors.map((s) => s.id))],
          minimal_response: true,
          no_attributes: true,
        });
        if (!data || typeof data !== "object") return;
        const rings = [];
        for (const sensor of sensors) {
          const states = Array.isArray(data[sensor.id]) ? data[sensor.id] : [];
          let before = null;
          states.forEach((row, index) => {
            if (!row || typeof row !== "object") return;
            const state = row.s !== undefined ? row.s : row.state;
            const time = whenOf(row);
            // Off -> on is one ring. The first row is the state at midnight.
            if (index > 0 && state === "on" && before === "off" && time && time >= start.getTime()) {
              rings.push({ ch: sensor.ch, time, kind: "ring", ring: true, label: sensor.label });
            }
            before = state;
          });
        }
        host._flRings = rings;
        paintSide(host);
      } catch (err) {
        if (!host._flxRingWarned) console.warn("nvr wall-extras: no gate / door rings", err);
        host._flxRingWarned = true;
      } finally {
        host._flxRingBusy = false;
      }
    };
    // Called by fast-live.js to draw a ring's row: the photo saved when it rang
    // (if there is one), else a bell. Tap: that camera, live.
    // Photos: media-source local/doorbell/<YYYY-MM-DD>/<camera>_<HHMMSS>.jpg,
    // where <camera> is the camera entity's object id (e.g. front_door).
    const BELL_ROOT = "media-source://media_source/local/doorbell";
    const bellFolder = (host, day) => {
      host._flxBellDays = host._flxBellDays || {};
      const cached = host._flxBellDays[day];
      if (cached && Date.now() - cached.at < 60000) return cached.files;
      const files = host._hass
        .callWS({ type: "media_source/browse_media", media_content_id: `${BELL_ROOT}/${day}` })
        .then((folder) =>
          (folder.children || [])
            .map((child) => {
              const match = /^(.+)_(\d\d)(\d\d)(\d\d)\.jpg$/.exec(child.title || "");
              if (!match) return null;
              const [y, m, d] = day.split("-").map(Number);
              return { cam: match[1], id: child.media_content_id, time: new Date(y, m - 1, d, +match[2], +match[3], +match[4]).getTime() };
            })
            .filter(Boolean)
        )
        .catch(() => []); // no folder yet: no photos that day
      host._flxBellDays[day] = { at: Date.now(), files };
      return files;
    };
    const bellPhoto = async (host, row) => {
      const entry = W.entryFor(host, row.ch);
      const cam = entry && typeof entry.entity === "string" ? entry.entity.split(".")[1] : null;
      if (!cam || !host._hass || typeof host._hass.callWS !== "function") return null;
      const files = await bellFolder(host, isoDay(new Date(row.time)));
      let best = null;
      for (const file of files) {
        const gap = Math.abs(file.time - row.time);
        if (file.cam === cam && gap < 90000 && (!best || gap < best.gap)) best = { ...file, gap };
      }
      if (!best) return null;
      const resolved = await host._hass.callWS({ type: "media_source/resolve_media", media_content_id: best.id });
      return resolved && resolved.url;
    };
    // Only with card option `ring_photo_days: N` (off unless set): once every
    // 12 hours, an admin's wall deletes ring photos older than N days.
    const pruneBellPhotos = async (host) => {
      try {
        const keepDays = Number(host._config && host._config.ring_photo_days) || 0;
        if (!(keepDays > 0)) return;
        const user = host._hass && host._hass.user;
        if (!user || !user.is_admin || Date.now() - (host._flxBellPruned || 0) < 43200000) return;
        host._flxBellPruned = Date.now();
        const root = await host._hass.callWS({ type: "media_source/browse_media", media_content_id: BELL_ROOT });
        const oldest = new Date();
        oldest.setHours(0, 0, 0, 0);
        oldest.setDate(oldest.getDate() - keepDays);
        for (const day of root.children || []) {
          if (!/^\d{4}-\d\d-\d\d$/.test(day.title || "") || day.title >= isoDay(oldest)) continue;
          const folder = await host._hass.callWS({ type: "media_source/browse_media", media_content_id: day.media_content_id });
          for (const file of folder.children || []) {
            if (!/\.jpg$/.test(file.title || "")) continue;
            await host._hass.callWS({ type: "media_source/local_source/remove", media_content_id: file.media_content_id });
          }
        }
      } catch (_) {
        /* no doorbell folder yet, or not allowed: nothing to tidy */
      }
    };
    W.ring = (host, button, row, names) => {
      ensureStyle(host);
      button.classList.add("flx-ring");
      button.innerHTML =
        `<span class="flx-bell">${bell(22)}</span>` +
        `<span class="fl-ev-what">${bell(16)}<span></span></span>` +
        '<span class="fl-ev-meta"></span>';
      button.querySelector(".fl-ev-what > span").textContent = row.label;
      button.lastChild.textContent = `${names[row.ch] || ""}, ${clock(row.time).slice(0, 5)}`;
      bellPhoto(host, row)
        .then((url) => {
          const holder = button.querySelector(".flx-bell");
          if (!url || !holder || !button.isConnected) return;
          const img = document.createElement("img");
          img.alt = "";
          img.draggable = false;
          img.onload = () => holder.replaceWith(img);
          img.src = url;
        })
        .catch(() => {}); // the bell stays
      pruneBellPhotos(host);
      button.addEventListener("click", () => {
        const root = host.shadowRoot;
        if (row.ch !== host._selected) {
          // Exactly what tapping that camera's tile does.
          const tile = root.querySelector(`.tile[data-channel="${row.ch}"]`);
          if (tile) tile.click();
        }
        // On a phone the list is under the picture: bring the picture into view.
        if (NARROW.matches) {
          const stage = root.querySelector("#stage");
          if (stage) stage.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }
      });
    };

    // ---- 3. time and date in the header ----------------------------------------
    const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    // The title of the camera on the big picture (see the CSS above). The card
    // writes the plain name into .title; it is mirrored into .flx-name, so the
    // card's own updates keep working.
    const ICON_PTZ =
      "M12 2a3 3 0 0 1 3 3v1h2a2 2 0 0 1 2 2v3a7 7 0 0 1-14 0V8a2 2 0 0 1 2-2h2V5a3 3 0 0 1 3-3m0 8a3 3 0 1 0 0 6 3 3 0 0 0 0-6M5 20h14v2H5z";
    const ICON_CAM =
      "M18 10.48V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4.48l4 3.98v-11zM10 15a3 3 0 1 1 0-6 3 3 0 0 1 0 6";
    const paintTitle = (host) => {
      try {
        const title = host.shadowRoot && host.shadowRoot.querySelector(".fl-main > .head .title");
        if (!title) return;
        const name = [...title.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim() ||
          (title.querySelector(".flx-name") || {}).textContent || "";
        const channel = (host._channels || []).find((c) => c.id === host._selected) || {};
        const ptz = !!channel.ptz || Number((host._config.ptz || {}).channel) === host._selected;
        const recording = !!(host._recording && host._recording[host._selected]);
        const history = host._mode === "playback";
        const state = history ? "hist" : recording ? "rec" : "live";
        const sig = [name, host._selected, ptz, state].join("|");
        if (!title._flxObs && window.MutationObserver) {
          // The card writes the plain name straight into .title when the big
          // picture swaps camera: dress it again at once.
          title._flxObs = new MutationObserver(() => paintTitle(host));
          title._flxObs.observe(title, { childList: true });
        }
        if (host.getAttribute("lm") === "grid") orderCells(host, "grid");
        if (title.dataset.flx === sig && title.querySelector(".flx-chip")) return;
        title.dataset.flx = sig;
        const label = history ? "History" : recording ? "Recording" : "Live";
        title.innerHTML =
          `<span class="flx-chip"><svg viewBox="0 0 24 24"><path d="${ptz ? ICON_PTZ : ICON_CAM}"/></svg></span>` +
          '<span class="flx-titletext"><span class="flx-name"></span>' +
          `<span class="flx-sub"><i class="${state}"></i>${label}<em>/</em>CH ${host._selected}` +
          `${ptz ? "<em>/</em>PTZ" : ""}</span></span>`;
        title.querySelector(".flx-name").textContent = name;
        title.title = name;
      } catch (_) {
        /* the plain name stays */
      }
    };
    const paintClock = (host) => {
      const head = host.shadowRoot && host.shadowRoot.querySelector(".fl-main > .head");
      if (!head) return;
      let box = head.querySelector(".flx-clock");
      if (!box) {
        box = document.createElement("span");
        box.className = "flx-clock";
        box.innerHTML = "<b></b><span></span>";
        head.appendChild(box);
      }
      const now = new Date();
      const time = clock(now.getTime()).slice(0, 5);
      const date = `${DAYS[now.getDay()]} ${now.getDate()} ${MONTHS[now.getMonth()]}`;
      if (box.firstChild.textContent !== time) box.firstChild.textContent = time;
      if (box.lastChild.textContent !== date) box.lastChild.textContent = date;
    };
    // One timer per card, due just after each minute turns; it stops itself
    // when the card leaves the page.
    const runClock = (host) => {
      clearTimeout(host._flxClock);
      host._flxClock = null;
      if (!host.isConnected || !isWall(host)) return;
      paintClock(host);
      host._flxClock = setTimeout(() => runClock(host), 60000 - (Date.now() % 60000) + 50);
    };

    // ---- Firefox: a live picture stuck at a gap ------------------------------------
    // MSE video in Firefox stops dead at a hole in what it has downloaded, where
    // Chrome steps over it (the same family as the Firefox replay skipping). Once
    // a second: a playing video whose time hasn't moved but has more downloaded
    // after it is moved on to that (just behind the live edge).
    const UNSTICK = /firefox/i.test(navigator.userAgent);
    const deepVideo = (start) => {
      const stack = [start];
      while (stack.length) {
        const node = stack.pop();
        if (node.localName === "video") return node;
        if (node.shadowRoot) stack.push(...node.shadowRoot.children);
        if (node.children) stack.push(...node.children);
      }
      return null;
    };
    const unstick = (host) => {
      if (!host.isConnected || !isWall(host) || host._mode !== "live" || document.hidden) return;
      const root = host.shadowRoot;
      host._flxVt = host._flxVt || new WeakMap();
      const places = [...root.querySelectorAll(".fl-tile-live"), root.querySelector("#stage")].filter(Boolean);
      for (const place of places) {
        const video = deepVideo(place);
        if (!video || video.paused || !video.readyState || !video.buffered.length) continue;
        const now = video.currentTime;
        const before = host._flxVt.get(video);
        host._flxVt.set(video, now);
        if (before === undefined || Math.abs(now - before) > 0.05) continue; // moving
        const ranges = video.buffered;
        let target = null;
        for (let i = 0; i < ranges.length; i += 1) {
          if (ranges.start(i) > now + 0.01) {
            target = ranges.start(i) + 0.05;
            break;
          }
        }
        const end = ranges.end(ranges.length - 1);
        if (target === null && end - now > 0.4) target = end - 0.3;
        if (target === null) continue;
        try {
          video.currentTime = target;
          host._flxUnstuck = (host._flxUnstuck || 0) + 1;
        } catch (_) {
          /* try again next second */
        }
      }
    };
    const runUnstick = (host) => {
      if (!(UNSTICK || window.__flxUnstick) || host._flxUnstickTimer) return;
      host._flxUnstickTimer = setInterval(() => {
        try {
          unstick(host);
        } catch (_) {
          /* extras only */
        }
      }, 1000);
    };

    // ---- 4. the REC marker opens that recording in History -----------------------
    const addRecButtons = (host) => {
      host.shadowRoot.querySelectorAll(".tile").forEach((tile) => {
        if (tile.querySelector(".flx-rec")) return;
        const button = document.createElement("button");
        button.className = "flx-rec";
        button.type = "button";
        button.textContent = "REC";
        button.title = "Open this recording";
        tile.appendChild(button);
      });
    };
    const openRecording = async (host, ch) => {
      try {
        const now = Date.now();
        host._selected = ch;
        host._mode = "playback";
        host._playbackUrl = null;
        host._cursor = null;
        host._date = isoDay(new Date(now));
        await host._loadTimeline();
        const blocks = host._blocks || [];
        const last = blocks[blocks.length - 1];
        if (!last) return; // nothing recorded yet: History stays open on that camera
        const start = last.start.getTime();
        const end = Math.min(now, last.end.getTime());
        // Where the recording now under way began; for one that has run for
        // more than ten minutes (or a camera that records all the time), the
        // last half minute of it instead.
        const at = now - start <= 600000 ? start : Math.max(start, end - 30000);
        await goHistory(host, ch, at);
      } catch (err) {
        console.warn("nvr wall-extras: could not open that recording", err);
      }
    };
    const wireRecButtons = (host) => {
      if (host._flxRecWired) return;
      host._flxRecWired = true;
      // On the shadow root, in the capture phase: ahead of the tile's own tap.
      host.shadowRoot.addEventListener(
        "click",
        (event) => {
          const path = event.composedPath();
          const button = path.find((node) => node.classList && node.classList.contains("flx-rec"));
          if (!button || !isWall(host) || host._mode !== "live") return;
          const tile = button.parentElement;
          if (!tile || !tile.classList.contains("fl-recording")) return;
          event.stopImmediatePropagation();
          event.preventDefault();
          openRecording(host, Number(tile.dataset.channel));
        },
        true
      );
    };

    // A tap you can feel: the Home Assistant app turns this event into a
    // phone haptic (the same path HA's own buttons use; off in a browser).
    const haptic = (type) => {
      try {
        const event = new Event("haptic", { bubbles: true, composed: true });
        event.detail = type;
        window.dispatchEvent(event);
      } catch (_) {
        /* no haptics here */
      }
    };
    const wireHaptics = (host) => {
      if (host._flxHaptics) return;
      host._flxHaptics = true;
      host.shadowRoot.addEventListener(
        "click",
        (event) => {
          if (!isWall(host)) return;
          const hit = event.composedPath().find(
            (node) => node.classList &&
              (node.classList.contains("tile") || node.classList.contains("fl-preset-btn") ||
                node.classList.contains("flx-rec") || (node.closest && node.closest(".modes, .fl-preset-list")))
          );
          if (hit) haptic(hit.classList.contains("tile") && !hit.classList.contains("active") ? "medium" : "light");
        },
        true
      );
    };

    // ---- PTZ markers from the camera that sends it ---------------------------------
    // The PTZ pauses its own person / vehicle rules while it moves or tracks, so
    // what it chased after the Panoramic spotted someone shows as plain motion.
    // On the PTZ's History timeline, add the person / vehicle markers of the
    // cameras in `ptz.linked` (e.g. [2]). Only that request (the whole chosen
    // day): the Today totals keep counting each camera once.
    const originalApi = proto._api;
    if (originalApi) {
      proto._api = function (path, ...rest) {
        const own = originalApi.call(this, path, ...rest);
        try {
          const ptz = this._config && this._config.ptz;
          const linked = (ptz && ptz.linked) || [];
          const match = /^([^/]+)\/(\d+)\/detections(\?.*)$/.exec(String(path));
          if (!linked.length || !match || Number(match[2]) !== Number(ptz.channel)) return own;
          if (!this._dayEnd || !match[3].includes(encodeURIComponent(this._dayEnd.toISOString()))) return own;
          const others = linked.map((ch) =>
            originalApi.call(this, `${match[1]}/${ch}/detections${match[3]}`).catch(() => ({ detections: [] }))
          );
          return Promise.all([own, ...others]).then(([mine, ...theirs]) => {
            const all = [...((mine && mine.detections) || [])];
            for (const data of theirs) all.push(...((data && data.detections) || []));
            all.sort((a, b) => new Date(a.time) - new Date(b.time));
            const out = [];
            for (const d of all) {
              const prev = out[out.length - 1];
              if (prev && prev.kind === d.kind && Math.abs(new Date(prev.time) - new Date(d.time)) < 3000) continue;
              out.push(d);
            }
            return { ...(mine || {}), detections: out };
          });
        } catch (_) {
          return own;
        }
      };
    }

    // ---- 5. PERSON / VEHICLE tags while an event is recording -------------------
    // The recorder starts recording when a camera catches something, and the
    // wall already asks it every 4 s which cameras are recording (the REC
    // markers). When one starts, ask the recorder what it saw (its person /
    // vehicle search, from shortly before the recording began) every 5 s for up
    // to 2 minutes until it names something, and show that on the camera's
    // tile and, for the camera on the big picture, above LIVE. The tag stays
    // while the recording lasts and 20 s after. The camera alarm sensors in
    // Home Assistant are not used: they hardly ever fire for these cameras.
    // A PTZ camera also counts its `ptz.linked` cameras (it pauses its own
    // smart rules while it moves).
    const TAG_LOOK = {
      person: { label: "Person", color: "var(--fl-person,#6fcf7f)" },
      vehicle: { label: "Vehicle", color: "var(--fl-vehicle,#ffb84d)" },
    };
    const TAG_TICK = 2000;
    const TAG_ASK_EVERY = 5000;
    const TAG_ASK_FOR = 120000;
    const TAG_LINGER = 20000;
    const askKind = async (host, ch, since) => {
      if (!host._device || !host._api) return null;
      const ptz = (host._config && host._config.ptz) || {};
      const channels = [ch].concat(ptz.channel === ch ? ptz.linked || [] : []);
      let best = null;
      for (const one of channels) {
        try {
          const data = await host._api(
            `${host._device.id}/${one}/detections` +
              `?start=${encodeURIComponent(new Date(since).toISOString())}` +
              `&end=${encodeURIComponent(new Date().toISOString())}`
          );
          for (const d of data.detections || []) {
            const time = new Date(d.time).getTime();
            if (TAG_LOOK[d.kind] && (!best || time > best.time)) best = { kind: d.kind, time };
          }
        } catch (_) {
          /* try again on the next round */
        }
      }
      return best && best.kind;
    };
    const tagHtml = (kind) => {
      const look = TAG_LOOK[kind];
      return (W.iconSvg ? W.iconSvg(kind, 12, true) : "") + look.label;
    };
    const paintTags = (host) => {
      try {
        const root = host.shadowRoot;
        if (!root || !isWall(host)) return;
        const live = host._mode === "live";
        const now = Date.now();
        const tags = (host._flxTags = host._flxTags || {});
        // Every camera on the card, whether or not it has a live player entry.
        for (const channel of host._channels || []) {
          const ch = Number(channel.id);
          const entry = W.entryFor(host, ch);
          if (entry && entry.thumb) continue; // gate / door stations are not recorded
          const tag = (tags[ch] = tags[ch] || {});
          const recording = live && !!(host._recording && host._recording[ch]);
          if (recording) {
            if (!tag.since) Object.assign(tag, { since: now, kind: null, asked: 0 });
            tag.until = now + TAG_LINGER;
            if (!tag.kind && !tag.busy && now - tag.since < TAG_ASK_FOR && now - tag.asked >= TAG_ASK_EVERY) {
              tag.busy = true;
              tag.asked = now;
              askKind(host, ch, tag.since - 30000)
                .then((kind) => {
                  if (kind && tag.since) tag.kind = kind;
                  paintTags(host);
                })
                .finally(() => {
                  tag.busy = false;
                });
            }
          } else if (tag.since && now > (tag.until || 0)) {
            tags[ch] = {};
          }
          const show = live && tags[ch].kind ? tags[ch].kind : null;
          const tile = root.querySelector(`.tile[data-channel="${ch}"]`);
          if (tile) {
            let chip = tile.querySelector(":scope > .flx-tag");
            if (!show) {
              if (chip) chip.remove();
            } else if (!chip || chip.dataset.kind !== show) {
              if (!chip) {
                chip = document.createElement("span");
                chip.className = "flx-tag";
                tile.appendChild(chip);
              }
              chip.dataset.kind = show;
              chip.style.setProperty("--flx-kind", TAG_LOOK[show].color);
              chip.innerHTML = tagHtml(show);
            }
          }
          if (ch === host._selected) {
            const box = root.querySelector("#stage > .fl-status");
            let chip = box && box.querySelector(":scope > .flx-tag");
            if (box && !show) {
              if (chip) chip.remove();
            } else if (box && (!chip || chip.dataset.kind !== show)) {
              if (!chip) {
                chip = document.createElement("span");
                chip.className = "flx-tag";
                box.appendChild(chip); // the column is reversed: this sits above RECORDING
              }
              chip.dataset.kind = show;
              chip.style.setProperty("--flx-kind", TAG_LOOK[show].color);
              chip.innerHTML = tagHtml(show);
            }
          }
        }
        // The big picture moved to another camera: drop a tag left from the last one.
        const stageChip = root.querySelector("#stage > .fl-status > .flx-tag");
        if (stageChip && !(tags[host._selected] && tags[host._selected].kind && live)) stageChip.remove();
      } catch (err) {
        console.warn("nvr wall: event tags failed", err);
      }
    };
    const runTags = (host) => {
      paintTags(host);
      if (!host._flxTagTimer) {
        host._flxTagTimer = setInterval(() => {
          paintTags(host);
          paintTitle(host);
        }, TAG_TICK);
      }
    };

    // ---- wiring -----------------------------------------------------------------
    // Called by fast-live.js after every redraw of the wall.
    W.after = (host) => {
      if (!isWall(host)) return;
      host._flxSeen = true;
      ensureStyle(host);
      // The tiles rise in on first arrival only, not on every redraw.
      if (!host.hasAttribute("flx-shown") && !host._flxShownTimer) {
        host._flxShownTimer = setTimeout(() => host.setAttribute("flx-shown", ""), 1200);
      }
      addRecButtons(host);
      wireRecButtons(host);
      wireHaptics(host);
      runUnstick(host);
      watchNarrow(host);
      watchFill(host);
      ensureSideBar(host);
      ensureTimelineBar(host);
      watchSide(host);
      host.toggleAttribute("flx-blur", new URLSearchParams(window.location.search).has("blur"));
      applyLayout(host);
      fillScreen(host);
      if (!host._flxFillSettle) {
        // Once, after the page header has settled on first arrival.
        host._flxFillSettle = setTimeout(() => fillScreen(host), 400);
      }
      if (host._flxClock) paintClock(host);
      else runClock(host);
      runTags(host);
      paintTitle(host);
    };
    // A custom element's connected / disconnected callbacks are fixed when it is
    // defined, so patching them now would do nothing. The card's own callbacks
    // call these two methods (and so does its page-hidden / page-shown handler),
    // which are looked up at call time: hook those instead.
    const originalStop = proto._stopTimers;
    if (originalStop) {
      proto._stopTimers = function (...args) {
        try {
          if (!this.isConnected) {
            clearTimeout(this._flxClock);
            this._flxClock = null;
            clearInterval(this._flxUnstickTimer);
            this._flxUnstickTimer = null;
            clearInterval(this._flxTagTimer);
            this._flxTagTimer = null;
            unwatchNarrow(this);
            unwatchFill(this);
            if (this._flxObs) {
              this._flxObs.disconnect();
              this._flxObs = null;
            }
          }
        } catch (_) {
          /* extras only */
        }
        return originalStop.apply(this, args);
      };
    }
    // A card drawn before this file arrived: catch up (once).
    const catchUp = (host) => {
      if (host._flxSeen || !isWall(host) || !host.shadowRoot || !host.shadowRoot.querySelector(".fl-main")) return false;
      W.after(host);
      const stage = host.shadowRoot.querySelector("#stage");
      if (stage && host._mode === "live") W.ptz(host, stage);
      W.counts(host);
      return true;
    };
    const originalStart = proto._startSnapshots;
    if (originalStart) {
      proto._startSnapshots = function (...args) {
        const result = originalStart.apply(this, args);
        try {
          if (this.isConnected && !catchUp(this) && isWall(this) && this._flxSeen) {
            runClock(this);
            runTags(this);
            runUnstick(this);
            watchNarrow(this);
            const stage = this.shadowRoot.querySelector("#stage");
            if (stage && !this._flxObs && this._mode === "live") watchStage(this, stage);
          }
        } catch (_) {
          /* extras only */
        }
        return result;
      };
    }
    // The live picture needs the Advanced Camera Card. When that file is still
    // loading as the wall is drawn (a cold start on a tablet), the card falls
    // back to its own player: the small stream and no joystick, for good. Once
    // the camera card is in, draw the live picture again (at most every 10 s).
    const unstickLive = (host) => {
      if (host._mode !== "live" || !host.isConnected || !customElements.get("advanced-camera-card")) return;
      const stage = host.shadowRoot && host.shadowRoot.querySelector("#stage");
      if (!stage || !W.entryFor(host, host._selected)) return;
      if (stage.querySelector("advanced-camera-card")) {
        host._flxUnstickTries = 0; // healthy: a later fallback may try again
        return;
      }
      // The card's own player leaves a video or picture; the camera card's
      // stage is still empty while it is being built.
      if (!stage.querySelector("video, img")) return;
      // Three tries per camera: if the camera card keeps failing, keep the
      // fallback picture instead of restarting it every 10 s.
      if (host._flxUnstickCh !== host._selected) {
        host._flxUnstickCh = host._selected;
        host._flxUnstickTries = 0;
      }
      if ((host._flxUnstickTries || 0) >= 3) return;
      if (Date.now() - (host._flxUnstickLiveAt || 0) < 10000) return;
      host._flxUnstickTries = (host._flxUnstickTries || 0) + 1;
      host._flxUnstickLiveAt = Date.now();
      stage.dataset.url = "";
      host._renderLive(stage);
    };
    // ---- 11. replays from the fast download ------------------------------------------
    // The recorder's playback stream comes at real time, a keyframe gap at a
    // time (measured: 1.1 MB every 2 s on a 2 s-GOP camera), so the player runs
    // dry and skips at every gap. The same footage from its download endpoint
    // (the card's Save link) arrives about 25x faster. Browsers that play HLS
    // themselves (iPhone, iPad) keep their own route.
    const NATIVE_HLS = !!document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
    const pacedPlayback = proto._renderPlayback;
    if (pacedPlayback) {
      proto._renderPlayback = function (stage, ...rest) {
        try {
          const url = this._playbackUrl;
          const fast = this._downloadUrl;
          if (this._flxPaceNext && url && /\/clip\//.test(url)) {
            this._flxPaceNext = false; // this one clip on the paced stream (see the fallback)
          } else if (!NATIVE_HLS && url && fast && fast !== url && /\/clip\//.test(url)) {
            this._flxFastFor = { clip: url, fast };
            this._playbackUrl = fast;
          }
        } catch (_) {
          /* keep the paced stream */
        }
        const result = pacedPlayback.call(this, stage, ...rest);
        Promise.resolve(result)
          .then(() => {
            const map = this._flxFastFor;
            const video = stage && stage.querySelector && stage.querySelector("video");
            if (!map || !video || video._flxFastWatch || this._playbackUrl !== map.fast) return;
            video._flxFastWatch = true;
            const range = /\/(\d+)\/(\d+)\.mp4/.exec(map.fast);
            const length = range ? Number(range[2]) - Number(range[1]) : 0;
            // The fast route failed (an error, nothing within 8 s, or it ended
            // short): carry on from the same moment on the paced stream.
            let done = false;
            const fallBack = () => {
              if (done || this._playbackUrl !== map.fast || !stage.isConnected) return;
              done = true;
              clearTimeout(timer);
              const at = video.currentTime || 0;
              this._flxPaceNext = true;
              if (at > 1 && this._cursor && this._playFrom) {
                this._playFrom(new Date(this._cursor.getTime() + at * 1000));
              } else {
                this._playbackUrl = map.clip;
                stage.dataset.url = "";
                this._renderPlayback(stage);
              }
            };
            const timer = setTimeout(() => {
              if (video.readyState < 2) fallBack();
            }, 8000);
            video.addEventListener("error", fallBack, { once: true });
            video.addEventListener("ended", () => {
              if (length && video.currentTime < length - 3) fallBack();
            });
          })
          .catch(() => {});
        return result;
      };
    }
    // ... or on its next state update.
    const hassProp = Object.getOwnPropertyDescriptor(proto, "hass");
    if (hassProp && hassProp.set) {
      Object.defineProperty(proto, "hass", {
        configurable: true,
        get: hassProp.get,
        set(hass) {
          hassProp.set.call(this, hass);
          try {
            catchUp(this);
            unstickLive(this);
          } catch (_) {
            /* extras only */
          }
        },
      });
    }
  }
});
