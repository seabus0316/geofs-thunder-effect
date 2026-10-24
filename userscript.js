// ==UserScript==
// @name         GeoFS Lightning
// @namespace    https://github.com/seabus0316
// @version      0.5.0
// @description  3D branching lightning + screen flash for GeoFS. Manual and storm-driven auto mode.
// @author       SeaBus
// @match        http://*/geofs.php*
// @match        https://*/geofs.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // Re-injection safety: tear down any previous instance first.
  if (window.GeoFSLightning && typeof window.GeoFSLightning.destroy === 'function') {
    try { window.GeoFSLightning.destroy(); } catch (e) { /* ignore */ }
  }

  const TAG = '[GeoFSLightning]';
  const CFG = {
    minDist: 600,         // m, horizontal distance from camera
    maxDist: 1800,        // observed: bolt nearly invisible beyond ~1800 m with clouds on
    visFactor: 0.18,      // max strike distance <= visibility * visFactor (tune in-game)
    minDistRatio: 0.3,    // min distance = effective max * this
    bearingSpread: 35,    // deg, random offset from camera heading
    cloudHeight: 3000,    // m fallback if weather.definition.cloudBase is unusable
    minHeight: 500,       // m, clamp for cloudBase - groundHeight
    maxHeight: 6000,
    jitter: 0.35,         // lateral jitter as fraction of segment length
    durationMs: 380,
    flashPeak: 0.6,       // max overlay opacity (centre of the glow, nearest strike)
    flashAmbient: 0.08,   // glow alpha far from the bolt (0 = none)
    flashFar: 0.4,        // strength multiplier for the farthest strikes
    coreWidths: [1.5, 2, 2.5], // px, main channel top -> bottom
    glowWidths: [5, 7, 9],
    branchCore: 1,
    branchGlow: 3,
    branchesMin: 2,
    branchesMax: 5,
    autoMeanMaxMs: 25000, // mean interval at storm level ~0
    autoMeanMinMs: 3000,  // mean interval at storm level 1
    autoMinLevel: 0.05    // below this, no auto strikes
  };

  const S = {
    enabled: false,
    viewer: null,
    scene: null,
    lines: null,          // Cesium.PolylineCollection
    removeListener: null, // preRender remover
    flashEl: null,
    flashStrength: 1,
    uiInterval: null,
    uiTimer: null,
    uidn: 0,
    docClick: null,
    fallbackAllowed: false,
    panel: null,
    btnToggle: null,
    btnStrike: null,
    pollTimer: null,
    glowMat: null,
    coreMat: null,
    t0: 0,
    destroyed: false
  };

  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  // ---------- runtime probe (Phase 1 evidence, printed to Console) ----------
  function probe() {
    const r = {};
    const t = (name, fn) => { try { r[name] = fn(); } catch (e) { r[name] = 'ERR: ' + e.message; } };
    t('Cesium global', () => typeof window.Cesium);
    t('Cesium.VERSION', () => window.Cesium && Cesium.VERSION);
    t('geofs', () => typeof window.geofs);
    t('geofs.api.viewer', () => !!(geofs.api && geofs.api.viewer));
    t('viewer.scene', () => !!geofs.api.viewer.scene);
    t('viewer.camera', () => !!geofs.api.viewer.camera);
    t('scene.preRender', () => typeof geofs.api.viewer.scene.preRender.addEventListener);
    t('scene.globe.getHeight', () => typeof geofs.api.viewer.scene.globe.getHeight);
    t('scene.requestRenderMode', () => geofs.api.viewer.scene.requestRenderMode);
    t('camera.heading (deg)', () => Cesium.Math.toDegrees(geofs.api.viewer.camera.heading));
    t('geofs.api.addFrameCallback', () => typeof geofs.api.addFrameCallback);
    t('geofs.api.setImageryBrightness', () => typeof geofs.api.setImageryBrightness);
    t('weather.definition.thunderstorm', () => weather.definition.thunderstorm);
    t('weather.definition.cloudBase', () => weather.definition.cloudBase);
    t('weather.manualDefinition.thunderstorm', () => weather.manualDefinition.thunderstorm);
    t('weather.definition.precipitationAmount', () => weather.definition.precipitationAmount);
    t('weather.definition.precipitationType', () => weather.definition.precipitationType);
    t('weather.definitionBounds.thunderstorm', () => weather.definitionBounds.thunderstorm);
    console.table(r);
    return r;
  }

  // ---------- helpers ----------
  const rnd = (a, b) => a + Math.random() * (b - a);

  function groundHeight(carto) {
    try {
      const h = S.scene.globe.getHeight(carto);
      if (typeof h === 'number' && isFinite(h)) return h;
    } catch (e) { /* fall through */ }
    return 0;
  }

  function stormLevel() {
    try {
      const v = weather.definition.thunderstorm;
      if (typeof v !== 'number' || !isFinite(v)) return 0;
      return Math.min(1, Math.max(0, v > 1 ? v / 100 : v)); // observed scale: 0-100
    } catch (e) { return 0; }
  }

  function boltHeight(h0) {
    try {
      const cb = weather.definition.cloudBase; // unit/datum unverified: assumed metres MSL
      if (typeof cb === 'number' && isFinite(cb) && cb > 0) {
        return Math.min(CFG.maxHeight, Math.max(CFG.minHeight, cb - h0));
      }
    } catch (e) { /* fall through */ }
    return CFG.cloudHeight;
  }

  function toWorld(enu, pts) {
    return pts.map(p => Cesium.Matrix4.multiplyByPoint(
      enu, new Cesium.Cartesian3(p[0], p[1], p[2]), new Cesium.Cartesian3()));
  }

  function buildBolt() {
    const cam = S.viewer.camera;
    const hdg = (cam.heading || 0) + Cesium.Math.toRadians(rnd(-CFG.bearingSpread, CFG.bearingSpread));
    const rel = Math.atan2(Math.sin(hdg - (cam.heading || 0)), Math.cos(hdg - (cam.heading || 0))); // -pi..pi, + = right
    let dMax = CFG.maxDist;
    try {
      const vis = weather.definition.visibility; // metres assumed
      if (typeof vis === 'number' && isFinite(vis) && vis > 0) dMax = Math.min(dMax, vis * CFG.visFactor);
    } catch (e) { /* keep default */ }
    dMax = Math.max(dMax, 800);
    const dMin = Math.min(CFG.minDist, dMax * CFG.minDistRatio);
    const dist = rnd(dMin, dMax);

    const enuCam = Cesium.Transforms.eastNorthUpToFixedFrame(cam.positionWC);
    const probePt = Cesium.Matrix4.multiplyByPoint(
      enuCam,
      new Cesium.Cartesian3(Math.sin(hdg) * dist, Math.cos(hdg) * dist, 0),
      new Cesium.Cartesian3()
    );
    const c = Cesium.Cartographic.fromCartesian(probePt);
    const h0 = groundHeight(c);
    const base = Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, h0);
    const enu = Cesium.Transforms.eastNorthUpToFixedFrame(base);

    const H = boltHeight(h0);
    const n = Math.max(12, Math.min(40, Math.round(H / 120)));
    const segLen = H / n;

    // local [east, north, up] points, cloud -> ground
    const local = [];
    for (let i = 0; i <= n; i++) {
      const t = 1 - i / n;
      const amp = (i === n) ? 0 : segLen * CFG.jitter * (0.4 + t);
      local.push([rnd(-amp, amp) * 2, rnd(-amp, amp) * 2, t * H]);
    }

    // main channel in 3 sections (thin top -> thick bottom); shared end points
    const cuts = [0, Math.floor(n / 3), Math.floor(2 * n / 3), n];
    const main = [];
    for (let s = 0; s < 3; s++) main.push(toWorld(enu, local.slice(cuts[s], cuts[s + 1] + 1)));

    // branches: leave the main channel, drift sideways and downward
    const branches = [];
    const nb = Math.round(rnd(CFG.branchesMin, CFG.branchesMax));
    for (let b = 0; b < nb; b++) {
      const o = local[Math.floor(rnd(n * 0.15, n * 0.75))];
      const ang = rnd(0, Math.PI * 2);
      const len = H * rnd(0.15, 0.3);
      const bn = Math.max(6, Math.round(n * 0.4));
      const step = len / bn;
      let x = o[0], y = o[1], z = o[2];
      const pts = [[x, y, z]];
      for (let k = 1; k <= bn; k++) {
        x += Math.cos(ang) * step * 0.6 + rnd(-1, 1) * step * CFG.jitter * 2;
        y += Math.sin(ang) * step * 0.6 + rnd(-1, 1) * step * CFG.jitter * 2;
        z -= step * 0.8;
        if (z <= 0) { pts.push([x, y, 0]); break; }
        pts.push([x, y, z]);
      }
      if (pts.length > 1) branches.push(toWorld(enu, pts));
    }
    const anchors = toWorld(enu, FLASH_LAYERS.map(l => [0, 0, H * l.f]));
    return { main, branches, anchors, distRatio: Math.min(1, dist / dMax), rel };
  }

  // intensity 0..1 over normalized time u in [0,1]: bright, dip, re-strike, decay
  function intensity(u) {
    if (u < 0 || u > 1) return 0;
    if (u < 0.15) return 1;
    if (u < 0.28) return 0.25;
    if (u < 0.45) return 0.85;
    return Math.max(0, 1 - (u - 0.45) / 0.55) * 0.6;
  }

  function requestRender() {
    try { S.scene.requestRender && S.scene.requestRender(); } catch (e) { /* ignore */ }
  }

  function endStrike() {
    if (S.removeListener) { try { S.removeListener(); } catch (e) {} S.removeListener = null; }
    if (S.lines) { try { S.lines.removeAll(); } catch (e) {} }
    if (S.flashEl) S.flashEl.style.opacity = '0';
    requestRender();
  }

  // ---------- directional flash ----------
  // glow sources along the bolt: f = height fraction, w = alpha weight, m = radius multiplier
  const FLASH_LAYERS = [
    { f: 0.08, w: 0.85, m: 0.8 },
    { f: 0.40, w: 0.55, m: 0.8 },
    { f: 0.70, w: 0.55, m: 0.9 },
    { f: 1.00, w: 1.00, m: 1.2 }  // cloud base lit up
  ];

  function projectToScreen(pos) {
    try {
      const cam = S.viewer.camera;
      const toPos = Cesium.Cartesian3.subtract(pos, cam.positionWC, new Cesium.Cartesian3());
      if (Cesium.Cartesian3.dot(toPos, cam.directionWC) <= 0) return null; // behind camera
      const p = Cesium.SceneTransforms.wgs84ToWindowCoordinates(S.scene, pos);
      if (!p) return null;
      const r = S.scene.canvas.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    } catch (e) { return null; }
  }

  function setFlashShape(bolt) {
    const W = window.innerWidth, H = window.innerHeight;
    let strength = 1 - (1 - CFG.flashFar) * bolt.distRatio;
    const R = W * (0.9 - 0.4 * bolt.distRatio);
    const c = '215,225,255';
    const layers = [];
    FLASH_LAYERS.forEach(function (l, i) {
      const pt = projectToScreen(bolt.anchors[i]);
      if (!pt) return;
      const x = Math.max(-0.5 * W, Math.min(1.5 * W, pt.x));
      const y = Math.max(-0.5 * H, Math.min(1.5 * H, pt.y));
      layers.push([x, y, l.w, R * l.m]);
    });
    if (!layers.length) { // all behind camera: light from that side, weaker
      layers.push([bolt.rel > 0 ? 1.3 * W : -0.3 * W, 0.5 * H, 1, R]);
      strength *= 0.5;
    }
    const bg = layers.map(function (L) {
      const r = L[3], w = L[2];
      return 'radial-gradient(circle ' + r.toFixed(0) + 'px at ' + L[0].toFixed(0) + 'px ' + L[1].toFixed(0) + 'px,' +
        'rgba(' + c + ',' + w.toFixed(2) + ') 0px,' +
        'rgba(' + c + ',' + (w * 0.5).toFixed(2) + ') ' + (r * 0.25).toFixed(0) + 'px,' +
        'rgba(' + c + ',' + (w * 0.18).toFixed(2) + ') ' + (r * 0.6).toFixed(0) + 'px,' +
        'rgba(' + c + ',0) ' + r.toFixed(0) + 'px)';
    });
    bg.push('linear-gradient(rgba(' + c + ',' + CFG.flashAmbient + '),rgba(' + c + ',' + CFG.flashAmbient + '))');
    S.flashEl.style.background = bg.join(',');
    S.flashStrength = strength;
  }

  // ---------- core ----------
  function strike() {
    if (!S.enabled || S.destroyed) return;
    if (S.removeListener) endStrike(); // cancel overlapping strike

    let bolt;
    try { bolt = buildBolt(); }
    catch (e) { warn('buildBolt failed', e); return; }
    setFlashShape(bolt);

    S.lines.removeAll();
    // glow first (drawn under), then core
    bolt.branches.forEach(pts => S.lines.add({ positions: pts, width: CFG.branchGlow, material: S.brGlowMat }));
    bolt.main.forEach((pts, i) => S.lines.add({ positions: pts, width: CFG.glowWidths[i], material: S.glowMat }));
    bolt.branches.forEach(pts => S.lines.add({ positions: pts, width: CFG.branchCore, material: S.brCoreMat }));
    bolt.main.forEach((pts, i) => S.lines.add({ positions: pts, width: CFG.coreWidths[i], material: S.coreMat }));

    S.t0 = performance.now();
    S.removeListener = S.scene.preRender.addEventListener(function () {
      const u = (performance.now() - S.t0) / CFG.durationMs;
      if (u >= 1) { endStrike(); return; }
      const k = intensity(u);
      S.coreMat.uniforms.color.alpha = k;
      S.glowMat.uniforms.color.alpha = 0.3 * k;
      S.brCoreMat.uniforms.color.alpha = 0.7 * k;
      S.brGlowMat.uniforms.color.alpha = 0.2 * k;
      S.flashEl.style.opacity = String((CFG.flashPeak * k * S.flashStrength).toFixed(3));
      requestRender(); // requestRenderMode is true in this GeoFS build
    });
    requestRender();
  }

  // ---------- auto mode (driven by weather.definition.thunderstorm) ----------
  function clearAuto() {
    if (S.autoTimer) { clearTimeout(S.autoTimer); S.autoTimer = null; }
  }

  function scheduleAuto() {
    clearAuto();
    if (!S.auto || !S.enabled || S.destroyed) return;
    const k = stormLevel();
    let d = 2000; // idle re-check
    if (k > CFG.autoMinLevel) {
      const mean = CFG.autoMeanMaxMs + (CFG.autoMeanMinMs - CFG.autoMeanMaxMs) * k;
      d = Math.min(60000, Math.max(800, -Math.log(1 - Math.random()) * mean));
    }
    S.autoTimer = setTimeout(function () {
      S.autoTimer = null;
      if (!S.auto || !S.enabled || S.destroyed) return;
      if (stormLevel() > CFG.autoMinLevel) strike();
      scheduleAuto();
    }, d);
  }

  function setAuto(on) {
    S.auto = !!on && S.enabled;
    if (S.auto) scheduleAuto(); else clearAuto();
    savePrefs();
    updatePanel();
  }

  function enable() {
    if (S.enabled || S.destroyed) return;
    if (!S.viewer) { warn('viewer not ready'); return; }

    const C = Cesium.Color;
    S.coreMat = Cesium.Material.fromType('Color', { color: new C(1.0, 1.0, 1.0, 1.0) });
    S.glowMat = Cesium.Material.fromType('Color', { color: new C(0.6, 0.75, 1.0, 0.3) });
    S.brCoreMat = Cesium.Material.fromType('Color', { color: new C(0.95, 0.97, 1.0, 0.7) });
    S.brGlowMat = Cesium.Material.fromType('Color', { color: new C(0.6, 0.75, 1.0, 0.2) });
    S.lines = S.scene.primitives.add(new Cesium.PolylineCollection());

    const el = document.createElement('div');
    el.id = 'geofs-lightning-flash';
    el.style.cssText =
      'position:fixed;inset:0;pointer-events:none;opacity:0;z-index:5;' +
      'background:rgb(215,225,255);';
    document.body.appendChild(el);
    S.flashEl = el;

    S.enabled = true;
    savePrefs();
    updatePanel();
    log('enabled');
  }

  function disable() {
    if (!S.enabled) return;
    S.auto = false;
    clearAuto();
    endStrike();
    if (S.lines) {
      try { S.scene.primitives.remove(S.lines); } catch (e) { warn('remove lines', e); }
      S.lines = null;
    }
    if (S.flashEl && S.flashEl.parentNode) S.flashEl.parentNode.removeChild(S.flashEl);
    S.flashEl = null;
    S.coreMat = S.glowMat = S.brCoreMat = S.brGlowMat = null;
    S.enabled = false;
    savePrefs();
    updatePanel();
    requestRender();
    log('disabled');
  }

  // ---------- persisted prefs ----------
  const PREF_KEY = 'geofsLightningSettings_v1';
  const PREFS = { enabled: false, auto: false, flashPeak: CFG.flashPeak };

  function loadPrefs() {
    try {
      const r = JSON.parse(localStorage.getItem(PREF_KEY) || 'null');
      if (!r) return;
      if (typeof r.enabled === 'boolean') PREFS.enabled = r.enabled;
      if (typeof r.auto === 'boolean') PREFS.auto = r.auto;
      if (typeof r.flashPeak === 'number' && isFinite(r.flashPeak)) {
        PREFS.flashPeak = Math.min(1, Math.max(0.1, r.flashPeak));
      }
    } catch (e) { /* ignore */ }
  }

  function savePrefs() {
    if (S.destroyed) return; // destroy() must not overwrite the user's saved state
    PREFS.enabled = S.enabled;
    PREFS.auto = S.auto;
    PREFS.flashPeak = CFG.flashPeak;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(PREFS)); } catch (e) { /* ignore */ }
  }

  // ---------- UI ----------
  // Preferred: a LIGHTNING section inside Bonsai UI's settings panel (#bonsai-settings),
  // re-injected whenever Bonsai rebuilds that panel. Fallback: small standalone panel.
  const SECTION_ID = 'gl-section';
  const POP_ID = 'gl-popover';
  const BTN_ID = 'gl-bar-btn';
  const STYLE_ID = 'gl-style';

  // Shared control block (used in Bonsai's settings panel and in the popover).
  function makeControls(titleTag) {
    const uid = ++S.uidn;
    const sec = document.createElement('div');
    sec.setAttribute('data-gl-controls', '1');
    sec.innerHTML =
      '<' + titleTag + '>LIGHTNING</' + titleTag + '>' +
      '<div class="row"><label for="gl-enable-' + uid + '">Lightning effect</label>' +
        '<input type="checkbox" data-gl="enable" id="gl-enable-' + uid + '"></div>' +
      '<div class="row"><label for="gl-auto-' + uid + '">Auto (follows thunderstorm weather)</label>' +
        '<input type="checkbox" data-gl="auto" id="gl-auto-' + uid + '"></div>' +
      '<h4>FLASH BRIGHTNESS</h4>' +
      '<div class="row"><input type="range" data-gl="bright" min="0.1" max="1" step="0.05">' +
        '<span data-gl="brightVal"></span></div>' +
      '<button class="reset" data-gl="strike">TEST STRIKE</button>';

    const q = k => sec.querySelector('[data-gl="' + k + '"]');
    const en = q('enable'), au = q('auto'), br = q('bright'), st = q('strike');
    en.addEventListener('change', () => { en.checked ? enable() : disable(); });
    au.addEventListener('change', () => { setAuto(au.checked); });
    br.addEventListener('input', () => {
      CFG.flashPeak = parseFloat(br.value);
      savePrefs();
      syncControls();
    });
    st.addEventListener('click', () => { strike(); st.blur(); });
    return sec;
  }

  function syncControls() {
    document.querySelectorAll('[data-gl-controls]').forEach(function (sec) {
      const q = k => sec.querySelector('[data-gl="' + k + '"]');
      q('enable').checked = S.enabled;
      q('auto').checked = S.auto;
      q('auto').disabled = !S.enabled;
      q('strike').disabled = !S.enabled;
      q('strike').style.opacity = S.enabled ? '1' : '0.5';
      q('bright').value = CFG.flashPeak;
      q('brightVal').textContent = Math.round(CFG.flashPeak * 100) + '%';
    });
    const btn = document.getElementById(BTN_ID);
    if (btn) btn.classList.toggle('geofs-toggled', S.enabled);
  }

  function injectBonsai() {
    const host = document.getElementById('bonsai-settings');
    if (!host) return false;
    if (document.getElementById(SECTION_ID)) return true;
    const wrap = document.createElement('div');
    wrap.id = SECTION_ID;
    wrap.appendChild(makeControls('h4'));
    host.insertBefore(wrap, host.querySelector('#bs-reset') || null);
    return true;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `
      #gl-popover{position:fixed;left:50%;bottom:54px;transform:translateX(-50%);z-index:2147483646;
        width:300px;display:none;background:rgba(0,0,0,.82);border:1px solid rgba(255,255,255,.25);
        border-radius:6px;backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);color:#fff;
        font:12px 'Consolas','Menlo',monospace;padding:12px 14px;pointer-events:auto}
      #gl-popover h3{font-size:12px;letter-spacing:3px;margin:0 0 8px;color:#ccc;
        border-bottom:1px solid rgba(255,255,255,.15);padding-bottom:6px}
      #gl-popover h4{font-size:10px;letter-spacing:2px;margin:10px 0 6px;color:#888}
      #gl-popover .row{display:flex;align-items:center;justify-content:space-between;padding:4px 0}
      #gl-popover .row label{flex:1;cursor:pointer}
      #gl-popover input[type=checkbox]{accent-color:#fff;cursor:pointer}
      #gl-popover input[type=range]{width:130px}
      #gl-popover button.reset{margin-top:10px;width:100%;padding:6px;background:rgba(255,255,255,.08);
        color:#fff;border:1px solid rgba(255,255,255,.2);cursor:pointer;font:inherit;font-size:11px;letter-spacing:2px}
      #gl-popover button.reset:hover{background:rgba(255,255,255,.18)}
      #gl-popover button:disabled,#gl-popover input:disabled{cursor:default}
    `;
    document.head.appendChild(st);
  }

  // Official GeoFS bottom bar (.geofs-ui-bottom): add an icon button that toggles a popover.
  function injectOfficial() {
    const bar = document.querySelector('.geofs-ui-bottom');
    if (!bar) return false;
    if (document.getElementById(BTN_ID) && bar.contains(document.getElementById(BTN_ID))) return true;

    // bar was rebuilt or first run: (re)create button; reuse popover if it exists
    const old = document.getElementById(BTN_ID);
    if (old && old.parentNode) old.parentNode.removeChild(old);
    ensureStyle();

    const btn = document.createElement('button');
    btn.id = BTN_ID;
    btn.className = 'mdl-button mdl-button--icon';
    btn.title = 'Lightning';
    btn.innerHTML = '<i class="material-icons">flash_on</i>';
    bar.appendChild(btn);

    let pop = document.getElementById(POP_ID);
    if (!pop) {
      pop = document.createElement('div');
      pop.id = POP_ID;
      pop.appendChild(makeControls('h3'));
      document.body.appendChild(pop);
    }
    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      pop.style.display = (pop.style.display === 'block') ? 'none' : 'block';
      btn.blur();
    });
    if (!S.docClick) {
      S.docClick = function (e) {
        const pp = document.getElementById(POP_ID);
        const bb = document.getElementById(BTN_ID);
        if (!pp || pp.style.display !== 'block') return;
        if (pp.contains(e.target) || (bb && bb.contains(e.target))) return;
        pp.style.display = 'none';
      };
      document.addEventListener('click', S.docClick, true);
    }
    syncControls();
    return true;
  }

  function decideUI() {
    if (S.destroyed || !S.panel) return;
    const b = injectBonsai();
    const o = injectOfficial();
    if (b || o) {
      S.panel.style.display = 'none';
      syncControls();
    } else if (S.fallbackAllowed) {
      S.panel.style.display = 'flex';
    }
  }

    function buildPanel() {
    const p = document.createElement('div');
    p.id = 'geofs-lightning-panel';
    p.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:9999;display:none;gap:6px;' +
      'font:12px sans-serif;background:rgba(0,0,0,.55);padding:4px 6px;border-radius:6px;';
    const mk = (txt, fn) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.style.cssText = 'cursor:pointer;border:0;border-radius:4px;padding:3px 8px;';
      b.addEventListener('click', fn);
      p.appendChild(b);
      return b;
    };
    S.btnToggle = mk('⚡ Enable', () => (S.enabled ? disable() : enable()));
    S.btnStrike = mk('Strike', strike);
    S.btnAuto = mk('Auto: off', () => setAuto(!S.auto));
    document.body.appendChild(p);
    S.panel = p;
    updatePanel();
  }

  function updatePanel() {
    if (S.panel) {
      S.btnToggle.textContent = S.enabled ? '⚡ Disable' : '⚡ Enable';
      S.btnStrike.disabled = !S.enabled;
      S.btnStrike.style.opacity = S.enabled ? '1' : '0.5';
      S.btnAuto.disabled = !S.enabled;
      S.btnAuto.style.opacity = S.enabled ? '1' : '0.5';
      S.btnAuto.textContent = S.auto ? 'Auto: on' : 'Auto: off';
    }
    syncControls();
  }

  // ---------- lifecycle ----------
  function destroy() {
    S.destroyed = true;
    if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; }
    if (S.uiTimer) { clearTimeout(S.uiTimer); S.uiTimer = null; }
    if (S.uiInterval) { clearInterval(S.uiInterval); S.uiInterval = null; }
    if (S.docClick) { document.removeEventListener('click', S.docClick, true); S.docClick = null; }
    disable();
    [SECTION_ID, BTN_ID, POP_ID, STYLE_ID].forEach(function (id) {
      const el = document.getElementById(id);
      if (el && el.parentNode) el.parentNode.removeChild(el);
    });
    if (S.panel && S.panel.parentNode) S.panel.parentNode.removeChild(S.panel);
    S.panel = null;
    delete window.GeoFSLightning;
    log('destroyed');
  }

  function ready() {
    return !!(window.Cesium && window.geofs && geofs.api && geofs.api.viewer &&
              geofs.api.viewer.scene && geofs.api.viewer.camera);
  }

  function init() {
    S.viewer = geofs.api.viewer;
    S.scene = S.viewer.scene;

    loadPrefs();
    CFG.flashPeak = PREFS.flashPeak;
    const want = { enabled: PREFS.enabled, auto: PREFS.auto }; // capture before enable() re-saves

    buildPanel();
    decideUI();
    S.uiInterval = setInterval(decideUI, 1500); // GeoFS bar / Bonsai panel may build or rebuild later
    S.uiTimer = setTimeout(function () { // no Bonsai after 3 s -> show standalone panel
      S.uiTimer = null;
      S.fallbackAllowed = true;
      decideUI();
    }, 3000);

    if (want.enabled) {
      enable();
      if (want.auto) setAuto(true);
    }
    log('ready. Console: GeoFSLightning.probe() / .strike() / .destroy()');
  }

  window.GeoFSLightning = { enable, disable, strike, setAuto, destroy, probe, cfg: CFG };

  let tries = 0;
  S.pollTimer = setInterval(function () {
    if (S.destroyed) return;
    if (ready()) {
      clearInterval(S.pollTimer); S.pollTimer = null;
      try { init(); } catch (e) { warn('init failed', e); }
    } else if (++tries > 120) { // ~60 s
      clearInterval(S.pollTimer); S.pollTimer = null;
      warn('GeoFS viewer not available after 60 s; run GeoFSLightning.probe()');
    }
  }, 500);
})();
