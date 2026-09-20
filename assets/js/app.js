/* ============================================================================
 * Hurricane Drafter
 * Pull 14 real Atlantic cyclones, then watch the season you built replay.
 * ========================================================================== */
(function () {
  'use strict';

  var ROSTER_SIZE = 14;
  var OFFER_SIZE = 3;

  /* Tier colour, star count and pull rate. Rates sum to 1. */
  var TIERS = {
    Bronze:    { stars: 1, color: '#d07d2a', odds: 0.520, art: 'bronze',    blurb: 'Depressions, weak storms, footnotes' },
    Silver:    { stars: 2, color: '#9aa4ab', odds: 0.300, art: 'silver',    blurb: 'Ordinary storms and minimal canes' },
    Gold:      { stars: 3, color: '#f6c700', odds: 0.140, art: 'gold',      blurb: 'Serious hurricanes, season-shapers' },
    Elite:     { stars: 4, color: '#fb1f27', odds: 0.035, art: 'elite',     blurb: 'The names people still remember' },
    Legendary: { stars: 5, color: '#f11ce4', odds: 0.005, art: 'legendary', blurb: 'Overall 96+ — the all-time record' }
  };
  var TIER_ORDER = ['Bronze', 'Silver', 'Gold', 'Elite', 'Legendary'];

  var CAT = {
    '-1': { label: 'TD', color: '#5ad2f4', name: 'Tropical depression' },
    '0':  { label: 'TS', color: '#3fd0c9', name: 'Tropical storm' },
    '1':  { label: '1',  color: '#f2c14e', name: 'Category 1 hurricane' },
    '2':  { label: '2',  color: '#f0983b', name: 'Category 2 hurricane' },
    '3':  { label: '3',  color: '#e6602f', name: 'Category 3 hurricane' },
    '4':  { label: '4',  color: '#cf2b3e', name: 'Category 4 hurricane' },
    '5':  { label: '5',  color: '#a63aa8', name: 'Category 5 hurricane' }
  };

  /* NOAA classifies a season's activity by its ACE total. */
  var ACE_BANDS = [
    { min: 159.6, name: 'Extremely active', note: 'Top-decile territory — the kind of year that gets its own retrospective.' },
    { min: 126.1, name: 'Above normal',     note: 'A busy, damaging season by any modern standard.' },
    { min: 73,    name: 'Near normal',      note: 'A season that would blend into the climatology.' },
    { min: -1,    name: 'Below normal',     note: 'Quiet. The packs were not kind.' }
  ];

  var GRADES = [
    [92, 'S'], [88, 'A+'], [84, 'A'], [80, 'A-'], [76, 'B+'], [72, 'B'],
    [68, 'B-'], [64, 'C+'], [60, 'C'], [56, 'C-'], [52, 'D'], [0, 'F']
  ];

  var STATUS_NAME = { 0: 'Tropical depression', 1: 'Tropical storm', 2: 'Hurricane', 3: 'Post-tropical', 4: 'Subtropical depression', 5: 'Subtropical storm', 6: 'Low', 7: 'Tropical wave', 8: 'Disturbance' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /* ── state ─────────────────────────────────────────────────────────── */
  var DB = null;          /* storms.json */
  var TRACKS = null;      /* tracks.json — fetched in the background */
  var tracksPromise = null;

  var state = {
    mode: 'draft',
    pool: {},             /* tier -> array of storms still available */
    used: {},             /* storm id -> true */
    roster: [],
    pack: 0,
    offer: []
  };

  var play = null;        /* playback controller, see startPlayback() */
  var map = null;
  var layers = { tracks: null, marker: null, labels: null };

  var $ = function (id) { return document.getElementById(id); };
  var el = function (tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* ── small helpers ─────────────────────────────────────────────────── */

  function cat(c) { return CAT[String(c)] || CAT['-1']; }

  function catForWindKt(kt) {
    if (kt >= 137) return CAT['5'];
    if (kt >= 113) return CAT['4'];
    if (kt >= 96) return CAT['3'];
    if (kt >= 83) return CAT['2'];
    if (kt >= 64) return CAT['1'];
    if (kt >= 34) return CAT['0'];
    return CAT['-1'];
  }

  function fmt(n, digits) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US', {
      minimumFractionDigits: digits || 0, maximumFractionDigits: digits || 0
    });
  }

  function prettyDate(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length < 8) return '';
    return MONTHS[parseInt(yyyymmdd.slice(4, 6), 10) - 1] + ' ' + parseInt(yyyymmdd.slice(6, 8), 10);
  }

  function dayOfYear(yyyymmdd) {
    if (!yyyymmdd || yyyymmdd.length < 8) return 999;
    return parseInt(yyyymmdd.slice(4, 6), 10) * 31 + parseInt(yyyymmdd.slice(6, 8), 10);
  }

  function escapeHTML(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /* Deterministic per-storm randomness, so a storm's fallback art never
     changes between draws. */
  function seedFrom(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function rngFrom(seed) {
    return function () {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      var t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  /* ── card art ──────────────────────────────────────────────────────── */

  /* Roughly two of every three storms in the record have no usable photo.
     Those get a generated cyclone instead — seeded by ATCF id, tinted by
     the storm's peak category. */
  var swirlSeq = 0;

  function swirlSVG(storm) {
    var rnd = rngFrom(seedFrom(storm.id));
    var c = cat(storm.c).color;
    var arms = 3 + Math.floor(rnd() * 4);
    var tilt = rnd() * 360;
    var sweep = 230 + rnd() * 170;          /* how tightly the arms wrap */
    var cx = 50 + (rnd() - 0.5) * 10;
    var cy = 58 + (rnd() - 0.5) * 12;
    var reach = 44 + rnd() * 14;
    var eye = storm.c >= 3 ? 6 + rnd() * 4 : 0;
    /* Gradient ids must be unique across the whole document, and the same
       storm can be on screen more than once (an offer card left behind on the
       hidden draft screen, plus its card in the season report). A per-call
       counter keeps them distinct; the art itself stays seeded by the id. */
    var uid = 'sw' + (++swirlSeq);
    var paths = '';

    for (var a = 0; a < arms; a++) {
      var base = tilt + (360 / arms) * a + (rnd() - 0.5) * 22;
      var curl = sweep * (0.82 + rnd() * 0.36);
      var d = '';
      for (var i = 0; i <= 28; i++) {
        var t = 0.1 + (i / 28) * 0.9;
        var ang = (base + t * curl) * Math.PI / 180;
        var r = Math.pow(t, 0.86) * reach;
        d += (i ? 'L' : 'M') + (cx + Math.cos(ang) * r).toFixed(1) + ' ' +
             (cy + Math.sin(ang) * r * 1.12).toFixed(1) + ' ';
      }
      paths += '<path d="' + d + '" fill="none" stroke="url(#' + uid + 'g)" stroke-width="' +
               (4 + rnd() * 9).toFixed(1) + '" stroke-linecap="round" opacity="' +
               (0.5 + rnd() * 0.45).toFixed(2) + '"/>';
    }

    /* A faint cloud shield so weak storms do not read as bare spirals. */
    var shield = '<ellipse cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" rx="' +
      (reach * 1.15).toFixed(1) + '" ry="' + (reach * 1.3).toFixed(1) +
      '" fill="url(#' + uid + 'h)" opacity="' + (0.3 + rnd() * 0.25).toFixed(2) + '"/>';

    return '<svg viewBox="0 0 100 117" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' +
      '<defs>' +
        '<radialGradient id="' + uid + 'g" cx="' + cx + '%" cy="' + (cy / 1.17) + '%">' +
          '<stop offset="0%" stop-color="#ffffff" stop-opacity=".98"/>' +
          '<stop offset="30%" stop-color="#eaf4fb" stop-opacity=".9"/>' +
          '<stop offset="68%" stop-color="' + c + '" stop-opacity=".8"/>' +
          '<stop offset="100%" stop-color="' + c + '" stop-opacity=".1"/>' +
        '</radialGradient>' +
        '<radialGradient id="' + uid + 'h"><stop offset="0%" stop-color="' + c + '" stop-opacity=".5"/>' +
          '<stop offset="100%" stop-color="' + c + '" stop-opacity="0"/></radialGradient>' +
        '<radialGradient id="' + uid + 'bg" cx="50%" cy="50%">' +
          '<stop offset="0%" stop-color="#16263a"/>' +
          '<stop offset="100%" stop-color="#04080e"/>' +
        '</radialGradient>' +
      '</defs>' +
      '<rect width="100" height="117" fill="url(#' + uid + 'bg)"/>' +
      shield + paths +
      (eye ? '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + eye.toFixed(1) + '" fill="#05090f" opacity=".85"/>' +
             '<circle cx="' + cx.toFixed(1) + '" cy="' + cy.toFixed(1) + '" r="' + eye.toFixed(1) + '" fill="none" stroke="#fff" stroke-width="1.8" opacity=".8"/>' : '') +
      '</svg>';
  }

  /* "Tropical Storm Nine" is a type plus a number, not a name. Cards show
     the distinguishing part; the full designation stays in the tooltip. */
  var GENERIC = /^(Hurricane|Tropical Storm|Tropical Depression|Subtropical Storm|Subtropical Depression)\s+(.+)$/;

  function shortName(storm) {
    var m = GENERIC.exec(storm.n);
    return m ? m[2] : storm.n;
  }

  function stars(n) {
    var out = '';
    for (var i = 0; i < 5; i++) out += i < n ? '★' : '☆';
    return out;
  }

  function buildCard(storm) {
    var tier = TIERS[storm.t];
    var c = cat(storm.c);
    var card = el('div', 'card');
    card.style.setProperty('--tier', tier.color);

    card.appendChild(el('div', 'card-well'));

    /* Generated art goes down first so a card is never blank; a real photo,
       when there is one and it loads, fades in over the top. */
    var art = el('div', 'card-art');
    art.innerHTML = swirlSVG(storm);
    if (storm.img) {
      var img = new Image();
      img.className = 'card-photo';
      img.alt = '';
      img.loading = 'lazy';
      img.referrerPolicy = 'no-referrer';
      img.onload = function () { img.classList.add('is-in'); };
      img.onerror = function () {
        /* The CSV's thumb.wikimedia.org alias is swapped for the canonical
           host at build time; if that 404s, try the alias before giving up. */
        if (!img.dataset.retried && storm.img.indexOf('upload.wikimedia.org') > -1) {
          img.dataset.retried = '1';
          img.src = storm.img.replace('upload.wikimedia.org', 'thumb.wikimedia.org');
          return;
        }
        img.remove();
      };
      img.src = storm.img;
      art.appendChild(img);
    }
    card.appendChild(art);

    var frame = new Image();
    frame.className = 'card-frame';
    frame.alt = '';
    frame.src = 'assets/templates/' + tier.art + '.webp';
    card.appendChild(frame);

    var ovr = el('div', 'card-ovr', '<b>' + storm.o + '</b><span>OVR</span>');
    card.appendChild(ovr);

    var badge = el('div', 'card-cat', c.label);
    badge.style.background = c.color;
    card.appendChild(badge);

    if (storm.ret) card.appendChild(el('div', 'card-retired', 'RETIRED'));

    var name = shortName(storm);
    var body = el('div', 'card-body');
    body.title = storm.n + ' (' + storm.y + ')';
    body.innerHTML =
      '<div class="card-name" style="font-size:' +
        (name.length > 15 ? 4.8 : name.length > 11 ? 5.8 : name.length > 8 ? 6.4 : 7) + 'cqw">' +
        escapeHTML(name) + '</div>' +
      '<div class="card-sub">' + storm.y + ' &middot; ' + escapeHTML(c.label === 'TD' || c.label === 'TS' ? c.label : 'CAT ' + c.label) + '</div>' +
      '<div class="card-stats">' +
        stat(storm.w, 'MPH') +
        stat(storm.p, 'MB') +
        stat(storm.a != null ? storm.a.toFixed(1) : null, 'ACE') +
        stat(storm.d != null ? Math.round(storm.d / 24) + 'd' : null, 'LIFE') +
      '</div>';
    card.appendChild(body);

    return card;
  }

  function stat(value, label) {
    return '<div class="card-stat"><b>' + (value == null ? '—' : value) + '</b><span>' + label + '</span></div>';
  }

  /* ── boot ──────────────────────────────────────────────────────────── */

  function boot() {
    renderOdds();
    wireHome();

    fetch('data/storms.json')
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (json) {
        DB = json;
        $('legendaryCount').textContent = json.storms.filter(function (s) { return s.t === 'Legendary'; }).length;
        $('btnStart').disabled = false;
        $('btnStart').textContent = 'Open the first pack';
        $('homeHint').textContent = fmt(json.count) + ' Atlantic cyclones in the pool, 1851 through 2025.';
        $('boot').classList.add('is-gone');
      })
      .catch(function (err) {
        $('homeHint').textContent = 'Could not load the storm data (' + err.message + '). Serve this page over HTTP rather than opening the file directly.';
        $('boot').classList.add('is-gone');
      });
  }

  function loadTracks() {
    if (!tracksPromise) {
      tracksPromise = fetch('data/tracks.json')
        .then(function (r) { return r.json(); })
        .then(function (json) { TRACKS = json.tracks; return TRACKS; });
    }
    return tracksPromise;
  }

  function renderOdds() {
    var list = $('oddsList');
    TIER_ORDER.slice().reverse().forEach(function (name) {
      var t = TIERS[name];
      var row = el('li', 'odds-row');
      row.innerHTML =
        '<span class="odds-stars" style="color:' + t.color + '">' + stars(t.stars) + '</span>' +
        '<span class="odds-name">' + name + '<small>' + t.blurb + '</small></span>' +
        '<span class="odds-pct" style="color:' + t.color + '">' + (t.odds * 100).toFixed(1) + '%</span>';
      list.appendChild(row);
    });
  }

  function wireHome() {
    Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (btn) {
      btn.addEventListener('click', function () {
        state.mode = btn.dataset.mode;
        Array.prototype.forEach.call(document.querySelectorAll('.mode-btn'), function (b) {
          b.classList.toggle('is-on', b === btn);
          b.setAttribute('aria-checked', b === btn ? 'true' : 'false');
        });
      });
    });

    $('btnStart').addEventListener('click', startRun);
    $('btnRestart').addEventListener('click', function () {
      if (confirm('Throw this season away and start over?')) startRun();
    });
    $('pack').addEventListener('click', openPack);
    $('btnAgain').addEventListener('click', startRun);
    $('btnReplay').addEventListener('click', function () { goMap(); });
    $('btnCopy').addEventListener('click', copySummary);
    $('btnPlay').addEventListener('click', togglePlay);
    $('btnSpeed').addEventListener('click', cycleSpeed);
    $('btnSkip').addEventListener('click', function () { if (play) play.skipStorm(); });
    $('btnFinish').addEventListener('click', function () { play ? play.finishAll() : goSeason(); });
  }

  function show(id) {
    Array.prototype.forEach.call(document.querySelectorAll('.screen'), function (s) {
      s.classList.toggle('is-active', s.id === id);
    });
    window.scrollTo(0, 0);
  }

  /* ── the draft ─────────────────────────────────────────────────────── */

  function startRun() {
    state.pool = {};
    TIER_ORDER.forEach(function (t) { state.pool[t] = []; });
    DB.storms.forEach(function (s) {
      if (state.pool[s.t]) state.pool[s.t].push(s);
    });

    state.used = {};
    state.roster = [];
    state.pack = 0;
    state.offer = [];

    $('btnRestart').hidden = false;
    show('screen-draft');
    renderRoster();
    nextPack();
    loadTracks();   /* warm the 1 MB track payload while the user drafts */
  }

  function nextPack() {
    if (state.roster.length >= ROSTER_SIZE) return goMap();

    state.pack++;
    $('packNum').textContent = state.pack;
    $('packBar').style.width = ((state.roster.length / ROSTER_SIZE) * 100) + '%';
    $('draftPrompt').textContent = 'Tap the pack to open';

    var offer = $('offer');
    offer.hidden = true;
    offer.innerHTML = '';

    var pack = $('pack');
    pack.hidden = false;
    pack.classList.remove('is-opening');
    pack.disabled = false;
  }

  function rollTier() {
    var r = Math.random(), acc = 0;
    for (var i = 0; i < TIER_ORDER.length; i++) {
      acc += TIERS[TIER_ORDER[i]].odds;
      if (r < acc && state.pool[TIER_ORDER[i]].length) return TIER_ORDER[i];
    }
    /* Exhausted or fell through: take the fullest tier that still has cards. */
    var best = null;
    TIER_ORDER.forEach(function (t) {
      if (state.pool[t].length && (!best || state.pool[t].length > state.pool[best].length)) best = t;
    });
    return best;
  }

  function drawCard(seen) {
    for (var attempt = 0; attempt < 80; attempt++) {
      var tier = rollTier();
      if (!tier) return null;
      var bucket = state.pool[tier];
      var s = bucket[Math.floor(Math.random() * bucket.length)];
      if (!state.used[s.id] && seen.indexOf(s.id) === -1) {
        seen.push(s.id);
        return s;
      }
    }
    return null;
  }

  function openPack() {
    var pack = $('pack');
    if (pack.disabled) return;
    pack.disabled = true;
    pack.classList.add('is-opening');

    var count = state.mode === 'draft' ? OFFER_SIZE : 1;
    var seen = [];
    state.offer = [];
    for (var i = 0; i < count; i++) {
      var s = drawCard(seen);
      if (s) state.offer.push(s);
    }

    setTimeout(function () {
      pack.hidden = true;
      renderOffer();
    }, 430);
  }

  function renderOffer() {
    var offer = $('offer');
    offer.innerHTML = '';
    offer.hidden = false;
    offer.classList.toggle('single', state.offer.length === 1);

    var best = state.offer.reduce(function (a, b) { return b.o > a.o ? b : a; }, state.offer[0]);
    $('draftPrompt').textContent = state.mode === 'draft'
      ? 'Pick one for your season'
      : 'Pulled — added to your season';

    state.offer.forEach(function (storm) {
      var tier = TIERS[storm.t];
      var slot = el('div', 'offer-slot');

      var flip = el('div', 'card-flip');
      flip.style.position = 'relative';

      if (tier.stars >= 4) {
        var burst = el('span', 'tier-burst');
        burst.style.setProperty('--burst', tier.color);
        flip.appendChild(burst);
      }

      var card = buildCard(storm);
      if (tier.stars >= 4) card.classList.add('is-hit');
      if (state.mode === 'draft') {
        card.classList.add('is-pickable');
        card.addEventListener('click', function () { pick(storm, slot); });
      }
      flip.appendChild(card);
      slot.appendChild(flip);

      var tag = el('div', 'tier-tag', '<i></i>' + storm.t + ' &middot; ' + stars(tier.stars));
      tag.style.color = tier.color;
      slot.appendChild(tag);

      if (state.mode === 'draft') {
        var btn = el('button', 'pick-btn',
          '<span class="pb-verb">Take </span>' + escapeHTML(shortName(storm)));
        btn.addEventListener('click', function () { pick(storm, slot); });
        slot.appendChild(btn);
      }

      offer.appendChild(slot);
    });

    if (state.mode === 'pull') {
      setTimeout(function () {
        pick(state.offer[0], offer.firstChild);
      }, 1500);
    } else if (best && best.t === 'Legendary') {
      $('draftPrompt').textContent = 'A five-star pull. Pick one for your season.';
    }
  }

  function pick(storm, slot) {
    if (state.used[storm.id]) return;
    state.used[storm.id] = true;
    state.roster.push(storm);

    Array.prototype.forEach.call($('offer').children, function (node) {
      node.classList.add(node === slot ? 'is-taken' : 'is-dropping');
      Array.prototype.forEach.call(node.querySelectorAll('button'), function (b) { b.disabled = true; });
    });

    renderRoster();
    setTimeout(nextPack, 620);
  }

  function renderRoster() {
    var list = $('roster');
    list.innerHTML = '';
    for (var i = 0; i < ROSTER_SIZE; i++) {
      var s = state.roster[i];
      var li = el('li');
      if (s) {
        var tier = TIERS[s.t];
        li.className = 'filled';
        li.style.borderColor = tier.color;
        li.style.background = 'linear-gradient(180deg, ' + tier.color + '22, ' + tier.color + '08)';
        li.innerHTML = '<span class="rn">' + escapeHTML(shortName(s)) + '</span>' +
                       '<span class="ro" style="color:' + tier.color + '">' + s.o + '</span>';
        li.title = s.n + ' (' + s.y + ') — ' + s.t + ', overall ' + s.o;
      } else {
        li.textContent = i + 1;
      }
      list.appendChild(li);
    }

    var ace = state.roster.reduce(function (sum, s) { return sum + (s.a || 0); }, 0);
    $('rosterMeta').textContent = state.roster.length + ' / ' + ROSTER_SIZE + ' · ACE ' + ace.toFixed(1);
    $('packBar').style.width = ((state.roster.length / ROSTER_SIZE) * 100) + '%';
  }

  /* ── track playback ────────────────────────────────────────────────── */

  function seasonOrder() {
    /* Real storms from scattered years, replayed as one season: sort by
       where in the calendar they fell. */
    return state.roster.slice().sort(function (a, b) {
      return dayOfYear(a.sd) - dayOfYear(b.sd);
    });
  }

  function goMap() {
    $('offer').innerHTML = '';   /* drop the last pack's cards from the DOM */
    show('screen-map');
    $('btnFinish').textContent = 'Season totals';

    loadTracks().then(function () {
      ensureMap();
      setTimeout(function () {
        map.invalidateSize();
        startPlayback(seasonOrder());
      }, 90);
    });
  }

  function ensureMap() {
    if (map) return;

    map = L.map('map', {
      center: [24, -58], zoom: 4, minZoom: 2, maxZoom: 10,
      worldCopyJump: true, zoomControl: false, attributionControl: true
    });
    L.control.zoom({ position: 'bottomright' }).addTo(map);

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 10,
      attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics · Tracks: HURDAT2 / NHC'
    }).addTo(map);

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
      maxZoom: 10, opacity: 0.55
    }).addTo(map);

    layers.tracks = L.layerGroup().addTo(map);
    layers.labels = L.layerGroup().addTo(map);
  }

  function stormIcon(color) {
    return L.divIcon({
      className: 'storm-dot',
      iconSize: [26, 26], iconAnchor: [13, 13],
      html: '<svg width="26" height="26" viewBox="0 0 26 26">' +
        '<g class="eye">' +
        '<path d="M13 13 C13 6 19 4 21 7 C19 5 14 8 13 13Z" fill="' + color + '" opacity=".95"/>' +
        '<path d="M13 13 C13 20 7 22 5 19 C7 21 12 18 13 13Z" fill="' + color + '" opacity=".95"/>' +
        '</g>' +
        '<circle cx="13" cy="13" r="2.6" fill="#fff"/></svg>'
    });
  }

  function startPlayback(order) {
    layers.tracks.clearLayers();
    layers.labels.clearLayers();
    if (layers.marker) { map.removeLayer(layers.marker); layers.marker = null; }
    order.forEach(function (s) { s.__drawn = false; });

    renderMapList(order, -1);

    /* Segments for the storm currently being animated live in their own
       group, so a skip can wipe the partial draw and lay down the whole
       track cleanly instead of stacking two polylines. */
    var live = L.layerGroup().addTo(layers.tracks);

    play = {
      order: order,
      index: -1,
      speed: 1,
      playing: true,
      raf: null,
      done: false,
      moving: false,
      allBounds: L.latLngBounds([]),
      skipStorm: function () {
        if (play.done || play.moving) return;
        drawWhole(order[play.index]);
        advance();
      },
      finishAll: function () {
        stop();
        for (var i = Math.max(play.index, 0); i < order.length; i++) drawWhole(order[i]);
        play.index = order.length;
        goSeason();
      }
    };

    $('btnPlay').textContent = 'Pause';
    $('btnSpeed').textContent = '1×';
    advance();

    function stop() {
      if (play.raf) { cancelAnimationFrame(play.raf); play.raf = null; }
      if (layers.marker) { map.removeLayer(layers.marker); layers.marker = null; }
    }

    function advance() {
      stop();
      play.moving = false;
      play.index++;
      if (play.index >= order.length) return finishSeasonView();
      runStorm(order[play.index]);
    }

    function trackOf(storm) { return (TRACKS && TRACKS[storm.id]) || []; }

    function boundsOf(pts) {
      return L.latLngBounds(pts.map(function (p) { return [p[0], p[1]]; }));
    }

    /* Draw a storm's full track at rest opacity — used for skips and for
       storms already played. */
    function drawWhole(storm) {
      if (!storm || storm.__drawn) return;
      var pts = trackOf(storm);
      storm.__drawn = true;
      if (!pts.length) return;
      if (storm === order[play.index]) live.clearLayers();
      for (var i = 0; i < pts.length - 1; i++) segment(storm, pts, i, 0.6, layers.tracks);
      restLabel(storm, pts);
      play.allBounds.extend(boundsOf(pts));
    }

    function segment(storm, pts, i, opacity, target) {
      return L.polyline([[pts[i][0], pts[i][1]], [pts[i + 1][0], pts[i + 1][1]]], {
        color: catForWindKt(pts[i][2]).color,
        weight: 3.4, opacity: opacity, lineCap: 'round'
      }).addTo(target || live);
    }

    function restLabel(storm, pts) {
      var peak = pts.reduce(function (a, b) { return b[2] > a[2] ? b : a; }, pts[0]);
      L.marker([peak[0], peak[1]], {
        interactive: false,
        icon: L.divIcon({ className: 'track-label', html: escapeHTML(storm.n), iconSize: [0, 0] })
      }).addTo(layers.labels);
    }

    function runStorm(storm) {
      var pts = trackOf(storm);
      live.clearLayers();
      renderMapList(order, play.index);

      $('hudIndex').textContent = 'Storm ' + (play.index + 1) + ' of ' + order.length;
      $('hudName').textContent = storm.n;
      $('hudName').title = storm.n;
      $('hudSub').textContent = storm.y + ' · ' + prettyDate(storm.sd) + ' – ' + prettyDate(storm.ed) +
        (storm.gen ? ' · ' + storm.gen : '');
      $('hudLive').innerHTML = '';

      if (!pts.length) { play.moving = true; setTimeout(advance, 200); return; }

      map.flyToBounds(boundsOf(pts).pad(0.25), { duration: 0.85, maxZoom: 6 });

      var drawn = [];
      var pos = 0;
      var last = null;
      var started = performance.now() + 700;   /* let the fly-to settle */

      layers.marker = L.marker([pts[0][0], pts[0][1]], {
        interactive: false, icon: stormIcon(catForWindKt(pts[0][2]).color), zIndexOffset: 900
      }).addTo(map);

      function frame(now) {
        play.raf = requestAnimationFrame(frame);
        if (!play.playing) { last = now; return; }
        if (now < started) { last = now; return; }

        var dt = last == null ? 16 : Math.min(now - last, 120);
        last = now;
        pos += (dt / 300) * play.speed;      /* 300 ms per best-track fix at 1× */

        var i = Math.floor(pos);
        while (drawn.length < Math.min(i, pts.length - 1)) {
          segment(storm, pts, drawn.length, 0.95);
          drawn.push(1);
        }

        if (i >= pts.length - 1) {
          cancelAnimationFrame(play.raf);
          play.raf = null;
          play.moving = true;
          drawWhole(storm);
          setTimeout(advance, 700);
          return;
        }

        var a = pts[i], b = pts[i + 1], f = pos - i;
        var lat = a[0] + (b[0] - a[0]) * f;
        var lon = a[1] + (b[1] - a[1]) * f;
        var kt = Math.round(a[2] + (b[2] - a[2]) * f);
        var c = catForWindKt(kt);

        layers.marker.setLatLng([lat, lon]);
        layers.marker.setIcon(stormIcon(c.color));

        $('hudLive').innerHTML =
          '<div><b style="color:' + c.color + '">' + Math.round(kt * 1.15078) + '</b><span>MPH</span></div>' +
          '<div><b>' + c.label + '</b><span>CATEGORY</span></div>' +
          '<div><b style="font-size:.78rem">' + (STATUS_NAME[a[3]] || '—') + '</b><span>STATUS</span></div>';
      }

      play.raf = requestAnimationFrame(frame);
    }

    function finishSeasonView() {
      stop();
      play.done = true;
      renderMapList(order, order.length);
      $('hudIndex').textContent = 'Season complete';
      $('hudName').textContent = order.length + ' storms';
      $('hudSub').textContent = 'Every track you drafted, on one map.';
      $('hudLive').innerHTML = '';
      $('btnPlay').textContent = 'Replay';
      $('btnFinish').textContent = 'See season totals →';
      if (play.allBounds.isValid()) map.flyToBounds(play.allBounds.pad(0.08), { duration: 1.1 });
    }
  }

  function renderMapList(order, current) {
    var list = $('mapList');
    list.innerHTML = '';
    order.forEach(function (s, i) {
      var c = cat(s.c);
      var row = el('div', 'ml-row' + (i < current ? ' done' : i === current ? ' now' : ''));
      row.innerHTML =
        '<span class="ml-n">' + (i + 1) + '</span>' +
        '<span class="ml-name" title="' + escapeHTML(s.n) + '">' + escapeHTML(s.n) + '</span>' +
        '<span class="ml-cat" style="background:' + c.color + '">' + c.label + '</span>';
      list.appendChild(row);
    });
    var now = list.querySelector('.now');
    if (now) now.scrollIntoView({ block: 'nearest' });
  }

  function togglePlay() {
    if (!play) return;
    if (play.done) { startPlayback(seasonOrder()); return; }
    play.playing = !play.playing;
    $('btnPlay').textContent = play.playing ? 'Pause' : 'Play';
  }

  function cycleSpeed() {
    if (!play) return;
    var steps = [1, 2, 4, 8];
    play.speed = steps[(steps.indexOf(play.speed) + 1) % steps.length];
    $('btnSpeed').textContent = play.speed + '×';
  }

  /* ── season report ─────────────────────────────────────────────────── */

  function summarise() {
    var r = state.roster;
    var totalAce = 0, fatalities = 0, knownFatalities = 0, hurricanes = 0, majors = 0, cat5 = 0;
    var retired = 0, landfalls = 0, ovrSum = 0, hours = 0;
    var strongest = null, deepest = null, longest = null, mostAce = null, deadliest = null;

    r.forEach(function (s) {
      totalAce += s.a || 0;
      ovrSum += s.o;
      hours += s.d || 0;
      if (s.c >= 1) hurricanes++;
      if (s.c >= 3) majors++;
      if (s.c >= 5) cat5++;
      if (s.ret) retired++;
      if (s.lf) landfalls++;
      if (s.f != null) { fatalities += s.f; knownFatalities++; }
      if (!strongest || s.w > strongest.w) strongest = s;
      if (s.p != null && (!deepest || s.p < deepest.p)) deepest = s;
      if (!longest || (s.d || 0) > (longest.d || 0)) longest = s;
      if (!mostAce || (s.a || 0) > (mostAce.a || 0)) mostAce = s;
      if (s.f != null && (!deadliest || s.f > deadliest.f)) deadliest = s;
    });

    return {
      ace: totalAce, avgOvr: ovrSum / r.length, hurricanes: hurricanes, majors: majors,
      cat5: cat5, retired: retired, landfalls: landfalls, fatalities: fatalities,
      knownFatalities: knownFatalities, days: hours / 24,
      strongest: strongest, deepest: deepest, longest: longest,
      mostAce: mostAce, deadliest: deadliest
    };
  }

  function gradeFor(avg) {
    for (var i = 0; i < GRADES.length; i++) if (avg >= GRADES[i][0]) return GRADES[i][1];
    return 'F';
  }

  function aceBand(ace) {
    for (var i = 0; i < ACE_BANDS.length; i++) if (ace >= ACE_BANDS[i].min) return ACE_BANDS[i];
    return ACE_BANDS[ACE_BANDS.length - 1];
  }

  function goSeason() {
    var s = summarise();
    var band = aceBand(s.ace);
    var grade = gradeFor(s.avgOvr);

    $('seasonTitle').textContent = 'A ' + band.name.toLowerCase() + ' season';
    $('grade').textContent = grade;
    $('grade').style.color = s.avgOvr >= 84 ? '#f11ce4' : s.avgOvr >= 72 ? '#f6c700' : s.avgOvr >= 60 ? '#3fd0c9' : '#9aa4ab';
    $('seasonClass').textContent = band.name + ' · ACE ' + s.ace.toFixed(1);
    $('seasonNote').textContent = band.note + ' Average overall rating ' + s.avgOvr.toFixed(1) + '.';

    var grid = $('statGrid');
    grid.innerHTML = '';
    [
      [ROSTER_SIZE, 'Named storms', 'every pick counts'],
      [s.hurricanes, 'Hurricanes', s.hurricanes + ' of ' + ROSTER_SIZE + ' reached 74 mph'],
      [s.majors, 'Major hurricanes', 'Category 3 and up'],
      [s.cat5, 'Category 5s', s.cat5 ? 'the ceiling' : 'none this time'],
      [s.ace.toFixed(1), 'Total ACE', 'accumulated cyclone energy'],
      [s.strongest ? s.strongest.w + ' mph' : '—', 'Peak wind', s.strongest ? s.strongest.n + ', ' + s.strongest.y : ''],
      [s.deepest ? s.deepest.p + ' mb' : '—', 'Lowest pressure', s.deepest ? s.deepest.n + ', ' + s.deepest.y : 'none on record'],
      [Math.round(s.days) + 'd', 'Storm days', 'combined lifetime'],
      [s.landfalls, 'Landfalling', 'made landfall somewhere'],
      [s.retired, 'Retired names', s.retired ? 'names taken out of rotation' : 'nothing retired'],
      [fmt(s.fatalities), 'Deaths', s.knownFatalities + ' of ' + ROSTER_SIZE + ' storms have a figure on record']
    ].forEach(function (row) {
      grid.appendChild(el('div', 'stat', '<b>' + row[0] + '</b><span>' + row[1] + '</span><i>' + escapeHTML(row[2]) + '</i>'));
    });

    renderRank(s);
    renderSuperlatives(s);
    renderSeasonCards();

    show('screen-season');
  }

  function renderRank(s) {
    var seasons = Object.keys(DB.seasons).map(function (y) {
      return { year: y, ace: DB.seasons[y].ace };
    }).sort(function (a, b) { return b.ace - a.ace; });

    var better = seasons.filter(function (x) { return x.ace > s.ace; }).length;
    var rank = better + 1;
    var closest = seasons.reduce(function (a, b) {
      return Math.abs(b.ace - s.ace) < Math.abs(a.ace - s.ace) ? b : a;
    }, seasons[0]);
    var pct = Math.round(((seasons.length - better) / seasons.length) * 100);

    $('rankCard').innerHTML =
      '<p class="rank-line">Your fourteen storms total <b>' + s.ace.toFixed(1) + ' ACE</b>. ' +
      'Set against all <b>' + seasons.length + '</b> Atlantic seasons since 1851, that ranks <b>#' + rank + '</b> — ' +
      'ahead of ' + pct + '% of them. The real season it most resembles is <b>' + closest.year +
      '</b> (' + closest.ace.toFixed(1) + ' ACE).</p>' +
      '<div class="rank-bars" id="rankBars"></div>';

    var top = seasons.slice(0, 5);
    var mine = { year: 'Yours', ace: s.ace, me: true };
    var rows = top.concat([mine]).sort(function (a, b) { return b.ace - a.ace; });
    var max = rows[0].ace || 1;

    var bars = $('rankBars');
    rows.forEach(function (row) {
      var bar = el('div', 'rank-bar' + (row.me ? ' me' : ''));
      bar.innerHTML =
        '<span class="yr">' + row.year + '</span>' +
        '<span class="tr"><span class="fl" style="width:' + Math.max(2, (row.ace / max) * 100) + '%"></span></span>' +
        '<span class="vl">' + row.ace.toFixed(1) + '</span>';
      bars.appendChild(bar);
    });
  }

  function renderSuperlatives(s) {
    var grid = $('superGrid');
    grid.innerHTML = '';
    var items = [
      ['Strongest', s.strongest, function (x) { return x.w + ' mph · ' + x.y; }],
      ['Deepest pressure', s.deepest, function (x) { return x.p + ' mb · ' + x.y; }],
      ['Longest lived', s.longest, function (x) { return (x.d / 24).toFixed(1) + ' days · ' + x.y; }],
      ['Most energy', s.mostAce, function (x) { return x.a.toFixed(1) + ' ACE · ' + x.y; }],
      ['Deadliest', s.deadliest, function (x) { return fmt(x.f) + ' deaths · ' + x.y; }],
      ['Best card', state.roster.reduce(function (a, b) { return b.o > a.o ? b : a; }), function (x) { return x.t + ' · overall ' + x.o; }]
    ];
    items.forEach(function (item) {
      if (!item[1]) return;
      grid.appendChild(el('div', 'super',
        '<span>' + item[0] + '</span><b>' + escapeHTML(item[1].n) + '</b><i>' + escapeHTML(item[2](item[1])) + '</i>'));
    });
  }

  function renderSeasonCards() {
    var wrap = $('seasonCards');
    wrap.innerHTML = '';
    seasonOrder().forEach(function (storm, i) {
      var sc = el('div', 'sc');
      sc.appendChild(buildCard(storm));
      sc.appendChild(el('div', 'sc-cap', '#' + (i + 1) + ' · ' + prettyDate(storm.sd)));
      wrap.appendChild(sc);
    });
  }

  function copySummary() {
    var s = summarise();
    var band = aceBand(s.ace);
    var lines = [
      'HURRICANE DRAFTER — my Atlantic season',
      band.name + ' · ' + s.ace.toFixed(1) + ' ACE · grade ' + gradeFor(s.avgOvr),
      ROSTER_SIZE + ' storms · ' + s.hurricanes + ' hurricanes · ' + s.majors + ' major · ' + s.cat5 + ' cat 5',
      ''
    ];
    seasonOrder().forEach(function (st, i) {
      lines.push((i + 1) + '. ' + st.n + ' (' + st.y + ') — ' + st.t + ' ' + st.o + ' OVR, ' +
        st.w + ' mph, ' + (st.a != null ? st.a.toFixed(1) + ' ACE' : '—'));
    });
    lines.push('', 'tropicalcyclonedatabase.com');

    var text = lines.join('\n');
    var done = function () {
      $('btnCopy').textContent = 'Copied';
      setTimeout(function () { $('btnCopy').textContent = 'Copy season summary'; }, 1800);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { window.prompt('Copy your season:', text); });
    } else {
      window.prompt('Copy your season:', text);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
