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
