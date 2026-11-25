/*! Ultimate Hikvision NVR card 0.1.0
 * https://github.com/deekay2153/ultimate-hikvision-nvr-card
 * MIT licence. Contains the Hikvision NVR card by techmarkai
 * (https://github.com/techmarkai/hikvision-nvr-ha, MIT) and the Arcane PTZ
 * joystick (https://github.com/deekay2153/arcane-ptz-joystick, MIT).
 * Not affiliated with or endorsed by Hikvision.
 */

// ---- joystick.js ----
{
/* Arcane PTZ Joystick 1.0.0
 * https://github.com/deekay2153/arcane-ptz-joystick
 *
 * Drag the knob in any direction: the camera pans and tilts together, faster
 * the further you drag. Let go and it stops. Optional hold-to-zoom buttons and
 * a tap-to-aim button (tap the picture and the camera centres on that spot, or
 * draw a box and it zooms in to it).
 *
 * The card moves the camera by calling your scripts, so it works with any
 * camera Home Assistant can move. Ready-made scripts for Hikvision and ONVIF
 * cameras are in the repo's examples folder.
 *
 *   type: custom:arcane-ptz-joystick
 *   script: script.ptz_move        called with {pan, tilt}, each -100..100
 *                                  (right / up positive, 0 0 = stop)
 *   max_speed: 70                  speed at the rim, 5..100
 *   size: 150                      knob ring size in px
 *   zoom: false                    hold + / - buttons beside the ring
 *   zoom_in_script / zoom_out_script / zoom_stop_script
 *   zoom_out_full_script           double-tap - (optional)
 *   aim: false                     tap-to-aim button
 *   aim_script: script.ptz_aim     called with {x, y} or {x, y, x2, y2}:
 *                                  percent of the picture from its left / top
 *   arrange: side                  side | row | stack (where the buttons go)
 *   card: true                     false = no card background (for overlays)
 */
const VERSION = '1.0.0';

class ArcanePtzJoystick extends HTMLElement {
  static getStubConfig() {
    return { script: 'script.ptz_move', zoom: false, aim: false };
  }

  static getConfigForm() {
    const script = { entity: { domain: 'script' } };
    return {
      schema: [
        { name: 'script', required: true, selector: script },
        {
          type: 'grid', name: '', schema: [
            { name: 'max_speed', selector: { number: { min: 5, max: 100, step: 5, mode: 'slider' } } },
            { name: 'size', selector: { number: { min: 90, max: 260, step: 10, unit_of_measurement: 'px', mode: 'box' } } },
          ],
        },
        {
          type: 'grid', name: '', schema: [
            { name: 'card', selector: { boolean: {} } },
            { name: 'arrange', selector: { select: { mode: 'dropdown', options: [
              { value: 'side', label: 'Beside the ring, stacked' },
              { value: 'row', label: 'Beside the ring, in a row' },
              { value: 'stack', label: 'Under the ring' },
            ] } } },
          ],
        },
        { name: 'zoom', selector: { boolean: {} } },
        {
          type: 'expandable', name: '', title: 'Zoom scripts', schema: [
            { name: 'zoom_in_script', selector: script },
            { name: 'zoom_out_script', selector: script },
            { name: 'zoom_stop_script', selector: script },
            { name: 'zoom_out_full_script', selector: script },
          ],
        },
        { name: 'aim', selector: { boolean: {} } },
        { name: 'aim_script', selector: script },
      ],
      computeLabel: (f) => ({
        script: 'Move script',
        max_speed: 'Top speed',
        size: 'Size',
        card: 'Card background',
        arrange: 'Buttons',
        zoom: 'Zoom buttons',
        zoom_in_script: 'Zoom in script',
        zoom_out_script: 'Zoom out script',
        zoom_stop_script: 'Zoom stop script',
        zoom_out_full_script: 'Zoom all the way out script (double-tap -)',
        aim: 'Tap-to-aim button',
        aim_script: 'Aim script',
      }[f.name]),
      computeHelper: (f) => ({
        script: 'Called with pan and tilt, each -100 to 100. The examples folder has ready-made scripts.',
        card: 'Turn off when the joystick sits on top of a camera picture.',
        aim_script: 'Called with x and y, percent of the picture from its left and top edge.',
      }[f.name]),
    };
  }

  setConfig(config) {
    if (!config) throw new Error('arcane-ptz-joystick: missing config');
    this._config = config;
    this._cardBg = config.card !== false;
    this._script = String(config.script || 'script.ptz_move').replace(/^script\./, '');
    this._max = Math.max(5, Math.min(100, Number(config.max_speed) || 70));
    this._size = Number(config.size) || 150;
    const bare = (v, d) => String(v || d).replace(/^script\./, '');
    this._zoom = !!config.zoom;
    this._zoomIn = bare(config.zoom_in_script, 'script.ptz_start_zoom_in');
    this._zoomOut = bare(config.zoom_out_script, 'script.ptz_start_zoom_out');
    this._zoomStop = bare(config.zoom_stop_script, 'script.ptz_stop');
    this._zoomOutFull = config.zoom_out_full_script ? bare(config.zoom_out_full_script) : null;
    this._aim = !!config.aim;
    // Where the aim and zoom buttons go: 'side' (a column beside the ring, the
    // default), 'row' (a row beside the ring) or 'stack' (a row under it).
    this._arrange = ['row', 'stack'].includes(config.arrange) ? config.arrange : 'side';
    this._aimScript = bare(config.aim_script, 'script.ptz_aim');
    if (this._armed) this._disarm();
    this._target = { pan: 0, tilt: 0 };
    this._sent = { pan: 0, tilt: 0 };
    this._busy = false;
    this._active = false;
    this._build();
  }

  set hass(hass) {
    this._hass = hass;
  }

  getCardSize() {
    return Math.ceil(((this._size || 150) + (this._cardBg ? 32 : 0)) / 50);
  }

  getGridOptions() {
    return { columns: 6, min_columns: 3, rows: 'auto' };
  }

  disconnectedCallback() {
    if (this._active) this._release();
    if (this._zooming) this._zoomEnd();
    if (this._armed) this._disarm();
  }

  _call(script, data) {
    if (!this._hass || !script) return Promise.resolve();
    return this._hass.callService('script', script, data || {}).catch((err) =>
      console.warn('arcane-ptz-joystick: call failed', err)
    );
  }

  // A tap you can feel in the Home Assistant app (it turns this event into a
  // phone haptic; nothing happens in a plain browser).
  _haptic(type) {
    try {
      const event = new Event('haptic', { bubbles: true, composed: true });
      event.detail = type;
      window.dispatchEvent(event);
    } catch (_) {}
  }

  _zoomEnd() {
    this._zooming = false;
    this.shadowRoot.querySelectorAll('.zb').forEach((b) => b.classList.remove('active'));
    this._call(this._zoomStop);
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      if (!this._zooming && !this._active) this._call(this._zoomStop);
    }, 400);
  }

  _build() {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    const s = this._size;
    const k = Math.round(s * 0.38);
    const side = this._zoom || this._aim;
    const flat = this._arrange !== 'side'; // aim and zoom in a row
    const aimH = flat ? Math.max(40, Math.round(s * 0.42)) : Math.round(s * 0.27);
    // The zoom pill: lying down beside the ring ('row'), standing up under it
    // ('stack', so the whole control stays narrow).
    const zoomW = Math.round(aimH * 2.3);
    const stack = this._arrange === 'stack';
    const rowW = (this._aim ? aimH : 0) + (this._aim && this._zoom ? 8 : 0) + (this._zoom ? (stack ? aimH : zoomW) : 0);
    const rowH = stack && this._zoom ? zoomW : aimH;
    const hostW = !side ? s
      : this._arrange === 'row' ? s + 12 + rowW
      : stack ? Math.max(s, rowW)
      : s + 68;
    const hostH = side && stack ? s + 10 + rowH : s;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: flex !important; align-items: center; gap: ${this._arrange === 'stack' ? 10 : 12}px;
          flex-direction: ${this._arrange === 'stack' ? 'column' : 'row'};
          width: ${hostW}px; height: ${hostH}px; }
        ${this._cardBg ? `
        :host { box-sizing: border-box; width: 100%;
          height: ${hostH + 32}px; padding: 16px; justify-content: safe center;
          background: var(--ha-card-background, var(--card-background-color, #1c1c1c));
          border: var(--ha-card-border-width, 1px) solid var(--ha-card-border-color, var(--divider-color, #e0e0e0));
          border-radius: var(--ha-card-border-radius, 12px);
          box-shadow: var(--ha-card-box-shadow, none); }` : ''}
        .side { flex: none; width: 56px; height: ${s}px; display: flex;
          flex-direction: column; justify-content: center; gap: ${Math.round(s * 0.05)}px; }
        ${flat ? `
        .side { width: auto; height: ${rowH}px; flex-direction: row; align-items: center; gap: 8px; }
        .side .aim { width: ${aimH}px; }
        .side .zoom { flex: none; max-height: none; border-radius: ${aimH / 2}px;
          width: ${stack ? aimH : zoomW}px; height: ${stack ? zoomW : aimH}px;
          flex-direction: ${stack ? 'column' : 'row-reverse'}; }
        .side .zb { font-size: ${Math.round(aimH * 0.62)}px; }
        ${stack ? '' : '.side .zb + .zb { border-top: 0; border-right: 1px solid rgba(255,255,255,0.18); }'}` : ''}
        /* One material for every control: a raised, frosted dark surface with a
           lit top edge. Pressing pushes it in; it springs back on release. */
        :host { --acc: var(--ptz-joystick-accent, var(--primary-color, #8ab4ff));
          --spring: cubic-bezier(.34,1.56,.64,1); }
        .ring, .aim, .zoom {
          box-sizing: border-box; color: #fff;
          background: linear-gradient(180deg, rgba(40,45,57,.92), rgba(17,20,27,.95));
          border: 1px solid rgba(255,255,255,.09);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.10),
            0 10px 24px -10px rgba(0,0,0,.7), 0 2px 6px rgba(0,0,0,.35);
          touch-action: none; user-select: none; -webkit-user-select: none;
          -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
        }
        .aim {
          flex: none; height: ${aimH}px;
          display: flex; align-items: center; justify-content: center;
          border-radius: ${aimH / 2}px; cursor: pointer;
          transition: transform .28s var(--spring), background .2s, color .2s, box-shadow .2s;
        }
        .aim:active { transform: scale(.92); }
        .aim svg { width: ${Math.min(22, aimH - 12)}px; height: ${Math.min(22, aimH - 12)}px; opacity: .92; }
        .aim.armed { color: #fff; background: var(--acc);
          border-color: transparent; animation: armed 1.5s ease-in-out infinite; }
        @keyframes armed {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--acc) 55%, transparent), 0 6px 16px -6px rgba(0,0,0,.6); }
          50% { box-shadow: 0 0 0 8px color-mix(in srgb, var(--acc) 0%, transparent), 0 6px 16px -6px rgba(0,0,0,.6); }
        }
        .zoom {
          flex: 1 1 auto; min-height: 0; max-height: ${Math.round(s * 0.84)}px;
          width: 56px; display: flex; flex-direction: column; overflow: hidden;
          border-radius: 28px;
        }
        .zb { position: relative; flex: 1; display: flex; align-items: center; justify-content: center;
          color: rgba(255,255,255,.92); cursor: pointer;
          transition: background .18s, transform .28s var(--spring); }
        .zb svg { width: 18px; height: 18px; transition: transform .28s var(--spring); }
        .zb + .zb { border-top: 1px solid rgba(255,255,255,.08); }
        .zb.active { background: rgba(255,255,255,.10); box-shadow: inset 0 2px 8px rgba(0,0,0,.45); }
        .zb.active svg { transform: scale(.86); }
        /* Double-tap -: a quick accent sweep so the "all the way out" is felt. */
        .zb.full { background: color-mix(in srgb, var(--acc) 38%, transparent); }
        .zb.full svg { transform: scale(1.18); }
        .ring {
          position: relative; flex: none; width: ${s}px; height: ${s}px;
          border-radius: 50%; cursor: grab;
          transition: box-shadow .25s, border-color .25s;
        }
        /* The dial: fine tick marks round the inside edge. */
        .ring::before {
          content: ""; position: absolute; inset: 5px; border-radius: 50%; pointer-events: none;
          background: repeating-conic-gradient(rgba(255,255,255,.20) 0 1.2deg, transparent 1.2deg 15deg);
          -webkit-mask: radial-gradient(circle closest-side, transparent calc(100% - 6px), #000 calc(100% - 5.5px));
          mask: radial-gradient(circle closest-side, transparent calc(100% - 6px), #000 calc(100% - 5.5px));
        }
        /* A soft well the knob sits in. */
        .ring::after {
          content: ""; position: absolute; inset: 22%; border-radius: 50%; pointer-events: none;
          background: radial-gradient(circle at 50% 60%, rgba(0,0,0,.35), rgba(0,0,0,0) 70%);
        }
        .ring.active { cursor: grabbing; border-color: color-mix(in srgb, var(--acc) 45%, transparent);
          box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 0 0 4px color-mix(in srgb, var(--acc) 16%, transparent),
            0 10px 24px -10px rgba(0,0,0,.7); }
        /* Chevrons; the one you push towards lights up. */
        .tick { position: absolute; width: 7px; height: 7px; z-index: 1;
          border: solid #fff; border-width: 2px 0 0 2px; border-radius: 1px;
          opacity: .38; transition: opacity .15s; }
        .up { top: 15px; left: 50%; margin-left: -4.5px; transform: rotate(45deg);
          opacity: var(--ou, .38); }
        .down { bottom: 15px; left: 50%; margin-left: -4.5px; transform: rotate(225deg);
          opacity: var(--od, .38); }
        .left { left: 15px; top: 50%; margin-top: -4.5px; transform: rotate(-45deg);
          opacity: var(--ol, .38); }
        .right { right: 15px; top: 50%; margin-top: -4.5px; transform: rotate(135deg);
          opacity: var(--or, .38); }
        .ring.active .tick { border-color: color-mix(in srgb, var(--acc) 70%, #fff); }
        .knob {
          position: absolute; left: 50%; top: 50%; z-index: 2;
          width: ${k}px; height: ${k}px; margin: -${k / 2}px 0 0 -${k / 2}px;
          border-radius: 50%;
          background: radial-gradient(circle at 38% 30%, #ffffff, #e4e8ef 52%, #b7beca);
          box-shadow: 0 8px 16px -4px rgba(0,0,0,.6), 0 2px 4px rgba(0,0,0,.35),
            inset 0 -2px 3px rgba(0,0,0,.16), inset 0 1px 1px #fff;
          transition: transform .42s var(--spring), scale .2s var(--spring);
          will-change: transform; pointer-events: none;
        }
        .ring.active .knob { transition: scale .2s var(--spring); scale: .93; }
        @media (hover: hover) {
          .aim:hover, .zb:hover { background-color: rgba(255,255,255,.06); }
          .ring:hover:not(.active) { border-color: rgba(255,255,255,.16); }
        }
        @media (prefers-reduced-motion: reduce) {
          .knob, .aim, .zb, .zb svg { transition: none; }
          .aim.armed { animation: none; }
        }
      </style>
      <div class="ring">
        <div class="tick up"></div><div class="tick down"></div>
        <div class="tick left"></div><div class="tick right"></div>
        <div class="knob"></div>
      </div>
      ${side ? `<div class="side">
        ${this._aim ? `<div class="aim" title="Tap to aim"><svg viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="6.5"/>
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4"/><circle cx="12" cy="12" r="1.3"
          fill="currentColor" stroke="none"/></svg></div>` : ''}
        ${this._zoom ? `<div class="zoom">
          <div class="zb" data-dir="in" title="Zoom in"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></div>
          <div class="zb" data-dir="out" title="${this._zoomOutFull ? 'Zoom out (double-tap: all the way)' : 'Zoom out'}"><svg viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 12h14"/></svg></div>
        </div>` : ''}
      </div>` : ''}`;
    this._ring = this.shadowRoot.querySelector('.ring');
    this._knob = this.shadowRoot.querySelector('.knob');
    this._travel = (s - k) / 2 - 4;

    const stop = (e) => e.stopPropagation();
    ['touchstart', 'touchmove', 'mousedown', 'click', 'dblclick', 'wheel'].forEach((t) =>
      this._ring.addEventListener(t, stop, { passive: true })
    );
    this._ring.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      this._pointer = e.pointerId;
      try { this._ring.setPointerCapture(e.pointerId); } catch (_) {}
      this._active = true;
      this._ring.classList.add('active');
      this._haptic('light');
      this._move(e);
    });
    this._ring.addEventListener('pointermove', (e) => {
      if (!this._active || e.pointerId !== this._pointer) return;
      e.stopPropagation();
      this._move(e);
    });
    const end = (e) => {
      if (!this._active || (e.pointerId !== undefined && e.pointerId !== this._pointer)) return;
      e.stopPropagation();
      this._release();
    };
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) =>
      this._ring.addEventListener(t, end)
    );

    // Aim: tap the button to arm, then tap the picture.
    this._aimBtn = this.shadowRoot.querySelector('.aim');
    if (this._aimBtn) {
      ['touchstart', 'touchmove', 'mousedown', 'pointerdown', 'dblclick', 'wheel'].forEach((t) =>
        this._aimBtn.addEventListener(t, stop, { passive: true })
      );
      this._aimBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (this._armed) this._disarm();
        else { this._arm(); this._haptic('light'); }
      });
    }

    // Zoom: hold + or - to zoom, release to stop. Double-tap - = all the way out.
    this.shadowRoot.querySelectorAll('.zb').forEach((b) => {
      ['touchstart', 'touchmove', 'mousedown', 'click', 'dblclick', 'wheel'].forEach((t) =>
        b.addEventListener(t, stop, { passive: true })
      );
      b.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
        e.preventDefault();
        try { b.setPointerCapture(e.pointerId); } catch (_) {}
        const now = Date.now();
        if (b.dataset.dir === 'out' && this._zoomOutFull && this._lastOutTap && now - this._lastOutTap < 350) {
          // Second quick tap: no stop may follow, it would cut the move short.
          this._lastOutTap = 0;
          clearTimeout(this._zoomTimer);
          b.classList.add('active', 'full');
          setTimeout(() => b.classList.remove('active', 'full'), 600);
          this._call(this._zoomOutFull);
          this._haptic('medium');
          return;
        }
        this._outDown = b.dataset.dir === 'out' && this._zoomOutFull ? now : 0;
        this._zooming = true;
        b.classList.add('active');
        this._haptic('light');
        this._call(b.dataset.dir === 'in' ? this._zoomIn : this._zoomOut);
      });
      ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((t) =>
        b.addEventListener(t, (e) => {
          e.stopPropagation();
          // A short press of - may be the first half of a double-tap.
          if (this._zooming && this._outDown) this._lastOutTap = Date.now() - this._outDown < 300 ? Date.now() : 0;
          this._outDown = 0;
          if (this._zooming) this._zoomEnd();
        })
      );
    });
  }

  _arm() {
    this._armed = true;
    if (this._aimBtn) this._aimBtn.classList.add('armed');
    this._onTap = (e) => this._tap(e);
    window.addEventListener('click', this._onTap, true);
    // Drag on the picture = draw a box, the camera zooms in to it.
    this._onDown = (e) => this._down(e);
    this._onDrag = (e) => this._dragMove(e);
    this._onUp = (e) => this._dragEnd(e, true);
    this._onCancel = (e) => this._dragEnd(e, false);
    this._onBlock = (e) => { if (this._drag) e.stopPropagation(); };
    window.addEventListener('pointerdown', this._onDown, true);
    window.addEventListener('pointermove', this._onDrag, true);
    window.addEventListener('pointerup', this._onUp, true);
    window.addEventListener('pointercancel', this._onCancel, true);
    ['touchstart', 'touchmove', 'mousedown', 'mousemove'].forEach((t) =>
      window.addEventListener(t, this._onBlock, true)
    );
    // On a phone a finger dragged across the picture scrolls the page, and the
    // browser then cancels the drag before a box can be drawn. While a drag on
    // the picture is under way, tell the browser the finger is ours. (This has
    // to be its own listener: the ones above are "passive" and cannot do it.)
    this._onTouchMove = (e) => {
      if (this._drag && e.cancelable) e.preventDefault();
    };
    window.addEventListener('touchmove', this._onTouchMove, { capture: true, passive: false });
    // ... and no text-selection bubble or long-press menu while aiming.
    const page = document.documentElement.style;
    this._pageStyle = {
      userSelect: page.userSelect,
      webkitUserSelect: page.webkitUserSelect,
      webkitTouchCallout: page.webkitTouchCallout,
    };
    page.userSelect = 'none';
    page.webkitUserSelect = 'none';
    page.webkitTouchCallout = 'none';
    const pr = this._pictureRect();
    this._card = pr && pr.card;
    if (this._card) {
      this._cardTouch = this._card.style.touchAction;
      this._card.style.touchAction = 'none';
    }
    this._idle();
  }

  _disarm() {
    this._armed = false;
    if (this._aimBtn) this._aimBtn.classList.remove('armed');
    window.removeEventListener('click', this._onTap, true);
    window.removeEventListener('pointerdown', this._onDown, true);
    window.removeEventListener('pointermove', this._onDrag, true);
    window.removeEventListener('pointerup', this._onUp, true);
    window.removeEventListener('pointercancel', this._onCancel, true);
    ['touchstart', 'touchmove', 'mousedown', 'mousemove'].forEach((t) =>
      window.removeEventListener(t, this._onBlock, true)
    );
    if (this._onTouchMove) {
      window.removeEventListener('touchmove', this._onTouchMove, { capture: true });
      this._onTouchMove = null;
    }
    if (this._pageStyle) {
      Object.assign(document.documentElement.style, this._pageStyle);
      this._pageStyle = null;
    }
    if (this._card) this._card.style.touchAction = this._cardTouch || '';
    this._card = null;
    this._dropBox();
    clearTimeout(this._aimTimer);
  }

  // Switch itself off after 20 s without a tap.
  _idle() {
    clearTimeout(this._aimTimer);
    this._aimTimer = setTimeout(() => this._disarm(), 20000);
  }

  _tap(e) {
    if (Date.now() - (this._boxAt || 0) < 500) { e.stopPropagation(); e.preventDefault(); return; }
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(this)) return;
    // Taps on other controls (preset buttons, menus) keep their normal job.
    if (path.some((n) => n.localName && /button|menu|joystick|slider|input|select/.test(n.localName))) return;
    const r = this._pictureRect();
    if (!r || (r.card && !path.includes(r.card))) return;
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    if (x < 0 || x > 1 || y < 0 || y > 1) return;
    e.stopPropagation();
    e.preventDefault();
    const now = Date.now();
    if (now - (this._lastAim || 0) < 350) return;
    this._lastAim = now;
    this._idle();
    this._ripple(e.clientX, e.clientY);
    this._call(this._aimScript, { x: Math.round(x * 1000) / 10, y: Math.round(y * 1000) / 10 });
  }

  _down(e) {
    if (e.isPrimary === false || (e.button !== undefined && e.button > 0)) return;
    const path = e.composedPath ? e.composedPath() : [];
    if (path.includes(this)) return;
    if (path.some((n) => n.localName && /button|menu|joystick|slider|input|select/.test(n.localName))) return;
    const r = this._pictureRect();
    if (!r || (r.card && !path.includes(r.card))) return;
    if (e.clientX < r.left || e.clientX > r.left + r.width ||
        e.clientY < r.top || e.clientY > r.top + r.height) return;
    e.stopPropagation();
    this._drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, r, box: null };
  }

  _dragMove(e) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    e.stopPropagation();
    const cx = Math.min(Math.max(e.clientX, d.r.left), d.r.left + d.r.width);
    const cy = Math.min(Math.max(e.clientY, d.r.top), d.r.top + d.r.height);
    if (!d.box) {
      if (Math.hypot(cx - d.x0, cy - d.y0) < 14) return;
      d.box = document.createElement('div');
      d.box.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid #fff;' +
        'background:rgba(255,255,255,0.14);box-shadow:0 0 0 1px rgba(0,0,0,0.5);' +
        'border-radius:4px;pointer-events:none;z-index:99999;';
      document.body.appendChild(d.box);
    }
    d.x1 = cx;
    d.y1 = cy;
    const s = d.box.style;
    s.left = `${Math.min(d.x0, cx)}px`;
    s.top = `${Math.min(d.y0, cy)}px`;
    s.width = `${Math.abs(cx - d.x0)}px`;
    s.height = `${Math.abs(cy - d.y0)}px`;
  }

  _dragEnd(e, send) {
    const d = this._drag;
    if (!d || e.pointerId !== d.id) return;
    this._drag = null;
    if (!d.box) return; // a plain tap: the click handler aims
    e.stopPropagation();
    d.box.remove();
    this._boxAt = Date.now(); // swallow the click that follows a drag
    const w = Math.abs(d.x1 - d.x0) / d.r.width;
    const h = Math.abs(d.y1 - d.y0) / d.r.height;
    if (!send || w < 0.04 || h < 0.04) return;
    const pct = (v, o, len) => Math.round(((v - o) / len) * 1000) / 10;
    this._idle();
    this._call(this._aimScript, {
      x: pct(Math.min(d.x0, d.x1), d.r.left, d.r.width),
      y: pct(Math.min(d.y0, d.y1), d.r.top, d.r.height),
      x2: pct(Math.max(d.x0, d.x1), d.r.left, d.r.width),
      y2: pct(Math.max(d.y0, d.y1), d.r.top, d.r.height),
    });
  }

  _dropBox() {
    if (this._drag && this._drag.box) this._drag.box.remove();
    this._drag = null;
  }

  // Where the camera picture really is on screen (without the black bars).
  _pictureRect() {
    const collect = (root) => {
      const out = [];
      const walk = (node) => {
        if (node.nodeType === 1) {
          if (node === this) return;
          const t = node.localName;
          if (t === 'video' || t === 'img' || t === 'canvas') {
            const b = node.getBoundingClientRect();
            if (b.width >= 80 && b.height >= 60) out.push(node);
          }
          if (node.shadowRoot) walk(node.shadowRoot);
        }
        for (let c = node.firstElementChild; c; c = c.nextElementSibling) walk(c);
      };
      walk(root);
      return out;
    };
    // The picture is the one nearest to the joystick: inside the camera card
    // it sits on (Advanced Camera Card, picture-elements, picture-glance), or
    // otherwise the biggest one on the same dashboard view.
    let card = null;
    let found = [];
    for (let n = this.parentNode || this.host; n && n !== document; n = n.parentNode || n.host) {
      if (n.nodeType !== 1) continue;
      const hits = collect(n);
      if (hits.length) { card = n; found = hits; break; }
      if (n.localName === 'hui-view' || n.localName === 'hui-sections-view' ||
          n.localName === 'hui-masonry-view' || n.localName === 'hui-panel-view') break;
    }
    if (!card) found = collect(document.body);
    let best = null;
    let bestScore = 0;
    for (const el of found) {
      const b = el.getBoundingClientRect();
      const nw = el.videoWidth || el.naturalWidth || (el.localName === 'canvas' ? el.width : 0);
      const nh = el.videoHeight || el.naturalHeight || (el.localName === 'canvas' ? el.height : 0);
      if (!nw || !nh || b.width < 40 || b.height < 40) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
      const score = b.width * b.height * (el.localName === 'video' ? 4 : 1);
      if (score > bestScore) {
        bestScore = score;
        best = { b, nw, nh, fit: cs.objectFit };
      }
    }
    if (!best) {
      if (!card) return null;
      best = { b: card.getBoundingClientRect(), nw: 16, nh: 9, fit: 'contain' };
    }
    const { b, nw, nh, fit } = best;
    if (fit === 'fill') return { left: b.left, top: b.top, width: b.width, height: b.height, card };
    const scale = fit === 'cover'
      ? Math.max(b.width / nw, b.height / nh)
      : Math.min(b.width / nw, b.height / nh);
    const w = nw * scale;
    const h = nh * scale;
    return { left: b.left + (b.width - w) / 2, top: b.top + (b.height - h) / 2, width: w, height: h, card };
  }

  _ripple(x, y) {
    const d = document.createElement('div');
    d.style.cssText = `position:fixed;left:${x}px;top:${y}px;width:48px;height:48px;` +
      'margin:-24px 0 0 -24px;border-radius:50%;border:2px solid #fff;box-sizing:border-box;' +
      'box-shadow:0 0 0 1px rgba(0,0,0,0.5);pointer-events:none;z-index:99999;';
    document.body.appendChild(d);
    if (d.animate) {
      d.animate(
        [{ transform: 'scale(0.3)', opacity: 1 }, { transform: 'scale(1.15)', opacity: 0 }],
        { duration: 600, easing: 'ease-out' }
      );
    }
    setTimeout(() => d.remove(), 580);
  }

  _move(e) {
    const r = this._ring.getBoundingClientRect();
    let dx = e.clientX - (r.left + r.width / 2);
    let dy = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(dx, dy);
    const ux = dist ? dx / dist : 0; // direction, unit length
    const uy = dist ? dy / dist : 0;
    if (dist > this._travel) {
      dx = ux * this._travel;
      dy = uy * this._travel;
    }
    this._knob.style.transform = `translate(${dx}px, ${dy}px)`;
    this._lightArrows(dx / this._travel, dy / this._travel);

    const frac = Math.min(dist, this._travel) / this._travel; // 0..1
    const dead = 0.12;
    if (frac < dead) {
      this._set(0, 0);
      return;
    }
    // Gentle near the centre, full speed only at the rim.
    const speed = Math.max(5, this._max * Math.pow((frac - dead) / (1 - dead), 1.6));
    const q = (v) => Math.round(v / 5) * 5 || 0;
    this._set(q(ux * speed), q(-uy * speed));
  }

  // The chevron you push towards lights up (x, y: -1..1, y down).
  _lightArrows(x, y) {
    const o = (v) => (0.38 + 0.62 * Math.max(0, v)).toFixed(2);
    const st = this._ring.style;
    st.setProperty('--ou', o(-y));
    st.setProperty('--od', o(y));
    st.setProperty('--ol', o(-x));
    st.setProperty('--or', o(x));
  }

  _release() {
    this._active = false;
    this._ring.classList.remove('active');
    this._knob.style.transform = 'translate(0px, 0px)';
    this._lightArrows(0, 0);
    this._set(0, 0);
    // Belt and braces: send the stop a second time in case the first is lost.
    clearTimeout(this._stopTimer);
    this._stopTimer = setTimeout(() => {
      if (!this._active) {
        this._sent = null;
        this._pump();
      }
    }, 400);
  }

  _set(pan, tilt) {
    this._target = { pan, tilt };
    this._pump();
  }

  async _pump() {
    if (this._busy || !this._hass) return;
    const t = this._target;
    if (this._sent && this._sent.pan === t.pan && this._sent.tilt === t.tilt) return;
    this._busy = true;
    this._sent = t;
    try {
      await this._hass.callService('script', this._script, { pan: t.pan, tilt: t.tilt });
    } catch (err) {
      console.warn('arcane-ptz-joystick: call failed', err);
    }
    await new Promise((res) => setTimeout(res, 60));
    this._busy = false;
    this._pump();
  }
}

if (!customElements.get('arcane-ptz-joystick')) {
  customElements.define('arcane-ptz-joystick', ArcanePtzJoystick);
  window.customCards = window.customCards || [];
  window.customCards.push({
    type: 'arcane-ptz-joystick',
    name: 'Arcane PTZ Joystick',
    description: 'Drag in any direction to pan and tilt a camera, with hold-to-zoom and tap-to-aim.',
    preview: true,
    documentationURL: 'https://github.com/deekay2153/arcane-ptz-joystick',
  });
  console.info(`%c ARCANE-PTZ-JOYSTICK %c ${VERSION} `,
    'color:#fff;background:#3b82f6;font-weight:700', 'color:#3b82f6;background:#fff');
}

}

// ---- base-card.js ----
{
/**
 * Hikvision NVR card.
 *
 * Live view + history playback in one card. No bundled dependencies: video is
 * played by Home Assistant's own <ha-hls-player>, which already ships hls.js
 * and handles browsers without native HLS.
 *
 * type: custom:ultimate-nvr-card
 */

// Read from our own URL (…/ultimate-nvr-card.js?v=1.2.3) rather than a second
// hand-maintained constant. A version banner that disagrees with the installed
// integration is worse than none -- it sends you debugging the wrong build.
const CARD_VERSION = "0.1.0";

console.info(
  `%c ULTIMATE-NVR-CARD %c ${CARD_VERSION} `,
  "color:#fff;background:#03a9f4;font-weight:700",
  "color:#03a9f4;background:#fff"
);

const API = "hikvision_nvr";
const SNAPSHOT_INTERVAL = 10000;

// How much video a click on the timeline fetches, and therefore how much the
// Download button saves. One control for both, so what you save is what you
// just watched. The server caps a clip at 2 hours.
const CLIP_LENGTHS = [
  { seconds: 30, label: "30 sec" },
  { seconds: 60, label: "1 min" },
  { seconds: 120, label: "2 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 600, label: "10 min" },
  { seconds: 1800, label: "30 min" },
  { seconds: 3600, label: "1 hour" },
];
const DEFAULT_CLIP_SECONDS = 600;

// How long the native player gets to produce a frame before we fall back
// to HLS. Generous: WebRTC lands in about a second when it works.
const NATIVE_LIVE_TIMEOUT = 6000;

/** Force Home Assistant to load its camera chunk, which defines ha-hls-player. */
let playerReady = null;
function ensurePlayer() {
  if (!playerReady) {
    playerReady = (async () => {
      if (customElements.get("ha-hls-player")) return;
      const helpers = await window.loadCardHelpers();
      // Creating a camera card pulls in the video-player chunk as a side effect.
      const card = await helpers.createCardElement({
        type: "picture-entity",
        entity: "camera.__hikvision_probe__",
        camera_view: "live",
      });
      card.remove?.();
      await Promise.all([
        customElements.whenDefined("ha-hls-player"),
        customElements.whenDefined("ha-camera-stream"),
      ]);
    })().catch(() => {
      /* fall back to a plain <video> below */
    });
  }
  return playerReady;
}

// Channel names and NVR error strings are device-controlled, so they never go
// into innerHTML raw.
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]
  );

/** Home Assistant's callApi rejects with an object, not an Error. */
const errText = (err) => {
  if (!err) return "unknown error";
  if (typeof err === "string") return err;
  const body = err.body?.message || err.body?.error || err.body;
  return (
    err.message ||
    [err.status_code, typeof body === "string" ? body : err.error]
      .filter(Boolean)
      .join(" ") ||
    JSON.stringify(err)
  );
};

const pad = (n) => String(n).padStart(2, "0");
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const hhmmss = (d) => `${hhmm(d)}:${pad(d.getSeconds())}`;
const isoDate = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const STYLE = `
  :host { display: block; }
  ha-card { overflow: hidden; display: flex; flex-direction: column; }
  .head {
    display: flex; align-items: center; gap: 8px;
    padding: 10px 14px; border-bottom: 1px solid var(--divider-color);
  }
  .head .title { font-weight: 500; flex: 1; }
  .modes { display: flex; border: 1px solid var(--divider-color); border-radius: 999px; overflow: hidden; }
  .modes button {
    border: 0; background: none; color: var(--secondary-text-color);
    padding: 5px 14px; cursor: pointer; font: inherit; font-size: 13px;
  }
  .modes button[aria-pressed="true"] {
    background: var(--primary-color); color: var(--text-primary-color, #fff);
  }
  .grid { display: grid; gap: 2px; background: var(--divider-color); }
  .tile {
    position: relative; aspect-ratio: 16 / 9; background: #000;
    cursor: pointer; overflow: hidden;
  }
  .tile img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .tile.offline img { filter: grayscale(1) brightness(0.4); }
  .tile .label {
    position: absolute; inset: auto 0 0 0; padding: 4px 8px;
    font-size: 12px; color: #fff; background: linear-gradient(transparent, rgba(0,0,0,.75));
    display: flex; align-items: center; gap: 6px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: #2ecc71; flex: none; }
  .tile.offline .dot { background: var(--error-color, #e74c3c); }
  .tile.active { outline: 2px solid var(--primary-color); outline-offset: -2px; }
  .stage {
    position: relative; background: #000; aspect-ratio: 16 / 9;
    /* A player or overlay must never bleed past the stage onto the
       controls below, and the stage must not be shrunk by the flex
       column into overlapping them. */
    overflow: hidden; flex: none;
  }
  .stage > * { width: 100%; height: 100%; display: block; }
  .stage video { object-fit: contain; background: #000; }
  .overlay {
    position: absolute; inset: 0; display: grid; place-items: center;
    color: #fff; font-size: 13px; background: rgba(0,0,0,.5); text-align: center;
    padding: 12px;
  }
  .controls {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px; flex-wrap: wrap;
    position: relative; z-index: 1;
    background: var(--card-background-color, #fff);
    color: var(--primary-text-color);
  }
  .controls input[type="date"], .controls select {
    background: var(--card-background-color); color: var(--primary-text-color);
    border: 1px solid var(--divider-color); border-radius: 6px; padding: 4px 8px;
    font: inherit; font-size: 13px;
  }
  .controls .spacer { flex: 1; }
  .icon-btn {
    border: 0; background: none; cursor: pointer; color: var(--secondary-text-color);
    padding: 4px 8px; border-radius: 6px; font: inherit; font-size: 13px;
  }
  .icon-btn:hover { background: var(--secondary-background-color); }
  .icon-btn[disabled] { opacity: .4; cursor: default; }
  .timeline {
    position: relative; height: 34px; margin: 0 12px 12px;
    background: var(--secondary-background-color); border-radius: 6px;
    cursor: grab; overflow: hidden; touch-action: none;
  }
  .timeline .block { position: absolute; top: 0; bottom: 0; background: var(--primary-color); opacity: .75; }
  .timeline .block.motion { background: var(--warning-color, #ff9800); }
  .timeline .cursor { position: absolute; top: 0; bottom: 0; width: 2px; background: #fff; box-shadow: 0 0 3px #000; }
  .timeline .hours { position: absolute; inset: 0; pointer-events: none; }
  .timeline .hours span {
    position: absolute; top: 2px; font-size: 9px; color: var(--secondary-text-color);
    transform: translateX(-50%);
  }
  .timeline .tick { position: absolute; top: 0; bottom: 0; width: 1px; background: var(--divider-color); }
  .timeline { user-select: none; touch-action: none; }
  .timeline.dragging { cursor: grabbing; }
  .empty { padding: 24px; text-align: center; color: var(--secondary-text-color); font-size: 13px; }
  .err { padding: 12px; color: var(--error-color); font-size: 13px; }
`;

class HikvisionNvrCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ultimate-nvr-card-editor");
  }

  static getStubConfig() {
    return { type: "custom:ultimate-nvr-card", columns: 3 };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._mode = "live";
    this._device = null;
    this._channels = [];
    this._selected = null;
    this._date = isoDate(new Date());
    this._blocks = [];
    this._snapshotUrls = new Map();
    this._clipSeconds = DEFAULT_CLIP_SECONDS;
    // Live starts muted because browsers will not autoplay with sound;
    // the speaker button is what turns it on.
    this._muted = true;
    // Visible slice of the day, as fractions 0..1. Zoom narrows it, pan
    // slides it. The blocks always cover the whole day, so zooming never
    // needs another round trip to the NVR.
    this._view = { from: 0, to: 1 };
    this._timers = [];
    this._error = null;
    this._loading = true;
  }

  setConfig(config) {
    this._config = { columns: 3, default_mode: "live", live_stream: 1, ...config };
    this._mode = this._config.default_mode === "playback" ? "playback" : "live";
  }

  getCardSize() {
    return 8;
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._init();
  }

  connectedCallback() {
    if (this._hass && !this._loading) this._startSnapshots();
    document.addEventListener("visibilitychange", this._onVisibility);
  }

  disconnectedCallback() {
    this._stopTimers();
    document.removeEventListener("visibilitychange", this._onVisibility);
  }

  _onVisibility = () => {
    if (document.hidden) this._stopTimers();
    else this._startSnapshots();
  };

  _stopTimers() {
    this._timers.forEach(clearInterval);
    this._timers = [];
  }

  // ------------------------------------------------------------------ data

  async _api(path, options) {
    return this._hass.callApi(options?.method || "GET", `${API}/${path}`, options?.body);
  }

  async _init() {
    try {
      const { devices } = await this._api("devices");
      if (!devices.length) throw new Error("No NVR is configured");
      const device =
        devices.find(
          (d) => d.id === this._config.device || d.host === this._config.device
        ) || devices[0];
      this._device = device;

      let channels = device.channels;
      if (this._config.channels?.length) {
        const wanted = this._config.channels.map(Number);
        channels = channels.filter((c) => wanted.includes(c.id));
      }
      this._channels = channels;
      this._selected = channels[0]?.id ?? null;
      await Promise.all(channels.map((c) => this._refreshSnapshot(c.id)));
      this._loading = false;
      this._render();
      this._startSnapshots();
      if (this._mode === "playback") this._loadTimeline();
    } catch (err) {
      this._error = errText(err);
      this._loading = false;
      this._render();
    }
  }

  /** Signed URL so <img> can load it without an Authorization header. */
  async _refreshSnapshot(channel) {
    try {
      const { path } = await this._hass.callWS({
        type: "auth/sign_path",
        path: `/api/${API}/${this._device.id}/${channel}/snapshot`,
        // Generous: a backgrounded tab has its timers throttled, so a short
        // expiry means it wakes and re-requests a dead URL. Home Assistant
        // counts every rejection towards banning the browser's IP.
        expires: 3600,
      });
      // No cache-buster: auth/sign_path signs an EMPTY query-parameter list,
      // so any extra query arg invalidates the signature and Home Assistant
      // logs it as a failed login (and eventually IP-bans the browser). Each
      // signed path is unique anyway -- the JWT carries its own issued-at.
      this._snapshotUrls.set(channel, path);
      const img = this.shadowRoot.querySelector(`img[data-channel="${channel}"]`);
      if (img) {
        // A signed path minted before a Home Assistant restart is rejected
        // afterwards, and every rejection counts towards HA's IP-ban tally.
        // Drop a failed URL so the next tick signs a fresh one instead of
        // re-requesting the dead one.
        img.onerror = () => this._snapshotUrls.delete(channel);
        img.src = this._snapshotUrls.get(channel);
      }
    } catch (err) {
      /* a single failed thumbnail must not break the card */
    }
  }

  _startSnapshots() {
    this._stopTimers();
    if (!this._device || document.hidden) return;
    this._timers.push(
      setInterval(() => {
        // Only the tiles that are actually on screen.
        for (const channel of this._channels) {
          if (this._mode === "live" && channel.id === this._selected) continue;
          this._refreshSnapshot(channel.id);
        }
      }, SNAPSHOT_INTERVAL)
    );
  }

  async _loadTimeline() {
    const [y, m, d] = this._date.split("-").map(Number);
    const start = new Date(y, m - 1, d, 0, 0, 0);
    const end = new Date(y, m - 1, d, 23, 59, 59);
    this._dayStart = start;
    this._dayEnd = end;
    this._view = { from: 0, to: 1 };
    this._blocks = [];
    this._render();
    try {
      const data = await this._api(
        `${this._device.id}/${this._selected}/timeline` +
          `?start=${encodeURIComponent(start.toISOString())}` +
          `&end=${encodeURIComponent(end.toISOString())}&gap=120`
      );
      this._blocks = data.blocks.map((b) => ({
        start: new Date(b.start),
        end: new Date(b.end),
        motion: b.event_types.includes("motion"),
      }));
      this._error = null;
    } catch (err) {
      this._error = `Timeline failed: ${errText(err)}`;
    }
    this._render();
  }

  async _playFrom(when) {
    // Clamp to the block the user clicked, so we never ask the NVR for a range
    // that is mostly empty -- that is what makes seeking feel instant.
    const block =
      this._blocks.find((b) => when >= b.start && when <= b.end) ||
      this._blocks.find((b) => b.end > when);
    if (!block) return;
    const from = when > block.start ? when : block.start;
    // Ten minutes, not the whole block: ffmpeg starts sooner and seeking
    // elsewhere does not leave a long remux running behind you.
    const to = new Date(
      Math.min(block.end.getTime(), from.getTime() + this._clipSeconds * 1000)
    );
    this._cursor = from;
    this._render();
    try {
      const data = await this._api(
        `${this._device.id}/${this._selected}/playback` +
          `?start=${encodeURIComponent(from.toISOString())}` +
          `&end=${encodeURIComponent(to.toISOString())}`
      );
      // mp4_url, not hls_url: these recordings carry a G.722.1 audio track that
      // crashes Home Assistant's HLS worker, and fragmented MP4 starts sooner.
      this._playbackUrl = data.mp4_url || data.hls_url;
      // A separate endpoint: playback streams in real time, saving pulls the
      // same footage from the NVR's bulk endpoint at full speed.
      this._downloadUrl = data.download_url || data.mp4_url;
      this._error = null;
    } catch (err) {
      this._error = `Playback failed: ${errText(err)}`;
      this._playbackUrl = null;
    }
    this._render();
  }

  async _liveUrl() {
    const stream = this._config.live_stream || 1;
    const data = await this._api(
      `${this._device.id}/${this._selected}/live?stream=${stream}`
    );
    return data.hls_url;
  }

  async _download() {
    if (!this._downloadUrl) return;
    try {
      // sign_path signs the path with an empty parameter list, so only a
      // path-only URL can be signed -- the clip endpoint puts its times in the
      // path for exactly this reason.
      const { path } = await this._hass.callWS({
        type: "auth/sign_path",
        path: this._downloadUrl,
        expires: 3600,
      });
      const channel = this._channels.find((c) => c.id === this._selected);
      const stamp = this._cursor ? hhmmss(this._cursor).replace(/:/g, "") : "clip";
      const a = document.createElement("a");
      a.href = this._hass.hassUrl ? this._hass.hassUrl(path) : path;
      // Same-origin, so the browser honours this and saves instead of playing.
      a.download = `${(channel ? channel.name : "camera").replace(/\s+/g, "_")}_${
        this._date
      }_${stamp}.mp4`;
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      this._error = `Download failed: ${errText(err)}`;
      this._render();
    }
  }

  // ---------------------------------------------------------------- render

  _render() {
    const root = this.shadowRoot;
    if (!root.querySelector("ha-card")) {  // PATCHED: card-mod can add a child first
      const tpl = document.createElement("template"); tpl.innerHTML = `<style>${STYLE}</style><ha-card></ha-card>`; root.prepend(tpl.content);
    }
    const card = root.querySelector("ha-card");

    if (this._loading) {
      card.innerHTML = `<div class="empty">Loading NVR…</div>`;
      return;
    }
    if (!this._device) {
      card.innerHTML = `<div class="err">${esc(this._error || "No NVR available")}</div>`;
      return;
    }

    const channel = this._channels.find((c) => c.id === this._selected);
    card.innerHTML = `
      <div class="head">
        <div class="title">${esc(channel ? channel.name : this._device.name)}</div>
        ${
          this._mode === "live" && channel && channel.has_audio
            ? `<button class="icon-btn" id="mute" title="${
                this._muted ? "Unmute" : "Mute"
              }">${this._muted ? "\u{1F507}" : "\u{1F50A}"}</button>`
            : ""
        }
        <div class="modes">
          <button data-mode="live" aria-pressed="${this._mode === "live"}">Live</button>
          <button data-mode="playback" aria-pressed="${this._mode === "playback"}">History</button>
        </div>
      </div>
      <div class="stage" id="stage"></div>
      ${this._mode === "playback" ? this._playbackControls() : ""}
      ${this._error ? `<div class="err">${esc(this._error)}</div>` : ""}
      <div class="grid" style="grid-template-columns:repeat(${this._config.columns},1fr)">
        ${this._channels
          .map(
            (c) => `
          <div class="tile ${c.online ? "" : "offline"} ${
              c.id === this._selected ? "active" : ""
            }" data-channel="${c.id}">
            <img data-channel="${c.id}" src="${esc(this._snapshotUrls.get(c.id) || "")}" alt="${esc(c.name)}">
            <div class="label"><span class="dot"></span>${esc(c.name)}</div>
          </div>`
          )
          .join("")}
      </div>
    `;

    card.querySelectorAll(".modes button").forEach((button) =>
      button.addEventListener("click", () => {
        this._mode = button.dataset.mode;
        this._playbackUrl = null;
        this._render();
        if (this._mode === "playback") this._loadTimeline();
      })
    );
    const muteButton = card.querySelector("#mute");
    if (muteButton) {
      muteButton.addEventListener("click", () => {
        this._muted = !this._muted;
        const stage = this.shadowRoot.querySelector("#stage");
        const native = stage && stage.querySelector("ha-camera-stream");
        if (native) native.muted = this._muted;
        // The element already exists, so set it on the video underneath too
        // rather than waiting for a re-render to push the property down.
        const stack = stage ? [stage] : [];
        while (stack.length) {
          const node = stack.pop();
          if (node.tagName === "VIDEO") node.muted = this._muted;
          if (node.shadowRoot) stack.push(...node.shadowRoot.children);
          if (node.children) stack.push(...node.children);
        }
        muteButton.textContent = this._muted ? "\u{1F507}" : "\u{1F50A}";
        muteButton.title = this._muted ? "Unmute" : "Mute";
      });
    }

    card.querySelectorAll(".tile").forEach((tile) =>
      tile.addEventListener("click", () => {
        this._selected = Number(tile.dataset.channel);
        this._playbackUrl = null;
        this._render();
        if (this._mode === "playback") this._loadTimeline();
      })
    );

    if (this._mode === "playback") this._wirePlaybackControls(card);
    this._renderStage(card.querySelector("#stage"));
  }

  /** Fraction 0..1 across the whole day -> percent across the visible view. */
  _toView(fraction) {
    const { from, to } = this._view;
    return ((fraction - from) / (to - from)) * 100;
  }

  /** The timeline's contents. Repainted alone while zooming and panning: a
   *  full re-render would replace the element a drag is anchored to. */
  _timelineInner() {
    const span = this._dayEnd - this._dayStart;
    const asFraction = (time) => (time - this._dayStart) / span;

    const blocks = this._blocks
      .map((block) => {
        const left = this._toView(asFraction(block.start));
        const right = this._toView(asFraction(block.end));
        if (right < -5 || left > 105) return ""; // scrolled out of view
        const width = Math.max(right - left, 0.3);
        return `<div class="block ${block.motion ? "motion" : ""}" style="left:${left}%;width:${width}%"></div>`;
      })
      .join("");

    // Label density follows the zoom: every 6 hours when showing the day,
    // down to half-hours when zoomed right in.
    const visibleHours = (this._view.to - this._view.from) * 24;
    const step =
      visibleHours > 12 ? 6 : visibleHours > 6 ? 2 : visibleHours > 2 ? 1 : 0.5;
    const ticks = [];
    for (let hour = 0; hour <= 24; hour += step) {
      const left = this._toView(hour / 24);
      if (left < 0 || left > 100) continue;
      ticks.push(`<div class="tick" style="left:${left}%"></div>`);
      const label = Number.isInteger(hour)
        ? pad(hour)
        : `${pad(Math.floor(hour))}:30`;
      ticks.push(`<span style="left:${left}%">${label}</span>`);
    }

    const cursorAt = this._cursor ? asFraction(this._cursor) : null;
    const cursor =
      cursorAt !== null && cursorAt >= this._view.from && cursorAt <= this._view.to
        ? `<div class="cursor" style="left:${this._toView(cursorAt)}%"></div>`
        : "";
    return `<div class="hours">${ticks.join("")}</div>${blocks}${cursor}`;
  }

  /** Update the timeline in place, leaving its element and listeners intact. */
  _paintTimeline() {
    const timeline = this.shadowRoot.querySelector("#timeline");
    if (!timeline) return;
    timeline.innerHTML = this._timelineInner();
    const whole = this._view.to - this._view.from >= 0.999;
    for (const id of ["#zoomout", "#panleft", "#panright"]) {
      const button = this.shadowRoot.querySelector(id);
      if (button) button.disabled = whole;
    }
  }

  _playbackControls() {
    const zoomed = this._view.to - this._view.from < 0.999;

    return `
      <div class="controls">
        <input type="date" id="date" value="${this._date}" max="${isoDate(new Date())}">
        <button class="icon-btn" id="prev">‹ Prev</button>
        <button class="icon-btn" id="next">Next ›</button>
        <span class="spacer"></span>
        <span style="font-size:12px;color:var(--secondary-text-color)">
          ${this._cursor ? hhmmss(this._cursor) : `${this._blocks.length} recorded blocks`}
        </span>
        <label for="len" style="font-size:12px;color:var(--secondary-text-color)">Clip</label>
        <select id="len" title="How much video to play and download">
          ${CLIP_LENGTHS.map(
            (o) =>
              `<option value="${o.seconds}"${
                o.seconds === this._clipSeconds ? " selected" : ""
              }>${o.label}</option>`
          ).join("")}
        </select>
        <button class="icon-btn" id="panleft" ${zoomed ? "" : "disabled"} title="Move the view earlier">◀</button>
        <button class="icon-btn" id="panright" ${zoomed ? "" : "disabled"} title="Move the view later">▶</button>
        <button class="icon-btn" id="zoomout" ${zoomed ? "" : "disabled"} title="Show the whole day">Whole day</button>
        <button class="icon-btn" id="download" ${this._downloadUrl ? "" : "disabled"}>Download</button>
      </div>
      <div class="timeline" id="timeline">${this._timelineInner()}</div>
    `;
  }

  _wirePlaybackControls(card) {
    card.querySelector("#date").addEventListener("change", (event) => {
      this._date = event.target.value;
      this._cursor = null;
      this._playbackUrl = null;
      this._loadTimeline();
    });

    const timeline = card.querySelector("#timeline");
    const MIN_SPAN = 2 / (24 * 60); // two minutes, as a fraction of a day

    /** Where along the whole day a pointer is, 0..1. */
    const pointerFraction = (event) => {
      const rect = timeline.getBoundingClientRect();
      const ratio = Math.min(Math.max((event.clientX - rect.left) / rect.width, 0), 1);
      const { from, to } = this._view;
      return from + ratio * (to - from);
    };

    const clampView = (from, span) => {
      const width = Math.min(Math.max(span, MIN_SPAN), 1);
      const start = Math.min(Math.max(from, 0), 1 - width);
      this._view = { from: start, to: start + width };
      this._paintTimeline();
    };

    timeline.addEventListener("click", (event) => {
      if (this._panned) return; // the click that ends a drag is not a seek
      this._playFrom(
        new Date(
          this._dayStart.getTime() +
            pointerFraction(event) * (this._dayEnd - this._dayStart)
        )
      );
    });

    // Wheel zooms about the pointer, so the moment under the cursor stays put.
    timeline.addEventListener(
      "wheel",
      (event) => {
        event.preventDefault();
        const anchor = pointerFraction(event);
        const { from, to } = this._view;
        const span = (to - from) * (event.deltaY > 0 ? 1.25 : 0.8);
        clampView(anchor - (anchor - from) * (span / (to - from)), span);
      },
      { passive: false }
    );

    // Drag to pan; two fingers to pinch.
    let drag = null;
    const points = new Map();
    timeline.addEventListener("pointerdown", (event) => {
      points.set(event.pointerId, event.clientX);
      // Capture keeps the drag alive if the pointer leaves the bar, but it
      // throws for a pointer the element does not recognise -- and an
      // exception here would abort the handler and silently kill panning.
      try {
        timeline.setPointerCapture(event.pointerId);
      } catch {
        /* pan still works without capture, it just stops at the edge */
      }
      drag = { x: event.clientX, view: { ...this._view } };
      this._panned = false;
      timeline.classList.add("dragging");
    });
    timeline.addEventListener("pointermove", (event) => {
      if (!points.has(event.pointerId)) return;
      points.set(event.pointerId, event.clientX);
      const width = timeline.getBoundingClientRect().width;

      if (points.size >= 2) {
        const [a, b] = [...points.values()];
        const separation = Math.abs(a - b) / width;
        if (this._pinch) {
          const { from, to } = this._view;
          const centre = (from + to) / 2;
          const span = ((to - from) * this._pinch) / Math.max(separation, 0.01);
          clampView(centre - span / 2, span);
        }
        this._pinch = separation;
        this._panned = true;
        return;
      }

      if (!drag) return;
      const moved = (event.clientX - drag.x) / width;
      if (Math.abs(moved) > 0.005) this._panned = true;
      const span = drag.view.to - drag.view.from;
      clampView(drag.view.from - moved * span, span);
    });
    const release = (event) => {
      points.delete(event.pointerId);
      if (points.size === 0) timeline.classList.remove("dragging");
      if (points.size < 2) this._pinch = null;
      if (points.size === 0) drag = null;
    };
    timeline.addEventListener("pointerup", release);
    timeline.addEventListener("pointercancel", release);

    card.querySelector("#zoomout").addEventListener("click", () => {
      this._view = { from: 0, to: 1 };
      this._paintTimeline();
    });

    // Step by half a screen, so there is always overlap with what you just saw.
    const nudge = (direction) => {
      const span = this._view.to - this._view.from;
      clampView(this._view.from + direction * span * 0.5, span);
    };
    card.querySelector("#panleft").addEventListener("click", () => nudge(-1));
    card.querySelector("#panright").addEventListener("click", () => nudge(1));

    // Arrow keys once the timeline has focus.
    timeline.tabIndex = 0;
    timeline.addEventListener("keydown", (event) => {
      if (event.key === "ArrowLeft") nudge(-1);
      else if (event.key === "ArrowRight") nudge(1);
      else return;
      event.preventDefault();
    });

    const step = (direction) => {
      if (!this._blocks.length) return;
      const now = this._cursor || this._blocks[0].start;
      const next =
        direction > 0
          ? this._blocks.find((b) => b.start > now)
          : [...this._blocks].reverse().find((b) => b.start < now);
      if (next) this._playFrom(next.start);
    };
    card.querySelector("#len").addEventListener("change", (event) => {
      this._clipSeconds = Number(event.target.value);
      if (this._cursor) this._playFrom(this._cursor);
    });
    card.querySelector("#prev").addEventListener("click", () => step(-1));
    card.querySelector("#next").addEventListener("click", () => step(1));
    card.querySelector("#download").addEventListener("click", () => this._download());
  }

  /** Does this subtree have a video that is actually decoding pixels? */
  _hasLiveVideo(root) {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node) continue;
      if (node.tagName === "VIDEO" && node.videoWidth > 100 && node.readyState >= 2) {
        return true;
      }
      if (node.shadowRoot) stack.push(...node.shadowRoot.children);
      if (node.children) stack.push(...node.children);
    }
    return false;
  }

  async _renderStage(stage) {
    if (!stage || !this._selected) return;
    if (this._mode === "live") return this._renderLive(stage);
    return this._renderPlayback(stage);
  }

  /** An error, or a note about what to do next, where the video would be. */
  _overlay(stage, message) {
    stage.dataset.url = "";
    stage.innerHTML = `<div class="overlay">${esc(message)}</div>`;
  }

  _absolute(url) {
    return this._hass.hassUrl
      ? this._hass.hassUrl(url)
      : new URL(url, window.location.origin).href;
  }

  /**
   * Live view through Home Assistant's own camera element, which negotiates
   * WebRTC via go2rtc: measured in this stage, a decoding frame in ~1.0s
   * against ~2.9-5.1s for our HLS URL, and it reuses the stream the camera
   * entity already runs rather than starting a second one.
   *
   * The HLS URL is fetched only if that path is missing or stays black.
   * Asking for it up front -- which is what this did -- started an ffmpeg and
   * an RTSP session against the NVR on every single live view, held them for
   * the five minute idle timeout, and then threw the result away unread.
   */
  async _renderLive(stage) {
    const key = `live:${this._selected}`;
    if (stage.dataset.url === key) return;

    await ensurePlayer();
    const channel = this._channels.find((c) => c.id === this._selected);
    const stateObj = channel && this._hass.states[channel.entity_id];

    if (stateObj && customElements.get("ha-camera-stream")) {
      stage.dataset.url = key;
      stage.innerHTML = "";

      // ha-camera-stream reads its Home Assistant handles from Lit contexts,
      // not from a hass property, and must be attached before stateObj is set.
      const native = document.createElement("ha-camera-stream");
      stage.appendChild(native);
      native.stateObj = stateObj;
      native.muted = this._muted;
      native.allowExoPlayer = true;

      // Never leave a black stage: if nothing is decoding shortly, fall back
      // to the HLS path, which is slower but has always worked.
      const started = Date.now();
      const watchdog = setInterval(() => {
        if (!native.isConnected || stage.dataset.url !== key) {
          clearInterval(watchdog);
        } else if (this._hasLiveVideo(native)) {
          clearInterval(watchdog);
        } else if (Date.now() - started > NATIVE_LIVE_TIMEOUT) {
          clearInterval(watchdog);
          native.remove();
          this._renderHlsLive(stage);
        }
      }, 400);
      return;
    }

    await this._renderHlsLive(stage);
  }

  /** The fallback: our own HLS URL, remuxed server-side by ffmpeg. */
  async _renderHlsLive(stage) {
    const url = await this._liveUrl().catch(() => null);
    if (!url) return this._overlay(stage, this._error || "Starting stream\u2026");
    stage.dataset.url = url;
    stage.innerHTML = "";

    const absolute = this._absolute(url);
    if (customElements.get("ha-hls-player")) {
      const player = document.createElement("ha-hls-player");
      player.hass = this._hass;
      player.url = absolute;
      player.autoPlay = true;
      player.muted = true;
      player.playsInline = true;
      stage.appendChild(player);
      return;
    }
    // Native HLS (Safari / iOS) when the Home Assistant chunk is unavailable.
    const video = document.createElement("video");
    video.src = absolute;
    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;
    video.controls = true;
    stage.appendChild(video);
  }

  /**
   * History is a plain fragmented-MP4 file, so <video> plays it directly with
   * native seeking and no HLS machinery at all. It is signed rather than sent
   * with a header because a bare <video src> cannot carry one.
   */
  async _renderPlayback(stage) {
    const url = this._playbackUrl;
    if (!url) {
      return this._overlay(
        stage,
        this._error || "Pick a moment on the timeline to play"
      );
    }
    if (stage.dataset.url === url) return;
    stage.dataset.url = url;

    const { path } = await this._hass.callWS({
      type: "auth/sign_path",
      path: url,
      expires: 3600,
    });
    stage.innerHTML = "";
    const video = document.createElement("video");
    video.src = this._absolute(path);
    video.autoplay = true;
    video.muted = true;
    video.controls = true;
    video.playsInline = true;
    video.preload = "auto";
    stage.appendChild(video);
    // Chrome pauses muted video-only media in a background tab ("paused to
    // save power"); that rejection is expected and not worth surfacing.
    video.play().catch(() => {});
  }
}

/**
 * Visual editor. Everything is a dropdown, driven by <ha-form> so the widgets
 * are Home Assistant's own and stay consistent with the rest of the UI.
 * The NVR and camera lists are fetched live from the API, so there is nothing
 * to type and nothing to remember.
 */
class HikvisionNvrCardEditor extends HTMLElement {
  constructor() {
    super();
    this._devices = [];
  }

  setConfig(config) {
    this._config = { columns: 3, default_mode: "live", live_stream: 1, ...config };
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (first) this._load();
    else this._render();
  }

  async _load() {
    try {
      const { devices } = await this._hass.callApi("GET", "hikvision_nvr/devices");
      this._devices = devices;
    } catch (err) {
      this._error = errText(err);
    }
    this._render();
  }

  get _device() {
    return (
      this._devices.find(
        (d) => d.id === this._config?.device || d.host === this._config?.device
      ) || this._devices[0]
    );
  }

  _schema() {
    const device = this._device;
    const channels = device?.channels || [];
    return [
      {
        name: "device",
        selector: {
          select: {
            mode: "dropdown",
            options: this._devices.map((d) => ({
              value: d.id,
              label: `${d.name} (${d.model || d.host})`,
            })),
          },
        },
      },
      {
        name: "channels",
        selector: {
          select: {
            multiple: true,
            mode: "list",
            options: channels.map((c) => ({
              value: String(c.id),
              label: `${c.id} · ${c.name}${c.online ? "" : " (offline)"}`,
            })),
          },
        },
      },
      {
        name: "default_mode",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: "live", label: "Live view" },
              { value: "playback", label: "History" },
            ],
          },
        },
      },
      {
        name: "live_stream",
        selector: {
          select: {
            mode: "dropdown",
            options: [
              { value: 1, label: "Main stream — full resolution" },
              { value: 2, label: "Sub stream — lighter, starts faster" },
            ],
          },
        },
      },
      {
        name: "columns",
        selector: { number: { min: 1, max: 6, mode: "slider" } },
      },
    ];
  }

  _labels(schema) {
    return {
      device: "NVR",
      channels: "Cameras to show",
      default_mode: "Opens on",
      live_stream: "Live quality",
      columns: "Thumbnails per row",
    }[schema.name];
  }

  _render() {
    if (!this._hass || !this._config) return;
    if (!this.querySelector("ha-form")) {
      this.innerHTML = `<div class="hik-editor" style="padding:8px 0"></div>`;
      const form = document.createElement("ha-form");
      form.addEventListener("value-changed", (event) => {
        const config = { ...this._config, ...event.detail.value };
        // Selecting a different NVR invalidates the camera picks.
        if (config.device !== this._config.device) delete config.channels;
        this._config = config;
        this.dispatchEvent(
          new CustomEvent("config-changed", {
            detail: { config: { type: "custom:ultimate-nvr-card", ...config } },
            bubbles: true,
            composed: true,
          })
        );
        this._render();
      });
      this.querySelector(".hik-editor").appendChild(form);
    }

    if (this._error) {
      this.querySelector(".hik-editor").insertAdjacentHTML(
        "afterbegin",
        `<div style="color:var(--error-color);font-size:13px;padding:8px">${esc(
          this._error
        )}</div>`
      );
      this._error = null;
    }

    const device = this._device;
    const form = this.querySelector("ha-form");
    form.hass = this._hass;
    form.schema = this._schema();
    form.computeLabel = (schema) => this._labels(schema);
    form.data = {
      ...this._config,
      device: device?.id ?? this._config.device,
      // Nothing selected means "all cameras" -- show that as all ticked.
      channels: (
        this._config.channels || (device?.channels || []).map((c) => c.id)
      ).map(String),
    };
  }
}

// The panel imports this module under a different URL than the global
// add_extra_js_url load, so it can execute twice. Defining twice throws.
if (!customElements.get("ultimate-nvr-card")) {
  customElements.define("ultimate-nvr-card", HikvisionNvrCard);
  customElements.define("ultimate-nvr-card-editor", HikvisionNvrCardEditor);
}


}

// ---- fast-live.js ----
{
const customElements = (() => {
  const real = window.customElements;
  return {
    get: (tag) => real.get(tag),
    define: (...args) => real.define(...args),
    upgrade: (...args) => real.upgrade(...args),
    whenDefined: (tag) => real.get(tag)
      ? { then(done) { done(real.get(tag)); return Promise.resolve(real.get(tag)); } }
      : real.whenDefined(tag),
  };
})();
/* Fast live view for the Hikvision NVR playback card (custom:ultimate-nvr-card).
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
customElements.whenDefined("ultimate-nvr-card").then(() => {
  const proto = customElements.get("ultimate-nvr-card").prototype;
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
    if (host.getAttribute("lm") === "single") return false; // wall layout "Single": the tiles are hidden
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
    isWall, entryFor, goHistory, clock, isoDay, paintSide, buildCard, iconSvg, refreshPtz, syncTiles,
  });
  function hook(name, ...args) {
    try {
      if (W[name]) W[name](...args);
    } catch (err) {
      console.warn("nvr fast-live: wall extra failed", err);
    }
  }
});

}

// ---- wall-extras.js ----
{
const customElements = (() => {
  const real = window.customElements;
  return {
    get: (tag) => real.get(tag),
    define: (...args) => real.define(...args),
    upgrade: (...args) => real.upgrade(...args),
    whenDefined: (tag) => real.get(tag)
      ? { then(done) { done(real.get(tag)); return Promise.resolve(real.get(tag)); } }
      : real.whenDefined(tag),
  };
})();
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
 *   6. A layout switch in the header (wide screens): Focus (the big picture
 *      and the tiles), Grid (every camera the same size) and Single (one
 *      camera). Remembered per browser; card option `view:` sets the default.
 *   7. The detections bar slides away and back (wide screens): swipe it to
 *      the right, or tap its handle; swipe in from the right edge, or tap the
 *      handle, to bring it back. Remembered per browser.
 *
 * Deployed as an inline dashboard resource; this file is the source of truth.
 */
customElements.whenDefined("ultimate-nvr-card").then(() => {
  const proto = customElements.get("ultimate-nvr-card").prototype;
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
        :host([wall][side-off]) .fl-side { width: 0; }
        :host([wall]) .fl-side > * { width: 250px; }
        .flx-side-tab {
          position: absolute; top: 50%; right: 250px; z-index: 6; transform: translateY(-50%);
          width: 18px; height: 64px; padding: 0; border: 0; border-radius: 10px 0 0 10px; cursor: pointer;
          display: grid; place-items: center; color: rgba(255,255,255,.8);
          background: rgba(20,23,31,.9); box-shadow: -4px 0 14px -6px rgba(0,0,0,.6);
          transition: right .28s cubic-bezier(.2, .8, .2, 1), background .2s; touch-action: none;
        }
        .flx-side-tab:hover { background: rgba(32,36,47,.96); }
        .flx-side-tab svg { width: 14px; height: 14px; fill: currentColor; transition: transform .28s; }
        :host([wall][side-off]) .flx-side-tab { right: 0; }
        :host([wall][side-off]) .flx-side-tab svg { transform: rotate(180deg); }
        @media (prefers-reduced-motion: reduce) {
          :host([wall]) .fl-side, .flx-side-tab, .flx-side-tab svg { transition: none; }
        }
      }
      @media (max-width: 899px), (max-height: 500px) { .flx-side-tab { display: none; } }
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
    const swipe = (el, onSwipe, startOk = () => true) => {
      let start = null;
      el.addEventListener("pointerdown", (event) => {
        start = event.isPrimary && startOk(event) ? { x: event.clientX, y: event.clientY, t: Date.now() } : null;
      });
      el.addEventListener("pointerup", (event) => {
        if (!start) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        const quick = Date.now() - start.t < 700;
        start = null;
        if (quick && Math.abs(dx) > 50 && Math.abs(dy) < 40) onSwipe(dx > 0 ? "right" : "left", event);
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
        if (saved === "closed") {
          host._sideOff = true;
          host.toggleAttribute("side-off", true);
        }
      }
      if (!card.querySelector(":scope > .flx-side-tab")) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "flx-side-tab";
        tab.setAttribute("aria-label", host._sideOff ? "Show detections" : "Hide detections");
        tab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M8.6 16.6 13.2 12 8.6 7.4 10 6l6 6-6 6z"/></svg>';
        tab.addEventListener("click", (event) => {
          event.stopPropagation();
          setSide(host, !!host._sideOff);
        });
        // Drag the handle itself: left opens, right closes.
        swipe(tab, (direction) => setSide(host, direction === "left"));
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
          (event) => host._sideOff && card.getBoundingClientRect().right - event.clientX < 40
        );
      }
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

}

// ---- ultimate.js ----
{
const customElements = (() => {
  const real = window.customElements;
  return {
    get: (tag) => real.get(tag),
    define: (...args) => real.define(...args),
    upgrade: (...args) => real.upgrade(...args),
    whenDefined: (tag) => real.get(tag)
      ? { then(done) { done(real.get(tag)); return Promise.resolve(real.get(tag)); } }
      : real.whenDefined(tag),
  };
})();
/* Ultimate Hikvision NVR card: the layer that makes the wall work in any house.
 *
 *  - Defaults: the wall layout, live tiles, 5 columns (2 on a phone).
 *  - Zero config: when the card's options do not list cameras (`fast_live`),
 *    every channel the integration reports gets its Home Assistant camera
 *    entity and that camera's motion sensors, and the first PTZ channel gets
 *    the joystick and its named presets. Anything set in the options wins.
 *  - The joystick drives the camera through the integration's own services
 *    (hikvision_nvr.ptz and ptz_aim) instead of hand-made scripts. Setting
 *    `script:` in `ptz.joystick` still uses your scripts.
 */
(() => {
  const TAG = "ultimate-nvr-card";
  const STICK = "arcane-ptz-joystick";
  const ZOOM_SPEED = 60;

  // ---- defaults and zero config -------------------------------------------------
  customElements.whenDefined(TAG).then(() => {
    const proto = customElements.get(TAG).prototype;
    if (proto.__ultimate) return;
    proto.__ultimate = true;

    const originalSetConfig = proto.setConfig;
    proto.setConfig = function (config) {
      originalSetConfig.call(this, {
        layout: "wall",
        live_tiles: true,
        columns: 5,
        columns_narrow: 2,
        ...(config || {}),
      });
      this._ultAuto = false;
    };

    const isMotion = (hass, id) => {
      const state = hass.states[id];
      const kind = state && state.attributes && state.attributes.device_class;
      return kind === "motion" || kind === "occupancy";
    };

    const autoConfig = (host) => {
      const config = host._config || {};
      const device = host._device;
      const hass = host._hass;
      const next = { ...config };
      if (!config.fast_live) {
        const fast = {};
        for (const channel of device.channels || []) {
          if (!channel.entity_id) continue; // no camera entity: the card's own live view
          const entry = { entity: channel.entity_id };
          const registry = hass.entities || {};
          const owner = registry[channel.entity_id] && registry[channel.entity_id].device_id;
          if (owner) {
            const motion = Object.values(registry)
              .filter((e) => e.device_id === owner && e.entity_id.startsWith("binary_sensor."))
              .map((e) => e.entity_id)
              .filter((id) => isMotion(hass, id));
            if (motion.length) entry.motion = motion;
          }
          fast[channel.id] = entry;
        }
        next.fast_live = fast;
      }
      if (config.ptz === undefined) {
        const ptz = (device.channels || []).find((channel) => channel.ptz);
        if (ptz) {
          next.ptz = {
            channel: ptz.id,
            joystick: { service: "hikvision_nvr", device_id: device.id, channel: ptz.id },
            presets: "auto",
          };
        }
      } else if (config.ptz && !(config.ptz.joystick && config.ptz.joystick.script)) {
        next.ptz = {
          ...config.ptz,
          joystick: {
            service: "hikvision_nvr",
            device_id: device.id,
            channel: Number(config.ptz.channel),
            ...(config.ptz.joystick || {}),
          },
        };
      }
      host._config = next;
      // Slots with no camera (offline) are left off unless asked for.
      if (!config.channels && config.show_offline !== true && Array.isArray(host._channels)) {
        const online = host._channels.filter((channel) => channel.online !== false);
        if (online.length) {
          host._channels = online;
          if (!online.some((channel) => channel.id === host._selected)) host._selected = online[0].id;
        }
      }
      if (next.ptz && next.ptz.presets === "auto") loadPresets(host);
    };

    // The camera's named presets become the "Views" list.
    const loadPresets = async (host) => {
      const ptz = host._config.ptz;
      ptz.presets = [];
      try {
        const reply = await host._hass.callService(
          "hikvision_nvr",
          "ptz_presets",
          { channel: Number(ptz.channel), device_id: host._device.id },
          undefined,
          false,
          true
        );
        const list = (reply && reply.response && reply.response.presets) || [];
        ptz.presets = list.map((p) => ({ name: p.name, preset: p.id, icon: "mdi:target" }));
        const W = proto.__flWall;
        if (ptz.presets.length && W && W.refreshPtz) W.refreshPtz(host);
      } catch (err) {
        console.info("ultimate-nvr-card: no PTZ preset list", err);
      }
    };

    const originalRender = proto._render;
    proto._render = function (...args) {
      if (!this._ultAuto && this._device && this._hass) {
        this._ultAuto = true;
        try {
          autoConfig(this);
        } catch (err) {
          console.warn("ultimate-nvr-card: automatic setup failed", err);
        }
      }
      return originalRender.apply(this, args);
    };
  });

  // ---- the joystick through the integration -----------------------------------
  customElements.whenDefined(STICK).then(() => {
    const P = customElements.get(STICK).prototype;
    if (P.__ultimateService) return;
    P.__ultimateService = true;
    // Set by the layer above when no script of your own was given.
    const service = (el) => (el._config && el._config.service === "hikvision_nvr" ? el._config : null);
    const target = (c) => ({
      channel: Number(c.channel),
      ...(c.device_id ? { device_id: c.device_id } : {}),
    });
    const send = (el, name, data) =>
      el._hass
        .callService("hikvision_nvr", name, data)
        .catch((err) => console.warn("ultimate-nvr-card: PTZ call failed", err));

    const originalCall = P._call;
    P._call = function (script, data) {
      const c = service(this);
      if (!c) return originalCall.call(this, script, data);
      if (!this._hass || !script) return Promise.resolve();
      const t = target(c);
      const speed = Number(c.zoom_speed) || ZOOM_SPEED;
      if (script === this._aimScript) return send(this, "ptz_aim", { ...t, ...(data || {}) });
      if (script === this._zoomIn) return send(this, "ptz", { ...t, zoom: speed, duration: 0 });
      if (script === this._zoomOut) return send(this, "ptz", { ...t, zoom: -speed, duration: 0 });
      if (script === this._zoomStop) return send(this, "ptz", { ...t, duration: 0 });
      if (script === this._zoomOutFull) return send(this, "ptz", { ...t, zoom: -100, duration: 4 });
      return Promise.resolve();
    };

    const originalPump = P._pump;
    P._pump = async function () {
      const c = service(this);
      if (!c) return originalPump.call(this);
      if (this._busy || !this._hass) return;
      const t = this._target;
      if (this._sent && this._sent.pan === t.pan && this._sent.tilt === t.tilt) return;
      this._busy = true;
      this._sent = t;
      // Continuous move (duration 0) until the next call; 0 / 0 stops.
      await send(this, "ptz", { ...target(c), pan: t.pan, tilt: t.tilt, duration: 0 });
      await new Promise((resolve) => setTimeout(resolve, 60));
      this._busy = false;
      this._pump();
    };
  });

  // ---- card picker ---------------------------------------------------------------
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === TAG)) {
    window.customCards.push({
      type: TAG,
      name: "Ultimate Hikvision NVR",
      description: "Camera wall for a Hikvision recorder: live grid, PTZ joystick, person / vehicle timeline.",
      preview: false,
      documentationURL: "https://github.com/deekay2153/ultimate-ultimate-nvr-card",
    });
  }
})();

}
