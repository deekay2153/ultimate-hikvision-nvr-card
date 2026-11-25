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
 *      doorbell/<date>/<camera>_<HHMMSS>.jpg; photos older than 14 days are
 *      deleted from here, by an admin's wall):
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
         under the page header, and the camera rows share that height, so there
         is never a gap at the bottom. Tiles and the big picture let go of 16:9;
         pictures are cropped to fill a tile, the big picture is shown whole. */
      :host([wall][flx-fill]) ha-card { height: var(--flx-fill-h); }
      :host([wall][flx-fill]) .fl-main { grid-template-rows: var(--flx-rows); align-content: stretch; }
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
    // ---- fill the screen -------------------------------------------------------------
    const fillScreen = (host) => {
      try {
        const root = host.shadowRoot;
        const main = root && root.querySelector(".fl-main");
        const stage = root && root.querySelector(".fl-main > .stage");
        const wide = !NARROW.matches && !SHORT.matches && !(stage && stage.classList.contains("fl-full"));
        if (!main || !wide || (host._config && host._config.fill === false)) {
          host.removeAttribute("flx-fill");
          return;
        }
        const top = host.getBoundingClientRect().top;
        if (top < 0) return; // scrolled: keep what we had
        const height = Math.max(420, Math.floor(window.innerHeight - top - 8));
        // Rows of cameras: the big picture takes 3 x 3 cells of the 5 columns.
        let cells = 9;
        main.querySelectorAll(".tile, .fl-sum").forEach((el) => {
          if (getComputedStyle(el).display === "none") return;
          const span = /span (\d+)/.exec(el.style.gridColumn || "");
          cells += span ? Number(span[1]) : 1;
        });
        const columns = getComputedStyle(main).gridTemplateColumns.split(" ").length || 5;
        const rows = Math.max(3, Math.ceil(cells / columns));
        host.style.setProperty("--flx-fill-h", `${height}px`);
        host.style.setProperty("--flx-rows", `auto repeat(${rows}, minmax(0, 1fr))`);
        host.setAttribute("flx-fill", "");
      } catch (err) {
        console.warn("nvr wall: fill the screen failed", err);
      }
    };
    const watchFill = (host) => {
      if (host._flxFill) return;
      host._flxFill = () => fillScreen(host);
      window.addEventListener("resize", host._flxFill);
    };
    const unwatchFill = (host) => {
      if (!host._flxFill) return;
      window.removeEventListener("resize", host._flxFill);
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
    const BELL_KEEP_DAYS = 14;
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
    // Once every 12 hours, an admin's wall deletes ring photos older than 14 days.
    const pruneBellPhotos = async (host) => {
      try {
        const user = host._hass && host._hass.user;
        if (!user || !user.is_admin || Date.now() - (host._flxBellPruned || 0) < 43200000) return;
        host._flxBellPruned = Date.now();
        const root = await host._hass.callWS({ type: "media_source/browse_media", media_content_id: BELL_ROOT });
        const oldest = new Date();
        oldest.setHours(0, 0, 0, 0);
        oldest.setDate(oldest.getDate() - BELL_KEEP_DAYS);
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
      if (!host._flxTagTimer) host._flxTagTimer = setInterval(() => paintTags(host), TAG_TICK);
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
      fillScreen(host);
      setTimeout(() => fillScreen(host), 300); // after the page header has settled
      if (host._flxClock) paintClock(host);
      else runClock(host);
      runTags(host);
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
          } catch (_) {
            /* extras only */
          }
        },
      });
    }
  }
});
