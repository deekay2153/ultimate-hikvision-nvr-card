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
      // A twin-lens camera (a panoramic lens that steers a PTZ, e.g. TandemVu)
      // shows up as two channels at one address. It spots people and vehicles
      // on the panoramic lens only, so the PTZ borrows that lens's markers.
      if (next.ptz && next.ptz.linked === undefined) {
        const channels = device.channels || [];
        const own = channels.find((channel) => channel.id === Number(next.ptz.channel));
        const twins = own && own.ip_address
          ? channels.filter((channel) => channel.id !== own.id && channel.ip_address === own.ip_address).map((c) => c.id)
          : [];
        if (twins.length) next.ptz = { ...next.ptz, linked: twins };
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
      documentationURL: "https://github.com/deekay2153/ultimate-hikvision-nvr-card",
    });
  }
})();
