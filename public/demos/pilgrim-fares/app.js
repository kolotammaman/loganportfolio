// A demo of Pilgrim Fares: flight deals scored by price, stops, carrier, and proximity to a feast day.
// The scoring weights and feast-proximity rule are the app's own. Fares here are generated sample
// data (the real app reads live fares daily), and nothing is sent anywhere.
(function () {
  'use strict';

  var WEIGHTS = { discount: 0.5, stops: 0.2, carrier: 0.15, feast: 0.15 };
  var BUDGET = ['NK', 'SPIRIT', 'F9', 'FRONTIER', 'G4', 'ALLEGIANT', 'W6', 'WIZZ', 'FR', 'RYANAIR', 'U2', 'EASYJET'];
  var clamp01 = function (n) { return Math.max(0, Math.min(1, n)); };
  var discountC = function (d) { return clamp01((d - 20) / 50); };
  var stopsC = function (s) { return s === 0 ? 1 : s === 1 ? 0.6 : 0; };
  var carrierC = function (c) { if (!c) return 0.5; var u = c.toUpperCase(); return BUDGET.some(function (b) { return u.indexOf(b) !== -1; }) ? 0.2 : 1; };

  var ORIGINS = [['PHL', 'Philadelphia'], ['JFK', 'New York'], ['BOS', 'Boston'], ['ORD', 'Chicago'], ['ATL', 'Atlanta'], ['DFW', 'Dallas'], ['MIA', 'Miami'], ['LAX', 'Los Angeles']];

  // name, country, airports, typical round-trip fare from the East Coast, carriers that fly it, feasts
  var DEST = [
    ['Rome', 'Italy', 'FCO', 850, ['ITA Airways', 'Delta', 'American'], [['Sts. Peter and Paul', 6, 29], ['St. Francis of Assisi', 10, 4]]],
    ['Fatima', 'Portugal', 'LIS', 780, ['TAP Air Portugal', 'United', 'Delta'], [['Our Lady of Fatima', 5, 13], ['Our Lady of Fatima (October)', 10, 13]]],
    ['Lourdes', 'France', 'TLS', 960, ['Air France', 'Delta', 'United'], [['Our Lady of Lourdes', 2, 11]]],
    ['Santiago de Compostela', 'Spain', 'SCQ', 920, ['Iberia', 'American', 'Delta'], [['St. James', 7, 25]]],
    ['Holy Land', 'Israel', 'TLV', 1250, ['El Al', 'United', 'Delta'], [['Holy Week / Easter', 'easter', 0]]],
    ['Mexico City (Guadalupe)', 'Mexico', 'MEX', 520, ['Aeromexico', 'Delta', 'Spirit Airlines'], [['Our Lady of Guadalupe', 12, 12]]],
    ['Knock', 'Ireland', 'DUB', 700, ['Aer Lingus', 'Delta', 'United'], [['Our Lady of Knock', 8, 21]]],
    ['Krakow', 'Poland', 'KRK', 930, ['LOT Polish Airlines', 'United', 'Lufthansa'], [['Divine Mercy Sunday', 'easter', 7], ['St. John Paul II', 10, 22]]],
    ['Medjugorje', 'Bosnia and Herzegovina', 'SPU', 1050, ['Lufthansa', 'Air France', 'United'], [['Queen of Peace Anniversary', 6, 24]]],
    ['Lisieux', 'France', 'CDG', 820, ['Air France', 'Delta', 'Norse Atlantic'], [['St. Therese of Lisieux', 10, 1]]],
    ['Czestochowa', 'Poland', 'KTW', 980, ['LOT Polish Airlines', 'Lufthansa', 'United'], [['Our Lady of Czestochowa', 8, 26]]],
    ['San Juan de los Lagos', 'Mexico', 'GDL', 560, ['Aeromexico', 'American', 'Spirit Airlines'], [['Candlemas', 2, 2]]]
  ];

  // Easter Sunday (Gregorian), then the movable feasts that hang off it
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
    var h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451);
    var mo = Math.floor((h + l - 7 * m + 114) / 31), da = ((h + l - 7 * m + 114) % 31) + 1;
    return new Date(Date.UTC(y, mo - 1, da));
  }
  var DAY = 86400000;
  var iso = function (t) { return new Date(t).toISOString().slice(0, 10); };
  function feastDates(d, years) {
    var out = [];
    d[5].forEach(function (f) {
      years.forEach(function (y) {
        var t = typeof f[1] === 'string' ? easter(y).getTime() + f[2] * DAY : Date.UTC(y, f[1] - 1, f[2]);
        out.push({ name: f[0], t: t, date: iso(t) });
      });
    });
    return out;
  }

  // The app's rule: 1.0 if a feast falls in the trip window, 0.5 if within 7 days of either edge
  function feastProximity(feasts, depart, back) {
    var best = { score: 0, feast: null };
    for (var i = 0; i < feasts.length; i++) {
      var t = feasts[i].t;
      if (t >= depart && t <= back) return { score: 1, feast: feasts[i] };
      var dist = Math.min(Math.abs(t - depart), Math.abs(t - back));
      if (dist <= 7 * DAY && best.score < 0.5) best = { score: 0.5, feast: feasts[i] };
    }
    return best;
  }

  // small deterministic PRNG so sample fares stay stable between visits
  function rng(seedStr) {
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  }

  var originBump = { PHL: 0, JFK: -30, BOS: -10, ORD: 40, ATL: 50, DFW: 90, MIA: 60, LAX: 190 };
  var today = new Date();
  var todayT = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  var years = [today.getFullYear(), today.getFullYear() + 1];

  function buildDeals(origin) {
    var deals = [];
    DEST.forEach(function (d, di) {
      var r = rng(origin + d[0]);
      var baseline = Math.round((d[3] + originBump[origin]) / 5) * 5;
      var feasts = feastDates(d, years).filter(function (f) { return f.t > todayT + 14 * DAY && f.t < todayT + 400 * DAY; });
      var starts = [];
      // one trip built around the next two feasts, plus two ordinary off-peak trips
      feasts.sort(function (a, b) { return a.t - b.t; }).slice(0, 2).forEach(function (f) { starts.push(f.t - Math.round(2 + r() * 5) * DAY); });
      starts.push(todayT + Math.round(35 + r() * 80) * DAY, todayT + Math.round(150 + r() * 180) * DAY);
      starts.forEach(function (s, si) {
        var len = Math.round(7 + r() * 7), back = s + len * DAY;
        var disc = Math.round(12 + r() * 52);
        var stops = r() < 0.4 ? 0 : 1;
        if (d[3] < 600 && r() < 0.3) stops = 0;
        var carrier = d[4][Math.floor(r() * d[4].length)];
        var price = Math.round((baseline * (1 - disc / 100)) / 5) * 5;
        var prox = feastProximity(feastDates(d, years), s, back);
        var score = discountC(disc) * WEIGHTS.discount + stopsC(stops) * WEIGHTS.stops + carrierC(carrier) * WEIGHTS.carrier + prox.score * WEIGHTS.feast;
        deals.push({ dest: d[0], country: d[1], airport: d[2], depart: iso(s), ret: iso(back), baseline: baseline, price: price, disc: disc, stops: stops, carrier: carrier,
          prox: prox, score: Math.round(score * 100) / 100, comp: { discount: discountC(disc), stops: stopsC(stops), carrier: carrierC(carrier), feast: prox.score }, key: d[0] + si });
      });
    });
    return deals;
  }

  var state = { origin: 'PHL', watch: ['Rome', 'Fatima', 'Lourdes', 'Krakow', 'Holy Land'], minDisc: 25, nonstop: false, hideBudget: false };

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function fmtDate(s) { var d = new Date(s + 'T00:00:00Z'); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }); }
  function chip(label, pressed, onClick) { var b = el('button', 'chip', label); b.type = 'button'; b.setAttribute('aria-pressed', String(pressed)); b.addEventListener('click', onClick); return b; }

  function render() {
    var box = document.getElementById('origin');
    box.textContent = '';
    ORIGINS.forEach(function (o) { box.appendChild(chip(o[0] + ' ' + o[1], o[0] === state.origin, function () { state.origin = o[0]; render(); })); });

    var wl = document.getElementById('watch');
    wl.textContent = '';
    DEST.forEach(function (d) {
      var on = state.watch.indexOf(d[0]) !== -1;
      wl.appendChild(chip(d[0], on, function () { var i = state.watch.indexOf(d[0]); if (i === -1) state.watch.push(d[0]); else state.watch.splice(i, 1); render(); }));
    });

    var all = buildDeals(state.origin).filter(function (x) { return state.watch.indexOf(x.dest) !== -1; });
    var deals = all.filter(function (x) {
      return x.disc >= state.minDisc && (!state.nonstop || x.stops === 0) && (!state.hideBudget || carrierC(x.carrier) > 0.2);
    }).sort(function (a, b) { return b.score - a.score; });

    document.getElementById('count').textContent = deals.length + ' deal' + (deals.length === 1 ? '' : 's') + ' from ' + state.origin + ' on ' + state.watch.length + ' watched destination' + (state.watch.length === 1 ? '' : 's');
    var res = document.getElementById('res');
    res.textContent = '';
    if (!deals.length) res.appendChild(el('div', 'empty', state.watch.length ? 'No deals clear these filters. Lower the minimum discount or allow one-stop flights.' : 'Add a destination to your watchlist to see deals.'));

    deals.forEach(function (x, i) {
      var card = el('article', 'card' + (i === 0 ? ' top1' : ''));
      var a = el('div');
      a.appendChild(el('p', 'nm', x.dest));
      a.appendChild(el('p', 'br', x.country + ' · ' + x.airport));
      if (i === 0) a.appendChild(el('span', 'badge best', 'Best deal'));
      if (x.prox.score === 1) a.appendChild(el('span', 'badge best', 'Feast in window'));
      else if (x.prox.score === 0.5) a.appendChild(el('span', 'badge', 'Feast within a week'));
      if (x.prox.feast) a.appendChild(el('p', 'via', x.prox.feast.name + ', ' + fmtDate(x.prox.feast.date)));

      var b = el('div');
      var dl = el('dl', 'specs');
      [['Depart', fmtDate(x.depart)], ['Return', fmtDate(x.ret)], ['Route', state.origin + ' → ' + x.airport], ['Stops', x.stops === 0 ? 'Nonstop' : '1 stop'], ['Carrier', x.carrier], ['Typical fare', '$' + x.baseline.toLocaleString()]].forEach(function (p) {
        var d = el('div'); d.appendChild(el('dt', null, p[0])); d.appendChild(el('dd', '', p[1])); dl.appendChild(d);
      });
      var sc = el('div'); sc.appendChild(el('dt', null, 'Deal score'));
      var dd = el('dd'); var bar = el('span', 'bar'); var fill = document.createElement('i'); fill.style.width = Math.round(x.score * 100) + '%'; bar.appendChild(fill); dd.appendChild(bar); dd.appendChild(document.createTextNode(Math.round(x.score * 100) + '/100'));
      sc.appendChild(dd); dl.appendChild(sc); b.appendChild(dl);
      b.appendChild(el('p', 'tip', 'Why this score: ' + x.disc + '% under typical (' + Math.round(x.comp.discount * 50) + '/50), ' + (x.stops === 0 ? 'nonstop' : 'one stop') + ' (' + Math.round(x.comp.stops * 20) + '/20), ' + (x.comp.carrier > 0.2 ? 'full-service carrier' : 'budget carrier') + ' (' + Math.round(x.comp.carrier * 15) + '/15), feast match (' + Math.round(x.comp.feast * 15) + '/15).'));

      var c3 = el('div', 'price');
      c3.appendChild(el('div', 'big', '$' + x.price.toLocaleString()));
      c3.appendChild(el('small', null, 'round trip, sample fare'));
      c3.appendChild(el('small', 'save', x.disc + '% off typical'));
      card.appendChild(a); card.appendChild(b); card.appendChild(c3);
      res.appendChild(card);
    });

    // upcoming feast calendar for the watchlist
    var cal = document.getElementById('cal');
    cal.textContent = '';
    var feasts = [];
    DEST.filter(function (d) { return state.watch.indexOf(d[0]) !== -1; }).forEach(function (d) {
      feastDates(d, years).forEach(function (f) { if (f.t >= todayT && f.t < todayT + 400 * DAY) feasts.push({ d: d[0], f: f }); });
    });
    feasts.sort(function (a, b) { return a.f.t - b.f.t; });
    if (!feasts.length) cal.appendChild(el('p', 'foot', 'No upcoming feasts for the current watchlist.'));
    feasts.slice(0, 10).forEach(function (x) {
      var row = el('div', 'frow');
      row.appendChild(el('span', 'fd', fmtDate(x.f.date)));
      row.appendChild(el('span', 'fn', x.f.name));
      row.appendChild(el('span', 'fc', x.d));
      cal.appendChild(row);
    });
  }

  document.getElementById('disc').addEventListener('input', function (e) {
    state.minDisc = parseInt(e.target.value, 10);
    document.getElementById('discout').textContent = state.minDisc + '% or more';
  });
  document.getElementById('disc').addEventListener('change', render);
  document.getElementById('nonstop').addEventListener('change', function (e) { state.nonstop = e.target.checked; render(); });
  document.getElementById('nobudget').addEventListener('change', function (e) { state.hideBudget = e.target.checked; render(); });
  render();
})();
