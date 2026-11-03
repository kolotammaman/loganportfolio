// Ported from the app's catalog logic (configs.ts, scoring.ts). Runs on a static sample catalog.
(function () {
  'use strict';
  var fmtTime = function (s) {
    if (s == null) return '—';
    if (s >= 60) { var m = Math.floor(s / 60), r = s % 60; return m + ':' + (r < 10 ? '0' : '') + r; }
    return '0:' + (s < 10 ? '0' : '') + s;
  };
  var spec = function (p, k) { var v = p.specs && p.specs[k]; return v == null ? '' : v; };
  var rank = function (map) { return function (v) { return map[v] != null ? map[v] : 0; }; };
  var tear = rank({ High: 2, Standard: 1 });
  var hydro = rank({ Hydrophilic: 2, Moderate: 1 });
  var grit = rank({ 'Extra-Fine': 4, Fine: 3, Medium: 2, Coarse: 1 });
  var yn = function (b) { return b === true ? 'Yes' : 'No'; };

  // scorers: [getter, higherIsBetter]; columns: [label, render, optionalPriorityKey]
  var CONFIGS = {
    impression_material: {
      title: 'Impression materials', slider: true,
      priorities: [['speed', 'Fastest set time'], ['cost', 'Lowest cost'], ['detail', 'Best detail / tear strength'], ['wet', 'Best for wet fields'], ['shelf', 'Longest shelf life']],
      scorers: {
        speed: [function (p) { return p.set || 0; }, false],
        cost: [function (p) { return p.price; }, false],
        detail: [function (p) { return tear(p.tear); }, true],
        wet: [function (p) { return hydro(p.hydro); }, true],
        shelf: [function (p) { return p.shelf; }, true]
      },
      filters: [
        ['Material type', function (p) { return p.material || ''; }],
        ['Viscosity', function (p) { return p.viscosity || ''; }],
        ['Delivery', function (p) { return p.delivery || ''; }],
        ['Hydrophilicity', function (p) { return p.hydro || ''; }],
        ['Tear strength', function (p) { return p.tear || ''; }]
      ],
      cols: [
        ['Working time', function (p) { return fmtTime(p.working); }],
        ['Mouth / set time', function (p) { return fmtTime(p.set); }, 'speed'],
        ['Hydrophilicity', function (p) { return p.hydro || '—'; }, 'wet'],
        ['Tear strength', function (p) { return p.tear || '—'; }, 'detail'],
        ['Delivery', function (p) { return p.delivery || '—'; }],
        ['Shelf life', function (p) { return p.shelf + ' mo'; }, 'shelf']
      ]
    },
    bur: {
      title: 'Burs', slider: false,
      priorities: [['cost', 'Lowest cost'], ['grit', 'Finest grit / smoothest finish'], ['shelf', 'Longest shelf life']],
      scorers: {
        cost: [function (p) { return p.price; }, false],
        grit: [function (p) { return grit(spec(p, 'grit')); }, true],
        shelf: [function (p) { return p.shelf; }, true]
      },
      filters: [
        ['Shape', function (p) { return spec(p, 'shape'); }],
        ['Material', function (p) { return spec(p, 'burMaterial'); }],
        ['Grit', function (p) { return spec(p, 'grit'); }],
        ['Shank type', function (p) { return spec(p, 'shankType'); }]
      ],
      cols: [
        ['Shape', function (p) { return spec(p, 'shape') || '—'; }],
        ['Material', function (p) { return spec(p, 'burMaterial') || '—'; }],
        ['Grit', function (p) { return spec(p, 'grit') || '—'; }, 'grit'],
        ['Shank', function (p) { return spec(p, 'shankType') || '—'; }],
        ['Head diameter', function (p) { var d = spec(p, 'headDiameterMm'); return d ? d + ' mm' : '—'; }],
        ['Application', function (p) { return spec(p, 'application') || '—'; }],
        ['Shelf life', function (p) { return p.shelf + ' mo'; }, 'shelf']
      ]
    },
    cement: {
      title: 'Cements', slider: true,
      priorities: [['speed', 'Fastest set time'], ['cost', 'Lowest cost'], ['strength', 'Highest compressive strength'], ['film', 'Thinnest film'], ['shelf', 'Longest shelf life']],
      scorers: {
        speed: [function (p) { return p.set || 0; }, false],
        cost: [function (p) { return p.price; }, false],
        strength: [function (p) { return Number(spec(p, 'compressiveStrengthMpa')) || 0; }, true],
        film: [function (p) { return Number(spec(p, 'filmThicknessMicrons')) || 0; }, false],
        shelf: [function (p) { return p.shelf; }, true]
      },
      filters: [
        ['Cement type', function (p) { return spec(p, 'cementType'); }],
        ['Delivery', function (p) { return p.delivery || ''; }],
        ['Radiopaque', function (p) { return yn(p.specs && p.specs.radiopaque); }],
        ['Fluoride release', function (p) { return yn(p.specs && p.specs.fluorideRelease); }]
      ],
      cols: [
        ['Working time', function (p) { return fmtTime(p.working); }],
        ['Set time', function (p) { return fmtTime(p.set); }, 'speed'],
        ['Type', function (p) { return spec(p, 'cementType') || '—'; }],
        ['Film thickness', function (p) { var v = spec(p, 'filmThicknessMicrons'); return v ? v + ' µm' : '—'; }, 'film'],
        ['Compressive strength', function (p) { var v = spec(p, 'compressiveStrengthMpa'); return v ? v + ' MPa' : '—'; }, 'strength'],
        ['Delivery', function (p) { return p.delivery || '—'; }],
        ['Shelf life', function (p) { return p.shelf + ' mo'; }, 'shelf']
      ]
    }
  };

  var state = { cat: 'impression_material', pri: [], companies: [], filters: {}, maxSet: 360, prices: {} };
  var ALL = [];

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function uniq(a) { return Array.from(new Set(a)).filter(Boolean).sort(); }
  function toggle(list, v) { var i = list.indexOf(v); if (i === -1) list.push(v); else list.splice(i, 1); }
  function priceOf(p) { return state.prices[p.name] != null ? state.prices[p.name] : p.price; }

  // 0-1 normalizer scaled to the min/max in the current filtered list
  function normalizer(list, get, higher) {
    var vals = list.map(get), min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    if (max === min) return function () { return 1; };
    return function (v) { return higher ? (v - min) / (max - min) : (max - v) / (max - min); };
  }
  function getter(k, scorers) { return k === 'cost' ? priceOf : scorers[k][0]; }
  function buildScorer(list, order, scorers) {
    if (!order.length || !list.length) return null;
    var norms = {};
    order.forEach(function (k) { norms[k] = normalizer(list, getter(k, scorers), scorers[k][1]); });
    var total = order.length;
    return function (p) {
      var sum = 0, ws = 0;
      order.forEach(function (k, i) { var w = total - i; sum += w * norms[k](getter(k, scorers)(p)); ws += w; });
      return sum / ws;
    };
  }

  function chip(label, pressed, onClick, num) {
    var b = el('button', 'chip');
    b.type = 'button';
    b.setAttribute('aria-pressed', String(pressed));
    if (num) b.appendChild(el('span', 'n', String(num)));
    b.appendChild(document.createTextNode(label));
    b.addEventListener('click', onClick);
    return b;
  }

  function render() {
    var cfg = CONFIGS[state.cat];
    var items = ALL.filter(function (p) { return p.category === state.cat; });

    var tabs = document.getElementById('tabs');
    tabs.textContent = '';
    Object.keys(CONFIGS).forEach(function (k) {
      var t = el('button', 'tab', CONFIGS[k].title);
      t.type = 'button';
      t.setAttribute('role', 'tab');
      t.setAttribute('aria-selected', String(k === state.cat));
      t.addEventListener('click', function () {
        state.cat = k; state.pri = []; state.companies = []; state.filters = {}; state.maxSet = 360;
        render();
      });
      tabs.appendChild(t);
    });

    var pri = document.getElementById('pri');
    pri.textContent = '';
    cfg.priorities.forEach(function (p) {
      var idx = state.pri.indexOf(p[0]);
      pri.appendChild(chip(p[1], idx !== -1, function () { toggle(state.pri, p[0]); render(); }, idx !== -1 ? idx + 1 : 0));
    });
    document.getElementById('prihelp').textContent = state.pri.length === 0
      ? 'Click one or more, in the order you care about them. The first click counts the most.'
      : 'Blending, weighted in this order: ' + state.pri.map(function (k, i) {
        return (i + 1) + ') ' + cfg.priorities.filter(function (p) { return p[0] === k; })[0][1];
      }).join(' → ');

    var fbox = document.getElementById('filters');
    fbox.textContent = '';
    function group(label, values, active, onToggle) {
      if (!values.length) return;
      var g = el('div', 'grp');
      g.appendChild(el('span', 'lab', label));
      var c = el('div', 'chips');
      values.forEach(function (v) { c.appendChild(chip(v, active.indexOf(v) !== -1, function () { onToggle(v); render(); })); });
      g.appendChild(c);
      fbox.appendChild(g);
    }
    group('Company / partner', uniq([].concat.apply([], items.map(function (p) { return p.companies; }))), state.companies, function (v) { toggle(state.companies, v); });
    var allFilters = [['Availability', function (p) { return p.availability; }]].concat(cfg.filters);
    allFilters.forEach(function (f, i) {
      var key = String(i);
      state.filters[key] = state.filters[key] || [];
      group(f[0], uniq(items.map(f[1])), state.filters[key], function (v) { toggle(state.filters[key], v); });
    });
    if (cfg.slider) {
      var g = el('div', 'grp');
      g.appendChild(el('span', 'lab', 'Max set time'));
      var r = document.createElement('input');
      r.type = 'range'; r.min = 45; r.max = 360; r.step = 15; r.value = state.maxSet;
      r.setAttribute('aria-label', 'Max set time in seconds');
      var label = function () { return state.maxSet >= 360 ? 'No limit' : 'Up to ' + fmtTime(state.maxSet); };
      var out = el('div', 'badge best', label());
      r.addEventListener('input', function () { state.maxSet = parseInt(r.value, 10); out.textContent = label(); });
      r.addEventListener('change', render);
      g.appendChild(r);
      g.appendChild(document.createElement('br'));
      g.appendChild(out);
      fbox.appendChild(g);
    }

    var filtered = items.filter(function (p) {
      if (state.companies.length && !p.companies.some(function (c) { return state.companies.indexOf(c) !== -1; })) return false;
      for (var i = 0; i < allFilters.length; i++) {
        var a = state.filters[String(i)];
        if (a && a.length && a.indexOf(allFilters[i][1](p)) === -1) return false;
      }
      if (cfg.slider && state.maxSet < 360 && (p.set || 0) > state.maxSet) return false;
      return true;
    });
    var scoreOf = buildScorer(filtered, state.pri, cfg.scorers);
    var sorted = scoreOf ? filtered.slice().sort(function (a, b) { return scoreOf(b) - scoreOf(a); }) : filtered;

    document.getElementById('count').textContent = sorted.length + ' of ' + items.length + ' ' + cfg.title.toLowerCase() + ' match';
    var res = document.getElementById('res');
    res.textContent = '';
    if (!sorted.length) { res.appendChild(el('div', 'empty', 'Nothing matches these filters. Try loosening one.')); return; }

    sorted.slice(0, 60).forEach(function (p, i) {
      var top = i === 0 && state.pri.length > 0;
      var card = el('article', 'card' + (top ? ' top1' : ''));

      var a = el('div');
      a.appendChild(el('p', 'nm', p.name));
      a.appendChild(el('p', 'br', p.brand));
      if (top) a.appendChild(el('span', 'badge best', 'Top match'));
      if (p.material) a.appendChild(el('span', 'badge', p.material));
      a.appendChild(el('span', 'badge', p.availability));
      a.appendChild(el('p', 'via', 'Via: ' + p.companies.join(', ')));

      var b = el('div');
      var dl = el('dl', 'specs');
      cfg.cols.forEach(function (c) {
        var d = el('div');
        d.appendChild(el('dt', null, c[0]));
        d.appendChild(el('dd', c[2] && state.pri.indexOf(c[2]) !== -1 ? 'hl' : '', c[1](p)));
        dl.appendChild(d);
      });
      var ms = el('div');
      ms.appendChild(el('dt', null, 'Match score'));
      var dd = el('dd');
      if (scoreOf) {
        var pct = Math.round(scoreOf(p) * 100);
        var bar = el('span', 'bar');
        var fill = document.createElement('i');
        fill.style.width = pct + '%';
        bar.appendChild(fill);
        dd.appendChild(bar);
        dd.appendChild(document.createTextNode(pct + '%'));
      } else { dd.textContent = '—'; }
      ms.appendChild(dd);
      dl.appendChild(ms);
      b.appendChild(dl);
      if (p.note) b.appendChild(el('p', 'tip', p.note));

      var c3 = el('div', 'price');
      var wrap = el('div');
      wrap.appendChild(document.createTextNode('$'));
      var inp = document.createElement('input');
      inp.type = 'number'; inp.min = 0; inp.step = 0.01; inp.value = priceOf(p);
      inp.setAttribute('aria-label', 'Price for ' + p.name);
      inp.addEventListener('change', function () {
        var v = parseFloat(inp.value);
        if (!isNaN(v) && v >= 0) { state.prices[p.name] = v; render(); }
      });
      wrap.appendChild(inp);
      c3.appendChild(wrap);
      c3.appendChild(el('small', null, p.priceUnit));

      card.appendChild(a); card.appendChild(b); card.appendChild(c3);
      res.appendChild(card);
    });
    if (sorted.length > 60) res.appendChild(el('p', 'foot', 'Showing the top 60. Add filters to narrow the list.'));
  }

  fetch('products.json').then(function (r) { return r.json(); }).then(function (d) { ALL = d; render(); })
    .catch(function () { document.getElementById('count').textContent = 'Could not load the catalog.'; });
})();
