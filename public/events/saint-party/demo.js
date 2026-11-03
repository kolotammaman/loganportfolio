(() => {
  // shim/sqlite.js
  var norm = (v) => v === void 0 ? null : typeof v === "boolean" ? Number(v) : v;
  var DatabaseSync = class {
    constructor() {
      this.db = new globalThis.__SQL.Database(globalThis.__SAINT_DB_BYTES || void 0);
    }
    exec(sql) {
      this.db.exec(sql);
    }
    prepare(sql) {
      const db = this.db;
      const rows = (p, one) => {
        const s = db.prepare(sql);
        s.bind(p.map(norm));
        const out = [];
        while (s.step()) {
          out.push(s.getAsObject());
          if (one) break;
        }
        s.free();
        return out;
      };
      return {
        run: (...p) => {
          db.run(sql, p.map(norm));
          const changes = db.getRowsModified();
          const id = db.exec("SELECT last_insert_rowid()")[0].values[0][0];
          return { changes, lastInsertRowid: id };
        },
        get: (...p) => rows(p, true)[0],
        all: (...p) => rows(p, false)
      };
    }
    close() {
      this.db.close();
    }
  };

  // shim/fs.js
  function readFileSync() {
    return globalThis.__SAINTS_CSV;
  }

  // ../../saint-party/server/csv.js
  function parseCsv(text) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (c === '"') quoted = false;
        else field += c;
      } else if (c === '"') quoted = true;
      else if (c === ",") {
        row.push(field);
        field = "";
      } else if (c === "\n" || c === "\r") {
        if (c === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        field = "";
        rows.push(row);
        row = [];
      } else field += c;
    }
    if (field || row.length) {
      row.push(field);
      rows.push(row);
    }
    const [header, ...body] = rows.filter((r) => r.some((v) => v.trim()));
    return body.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? "").trim()])));
  }

  // ../../saint-party/server/store.js
  var LEVELS = ["Easy", "Medium", "Extra difficult"];
  var RSVP = ["Going", "Maybe", "Can\u2019t go"];
  var GENDERS = ["Male", "Female", "Either"];
  var SCHEMA = `
  CREATE TABLE saint (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female', 'Either')),
    level TEXT NOT NULL CHECK (level IN ('Easy', 'Medium', 'Extra difficult')),
    patron TEXT NOT NULL DEFAULT '',
    costume TEXT NOT NULL DEFAULT '',
    find1_id INTEGER REFERENCES saint (id) ON DELETE SET NULL,
    find2_id INTEGER REFERENCES saint (id) ON DELETE SET NULL,
    announce TEXT NOT NULL DEFAULT '',
    announce_time TEXT NOT NULL DEFAULT '',
    activity TEXT NOT NULL DEFAULT '',
    activity_time TEXT NOT NULL DEFAULT '',
    palette TEXT NOT NULL DEFAULT 'gold',
    icon TEXT NOT NULL DEFAULT 'sparkles',
    drinks INTEGER NOT NULL DEFAULT 0 CHECK (drinks IN (0, 1))
  );

  -- Later migrations below add to this table (no_drinks, reminder_sent_at, card_key).
  CREATE TABLE guest (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('Going', 'Maybe', 'Can\u2019t go')),
    gender TEXT NOT NULL DEFAULT '' CHECK (gender IN ('', 'Male', 'Female')),
    updated_at TEXT NOT NULL
  );

  -- A Phone is a browser's remembered token. Many Phones can point at one Guest.
  CREATE TABLE phone (
    token TEXT PRIMARY KEY,
    guest_id INTEGER NOT NULL REFERENCES guest (id) ON DELETE CASCADE
  );

  -- One Claim per Guest and one Claim per saint, enforced by the schema.
  CREATE TABLE claim (
    saint_id INTEGER NOT NULL UNIQUE REFERENCES saint (id),
    guest_id INTEGER NOT NULL UNIQUE REFERENCES guest (id) ON DELETE CASCADE,
    claimed_at TEXT NOT NULL
  );

  CREATE TABLE setting (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;
  function openStore(dbPath, { csvPath }) {
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    function transaction(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    }
    const { user_version: version } = db.prepare("PRAGMA user_version").get();
    if (version < 1) {
      transaction(() => {
        db.exec(SCHEMA);
        seedSaints(db, readFileSync(csvPath, "utf8"));
        db.exec("PRAGMA user_version = 1");
      });
    }
    if (version < 2) {
      transaction(() => {
        db.exec("ALTER TABLE saint ADD COLUMN parked INTEGER NOT NULL DEFAULT 0 CHECK (parked IN (0, 1))");
        db.exec("PRAGMA user_version = 2");
      });
    }
    if (version < 3) {
      transaction(() => {
        db.exec("ALTER TABLE guest ADD COLUMN no_drinks INTEGER NOT NULL DEFAULT 0 CHECK (no_drinks IN (0, 1))");
        db.exec("PRAGMA user_version = 3");
      });
    }
    if (version < 4) {
      transaction(() => {
        db.exec(`
        CREATE TABLE find (
          guest_id INTEGER NOT NULL REFERENCES guest (id) ON DELETE CASCADE,
          slot INTEGER NOT NULL,
          saint_id INTEGER NOT NULL REFERENCES saint (id) ON DELETE CASCADE,
          PRIMARY KEY (guest_id, slot),
          UNIQUE (guest_id, saint_id)
        )`);
        db.exec("PRAGMA user_version = 4");
      });
    }
    if (version < 5) {
      transaction(() => {
        db.exec("ALTER TABLE guest ADD COLUMN reminder_sent_at TEXT");
        db.exec("PRAGMA user_version = 5");
      });
    }
    if (version < 6) {
      transaction(() => {
        db.exec("ALTER TABLE guest ADD COLUMN card_key TEXT");
        db.exec("UPDATE guest SET card_key = lower(hex(randomblob(16)))");
        db.exec("CREATE UNIQUE INDEX guest_card_key ON guest (card_key)");
        db.exec("PRAGMA user_version = 6");
      });
    }
    if (version < 7) {
      transaction(() => {
        db.exec(`
        CREATE TABLE IF NOT EXISTS sheet_guest (
          phone_id TEXT PRIMARY KEY,
          email TEXT NOT NULL UNIQUE COLLATE NOCASE,
          guest_id INTEGER REFERENCES guest (id) ON DELETE SET NULL,
          fingerprint TEXT NOT NULL
        )`);
        db.exec("PRAGMA user_version = 7");
      });
    }
    return { db, transaction, close: () => db.close() };
  }
  function seedSaints(db, csvText) {
    const rows = parseCsv(csvText);
    const insert = db.prepare(`
    INSERT INTO saint (name, gender, level, patron, costume, announce, announce_time,
      activity, activity_time, palette, icon, drinks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of rows) {
      insert.run(
        r["Saint Name"],
        r["Gender"],
        r["Level"],
        r["Patron of"],
        r["Costume"],
        r["Announcement"],
        r["Announcement time"],
        r["Activity"],
        r["Activity time"],
        r["Card palette"] || "gold",
        r["Card icon"] || "sparkles",
        /^(yes|y|true|x)$/i.test(r["Drinks duty"]) ? 1 : 0
      );
    }
    const link = db.prepare(`
    UPDATE saint SET
      find1_id = (SELECT id FROM saint WHERE name = ?),
      find2_id = (SELECT id FROM saint WHERE name = ?)
    WHERE name = ?`);
    for (const r of rows) link.run(r["Find 1"], r["Find 2"], r["Saint Name"]);
  }

  // shim/crypto.js
  function randomBytes(n) {
    const b = crypto.getRandomValues(new Uint8Array(n));
    return { toString: () => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("") };
  }

  // ../../saint-party/server/reminder.js
  var FROM = "Saint Party";
  var DEFAULT_SUBJECT = "Saint Party tonight: your saint and the house rules";
  var DEFAULT_DETAILS = [
    "WHEN: Saturday, October 31, 9 PM to midnight",
    "WHERE: West Philadelphia (exact address goes to guests)",
    "",
    "House rules:",
    "1. Come dressed as your saint. Homemade is perfect.",
    "2. The party is on the first floor and in the basement only. Please don\u2019t go upstairs.",
    "3. Open your saint card when you arrive. Your two saints to find go live today: track them down and introduce yourself in character.",
    "4. Extra difficult saints, watch the clock. Quiet the whole room before you make your announcement.",
    "5. The drinks crew (St. Martin, St. Arnold, and St. Brigid) runs the drinks. There is a non-alcoholic option too.",
    "6. Please don\u2019t request songs from the DJs. They\u2019ve got it covered.",
    "7. Laugh with the saints, never at the faith.",
    "8. Need a ride home? Find St. Christopher or the host before you leave.",
    "",
    "Suggested donation: $5 to $15 to help cover party supplies. Much appreciated! Give at the door."
  ].join("\n");
  var GOLD = ["#fbf3df", "#3a2a10", "#b9862c"];
  var SANS = "font-family:Arial,sans-serif;";
  function reminderEmail({ to, guest, card, subject, details, cardUrl, palettes }) {
    const text = [];
    const html = [
      '<div style="font-family:Georgia,serif;max-width:560px;margin:0 auto;color:#2a2233">',
      '<p style="letter-spacing:.2em;text-transform:uppercase;font-size:11px;color:#b9862c;margin:0">All Saints\u2019 Eve</p>',
      '<h1 style="font-size:30px;margin:4px 0 16px">Saint Party</h1>'
    ];
    const line = (plain, inner = esc(plain)) => {
      html.push(`<p style="${SANS}font-size:14px;margin:0 0 8px">${inner}</p>`);
      text.push(plain);
    };
    if (guest) {
      const hi = "Hi " + guest.name.trim().split(/\s+/)[0] + ", " + (guest.status === "Maybe" ? "you said maybe. We hope you can make it tonight!" : "see you tonight!");
      html.push(`<p style="${SANS}font-size:16px;margin:0 0 16px">${esc(hi)}</p>`);
      text.push(hi, "");
    }
    if (card) {
      const [bg, ink, accent] = palettes[card.palette] ?? palettes.gold ?? GOLD;
      html.push(
        `<div style="background:${bg};color:${ink};border:2px solid ${accent};border-radius:16px;padding:18px 20px;margin:0 0 20px">`,
        '<p style="font-size:11px;letter-spacing:.2em;text-transform:uppercase;margin:0;opacity:.7">Tonight you are</p>',
        `<h2 style="font-size:28px;margin:4px 0 2px">${esc(card.name)}</h2>`,
        `<p style="font-style:italic;margin:0 0 10px">${card.patron ? "Patron of " + esc(card.patron) + " \xB7 " : ""}${esc(card.level)}</p>`
      );
      text.push("Tonight you are " + card.name + (card.patron ? ", patron of " + card.patron : "") + " (" + card.level + ").");
      line("Costume: " + card.costume, "<b>Costume:</b> " + esc(card.costume));
      if (card.announce) {
        const head = "Your announcement" + (card.announceTime ? " (" + card.announceTime + ")" : "") + ":";
        line(
          head + " quiet the whole room, then say \u201C" + card.announce + "\u201D",
          "<b>" + esc(head) + "</b> quiet the whole room, then say \u201C" + esc(card.announce) + "\u201D"
        );
      }
      if (card.activity) {
        const head = "Do this" + (card.activityTime ? " (" + card.activityTime + ")" : "") + ":";
        line(head + " " + card.activity, "<b>" + esc(head) + "</b> " + esc(card.activity));
      }
      if (card.drinks) {
        line(
          "Drinks crew: you\u2019re helping run the drinks tonight. Thank you!",
          "<b>Drinks crew:</b> you\u2019re helping run the drinks tonight. Thank you!"
        );
      }
      const findLine = card.findsReleased && card.finds.length ? "Find these saints: " + card.finds.map((f) => "the patron of " + f.clue).join("; ") + "." : "Your two saints to find will show up on your card today.";
      html.push(`<p style="${SANS}font-size:14px;margin:0"><b>${esc(findLine)}</b></p></div>`);
      text.push(findLine);
    } else {
      const nudge = "You don\u2019t have a saint yet. Open the link below to get one before the party.";
      html.push(`<p style="${SANS}font-size:15px">${esc(nudge)}</p>`);
      text.push(nudge);
    }
    const button = card ? "Open my saint card" : "Get my saint";
    html.push(
      '<table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 8px"><tr>',
      `<td bgcolor="#2a2233" style="background:#2a2233;border:2px solid #b9862c;border-radius:999px;padding:14px 28px">`,
      `<a href="${esc(cardUrl)}" style="${SANS}color:#fbf3df;font-size:17px;font-weight:bold;text-decoration:none">${button}</a></td></tr></table>`
    );
    const findMine = "If the button doesn\u2019t open your card, tap \u201CAlready RSVP\u2019d? Find my saint\u201D on the party page and enter " + to + ".";
    html.push(`<p style="${SANS}font-size:12px;color:#8a7c99;text-align:center;margin:0 0 24px">${esc(findMine)}</p>`);
    text.push("", "Open your saint card: " + cardUrl, findMine);
    html.push(`<div style="${SANS}font-size:15px;line-height:1.55;white-space:pre-line;margin:0 0 20px">${esc(details)}</div>`);
    text.push("", details);
    html.push(`<p style="${SANS}font-size:12px;color:#8a7c99;margin-top:24px">You\u2019re getting this because you RSVP\u2019d to Saint Party. Your email is only used for party updates.</p></div>`);
    return { subject, text: text.join("\n"), html: html.join("") };
  }
  function esc(s) {
    return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  // ../../saint-party/server/party.js
  var GuestError = class extends Error {
  };
  var CANT = RSVP[2];
  var MAX_INVITE = 4e3;
  var MAX_NAME = 120;
  var MAX_FIELD = 1e3;
  var MAX_TIME = 40;
  var MAX_SUBJECT = 200;
  var MAX_DETAILS = 4e3;
  var NONE_LEFT = "No saints left at that level. Try another, or find the host!";
  var FINDS_PER_GUEST = 2;
  var MAX_CONFLICTS = 50;
  var HAND_OUT_WEIGHTS = {
    drinks: 40,
    // a drinks-crew saint
    link: 3
    // each Find 1 or Find 2 link to or from a saint already claimed
  };
  var EVENT = {
    title: "Saint Party",
    date: "Saturday, October 31",
    time: "9 PM to midnight",
    address: "West Philadelphia (exact address goes to guests)",
    host: "Logan",
    donation: "Suggested donation of $5 to $15 to help cover party supplies. Much appreciated! Give at the door.",
    // For the "Add to calendar" link (local time in TZ below).
    start: "20261031T210000",
    end: "20261101T000000",
    tz: "America/New_York"
  };
  var DEFAULT_INVITE = [
    "An All Saints\u2019 Eve Halloween party. Everyone comes dressed as a saint.",
    "",
    "RSVP here, then get your saint right on this page: you\u2019ll get simple costume ideas and a few missions for the night, from easy to extra difficult (you choose).",
    "",
    "DJs, drinks (with a non-alcoholic option), and good company. The party is on the first floor and in the basement."
  ].join("\n");
  function createParty({ db, transaction }, {
    clock,
    publicUrl,
    cards,
    mailer,
    random = Math.random,
    handOutWeights = HAND_OUT_WEIGHTS
  }) {
    const sql = {
      guestByPhone: db.prepare(`
      SELECT guest.* FROM phone JOIN guest ON guest.id = phone.guest_id WHERE phone.token = ?`),
      guestByEmail: db.prepare("SELECT * FROM guest WHERE email = ?"),
      insertGuest: db.prepare(`
      INSERT INTO guest (email, name, status, gender, updated_at, card_key) VALUES (?, ?, ?, ?, ?, ?) RETURNING id`),
      guestByCardKey: db.prepare("SELECT * FROM guest WHERE card_key = ?"),
      updateGuest: db.prepare(`
      UPDATE guest SET email = ?, name = ?, status = ?, gender = ?, updated_at = ? WHERE id = ?`),
      updateEmail: db.prepare("UPDATE guest SET email = ?, updated_at = ? WHERE id = ?"),
      optOutOfDrinks: db.prepare("UPDATE guest SET no_drinks = 1, updated_at = ? WHERE id = ?"),
      linkPhone: db.prepare(`
      INSERT INTO phone (token, guest_id) VALUES (?, ?)
      ON CONFLICT (token) DO UPDATE SET guest_id = excluded.guest_id`),
      guestList: db.prepare(`
      SELECT name, status FROM guest WHERE status IN ('Going', 'Maybe') ORDER BY id`),
      saintOf: db.prepare(`
      SELECT saint.* FROM claim JOIN saint ON saint.id = claim.saint_id WHERE claim.guest_id = ?`),
      saintsWithClaims: db.prepare(`
      SELECT saint.gender, saint.level, saint.parked, claim.guest_id IS NOT NULL AS taken
      FROM saint LEFT JOIN claim ON claim.saint_id = saint.id`),
      drinkPartners: db.prepare(`
      SELECT saint.name FROM saint JOIN claim ON claim.saint_id = saint.id
      WHERE saint.drinks = 1 AND saint.id != ? ORDER BY saint.name`),
      pool: db.prepare(`
      SELECT saint.id, saint.drinks, saint.find1_id, saint.find2_id FROM saint
      WHERE NOT EXISTS (SELECT 1 FROM claim WHERE claim.saint_id = saint.id)
        AND (? IS NULL OR saint.id != ?)
        AND saint.gender IN (?, 'Either')
        AND (? = 'Any' OR saint.level = ?)
        AND NOT (saint.drinks = 1 AND (SELECT no_drinks FROM guest WHERE id = ?) = 1)
        AND NOT saint.parked`),
      claimedFinds: db.prepare(`
      SELECT saint.id, saint.find1_id, saint.find2_id FROM saint JOIN claim ON claim.saint_id = saint.id`),
      insertClaim: db.prepare("INSERT INTO claim (saint_id, guest_id, claimed_at) VALUES (?, ?, ?)"),
      giveBack: db.prepare("DELETE FROM claim WHERE guest_id = ?"),
      giveBackAll: db.prepare("DELETE FROM claim"),
      setting: db.prepare("SELECT value FROM setting WHERE key = ?"),
      saveSetting: db.prepare("INSERT OR REPLACE INTO setting (key, value) VALUES (?, ?)"),
      dropSetting: db.prepare("DELETE FROM setting WHERE key = ?"),
      guestsWithSaints: db.prepare(`
      SELECT guest.id, guest.name, guest.status, guest.reminder_sent_at, saint.name AS saint
      FROM guest LEFT JOIN claim ON claim.guest_id = guest.id LEFT JOIN saint ON saint.id = claim.saint_id
      ORDER BY CASE guest.status WHEN 'Going' THEN 0 WHEN 'Maybe' THEN 1 ELSE 2 END, guest.name COLLATE NOCASE`),
      saintsWithHolders: db.prepare(`
      SELECT saint.id, saint.name, saint.gender, saint.level, saint.patron, saint.costume,
        saint.find1_id, saint.find2_id, saint.announce, saint.announce_time, saint.activity,
        saint.activity_time, saint.palette, saint.icon, saint.drinks, saint.parked,
        claim.guest_id IS NOT NULL AS taken, claim.guest_id, guest.name AS guest
      FROM saint LEFT JOIN claim ON claim.saint_id = saint.id LEFT JOIN guest ON guest.id = claim.guest_id
      ORDER BY saint.id`),
      saintById: db.prepare("SELECT id FROM saint WHERE id = ?"),
      saintByName: db.prepare("SELECT id, parked FROM saint WHERE name = ?"),
      isHeld: db.prepare("SELECT 1 FROM claim WHERE saint_id = ?"),
      freeSaint: db.prepare("DELETE FROM claim WHERE saint_id = ? AND guest_id = ?"),
      // Their Phones, Claim and Find list go with them (ON DELETE CASCADE).
      deleteGuest: db.prepare("DELETE FROM guest WHERE id = ? AND name = ?"),
      insertSaint: db.prepare(`
      INSERT INTO saint (name, gender, level, patron, costume, find1_id, find2_id, announce, announce_time,
        activity, activity_time, palette, icon, drinks, parked)
      VALUES (:name, :gender, :level, :patron, :costume, :find1, :find2, :announce, :announceTime,
        :activity, :activityTime, :palette, :icon, :drinks, :parked)`),
      updateSaint: db.prepare(`
      UPDATE saint SET name = :name, gender = :gender, level = :level, patron = :patron, costume = :costume,
        find1_id = :find1, find2_id = :find2, announce = :announce, announce_time = :announceTime,
        activity = :activity, activity_time = :activityTime, palette = :palette, icon = :icon,
        drinks = :drinks, parked = :parked
      WHERE id = :id`),
      deleteSaint: db.prepare("DELETE FROM saint WHERE id = ?"),
      heldSaints: db.prepare(`
      SELECT saint.name, saint.announce, saint.announce_time, saint.activity, saint.activity_time,
        guest.name AS guest
      FROM saint JOIN claim ON claim.saint_id = saint.id JOIN guest ON guest.id = claim.guest_id
      ORDER BY saint.id`),
      holders: db.prepare(`
      SELECT claim.guest_id, saint.id, saint.find1_id, saint.find2_id
      FROM claim JOIN saint ON saint.id = claim.saint_id ORDER BY claim.guest_id`),
      allFinds: db.prepare("SELECT guest_id, saint_id FROM find ORDER BY guest_id, slot"),
      findsOf: db.prepare(`
      SELECT saint.patron FROM find JOIN saint ON saint.id = find.saint_id
        JOIN claim ON claim.saint_id = saint.id
      WHERE find.guest_id = ? ORDER BY find.slot`),
      dropFinds: db.prepare("DELETE FROM find WHERE guest_id = ?"),
      dropAllFinds: db.prepare("DELETE FROM find"),
      insertFind: db.prepare("INSERT INTO find (guest_id, slot, saint_id) VALUES (?, ?, ?)"),
      reminderCounts: db.prepare(`
      SELECT COUNT(*) AS signedUp, COUNT(reminder_sent_at) AS sent FROM guest WHERE status IN ('Going', 'Maybe')`),
      unreminded: db.prepare(`
      SELECT id FROM guest WHERE status IN ('Going', 'Maybe') AND reminder_sent_at IS NULL ORDER BY id`),
      markReminded: db.prepare(`
      UPDATE guest SET reminder_sent_at = ?
      WHERE id = ? AND status IN ('Going', 'Maybe') AND reminder_sent_at IS NULL RETURNING *`),
      unmarkReminded: db.prepare("UPDATE guest SET reminder_sent_at = NULL WHERE id = ? AND reminder_sent_at = ?"),
      testEmailGuest: db.prepare(`
      SELECT guest.* FROM guest JOIN claim ON claim.guest_id = guest.id
      WHERE guest.status IN ('Going', 'Maybe') ORDER BY guest.id LIMIT 1`),
      firstSaint: db.prepare("SELECT * FROM saint ORDER BY id LIMIT 1"),
      guestById: db.prepare("SELECT * FROM guest WHERE id = ?"),
      holderOf: db.prepare("SELECT guest.name FROM claim JOIN guest ON guest.id = claim.guest_id WHERE claim.saint_id = ?"),
      sheetRow: db.prepare("SELECT * FROM sheet_guest WHERE phone_id = ? OR email = ? ORDER BY phone_id = ? DESC LIMIT 1"),
      forgetSheetRow: db.prepare("DELETE FROM sheet_guest WHERE phone_id = ? OR email IN (?, ?)"),
      saveSheetRow: db.prepare("INSERT INTO sheet_guest (phone_id, email, guest_id, fingerprint) VALUES (?, ?, ?, ?)"),
      heldForSheet: db.prepare(`
      SELECT saint.name AS saint, guest.name AS guest, guest.email
      FROM claim JOIN saint ON saint.id = claim.saint_id JOIN guest ON guest.id = claim.guest_id ORDER BY saint.id`),
      remindedInSheet: db.prepare("UPDATE guest SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL")
    };
    const now = () => clock.now().toISOString();
    const setting = (key, fallback) => sql.setting.get(key)?.value ?? fallback;
    function counts() {
      const c = { total: 0, left: 0, maleLeft: 0, femaleLeft: 0, levels: { Male: {}, Female: {} } };
      const sides = [["Male", "maleLeft"], ["Female", "femaleLeft"]];
      for (const [g] of sides) for (const l of LEVELS) c.levels[g][l] = 0;
      for (const s of sql.saintsWithClaims.all()) {
        c.total++;
        if (s.taken || s.parked) continue;
        c.left++;
        for (const [g, left] of sides) {
          if (s.gender === g || s.gender === "Either") {
            c[left]++;
            c.levels[g][s.level]++;
          }
        }
      }
      return c;
    }
    const released = () => setting("finds_released", "no") === "yes";
    function card(s, guestId) {
      const findsReleased = released();
      const finds = findsReleased ? sql.findsOf.all(guestId).map((f) => ({ clue: f.patron })) : [];
      return {
        name: s.name,
        gender: s.gender,
        level: s.level,
        patron: s.patron,
        costume: s.costume,
        findsReleased,
        finds,
        announce: s.announce,
        announceTime: s.announce_time,
        activity: s.activity,
        activityTime: s.activity_time,
        palette: s.palette,
        icon: s.icon,
        drinks: !!s.drinks,
        drinkPartners: s.drinks ? sql.drinkPartners.all(s.id).map((x) => x.name) : []
      };
    }
    function eventInfo(guest) {
      const inside = guest && guest.status !== CANT;
      const calendarUrl = "https://calendar.google.com/calendar/render?action=TEMPLATE&text=" + encodeURIComponent(EVENT.title) + "&dates=" + EVENT.start + "/" + EVENT.end + "&ctz=" + encodeURIComponent(EVENT.tz) + "&location=" + encodeURIComponent(EVENT.address) + "&details=" + encodeURIComponent("Come dressed as your saint. Your saint card: " + publicUrl);
      return {
        title: EVENT.title,
        date: EVENT.date,
        time: EVENT.time,
        host: EVENT.host,
        donation: EVENT.donation,
        invite: setting("invite_text", DEFAULT_INVITE),
        address: inside ? EVENT.address : "",
        calendarUrl: inside ? calendarUrl : ""
      };
    }
    function guestList() {
      const guests = sql.guestList.all();
      const names = (status) => guests.filter((g) => g.status === status).map((g) => shortName(g.name));
      return { going: names("Going"), maybe: names("Maybe") };
    }
    function getState({ token } = {}) {
      const guest = token ? sql.guestByPhone.get(String(token)) : void 0;
      const saint = guest && sql.saintOf.get(guest.id);
      return {
        mine: saint ? card(saint, guest.id) : null,
        counts: counts(),
        email: guest ? maskEmail(guest.email) : "",
        rsvp: guest ? { name: guest.name, status: guest.status } : null,
        event: eventInfo(guest),
        guests: guestList()
      };
    }
    function join({ token, name, status, email, gender, level, noDrinks } = {}) {
      token = checkToken(token);
      name = String(name ?? "").trim().slice(0, 80);
      if (!name) throw new GuestError("Add your name so the host knows who\u2019s coming.");
      status = normRsvp(status);
      if (!status) throw new GuestError("Pick Going, Maybe, or Can\u2019t go.");
      email = checkEmail(email);
      level = level || "Any";
      let note = "";
      transaction(() => {
        const byPhone = sql.guestByPhone.get(token);
        const byEmail = email ? sql.guestByEmail.get(email) : void 0;
        refuseAnotherGuestsEmail(byPhone, byEmail);
        let guest = byEmail ?? byPhone;
        if (!email && !guest) throw new GuestError("Add your email so the host can send you party updates.");
        if (gender !== "Male" && gender !== "Female") gender = guest?.gender ?? "";
        const holding = guest && sql.saintOf.get(guest.id);
        const needSaint = status !== CANT && !holding;
        if (needSaint) {
          if (!gender) throw new GuestError("Pick male or female first.");
          if (level !== "Any" && !LEVELS.includes(level)) throw new GuestError("Pick how bold you\u2019re feeling first.");
        }
        if (guest) sql.updateGuest.run(byEmail ? guest.email : email || guest.email, name, status, gender, now(), guest.id);
        else guest = sql.insertGuest.get(email, name, status, gender, now(), randomBytes(16).toString("hex"));
        sql.linkPhone.run(token, guest.id);
        if (noDrinks) sql.optOutOfDrinks.run(now(), guest.id);
        if (status === CANT) sql.giveBack.run(guest.id);
        else if (needSaint && !handOut(guest.id, gender, level, null)) {
          note = NONE_LEFT;
        }
        repairFinds();
      });
      return { ...getState({ token }), note };
    }
    function claim({ token, level, noDrinks } = {}) {
      token = checkToken(token);
      let note = "";
      transaction(() => {
        const guest = sql.guestByPhone.get(token);
        if (!guest || guest.status === CANT) throw new GuestError("RSVP Going or Maybe first, then get your saint.");
        if (!guest.gender) throw new GuestError("Pick male or female first.");
        const holding = sql.saintOf.get(guest.id);
        level = level || holding?.level || "Any";
        if (level !== "Any" && !LEVELS.includes(level)) throw new GuestError("Pick how bold you\u2019re feeling first.");
        if (noDrinks) sql.optOutOfDrinks.run(now(), guest.id);
        sql.giveBack.run(guest.id);
        if (!handOut(guest.id, guest.gender, level, holding?.id ?? null)) {
          if (holding && !(holding.drinks && (noDrinks || guest.no_drinks))) {
            sql.insertClaim.run(holding.id, guest.id, now());
            note = "That was the last one at this level, so you keep this saint.";
          } else note = NONE_LEFT;
        }
        repairFinds();
      });
      return { ...getState({ token }), note };
    }
    function handOut(guestId, gender, level, notId) {
      const pool = sql.pool.all(notId, notId, gender, level, level, guestId);
      if (!pool.length) return false;
      sql.insertClaim.run(chooseWeighted(pool).id, guestId, now());
      return true;
    }
    function chooseWeighted(pool) {
      const claimed = /* @__PURE__ */ new Set();
      const linkedFrom = /* @__PURE__ */ new Map();
      for (const s of sql.claimedFinds.all()) {
        claimed.add(s.id);
        for (const f of [s.find1_id, s.find2_id]) if (f !== null) linkedFrom.set(f, (linkedFrom.get(f) ?? 0) + 1);
      }
      const weights = pool.map((s) => {
        const links = (linkedFrom.get(s.id) ?? 0) + [s.find1_id, s.find2_id].filter((f) => claimed.has(f)).length;
        return 1 + handOutWeights.link * links + (s.drinks ? handOutWeights.drinks : 0);
      });
      let x = random() * weights.reduce((a, b) => a + b, 0);
      for (let i = 0; i < pool.length; i++) {
        x -= weights[i];
        if (x < 0) return pool[i];
      }
      return pool.at(-1);
    }
    function findMe({ token, email } = {}) {
      token = checkToken(token);
      email = checkEmail(email);
      if (!email) throw new GuestError("Enter the email you RSVP\u2019d with.");
      transaction(() => {
        const guest = sql.guestByEmail.get(email);
        if (!guest) throw new GuestError("No RSVP found for that email. Check the spelling, or RSVP below.");
        refuseAnotherGuestsEmail(sql.guestByPhone.get(token), guest);
        sql.linkPhone.run(token, guest.id);
      });
      return getState({ token });
    }
    function openCard({ token, card: card2 } = {}) {
      token = checkToken(token);
      transaction(() => {
        const guest = typeof card2 === "string" && card2 ? sql.guestByCardKey.get(card2) : void 0;
        if (!guest) throw new GuestError("That link doesn\u2019t open a saint card anymore. Tap \u201CAlready RSVP\u2019d? Find my saint\u201D and enter your email.");
        sql.linkPhone.run(token, guest.id);
      });
      return getState({ token });
    }
    function saveEmail({ token, email } = {}) {
      token = checkToken(token);
      email = checkEmail(email);
      if (!email) throw new GuestError("Add your email first. It can be changed but not removed.");
      transaction(() => {
        const guest = sql.guestByPhone.get(token);
        if (!guest) throw new GuestError("RSVP first, then add your email.");
        refuseAnotherGuestsEmail(guest, sql.guestByEmail.get(email));
        sql.updateEmail.run(email, now(), guest.id);
      });
      return getState({ token });
    }
    function getHostState() {
      const guests = sql.guestsWithSaints.all().map((g) => ({
        id: g.id,
        name: g.name,
        status: g.status,
        saint: g.saint ?? "",
        reminder: g.status !== CANT,
        reminderSent: !!g.reminder_sent_at
      }));
      const lists = findLists();
      const saints = sql.saintsWithHolders.all().map((s) => ({
        id: s.id,
        name: s.name,
        gender: s.gender,
        level: s.level,
        patron: s.patron,
        costume: s.costume,
        find1: s.find1_id,
        find2: s.find2_id,
        announce: s.announce,
        announceTime: s.announce_time,
        activity: s.activity,
        activityTime: s.activity_time,
        palette: s.palette,
        icon: s.icon,
        drinks: !!s.drinks,
        parked: !!s.parked,
        taken: !!s.taken,
        guest: s.guest ?? "",
        guestId: s.guest_id,
        findList: s.taken ? lists.get(s.guest_id) ?? [] : []
      }));
      return {
        invite: setting("invite_text", DEFAULT_INVITE),
        released: released(),
        counts: counts(),
        guests,
        withoutSaint: guests.filter((g) => g.status !== CANT && !g.saint).length,
        saints,
        runOfShow: runOfShow(),
        reminder: reminderState(),
        sheetImport: sheetImportState()
      };
    }
    function sheetImportState() {
      return JSON.parse(setting("sheet_import", '{"at":"","conflicts":[]}'));
    }
    function runOfShow() {
      const timed = [];
      const loose = [];
      for (const s of sql.heldSaints.all()) {
        for (const [what, details, when] of [["Announcement", s.announce, s.announce_time], ["Activity", s.activity, s.activity_time]]) {
          if (!details || !when) continue;
          const row = { when, saint: s.name, what, details, guest: s.guest };
          const minutes = clockMinutes(when);
          if (minutes === null) loose.push(row);
          else timed.push({ minutes, row });
        }
      }
      timed.sort((a, b) => a.minutes - b.minutes);
      return { timed: timed.map((t) => t.row), loose };
    }
    function findLists() {
      const lists = /* @__PURE__ */ new Map();
      for (const f of sql.allFinds.all()) {
        if (!lists.has(f.guest_id)) lists.set(f.guest_id, []);
        lists.get(f.guest_id).push(f.saint_id);
      }
      return lists;
    }
    function setFindsReleased({ released: on } = {}) {
      if (typeof on !== "boolean") throw new GuestError("Say whether to release or hide Find lists.");
      transaction(() => {
        sql.saveSetting.run("finds_released", on ? "yes" : "no");
        repairFinds();
      });
      return getHostState();
    }
    function repairFinds() {
      if (!released()) return;
      const holders = sql.holders.all();
      const saintOf = new Map(holders.map((h) => [h.guest_id, h.id]));
      const held = new Set(saintOf.values());
      const want = Math.min(FINDS_PER_GUEST, holders.length - 1);
      const stored = findLists();
      const sought = new Map([...held].map((id) => [id, 0]));
      const seek = (list, id) => {
        list.push(id);
        sought.set(id, sought.get(id) + 1);
      };
      const lists = /* @__PURE__ */ new Map();
      for (const h of holders) {
        const list = [];
        for (const id of stored.get(h.guest_id) ?? []) {
          if (list.length < want && held.has(id) && id !== h.id) seek(list, id);
        }
        lists.set(h.guest_id, list);
      }
      for (const h of holders) {
        const list = lists.get(h.guest_id);
        const fits = (id) => id !== null && held.has(id) && id !== h.id && !list.includes(id);
        for (const id of [h.find1_id, h.find2_id]) if (list.length < want && fits(id)) seek(list, id);
        if (list.length < want) {
          const others = shuffle([...held].filter(fits)).sort((a, b) => sought.get(a) - sought.get(b));
          for (const id of others.slice(0, want - list.length)) seek(list, id);
        }
      }
      if (holders.length > 2) {
        for (const lonely of held) {
          if (sought.get(lonely)) continue;
          const swap = swapFor(lonely, holders, lists, sought);
          lists.get(swap.guest)[swap.slot] = lonely;
          sought.set(swap.id, sought.get(swap.id) - 1);
          sought.set(lonely, 1);
        }
      }
      for (const h of holders) {
        const list = lists.get(h.guest_id);
        const before = stored.get(h.guest_id) ?? [];
        if (list.length === before.length && list.every((id, i) => id === before[i])) continue;
        sql.dropFinds.run(h.guest_id);
        list.forEach((id, i) => sql.insertFind.run(h.guest_id, i + 1, id));
      }
      for (const guestId of stored.keys()) if (!saintOf.has(guestId)) sql.dropFinds.run(guestId);
    }
    function swapFor(lonely, holders, lists, sought) {
      let fallback = null;
      for (const h of holders) {
        if (h.id === lonely) continue;
        const list = lists.get(h.guest_id);
        for (let slot = 0; slot < list.length; slot++) {
          const id = list[slot];
          if (sought.get(id) < 2) continue;
          const swap = { guest: h.guest_id, slot, id };
          if (id !== h.find1_id && id !== h.find2_id) return swap;
          fallback ?? (fallback = swap);
        }
      }
      return fallback;
    }
    function shuffle(list) {
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      return list;
    }
    function saveInvite({ text } = {}) {
      saveOrDrop("invite_text", hostText(text, MAX_INVITE, "That invite is too long. Keep it under 4,000 characters."));
      return getHostState();
    }
    function saveSaint(args = {}) {
      transaction(() => {
        const id = args.id == null ? null : checkSaintId(args.id);
        const saint = checkSaint(args, id);
        if (id == null) sql.insertSaint.run(saint);
        else sql.updateSaint.run({ ...saint, id });
      });
      return getHostState();
    }
    function deleteSaint({ id } = {}) {
      transaction(() => {
        checkSaintId(id);
        if (sql.isHeld.get(id)) throw new GuestError("Someone holds that saint. Free it before deleting it.");
        sql.deleteSaint.run(id);
      });
      return getHostState();
    }
    function freeSaint({ id, guestId, sure } = {}) {
      if (sure !== true) throw new GuestError("Tap again to free this saint.");
      transaction(() => {
        if (!Number.isInteger(id) || !Number.isInteger(guestId) || !sql.freeSaint.run(id, guestId).changes) {
          throw new GuestError("That guest doesn\u2019t hold that saint anymore. Reload the page.");
        }
        repairFinds();
      });
      return getHostState();
    }
    function removeGuest({ guestId, name, sure } = {}) {
      if (sure !== true) throw new GuestError("Tap again to remove this guest.");
      transaction(() => {
        if (!Number.isInteger(guestId) || !sql.deleteGuest.run(guestId, String(name ?? "")).changes) {
          throw new GuestError("That guest isn\u2019t on the list anymore. Reload the page.");
        }
        repairFinds();
      });
      return getHostState();
    }
    function checkSaintId(id) {
      if (!Number.isInteger(id) || !sql.saintById.get(id)) throw new GuestError("That saint isn\u2019t on the list anymore. Reload the page.");
      return id;
    }
    function checkSaint(a, id) {
      const text = (v, max = MAX_FIELD) => hostText(v, max, "Keep each field under " + max.toLocaleString("en-US") + " characters.");
      const name = text(a.name, MAX_NAME);
      if (!name) throw new GuestError("Give the saint a name.");
      const same = sql.saintByName.get(name);
      if (same && same.id !== id) throw new GuestError("There\u2019s already a saint called " + name + ".");
      if (!GENDERS.includes(a.gender)) throw new GuestError("Pick who the saint is for: men, women, or anyone.");
      if (!LEVELS.includes(a.level)) throw new GuestError("Pick the saint\u2019s level.");
      if (!Object.hasOwn(cards.palettes, a.palette)) throw new GuestError("Pick a palette from the list.");
      if (!Object.hasOwn(cards.icons, a.icon)) throw new GuestError("Pick an icon from the list.");
      const find = (v) => {
        if (v == null || v === "") return null;
        if (!Number.isInteger(v) || v === id || !sql.saintById.get(v)) throw new GuestError("Each find has to be another saint on the list.");
        return v;
      };
      const find1 = find(a.find1);
      const find2 = find(a.find2);
      if (find1 != null && find1 === find2) throw new GuestError("Pick two different saints to find.");
      return {
        name,
        gender: a.gender,
        level: a.level,
        patron: text(a.patron),
        costume: text(a.costume),
        find1,
        find2,
        announce: text(a.announce),
        announceTime: text(a.announceTime, MAX_TIME),
        activity: text(a.activity),
        activityTime: text(a.activityTime, MAX_TIME),
        palette: a.palette,
        icon: a.icon,
        drinks: a.drinks ? 1 : 0,
        parked: a.parked ? 1 : 0
      };
    }
    let sending = null;
    let lastFailed = 0;
    function reminderState() {
      const { signedUp, sent } = sql.reminderCounts.get();
      return {
        ...reminderText(),
        testTo: setting("reminder_test_to", ""),
        signedUp,
        sent,
        scheduledFor: setting("reminder_at", ""),
        sending: !!sending,
        failed: lastFailed
      };
    }
    function reminderText() {
      return {
        subject: setting("reminder_subject", DEFAULT_SUBJECT),
        details: setting("reminder_details", DEFAULT_DETAILS),
        replyTo: setting("reminder_reply_to", "")
      };
    }
    function saveReminder({ subject, details, replyTo } = {}) {
      const changes = [];
      if (subject !== void 0) changes.push(["reminder_subject", hostText(subject, MAX_SUBJECT, "Keep the subject under 200 characters.")]);
      if (details !== void 0) changes.push(["reminder_details", hostText(details, MAX_DETAILS, "Keep the details under 4,000 characters.")]);
      if (replyTo !== void 0) changes.push(["reminder_reply_to", checkEmail(replyTo)]);
      transaction(() => {
        for (const [key, value] of changes) saveOrDrop(key, value);
      });
      return getHostState();
    }
    async function sendTestReminder({ to } = {}) {
      to = checkEmail(to);
      if (!to) throw new GuestError("Add the address to send the test to.");
      sql.saveSetting.run("reminder_test_to", to);
      const guest = sql.testEmailGuest.get();
      const saint = guest ? sql.saintOf.get(guest.id) : sql.firstSaint.get();
      const message = reminderFor(to, guest ?? null, saint ? card(saint, guest?.id ?? null) : null, reminderText());
      message.subject = "[TEST] " + message.subject;
      try {
        await mailer.send(message);
      } catch (err) {
        console.error(err);
        throw new GuestError("The test email didn\u2019t send: " + err.message);
      }
      return { ...getHostState(), testSentTo: to };
    }
    function sendRemindersNow() {
      startSending();
      return getHostState();
    }
    function scheduleReminder({ at } = {}) {
      let time = "";
      if (at != null && at !== "") {
        const date = typeof at === "string" ? new Date(at) : /* @__PURE__ */ new Date(NaN);
        if (Number.isNaN(date.getTime())) throw new GuestError("Pick a date and time for the send.");
        if (date <= clock.now()) throw new GuestError("Pick a time in the future.");
        time = date.toISOString();
      }
      saveOrDrop("reminder_at", time);
      return getHostState();
    }
    async function sendDueReminders() {
      const at = setting("reminder_at", "");
      if (!at || new Date(at) > clock.now()) return;
      if (sending) await sending;
      const { sent, failed } = await startSending();
      console.log(`Scheduled reminder: sent ${sent}` + (failed ? `, ${failed} failed, trying them again in a minute` : "") + ".");
      if (!failed && setting("reminder_at", "") === at) sql.dropSetting.run("reminder_at");
    }
    function startSending() {
      sending ?? (sending = sendReminders().catch((err) => {
        console.error("The reminder send stopped:", err);
        return { sent: 0, failed: 1 };
      }).then((result) => {
        lastFailed = result.failed;
        return result;
      }).finally(() => {
        sending = null;
      }));
      return sending;
    }
    async function sendReminders() {
      const text = reminderText();
      let sent = 0;
      let failed = 0;
      for (const { id } of sql.unreminded.all()) {
        const at = now();
        const guest = sql.markReminded.get(at, id);
        if (!guest) continue;
        try {
          const saint = sql.saintOf.get(guest.id);
          await mailer.send(reminderFor(guest.email, guest, saint ? card(saint, guest.id) : null, text));
          sent++;
        } catch (err) {
          console.error("Reminder to guest " + guest.id + " failed:", err);
          sql.unmarkReminded.run(guest.id, at);
          failed++;
        }
      }
      return { sent, failed };
    }
    function reminderFor(to, guest, saintCard, { subject, details, replyTo }) {
      const ownCard = guest && guest.email.toLowerCase() === to.toLowerCase();
      const cardUrl = ownCard ? publicUrl + "/?card=" + guest.card_key : publicUrl;
      const email = reminderEmail({ to, guest, card: saintCard, subject, details, cardUrl, palettes: cards.palettes });
      return { from: FROM, to, ...replyTo ? { replyTo } : {}, ...email };
    }
    function saveOrDrop(key, value) {
      if (value) sql.saveSetting.run(key, value);
      else sql.dropSetting.run(key);
    }
    function resetClaims() {
      return transaction(() => {
        const { changes } = sql.giveBackAll.run();
        sql.dropAllFinds.run();
        sql.dropSetting.run("finds_released");
        return Number(changes);
      });
    }
    function importSheet({ guests, claims } = {}) {
      if (!Array.isArray(guests) || !Array.isArray(claims)) throw new GuestError("Send the Sheet\u2019s guests and claims.");
      const saintOfPhone = new Map(claims.map((c) => [String(c?.phoneId ?? "").trim(), String(c?.saint ?? "").trim()]));
      const { imported, conflicts } = transaction(() => {
        let imported2 = 0;
        const conflicts2 = [];
        for (const row of oneRowPerEmail(guests, saintOfPhone)) {
          const outcome = importRow(row, saintOfPhone);
          if (outcome.applied) imported2++;
          if (outcome.conflict) conflicts2.push(outcome.conflict);
        }
        repairFinds();
        const last = sheetImportState().conflicts;
        const fresh = conflicts2.filter((text) => !last.some((c) => c.text === text));
        const kept = [...fresh.map((text) => ({ at: now(), text })), ...last].slice(0, MAX_CONFLICTS);
        sql.saveSetting.run("sheet_import", JSON.stringify({ at: now(), conflicts: kept }));
        return { imported: imported2, conflicts: conflicts2 };
      });
      for (const c of conflicts) console.warn("Sheet import: " + c);
      return { imported, conflicts, held: sql.heldForSheet.all().map((h) => ({ ...h })) };
    }
    function importRow(row, saintOfPhone) {
      const phoneId = String(row.phoneId ?? "").trim();
      const name = String(row.name ?? "").trim().slice(0, 80);
      const status = normRsvp(row.status);
      const email = String(row.email ?? "").trim();
      if (!phoneId || !name || !status || !validEmail(email)) {
        return { conflict: `Skipped ${name || email || "a row"}: it needs a phone ID, name, RSVP and email.` };
      }
      const gender = row.gender === "Male" || row.gender === "Female" ? row.gender : "";
      const saintName = status === CANT ? "" : saintOfPhone.get(phoneId) ?? "";
      const fingerprint = JSON.stringify([name, status, email.toLowerCase(), gender, saintName.toLowerCase()]);
      const seen = sql.sheetRow.get(phoneId, email, phoneId);
      const byEmail = sql.guestByEmail.get(email);
      let guest = seen?.guest_id != null && sql.guestById.get(seen.guest_id) || byEmail;
      if (byEmail && byEmail.id !== guest.id) {
        return { conflict: `Skipped ${name}: ${email} is another Guest\u2019s email here.` };
      }
      const record = () => {
        sql.forgetSheetRow.run(phoneId, email, seen?.email ?? email);
        sql.saveSheetRow.run(phoneId, email, guest?.id ?? null, fingerprint);
        if (guest && row.reminderSentAt) sql.remindedInSheet.run(String(row.reminderSentAt), guest.id);
      };
      if (seen?.fingerprint === fingerprint || !seen && guest && !(String(row.updatedAt ?? "") > guest.updated_at)) {
        record();
        return {};
      }
      const holding = guest && sql.saintOf.get(guest.id);
      if (guest) sql.updateGuest.run(email, name, status, gender || guest.gender, now(), guest.id);
      else guest = sql.insertGuest.get(email, name, status, gender, now(), randomBytes(16).toString("hex"));
      record();
      if ((holding?.name ?? "").toLowerCase() === saintName.toLowerCase()) return { applied: true };
      sql.giveBack.run(guest.id);
      if (!saintName) return { applied: true };
      const saint = sql.saintByName.get(saintName);
      if (!saint) return { applied: true, conflict: `${name} has ${saintName} in the Sheet, which isn\u2019t on the list here, so they have no saint here.` };
      if (saint.parked) return { applied: true, conflict: `${name} has ${saintName} in the Sheet, which is Parked here, so they have no saint here.` };
      const holder = sql.holderOf.get(saint.id);
      if (holder) return { applied: true, conflict: `${name} has ${saintName} in the Sheet, but ${holder.name} holds it here, so ${name} has no saint here.` };
      sql.insertClaim.run(saint.id, guest.id, now());
      return { applied: true };
    }
    return {
      getState,
      join,
      claim,
      findMe,
      openCard,
      saveEmail,
      getHostState,
      saveInvite,
      saveSaint,
      deleteSaint,
      freeSaint,
      removeGuest,
      setFindsReleased,
      resetClaims,
      saveReminder,
      sendTestReminder,
      sendRemindersNow,
      scheduleReminder,
      sendDueReminders,
      importSheet
    };
  }
  function refuseAnotherGuestsEmail(byPhone, byEmail) {
    if (byPhone && byEmail && byPhone.id !== byEmail.id) {
      throw new GuestError("That email is already on someone else\u2019s RSVP. Check it and try again.");
    }
  }
  function hostText(v, max, tooLong) {
    v = String(v ?? "").trim();
    if (v.length > max) throw new GuestError(tooLong);
    return v;
  }
  function checkToken(token) {
    token = String(token ?? "");
    if (token.length < 8 || token.length > 100) throw new GuestError("This browser lost its place. Reload the page.");
    return token;
  }
  function validEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 200;
  }
  function checkEmail(email) {
    email = String(email ?? "").trim();
    if (email && !validEmail(email)) {
      throw new GuestError("That email doesn\u2019t look right. Check it and try again.");
    }
    return email;
  }
  function oneRowPerEmail(rows, saintOfPhone) {
    const holds = (row) => !!saintOfPhone.get(String(row.phoneId ?? "").trim());
    const byEmail = /* @__PURE__ */ new Map();
    const noEmail = [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const email = String(row.email ?? "").trim().toLowerCase();
      if (!email) noEmail.push(row);
      else if (!byEmail.has(email) || holds(row) || !holds(byEmail.get(email))) byEmail.set(email, row);
    }
    return [...byEmail.values(), ...noEmail];
  }
  function normRsvp(v) {
    const s = String(v ?? "").trim().toLowerCase().replace("\u2019", "'");
    if (s === "going") return "Going";
    if (s === "maybe") return "Maybe";
    if (s === "can't go") return CANT;
    return "";
  }
  function clockMinutes(when) {
    const m = /^(\d{1,2}):(\d{2}) ([AP]M)$/.exec(when);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 12 || Number(m[2]) > 59) return null;
    const hour = Number(m[1]) % 12 + (m[3] === "PM" ? 12 : 24);
    return hour * 60 + Number(m[2]);
  }
  function maskEmail(e) {
    const at = e.indexOf("@");
    if (at < 1) return e;
    return e.charAt(0) + "***" + e.slice(at);
  }
  function shortName(n) {
    const parts = String(n || "").trim().split(/\s+/);
    if (!parts[0]) return "Guest";
    return parts.length > 1 ? parts[0] + " " + parts[parts.length - 1].charAt(0).toUpperCase() + "." : parts[0];
  }

  // ../../saint-party/saints.csv
  var saints_default = `Saint Name,Gender,Level,Patron of,Costume,Find 1,Find 2,Announcement,Announcement time,Activity,Activity time,Card palette,Card icon,Drinks duty\r
Saint Francis,Male,Medium,animals and the environment,"Wear brown (a hoodie or bathrobe works) with a rope or belt tied at the waist, and carry a stuffed animal. Bonus: a paper bird on your shoulder.",Saint Clare of Assisi,Saint Anthony,,,"Preach a 30-second sermon to an animal, a plant, or a stuffed animal in front of at least three witnesses.",,franciscan,bird,\r
Saint Lucy,Female,Easy,the blind and people with eye trouble,"Wear white with a red sash or scarf, and carry a plate with two eyeballs on it (ping-pong balls or googly eyes). Bonus: a ring of battery candles on your head.",Saint Blaise,Saint Veronica,,,Run a round of I Spy with three people. Every clue has to be about light or eyes.,,night,eye,\r
Saint Paul,Male,Extra difficult,missionaries and writers,"A bedsheet toga or robe with a belt, and a cardboard sword. Bonus: sunglasses for after you're struck blind, and a rolled-up 'letter'.",Saint Peter,Saint Stephen,Read aloud your Letter to the Partygoers: a three-sentence epistle praising the host and lovingly correcting one guest.,9:35 PM,Get struck blind (cover your eyes) and have someone lead you all the way to the drinks.,,gold,scroll,\r
Saint Joan of Arc,Female,Extra difficult,soldiers and France,"Gray or silver clothes with tinfoil 'armor' over a shirt, and a paper banner on a stick. Bonus: hair tucked up into a short bob.",Saint Michael the Archangel,Saint Barbara,"I hear voices, and they are telling me it is time to dance.",10:25 PM,Raise an army of at least four saints and lead them in a march once around the room.,,steel,flag,\r
Saint Zita,Female,Easy,housekeepers and people who lose their keys,"An apron, a headscarf, and a broom or dustpan. Bonus: a giant ring of keys, since she's who you pray to when you lose yours.",Saint Martin de Porres,Saint Elizabeth of Hungary,,,Challenge a helper to a one-minute cleanup sprint. Whoever collects more empty cups wins.,11:50 PM,snow,brush,\r
Saint Therese of Lisieux,Female,Easy,missionaries and florists,"A brown dress or robe, a black scarf worn as a veil over a white one, and a bunch of roses (fake, real, or paper).",Saint Joan of Arc,Saint Faustina,,,"Give three people a rose (real, paper, or napkin) and tell each one something true and kind about them.",,rose,flower,\r
Saint Lawrence,Male,Extra difficult,cooks and comedians,"Any robe or long shirt, a spatula, and grill marks drawn on your cheek with eyeliner. Bonus: a ketchup bottle tucked in your belt.",Saint Elizabeth of Hungary,Saint Stephen,"Turn me over, I'm done on this side.",9:45 PM,Tell your best grilling joke to three different people. Keep score of who laughs.,,ember,flame,\r
Saint Padre Pio,Male,Medium,civil defense volunteers and teenagers,"A brown robe (bathrobe or blanket) with a rope belt, fingerless gloves with a red dot on each palm, and a cotton-ball beard.",Saint Joseph of Cupertino,Saint Francis,,,"Bilocate: get photographed on the first floor and in the basement within one minute, then show the proof.",Between 10:00 and 10:15 PM,franciscan,hand,\r
Pope Saint John Paul II,Male,Extra difficult,World Youth Day and families,"All white, a tall white paper hat (folded poster board), and a staff with a cardboard cross on top. Bonus: ski goggles, since he loved to ski.",Saint Faustina,Saint Pier Giorgio Frassati,Be not afraid! Especially of the dance floor.,11:00 PM,He played goalie as a young man. Hold a penalty shootout with a balled-up napkin and three challengers. You're in goal.,,snow,church,\r
Saint Pier Giorgio Frassati,Male,Medium,young people and mountain climbers,"A striped button-down with rolled sleeves, hiking boots, and a walking stick. Bonus: a prop pipe and a hat.",Saint Carlo Acutis,Pope Saint John Paul II,,,"He loved a good prank. Pull one harmless prank on another saint, then lead a group photo of everyone striking a summit pose.",,forest,mountain-snow,\r
Saint Gianna Molla,Female,Medium,"mothers, doctors, and unborn children","A white coat (or white button-down), a stethoscope (a toy works), and a baby doll. Bonus: a name tag that says Dr. Molla.",Saint Rita of Cascia,Our Lady of Guadalupe,,,"Give three guests a checkup (pulse, say ahh) and prescribe each of them one specific dance move.",,sky,stethoscope,\r
Saint Michael the Archangel,Male,Medium,police officers and soldiers,"Wings from cardboard or a white sheet, a cardboard sword, and a belt. Bonus: a toy snake or dragon under your foot.",Saint Joan of Arc,Saint Olaf,,,Defend the heavens: win a best-of-three thumb war against three different challengers.,,royal,sword,\r
Saint Juan Diego,Male,Medium,Indigenous peoples,"A poncho or blanket over your shoulders as your tilma, with a printed image of Our Lady of Guadalupe taped on. Bonus: roses tucked inside it for the reveal.",Our Lady of Guadalupe,Saint Kateri Tekakwitha,,,Gather roses (or anything red) from three different guests and present them to the host as your sign.,By 10:10 PM,emerald,flower-2,\r
Saint Elizabeth of Hungary,Female,Easy,bakers and charities,"A paper crown, a nice dress, and a basket of bread or rolls. Bonus: hide fake roses under the bread for her miracle.",Saint Zita,Saint Nicholas,,,"Quietly hand out snacks to five people. If anyone catches you, insist they're roses.",10:00 PM,sunflower,wheat,\r
Saint Cecelia,Female,Extra difficult,musicians,"A long dress, a flower crown, and any instrument: a recorder, toy keyboard, or ukulele. Bonus: sheet music.",Saint Hildegard of Bingen,Saint Valentine,"Musicians, assemble! The patroness of music is in the building.",10:15 PM,Recruit three people for a slow-motion air-band performance of whatever is playing. You're on air harp.,,royal,music,\r
Saint Katherine Drexel,Female,Easy,racial justice and philanthropists,"Black clothes, a black scarf as a veil, glasses, and a book. Bonus: a bag of play money, since she gave away a fortune.",Saint Martin de Porres,Mother Teresa,,,"Hand out play money to five people, each one for a good deed they did this week. Make them tell you the deed first.",,habit,graduation-cap,\r
Saint Catherine Laboure,Female,Easy,the elderly,A blue or white outfit and a big folded paper 'wings' hat (her order wore a winged white cornette). Bonus: a paper Miraculous Medal on a ribbon.,Our Lady of Sorrows,Saint Faustina,,,Pick a secret word. Award a prize to the first person who says it in conversation with you.,,marian,sparkles,\r
Blessed Fulton Sheen,Male,Extra difficult,TV and radio (unofficially),"Black clothes, a red sash and a red cape (any red fabric), a cross on a chain, and a small chalkboard. Bonus: an old-school microphone prop.",Saint Carlo Acutis,Saint Thomas Aquinas,"Good evening. Life is worth living, and so is this party.",9:25 PM,Give a 60-second TV-style talk on a topic the crowd picks. Have an assistant erase your imaginary chalkboard at the end.,Right after your announcement,crimson,mic,\r
Mother Teresa,Female,Easy,the Missionaries of Charity,"Drape a white sheet or scarf as a veil, with three blue stripes along the edge (painter's tape or a marker works). Sandals, a cardigan, and a small cross pinned at the shoulder.",Saint Katherine Drexel,Saint Therese of Lisieux,,,Find three people standing alone and pull each one into a conversation.,,sky,hand-heart,\r
Our Lady of Guadalupe,Female,Medium,the Americas and unborn children,"A teal or blue-green scarf or blanket as a mantle with gold paper stars taped on, over a pink or rose dress. Bonus: a gold paper sunburst behind you.",Saint Juan Diego,Saint Gianna Molla,,,Find Juan Diego and stage the roses-in-the-tilma reveal for the whole room.,10:10 PM,teal,star,\r
Saint Joseph,Male,Extra difficult,"fathers, carpenters, and workers","A plain robe or flannel shirt, a tool belt, and a toy hammer or saw. Bonus: a lily, his symbol.",Our Lady of Sorrows,Saint John the Baptist,"Joseph never speaks in the Gospels, so act this out in charades only: I'm the dad here, and I built this place.",10:00 PM,Build the tallest cup tower of the night with at least two helpers.,,wood,hammer,\r
Saint John the Baptist,Male,Extra difficult,"Quebec, Puerto Rico, and baptism","Rough brown or tan clothes (a burlap sack or blanket works), a belt, a staff, and a cup of water. Bonus: a honey jar.",Saint Joseph,Saint Stephen,Prepare the way! Someone even better is coming! (Then announce the next guest who walks in.),Anytime in the first hour,Eat locusts and wild honey (a pretzel dipped in honey) in front of three witnesses.,,sky,droplet,\r
Saint Veronica,Female,Easy,photographers and laundry workers,"A long dress, a headscarf, and a white cloth (a dish towel) with a face drawn on it. Bonus: a camera around your neck.",Saint Christopher,Saint Catherine of Siena,,,Photograph ten different saints tonight and show the host your veil gallery.,Before midnight,snow,camera,\r
Saint Peter,Male,Medium,fishermen and popes,"A robe or toga, two big cardboard keys, and a fishing net (a mesh produce bag). Bonus: a toy fish.",Saint Paul,Saint Zita,,,"When someone asks if you know a certain saint, deny it three times. Then have someone crow like a rooster.",,gold,key,\r
Saint Christopher,Male,Extra difficult,travelers and drivers,"A walking stick, a backpack, and a teddy bear or doll riding on your shoulder (he carried the Christ child across a river).",Saint Frances Xavier Cabrini,Saint Olaf,Need a safe ride home? Come talk to me before you leave.,11:30 PM,Be the Christ-bearer: carry someone else's drink across the room for them five separate times.,,sea,anchor,\r
Our Lady of Sorrows,Female,Medium,those who grieve,"A dark blue or black scarf as a veil over a dark dress, tears drawn with eyeliner, and a paper heart pinned on with a paper sword through it.",Saint Joseph,Saint Catherine Laboure,,,"Collect seven small complaints from guests, then turn each one into a toast.",,night,heart-crack,\r
Saint Stephen,Male,Easy,deacons and stonemasons,"A long white shirt with a sash worn diagonally (a deacon's stole), and a basket of 'stones' (balled-up gray paper). Bonus: a paper palm branch.",Saint Paul,Saint Lawrence,,,Run a paper-ball toss: three challengers try to land a balled-up napkin in a cup.,,crimson,crown,\r
Saint Anthony,Male,Extra difficult,lost things,"A brown robe and rope belt, and carry a basket of random 'lost' things: socks, keys, a TV remote. Bonus: a lily.",Saint Francis,Saint Zita,"Tony, Tony, look around. Something's lost and must be found. Bring me your lost items.",11:45 PM,"Reunite three lost items (a phone, a drink, a friend) with their owners before the night is over.",Before midnight,franciscan,search,\r
Saint Thomas Aquinas,Male,Medium,students and universities,"A white robe or shirt with a black coat over it (Dominican colors), a big book, and a bald cap. Bonus: a sun drawn on your chest, his symbol.",Saint Catherine of Siena,Blessed Fulton Sheen,,,Moderate a debate between two guests: can angels dance? Crown a winner.,10:45 PM,habit,book-open,\r
Saint Nicholas,Male,Easy,children and sailors,"A red robe or bathrobe, a paper bishop's hat, and a bag of chocolate coins. Bonus: a white beard.",Saint Valentine,"Saint Francisco, Jacinta, or Lucia",,,Leave a small surprise (a candy or coin) in three people's pockets or bags without getting caught.,Before midnight,crimson,gift,\r
Saint Valentine,Male,Medium,couples and beekeepers,"A simple robe, a bag of plastic rings to hand out, and paper hearts pinned all over. Bonus: a toy bee, since he's also patron of beekeepers.",Saint Cecelia,Saint Gianna Molla,,,Hand out plastic rings and officiate a vow of eternal friendship between two guests.,11:40 PM,rose,heart,\r
Saint Catherine of Siena,Female,Extra difficult,Italy and nurses,"A white dress or shirt with a black cardigan or scarf over it (Dominican colors), and a crown of thorns twisted from brown paper or pipe cleaners. Bonus: a lily.",Saint Thomas Aquinas,Saint Padre Pio,I once told a pope to move back to Rome. Tonight I have a strongly worded letter for the host. (Then read your one demand aloud.),9:50 PM,"Get your demand met before the night is over: a snack, a group photo, a toast in your honor, anything.",Before midnight,habit,pen-tool,\r
Saint Faustina,Female,Medium,Divine Mercy,"Black clothes, a black scarf over a white headband as a veil, and a rosary. Bonus: a printed Divine Mercy image.",Pope Saint John Paul II,Saint Therese of Lisieux,,,Hear three people confess something silly they did this week and grant each one dramatic mercy.,,sky,sunrise,\r
Saint Carlo Acutis,Male,Easy,the internet,"A red polo, jeans, sneakers, and a laptop or tablet. Bonus: a backpack and a soccer ball.",Saint John Bosco,Saint Pier Giorgio Frassati,,,"Fix one real tech problem for a guest, then beat someone at rock-paper-scissors, best of five.",,polo,laptop,\r
Saint Kateri Tekakwitha,Female,Extra difficult,ecology and the environment,"Carry a lily (real, fake, or paper) and a rosary, with a small cross made from two sticks. She's called the Lily of the Mohawks, so build the look around the lily.",Saint Juan Diego,Saint Gertrude of Nivelles,Everybody step outside with me for one minute and look at the sky.,10:50 PM,She carved crosses into trees. Make a small cross out of two straws or sticks and give it to someone.,,forest,leaf,\r
Saint Martin de Porres,Male,Easy,barbers and racial harmony,"Black and white clothes (Dominican colors), a broom, and a comb or toy scissors. Bonus: a stuffed mouse, since he befriended them.",Saint Katherine Drexel,Saint Rose of Lima,,,Give three guests a haircut consultation and recommend the perfect saint hairstyle for each. Tonsures encouraged.,,habit,scissors,\r
Saint Olaf,Male,Medium,Norway,"A fur vest or blanket, a cardboard helmet and shield, and a beard. Bonus: a paper crown, since he was a king.",Saint Michael the Archangel,Saint Christopher,,,Lead a Viking toast with at least five people. Everyone has to shout it.,11:15 PM,steel,ship,\r
"Saint Francisco, Jacinta, or Lucia",Either,Medium,shepherds and children,"A shawl or blanket, a walking stick, and a stuffed sheep. Bonus: a rosary.",Saint Michael the Archangel,Saint Catherine Laboure,,,Stage the Miracle of the Sun: get at least five people to look at one light while you narrate dramatically.,11:25 PM,sunflower,sun,\r
Saint Brigid of Kildare,Female,Extra difficult,"Ireland, dairy workers, and brewers",A green scarf or cloak and a cross folded from paper strips or straws (a Brigid's cross). Bonus: a small pitcher.,Saint Patrick,Saint Arnold of Soissons,Legend says I turned bathwater into beer. Tonight I'm on drinks. Come see me.,9:20 PM,"Drinks duty with St. Martin and St. Arnold: make sure every guest gets offered a drink, including the non-alcoholic one.",,emerald,flame,Yes\r
Saint Clare of Assisi,Female,Medium,television (she saw Mass on her wall when too sick to go),"A brown or gray hooded robe (a blanket or hoodie works) and a rope belt. Bonus: carry an old TV remote, since she's the patron saint of television.",Saint Francis,Saint Carlo Acutis,,,Be the party's live TV: pick three people and narrate what they're doing like a nature documentary for one minute.,10:20 PM,franciscan,tv,\r
Saint Rose of Lima,Female,Easy,Latin America and florists,"A crown of roses (fake flowers on a headband), and a white top with a black scarf as a veil.",Saint Martin de Porres,Saint Therese of Lisieux,,,"Hand out flowers (real, fake, or napkin roses) to five people you haven't met yet.",,crimson,flower,\r
Saint Hildegard of Bingen,Female,Medium,"musicians, writers, and herbalists","A scarf or dish towel as a veil, a sprig of herbs, and a sheet of paper with swirly 'vision' drawings. Bonus: a pen behind your ear.",Saint Cecelia,Saint Arnold of Soissons,,,She invented her own language. Teach three people a word in yours and get them to use it all night.,,forest,sprout,\r
Saint Monica,Female,Easy,mothers and patience,"A shawl, a handkerchief for her famous tears, and a rosary. She prayed 17 years for her son Augustine.",Saint Augustine,Saint Gianna Molla,,,Ask three guests what their mom would say about tonight. Report back to Augustine.,,royal,droplet,\r
Saint Teresa of Avila,Female,Extra difficult,Spain and headache sufferers,"A brown dress or robe, a black scarf as a veil, and a quill or big book. Bonus: a chess piece (she's patron of chess players).",Saint Denis,Saint Therese of Lisieux,"God save us from sour-faced saints! If you're not smiling, I'm coming for you.",10:40 PM,Find the three most serious-looking people in the room and get each one to laugh.,,wood,feather,\r
Saint Scholastica,Female,Medium,nuns and against storms,"Black clothes, a black and white scarf as a veil, and a paper dove. She was St. Benedict's twin sister.",Saint Benedict,Saint Catherine of Siena,,,She prayed up a thunderstorm so her brother couldn't leave. Find someone about to leave and get five people making rain sounds to keep them.,After 11:30 PM,habit,cloud,\r
Saint Helena,Female,Medium,archaeologists and new discoveries,"A paper crown, a nice dress or robe, and a garden trowel or big spoon. She found the True Cross.",Saint George,Saint Catherine of Alexandria,,,"Hide a small cross (two taped sticks) somewhere on the first floor or in the basement, and give hints until someone finds it.",10:00 PM,gold,shovel,\r
Saint Martha,Female,Easy,"cooks, hosts, and servers","An apron, a wooden spoon, and a toy dragon on a leash (legend says she tamed one). A sock puppet dragon works.",Saint Mary Magdalene,Saint Lawrence,,,Be the host's right hand: refill the snacks twice and introduce two strangers to each other.,,sunflower,utensils,\r
Saint Margaret of Antioch,Female,Medium,nurses and expectant mothers,"A green dress or top, a cross in hand, and a 'dragon' made from a green blanket. Legend says a dragon swallowed her and she burst out.",Saint George,Saint Martha,,,Recruit two people to be the dragon and re-enact your escape from its belly for at least five onlookers.,,emerald,cross,\r
Saint Barbara,Female,Easy,"miners, firefighters, and artillery","A paper crown or veil, and carry a tower (a paper towel tube with three windows drawn on). Bonus: a toy firefighter helmet.",Saint Joan of Arc,Saint Christopher,,,She had a third window added to her tower for the Trinity. Build a three-window tower out of cups with two helpers.,,steel,castle,\r
Saint Rita of Cascia,Female,Medium,impossible causes,"Black clothes and a scarf veil, a rose, and a paper bee on your shoulder (bees swarmed her as a baby and did her no harm).",Saint Anthony,Saint Gianna Molla,,,"Collect three 'impossible' requests from guests (a dance move, a snack, a group photo) and make at least one happen.",Before midnight,vine,flower,\r
Saint Gertrude of Nivelles,Female,Easy,cats (by popular devotion) and travelers,"Cat ears on a headband, a scarf veil, and a toy mouse.",Saint Francis,Saint Christopher,,,Collect three cat photos from guests' phones and crown the winner.,,snow,cat,\r
Saint Frances Xavier Cabrini,Female,Easy,immigrants,"A black dress or cardigan with a white collar, and a small suitcase or paper ship. She crossed the Atlantic 24 times despite her fear of water.",Saint Katherine Drexel,Saint Christopher,,,Ask five guests where their family comes from and draw them on a napkin map.,,sea,sailboat,\r
Saint Mary Magdalene,Female,Extra difficult,the first to announce the Resurrection,"A red scarf or veil, any small jar, and a red egg (a red ball works). Legend says an egg turned red in her hand to prove her story to the Emperor.",Saint Peter,Saint Martha,"I was the first to spread the good news, so here's tonight's. (Ask the host for one piece of party news, then share it.)",11:20 PM,Hand three people a red candy and tell them the red egg legend.,,crimson,egg,\r
Saint Catherine of Alexandria,Female,Extra difficult,philosophers and students,"A paper crown, a book, and a wheel (a paper plate with spokes drawn on).",Saint Thomas Aquinas,Saint Helena,I once out-argued fifty philosophers. Anyone want to try? You have until midnight.,10:05 PM,Win three friendly debates on silly questions (is a hot dog a sandwich?) and get each loser to admit it.,Before midnight,royal,ship-wheel,\r
Saint Martin of Tours,Male,Extra difficult,soldiers and winemakers,"Roman soldier: a towel or blanket cape (cut or folded in half), a cardboard helmet, and a sword. He cut his cloak in half for a beggar.",Saint Arnold of Soissons,Saint Brigid of Kildare,"I'm the patron saint of winemakers, and St. Martin's Punch is officially open.",9:10 PM,"Run the punch with St. Brigid and St. Arnold. At 10:30, give half of something (your snack, your cape) to someone.",,crimson,wine,Yes\r
Saint Arnold of Soissons,Male,Medium,brewers,"A paper bishop's hat, a robe, and a beer stein or wooden spoon (his brewing paddle).",Saint Martin of Tours,Saint Brigid of Kildare,,,Run the shandy station with St. Martin and St. Brigid. Tell three people how he got his town to drink beer instead of bad water.,10:00 PM,wood,beer,Yes\r
Saint Patrick,Male,Easy,Ireland and engineers,"Wear green, carry a staff (a broom handle), and a paper shamrock. Bonus: a toy snake you're chasing off.",Saint Brigid of Kildare,Saint Columba,,,Use a shamrock to explain any three-part thing to three people (your top three songs counts).,,emerald,clover,\r
Saint George,Male,Medium,"England, soldiers, and scouts","A white shirt with a red cross taped on, a cardboard shield, and a sword.",Saint Margaret of Antioch,Saint Michael the Archangel,,,"Stage a theatrical duel with the dragon (Margaret, Martha, or any volunteer): imaginary weapons, full sound effects, slow motion, and a dramatic death scene for whoever loses.",10:45 PM,snow,shield,\r
Saint Joseph of Cupertino,Male,Extra difficult,"pilots, astronauts, and students taking exams","A brown robe (bathrobe or blanket) with a rope belt, plus aviator goggles or paper wings. He levitated when he prayed.",Saint Padre Pio,Saint Thomas Aquinas,This is your captain speaking. We are beginning our final descent toward midnight.,11:35 PM,Stage a levitation photo: jump while someone snaps you in mid-air with onlookers pointing up in awe.,,sky,plane,\r
Saint Philip Neri,Male,Extra difficult,joy and humor,Black clothes and a cushion or small pillow tied on your head. He wore one in public (and sometimes shaved half his beard) to stay humble.,Saint Lawrence,Saint Thomas More,"I am the patron saint of joy. For the next minute, laughing is mandatory.",9:55 PM,Read a joke (from a joke book or your phone) to three people with total seriousness.,,sunflower,laugh,\r
Saint Augustine,Male,Medium,brewers and theologians,"A paper bishop's hat, a robe, a book, and a pear in your pocket (as a boy he stole pears just for the thrill).",Saint Monica,Saint Jerome,,,"Confess to three people the most harmless rule you broke as a kid, and collect theirs.",,vine,apple,\r
Saint Benedict,Male,Easy,Europe and monks,"A black robe or hoodie, a book (his Rule), and a toy or paper raven. Legend says a poisoned cup shattered when he blessed it.",Saint Scholastica,Saint Arnold of Soissons,,,Make the sign of the cross over three people's cups and confirm none of them shatter.,,habit,bell,\r
Saint Jerome,Male,Medium,librarians and translators,"A red robe (a red bathrobe works), a big book, glasses, and a stuffed lion. He was famously grumpy.",Saint Augustine,Saint Paul,,,"Be gloriously grumpy: 'translate' three things guests say into fake Latin, and dramatically correct someone's grammar.",,wood,glasses,\r
Saint Vitus,Male,Extra difficult,"dancers, actors, and comedians","A Roman tunic (a big T-shirt with a belt), sandals, and a paper or toy rooster, his symbol.",Saint Cecelia,Saint Genesius,I am the patron saint of dancers. Everyone in this room is now dancing for one song.,10:35 PM,Teach three people one dance move each.,,rose,footprints,\r
Saint Genesius,Male,Medium,actors and comedians,"A scarf with theatrical flair, and drama masks made from paper plates. He was an actor who converted on stage.",Saint Vitus,Saint Philip Neri,,,Perform a 30-second dramatic monologue about something mundane (the snack table) for at least five people.,11:05 PM,royal,drama,\r
Saint John Bosco,Male,Easy,magicians and young people,"Black clothes (a cassock look), a top hat, and a deck of cards. As a boy he did magic tricks to draw a crowd.",Saint Pier Giorgio Frassati,Saint Carlo Acutis,,,Show three people a simple magic trick (look one up beforehand).,,night,wand-sparkles,\r
Saint Denis,Male,Medium,Paris and headache sufferers,"A paper bishop's hat and robe, and carry a 'head': a pumpkin or balloon with a face drawn on. Legend says he walked and preached carrying his own head.",Saint Teresa of Avila,Saint Joan of Arc,,,"Give a 20-second sermon speaking 'through' the head you're carrying, for at least five people.",11:50 PM,night,moon,\r
Saint Columba,Male,Easy,"Ireland, Scotland, and poets","A white or brown monk's robe, a book, and a toy sea monster. He's the first person on record to see the Loch Ness monster, and he told it to back off.",Saint Patrick,Saint Brigid of Kildare,,,Draw the Loch Ness monster on a napkin and get three people to sign it as witnesses.,,sea,waves,\r
Saint Thomas More,Male,Medium,lawyers and politicians,"A dark robe, a gold chain necklace, and a book or gavel. He cracked jokes on his way to the scaffold.",Saint Catherine of Alexandria,Saint Philip Neri,,,Hold court: hear one guest's complaint about another and deliver a wise and funny ruling.,10:10 PM,gold,gavel,\r
Saint Blaise,Male,Easy,throats,"A paper bishop's hat and two candles (unlit or LED) tied in an X, like the blessing of throats.",Saint Cecelia,Saint Lucy,,,Hand out cough drops or mints to three people and bless their throats for the sing-along.,,snow,flame-kindling,\r
`;

  // ../../saint-party/public/cards.json
  var cards_default = {
    about: "Card designs: each palette is [background, ink, accent]. Icons are from the Lucide icon set (https://lucide.dev), ISC license. Unknown palettes and icons fall back to gold and sparkles.",
    palettes: {
      ember: ["#2b1a14", "#fbe9dc", "#ff7a3d"],
      rose: ["#fbeef0", "#4a1f2c", "#c2405e"],
      marian: ["#eaf1fb", "#1c2f55", "#3e6fc4"],
      teal: ["#e4f1ee", "#123d38", "#c9a227"],
      forest: ["#eef5ea", "#1f3a24", "#3f8a4c"],
      emerald: ["#e8f6ee", "#0f3a22", "#1f9d55"],
      gold: ["#fbf3df", "#3a2a10", "#b9862c"],
      habit: ["#f3f1ee", "#1f1f22", "#4c4c57"],
      franciscan: ["#f4ebdf", "#3a2a1a", "#8a5a33"],
      wood: ["#f3e9db", "#3b2614", "#a0612b"],
      crimson: ["#fbebe8", "#4a1414", "#b3261e"],
      vine: ["#f6ecf1", "#3d1430", "#7d2459"],
      sea: ["#e8f4f6", "#133a44", "#2a8aa0"],
      sky: ["#eef6ff", "#19324d", "#4b8fd6"],
      royal: ["#f2ecfa", "#2f1c4a", "#7a4fc4"],
      night: ["#1c2140", "#eef0ff", "#e7b75a"],
      steel: ["#eceff2", "#1e2833", "#5b7186"],
      snow: ["#f7fbff", "#213042", "#7fa6cf"],
      sunflower: ["#fff8dc", "#3d3200", "#d4a017"],
      polo: ["#fff5f5", "#2a1214", "#d62f3a"]
    },
    icons: {
      anchor: '<svg class="lucide lucide-anchor" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 22V8" /> <path d="M5 12H2a10 10 0 0 0 20 0h-3" /> <circle cx="12" cy="5" r="3" />',
      apple: '<svg class="lucide lucide-apple" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z" /> <path d="M10 2c1 .5 2 2 2 5" />',
      beer: '<svg class="lucide lucide-beer" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M17 11h1a3 3 0 0 1 0 6h-1" /> <path d="M9 12v6" /> <path d="M13 12v6" /> <path d="M14 7.5c-1 0-1.44.5-3 .5s-2-.5-3-.5-1.72.5-2.5.5a2.5 2.5 0 0 1 0-5c.78 0 1.57.5 2.5.5S9.44 2 11 2s2 1.5 3 1.5 1.72-.5 2.5-.5a2.5 2.5 0 0 1 0 5c-.78 0-1.5-.5-2.5-.5Z" /> <path d="M5 8v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8" />',
      bell: '<svg class="lucide lucide-bell" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /> <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />',
      bird: '<svg class="lucide lucide-bird" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M16 7h.01" /> <path d="M3.4 18H12a8 8 0 0 0 8-8V7a4 4 0 0 0-7.28-2.3L2 20" /> <path d="m20 7 2 .5-2 .5" /> <path d="M10 18v3" /> <path d="M14 17.75V21" /> <path d="M7 18a6 6 0 0 0 3.84-10.61" />',
      "book-open": '<svg class="lucide lucide-book-open" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 7v14" /> <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />',
      brush: '<svg class="lucide lucide-brush" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m9.06 11.9 8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" /> <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-2.5 1.52-2 2.02 1.08 1.1 2.49 2.02 4 2.02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />',
      camera: '<svg class="lucide lucide-camera" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z" /> <circle cx="12" cy="13" r="3" />',
      castle: '<svg class="lucide lucide-castle" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M22 20v-9H2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2Z" /> <path d="M18 11V4H6v7" /> <path d="M15 22v-4a3 3 0 0 0-3-3a3 3 0 0 0-3 3v4" /> <path d="M22 11V9" /> <path d="M2 11V9" /> <path d="M6 4V2" /> <path d="M18 4V2" /> <path d="M10 4V2" /> <path d="M14 4V2" />',
      cat: '<svg class="lucide lucide-cat" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 5c.67 0 1.35.09 2 .26 1.78-2 5.03-2.84 6.42-2.26 1.4.58-.42 7-.42 7 .57 1.07 1 2.24 1 3.44C21 17.9 16.97 21 12 21s-9-3-9-7.56c0-1.25.5-2.4 1-3.44 0 0-1.89-6.42-.5-7 1.39-.58 4.72.23 6.5 2.23A9.04 9.04 0 0 1 12 5Z" /> <path d="M8 14v.5" /> <path d="M16 14v.5" /> <path d="M11.25 16.25h1.5L12 17l-.75-.75Z" />',
      church: '<svg class="lucide lucide-church" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M10 9h4" /> <path d="M12 7v5" /> <path d="M14 22v-4a2 2 0 0 0-4 0v4" /> <path d="M18 22V5.618a1 1 0 0 0-.553-.894l-4.553-2.277a2 2 0 0 0-1.788 0L6.553 4.724A1 1 0 0 0 6 5.618V22" /> <path d="m18 7 3.447 1.724a1 1 0 0 1 .553.894V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9.618a1 1 0 0 1 .553-.894L6 7" />',
      cloud: '<svg class="lucide lucide-cloud" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z" />',
      clover: '<svg class="lucide lucide-clover" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M16.17 7.83 2 22" /> <path d="M4.02 12a2.827 2.827 0 1 1 3.81-4.17A2.827 2.827 0 1 1 12 4.02a2.827 2.827 0 1 1 4.17 3.81A2.827 2.827 0 1 1 19.98 12a2.827 2.827 0 1 1-3.81 4.17A2.827 2.827 0 1 1 12 19.98a2.827 2.827 0 1 1-4.17-3.81A1 1 0 1 1 4 12" /> <path d="m7.83 7.83 8.34 8.34" />',
      cross: '<svg class="lucide lucide-cross" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M4 9a2 2 0 0 0-2 2v2a2 2 0 0 0 2 2h4a1 1 0 0 1 1 1v4a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2v-4a1 1 0 0 1 1-1h4a2 2 0 0 0 2-2v-2a2 2 0 0 0-2-2h-4a1 1 0 0 1-1-1V4a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4a1 1 0 0 1-1 1z" />',
      crown: '<svg class="lucide lucide-crown" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M11.562 3.266a.5.5 0 0 1 .876 0L15.39 8.87a1 1 0 0 0 1.516.294L21.183 5.5a.5.5 0 0 1 .798.519l-2.834 10.246a1 1 0 0 1-.956.734H5.81a1 1 0 0 1-.957-.734L2.02 6.02a.5.5 0 0 1 .798-.519l4.276 3.664a1 1 0 0 0 1.516-.294z" /> <path d="M5 21h14" />',
      drama: '<svg class="lucide lucide-drama" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M10 11h.01" /> <path d="M14 6h.01" /> <path d="M18 6h.01" /> <path d="M6.5 13.1h.01" /> <path d="M22 5c0 9-4 12-6 12s-6-3-6-12c0-2 2-3 6-3s6 1 6 3" /> <path d="M17.4 9.9c-.8.8-2 .8-2.8 0" /> <path d="M10.1 7.1C9 7.2 7.7 7.7 6 8.6c-3.5 2-4.7 3.9-3.7 5.6 4.5 7.8 9.5 8.4 11.2 7.4.9-.5 1.9-2.1 1.9-4.7" /> <path d="M9.1 16.5c.3-1.1 1.4-1.7 2.4-1.4" />',
      droplet: '<svg class="lucide lucide-droplet" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z" />',
      egg: '<svg class="lucide lucide-egg" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 22c6.23-.05 7.87-5.57 7.5-10-.36-4.34-3.95-9.96-7.5-10-3.55.04-7.14 5.66-7.5 10-.37 4.43 1.27 9.95 7.5 10z" />',
      eye: '<svg class="lucide lucide-eye" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0" /> <circle cx="12" cy="12" r="3" />',
      feather: '<svg class="lucide lucide-feather" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12.67 19a2 2 0 0 0 1.416-.588l6.154-6.172a6 6 0 0 0-8.49-8.49L5.586 9.914A2 2 0 0 0 5 11.328V18a1 1 0 0 0 1 1z" /> <path d="M16 8 2 22" /> <path d="M17.5 15H9" />',
      flag: '<svg class="lucide lucide-flag" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" /> <line x1="4" x2="4" y1="22" y2="15" />',
      flame: '<svg class="lucide lucide-flame" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" />',
      "flame-kindling": '<svg class="lucide lucide-flame-kindling" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 2c1 3 2.5 3.5 3.5 4.5A5 5 0 0 1 17 10a5 5 0 1 1-10 0c0-.3 0-.6.1-.9a2 2 0 1 0 3.3-2C8 4.5 11 2 12 2Z" /> <path d="m5 22 14-4" /> <path d="m5 18 14 4" />',
      flower: '<svg class="lucide lucide-flower" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="12" cy="12" r="3" /> <path d="M12 16.5A4.5 4.5 0 1 1 7.5 12 4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 1 1 4.5 4.5 4.5 4.5 0 1 1-4.5 4.5" /> <path d="M12 7.5V9" /> <path d="M7.5 12H9" /> <path d="M16.5 12H15" /> <path d="M12 16.5V15" /> <path d="m8 8 1.88 1.88" /> <path d="M14.12 9.88 16 8" /> <path d="m8 16 1.88-1.88" /> <path d="M14.12 14.12 16 16" />',
      "flower-2": '<svg class="lucide lucide-flower-2" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 5a3 3 0 1 1 3 3m-3-3a3 3 0 1 0-3 3m3-3v1M9 8a3 3 0 1 0 3 3M9 8h1m5 0a3 3 0 1 1-3 3m3-3h-1m-2 3v-1" /> <circle cx="12" cy="8" r="2" /> <path d="M12 10v12" /> <path d="M12 22c4.2 0 7-1.667 7-5-4.2 0-7 1.667-7 5Z" /> <path d="M12 22c-4.2 0-7-1.667-7-5 4.2 0 7 1.667 7 5Z" />',
      footprints: '<svg class="lucide lucide-footprints" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M4 16v-2.38C4 11.5 2.97 10.5 3 8c.03-2.72 1.49-6 4.5-6C9.37 2 10 3.8 10 5.5c0 3.11-2 5.66-2 8.68V16a2 2 0 1 1-4 0Z" /> <path d="M20 20v-2.38c0-2.12 1.03-3.12 1-5.62-.03-2.72-1.49-6-4.5-6C14.63 6 14 7.8 14 9.5c0 3.11 2 5.66 2 8.68V20a2 2 0 1 0 4 0Z" /> <path d="M16 17h4" /> <path d="M4 13h4" />',
      gavel: '<svg class="lucide lucide-gavel" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8" /> <path d="m16 16 6-6" /> <path d="m8 8 6-6" /> <path d="m9 7 8 8" /> <path d="m21 11-8-8" />',
      ghost: '<svg class="lucide lucide-ghost" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M9 10h.01" /> <path d="M15 10h.01" /> <path d="M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8z" />',
      gift: '<svg class="lucide lucide-gift" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <rect x="3" y="8" width="18" height="4" rx="1" /> <path d="M12 8v13" /> <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" /> <path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5" />',
      glasses: '<svg class="lucide lucide-glasses" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="6" cy="15" r="4" /> <circle cx="18" cy="15" r="4" /> <path d="M14 15a2 2 0 0 0-2-2 2 2 0 0 0-2 2" /> <path d="M2.5 13 5 7c.7-1.3 1.4-2 3-2" /> <path d="M21.5 13 19 7c-.7-1.3-1.5-2-3-2" />',
      "graduation-cap": '<svg class="lucide lucide-graduation-cap" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z" /> <path d="M22 10v6" /> <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5" />',
      hammer: '<svg class="lucide lucide-hammer" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m15 12-8.373 8.373a1 1 0 1 1-3-3L12 9" /> <path d="m18 15 4-4" /> <path d="m21.5 11.5-1.914-1.914A2 2 0 0 1 19 8.172V7l-2.26-2.26a6 6 0 0 0-4.202-1.756L9 2.96l.92.82A6.18 6.18 0 0 1 12 8.4V10l2 2h1.172a2 2 0 0 1 1.414.586L18.5 14.5" />',
      hand: '<svg class="lucide lucide-hand" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" /> <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" /> <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" /> <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />',
      "hand-heart": '<svg class="lucide lucide-hand-heart" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M11 14h2a2 2 0 1 0 0-4h-3c-.6 0-1.1.2-1.4.6L3 16" /> <path d="m7 20 1.6-1.4c.3-.4.8-.6 1.4-.6h4c1.1 0 2.1-.4 2.8-1.2l4.6-4.4a2 2 0 0 0-2.75-2.91l-4.2 3.9" /> <path d="m2 15 6 6" /> <path d="M19.5 8.5c.7-.7 1.5-1.6 1.5-2.7A2.73 2.73 0 0 0 16 4a2.78 2.78 0 0 0-5 1.8c0 1.2.8 2 1.5 2.8L16 12Z" />',
      heart: '<svg class="lucide lucide-heart" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />',
      "heart-crack": '<svg class="lucide lucide-heart-crack" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" /> <path d="m12 13-1-1 2-2-3-3 2-2" />',
      key: '<svg class="lucide lucide-key" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" /> <path d="m21 2-9.6 9.6" /> <circle cx="7.5" cy="15.5" r="5.5" />',
      laptop: '<svg class="lucide lucide-laptop" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M20 16V7a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v9m16 0H4m16 0 1.28 2.55a1 1 0 0 1-.9 1.45H3.62a1 1 0 0 1-.9-1.45L4 16" />',
      laugh: '<svg class="lucide lucide-laugh" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="12" cy="12" r="10" /> <path d="M18 13a6 6 0 0 1-6 5 6 6 0 0 1-6-5h12Z" /> <line x1="9" x2="9.01" y1="9" y2="9" /> <line x1="15" x2="15.01" y1="9" y2="9" />',
      leaf: '<svg class="lucide lucide-leaf" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z" /> <path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12" />',
      mic: '<svg class="lucide lucide-mic" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /> <path d="M19 10v2a7 7 0 0 1-14 0v-2" /> <line x1="12" x2="12" y1="19" y2="22" />',
      moon: '<svg class="lucide lucide-moon" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />',
      "mountain-snow": '<svg class="lucide lucide-mountain-snow" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m8 3 4 8 5-5 5 15H2L8 3z" /> <path d="M4.14 15.08c2.62-1.57 5.24-1.43 7.86.42 2.74 1.94 5.49 2 8.23.19" />',
      music: '<svg class="lucide lucide-music" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M9 18V5l12-2v13" /> <circle cx="6" cy="18" r="3" /> <circle cx="18" cy="16" r="3" />',
      "pen-tool": '<svg class="lucide lucide-pen-tool" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M15.707 21.293a1 1 0 0 1-1.414 0l-1.586-1.586a1 1 0 0 1 0-1.414l5.586-5.586a1 1 0 0 1 1.414 0l1.586 1.586a1 1 0 0 1 0 1.414z" /> <path d="m18 13-1.375-6.874a1 1 0 0 0-.746-.776L3.235 2.028a1 1 0 0 0-1.207 1.207L5.35 15.879a1 1 0 0 0 .776.746L13 18" /> <path d="m2.3 2.3 7.286 7.286" /> <circle cx="11" cy="11" r="2" />',
      plane: '<svg class="lucide lucide-plane" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z" />',
      sailboat: '<svg class="lucide lucide-sailboat" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M22 18H2a4 4 0 0 0 4 4h12a4 4 0 0 0 4-4Z" /> <path d="M21 14 10 2 3 14h18Z" /> <path d="M10 2v16" />',
      scissors: '<svg class="lucide lucide-scissors" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="6" cy="6" r="3" /> <path d="M8.12 8.12 12 12" /> <path d="M20 4 8.12 15.88" /> <circle cx="6" cy="18" r="3" /> <path d="M14.8 14.8 20 20" />',
      scroll: '<svg class="lucide lucide-scroll" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M19 17V5a2 2 0 0 0-2-2H4" /> <path d="M8 21h12a2 2 0 0 0 2-2v-1a1 1 0 0 0-1-1H11a1 1 0 0 0-1 1v1a2 2 0 1 1-4 0V5a2 2 0 1 0-4 0v2a1 1 0 0 0 1 1h3" />',
      search: '<svg class="lucide lucide-search" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="11" cy="11" r="8" /> <path d="m21 21-4.3-4.3" />',
      shield: '<svg class="lucide lucide-shield" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />',
      ship: '<svg class="lucide lucide-ship" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M2 21c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1 .6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /> <path d="M19.38 20A11.6 11.6 0 0 0 21 14l-9-4-9 4c0 2.9.94 5.34 2.81 7.76" /> <path d="M19 13V7a2 2 0 0 0-2-2H7a2 2 0 0 0-2 2v6" /> <path d="M12 10v4" /> <path d="M12 2v3" />',
      "ship-wheel": '<svg class="lucide lucide-ship-wheel" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="12" cy="12" r="8" /> <path d="M12 2v7.5" /> <path d="m19 5-5.23 5.23" /> <path d="M22 12h-7.5" /> <path d="m19 19-5.23-5.23" /> <path d="M12 14.5V22" /> <path d="M10.23 13.77 5 19" /> <path d="M9.5 12H2" /> <path d="M10.23 10.23 5 5" /> <circle cx="12" cy="12" r="2.5" />',
      shovel: '<svg class="lucide lucide-shovel" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M2 22v-5l5-5 5 5-5 5z" /> <path d="M9.5 14.5 16 8" /> <path d="m17 2 5 5-.5.5a3.53 3.53 0 0 1-5 0s0 0 0 0a3.53 3.53 0 0 1 0-5L17 2" />',
      sparkles: '<svg class="lucide lucide-sparkles" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" /> <path d="M20 3v4" /> <path d="M22 5h-4" /> <path d="M4 17v2" /> <path d="M5 18H3" />',
      sprout: '<svg class="lucide lucide-sprout" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M7 20h10" /> <path d="M10 20c5.5-2.5.8-6.4 3-10" /> <path d="M9.5 9.4c1.1.8 1.8 2.2 2.3 3.7-2 .4-3.5.4-4.8-.3-1.2-.6-2.3-1.9-3-4.2 2.8-.5 4.4 0 5.5.8z" /> <path d="M14.1 6a7 7 0 0 0-1.1 4c1.9-.1 3.3-.6 4.3-1.4 1-1 1.6-2.3 1.7-4.6-2.7.1-4 1-4.9 2z" />',
      star: '<svg class="lucide lucide-star" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z" />',
      stethoscope: '<svg class="lucide lucide-stethoscope" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M11 2v2" /> <path d="M5 2v2" /> <path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1" /> <path d="M8 15a6 6 0 0 0 12 0v-3" /> <circle cx="20" cy="10" r="2" />',
      sun: '<svg class="lucide lucide-sun" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <circle cx="12" cy="12" r="4" /> <path d="M12 2v2" /> <path d="M12 20v2" /> <path d="m4.93 4.93 1.41 1.41" /> <path d="m17.66 17.66 1.41 1.41" /> <path d="M2 12h2" /> <path d="M20 12h2" /> <path d="m6.34 17.66-1.41 1.41" /> <path d="m19.07 4.93-1.41 1.41" />',
      sunrise: '<svg class="lucide lucide-sunrise" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M12 2v8" /> <path d="m4.93 10.93 1.41 1.41" /> <path d="M2 18h2" /> <path d="M20 18h2" /> <path d="m19.07 10.93-1.41 1.41" /> <path d="M22 22H2" /> <path d="m8 6 4-4 4 4" /> <path d="M16 18a4 4 0 0 0-8 0" />',
      sword: '<svg class="lucide lucide-sword" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5" /> <line x1="13" x2="19" y1="19" y2="13" /> <line x1="16" x2="20" y1="16" y2="20" /> <line x1="19" x2="21" y1="21" y2="19" />',
      tv: '<svg class="lucide lucide-tv" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <rect width="20" height="15" x="2" y="7" rx="2" ry="2" /> <polyline points="17 2 12 7 7 2" />',
      utensils: '<svg class="lucide lucide-utensils" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" /> <path d="M7 2v20" /> <path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />',
      "wand-sparkles": '<svg class="lucide lucide-wand-sparkles" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72" /> <path d="m14 7 3 3" /> <path d="M5 6v4" /> <path d="M19 14v4" /> <path d="M10 2v2" /> <path d="M7 8H3" /> <path d="M21 16h-4" /> <path d="M11 3H9" />',
      waves: '<svg class="lucide lucide-waves" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M2 6c.6.5 1.2 1 2.5 1C7 7 7 5 9.5 5c2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /> <path d="M2 12c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" /> <path d="M2 18c.6.5 1.2 1 2.5 1 2.5 0 2.5-2 5-2 2.6 0 2.4 2 5 2 2.5 0 2.5-2 5-2 1.3 0 1.9.5 2.5 1" />',
      wheat: '<svg class="lucide lucide-wheat" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M2 22 16 8" /> <path d="M3.47 12.53 5 11l1.53 1.53a3.5 3.5 0 0 1 0 4.94L5 19l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" /> <path d="M7.47 8.53 9 7l1.53 1.53a3.5 3.5 0 0 1 0 4.94L9 15l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" /> <path d="M11.47 4.53 13 3l1.53 1.53a3.5 3.5 0 0 1 0 4.94L13 11l-1.53-1.53a3.5 3.5 0 0 1 0-4.94Z" /> <path d="M20 2h2v2a4 4 0 0 1-4 4h-2V6a4 4 0 0 1 4-4Z" /> <path d="M11.47 17.47 13 19l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L5 19l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" /> <path d="M15.47 13.47 17 15l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L9 15l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" /> <path d="M19.47 9.47 21 11l-1.53 1.53a3.5 3.5 0 0 1-4.94 0L13 11l1.53-1.53a3.5 3.5 0 0 1 4.94 0Z" />',
      wine: '<svg class="lucide lucide-wine" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" > <path d="M8 22h8" /> <path d="M7 10h10" /> <path d="M12 15v7" /> <path d="M12 15a5 5 0 0 0 5-5c0-2-.5-4-2-8H9c-1.5 4-2 6-2 8a5 5 0 0 0 5 5Z" />'
    }
  };

  // entry.js
  var DBKEY = "saint-party-demo-db";
  var realFetch = window.fetch.bind(window);
  var party;
  var store;
  var ready = (async () => {
    globalThis.__SQL = await initSqlJs({ locateFile: (f) => new URL("vendor/" + f, document.baseURI).href });
    globalThis.__SAINTS_CSV = saints_default;
    try {
      const saved = localStorage.getItem(DBKEY);
      if (saved) globalThis.__SAINT_DB_BYTES = Uint8Array.from(atob(saved), (c) => c.charCodeAt(0));
    } catch (e) {
    }
    store = openStore(":memory:", {});
    const mailer = { send: async () => {
      throw new Error("Email is turned off in this demo.");
    } };
    party = createParty(store, { clock: { now: () => /* @__PURE__ */ new Date() }, publicUrl: location.origin + location.pathname, cards: cards_default, mailer });
  })();
  function persist() {
    try {
      const bytes = store.db.db.export();
      let s = "";
      for (let i = 0; i < bytes.length; i += 32768) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 32768));
      localStorage.setItem(DBKEY, btoa(s));
    } catch (e) {
    }
  }
  var json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  window.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    const path = new URL(url, location.href).pathname;
    if (path.endsWith("/cards.json")) return json(200, cards_default);
    const i = path.indexOf("/api/");
    if (i === -1) return realFetch(input, init);
    await ready;
    const name = path.slice(i + 5);
    const fn = party[name];
    if (typeof fn !== "function") return json(404, { error: "Unknown action: " + name });
    try {
      const args = init && init.body ? JSON.parse(init.body) : {};
      const out = await fn(args);
      persist();
      return json(200, out ?? {});
    } catch (err) {
      return json(400, { error: err.message || "Something went wrong." });
    }
  };
  window.saintPartyDemoReset = () => {
    try {
      localStorage.removeItem(DBKEY);
      localStorage.removeItem("saint-token");
    } catch (e) {
    }
    location.reload();
  };
})();
