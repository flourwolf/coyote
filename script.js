/* =========================================================
   コヨーテ Web版 — 共通シードによる決定論的配札 + Firebaseによる
   手番・×(ライフ)の複数端末同期
   ========================================================= */

const APP_VERSION = "2.0.0";

/* ---------------------------------------------------------
   Firebase 設定
   ---------------------------------------------------------
   下記を自分のFirebaseプロジェクトの値に書き換えてください。
   Firebase Console → プロジェクトの設定 → 全般 → 「アプリを追加」(Web)
   で表示される設定値をそのまま貼り付ければ動きます。
   apiKey が "YOUR_API_KEY" のままの場合は、自動的にこの端末内だけの
   ローカルモードで動作します（他の端末とは同期されません）。
------------------------------------------------------------ */
const FIREBASE_CONFIG = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  databaseURL: "https://YOUR_PROJECT-default-rtdb.firebaseio.com",
  projectId: "YOUR_PROJECT",
};

function isFirebaseConfigured() {
  return FIREBASE_CONFIG.apiKey && FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}

const LIVES_TO_ELIMINATE = 2; // 公式ルール準拠(2つで脱落)

/* ---------- 決定論的な乱数生成（シード文字列 → PRNG） ---------- */

function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return function () {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

function mulberry32(seed) {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seedString) {
  const seedFn = xmur3(String(seedString));
  return mulberry32(seedFn());
}

function seededShuffle(array, rng) {
  const a = array.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ---------- 基本デッキ + 特殊カード ---------- */

function buildDeck() {
  const numberCounts = {
    "-10": 1, "-5": 2, "0": 4, "1": 4, "2": 4,
    "3": 4, "4": 4, "5": 4, "10": 3, "15": 2, "20": 1
  };
  const deck = [];
  for (const [v, n] of Object.entries(numberCounts)) {
    for (let i = 0; i < n; i++) {
      deck.push({ kind: "number", value: Number(v), display: String(v) });
    }
  }
  deck.push({ kind: "x2", display: "×2", icon: "👑", label: "酋長" });
  deck.push({ kind: "max0", display: "MAX→0", icon: "🦊", label: "キツネ" });
  deck.push({ kind: "unknown", display: "？", icon: "🕳️", label: "ほらあな" });
  return deck;
}

/* ---------- ラウンドの解決（配札 + 合計値の計算） ---------- */

function resolveRound(seed, names) {
  const rng = makeRng(`coyote:${seed}`);
  const deck = seededShuffle(buildDeck(), rng);
  if (names.length > deck.length) {
    throw new Error("人数が多すぎます（デッキの上限を超えています）");
  }

  const hands = {};
  names.forEach((name, i) => { hands[name] = deck[i]; });

  const cards = Object.values(hands);
  const numberCards = cards.filter((c) => c.kind === "number");

  let sum = numberCards.reduce((a, c) => a + c.value, 0);
  const notes = [];

  const hasMax0 = cards.some((c) => c.kind === "max0");
  if (hasMax0 && numberCards.length) {
    const maxVal = Math.max(...numberCards.map((c) => c.value));
    sum -= maxVal;
    notes.push(`🦊 キツネの効果で最大値(${maxVal})を1枚だけ0として扱いました`);
  }

  const hasX2 = cards.some((c) => c.kind === "x2");
  if (hasX2) {
    sum *= 2;
    notes.push("👑 酋長の効果で数字カードの合計を2倍にしました");
  }

  const hasUnknown = cards.some((c) => c.kind === "unknown");
  if (hasUnknown) {
    const drawnCard = deck[names.length] || null;
    if (drawnCard) {
      const v = drawnCard.kind === "number" ? drawnCard.value : 0;
      sum += v;
      notes.push(`🕳️ ほらあなの効果で山札から引いたカード(${drawnCard.display})の${v}を加算しました`);
    } else {
      notes.push("🕳️ ほらあなの効果を適用しようとしましたが、山札に残りがありませんでした");
    }
  }

  return { hands, total: sum, notes };
}

/* ---------- 手番順（シードから決定論的に、Firebase不要で全端末一致） ---------- */

function computeTurnOrder(seed, names) {
  const rng = makeRng(`order:${seed}`);
  return seededShuffle(names, rng);
}

// turnOrder上で startIndex から direction 方向に探索し、脱落していない最初のプレイヤーの
// インデックスを返す（全員脱落した場合は startIndex を返す＝異常系のフォールバック）
function nextActiveIndex(turnOrder, lives, startIndex, direction = 1) {
  const n = turnOrder.length;
  for (let step = 0; step < n; step++) {
    const idx = ((startIndex + step * direction) % n + n) % n;
    const name = turnOrder[idx];
    if ((lives[name] || 0) < LIVES_TO_ELIMINATE) return idx;
  }
  return startIndex;
}

/* ---------------------------------------------------------
   状態ストア：×の数(lives)・ラウンド(round)を複数端末で共有する。
   Firebaseが設定されていればFirebase Realtime Databaseを、
   未設定ならこの端末内のlocalStorageのみを使う。
   （手番順は固定なので同期対象に含めない。「前の人」は常に
   　自分の一つ前の順番のプレイヤーとして計算できるため）
------------------------------------------------------------ */

function initialState(turnOrder) {
  return {
    lives: Object.fromEntries(turnOrder.map((n) => [n, 0])),
    round: 1,
    lastResult: null,
  };
}

async function createStore(seed, turnOrder) {
  if (isFirebaseConfigured()) {
    try {
      const { initializeApp } = await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js");
      const { getDatabase, ref, update, onValue, runTransaction } =
        await import("https://www.gstatic.com/firebasejs/10.13.0/firebase-database.js");

      const app = initializeApp(FIREBASE_CONFIG);
      const db = getDatabase(app);
      const roomRef = ref(db, `games/${seed}`);

      // 部屋が存在しなければ初期化する（複数端末が同時に開いても壊れないようトランザクションで実行）
      await runTransaction(roomRef, (current) => current || initialState(turnOrder));

      return {
        mode: "firebase",
        subscribe(cb) {
          const unsub = onValue(roomRef, (snap) => {
            const val = snap.val();
            if (val) cb(val);
          });
          return unsub;
        },
        async commit(updates) {
          await update(roomRef, updates);
        },
      };
    } catch (e) {
      console.error("Firebase接続に失敗したため、ローカルモードで続行します。", e);
    }
  }
  return createLocalStore(seed, turnOrder);
}

function createLocalStore(seed, turnOrder) {
  const key = `coyote:state:${seed}`;
  const listeners = new Set();

  function load() {
    const raw = localStorage.getItem(key);
    if (raw) {
      try { return JSON.parse(raw); } catch { /* fallthrough */ }
    }
    const initial = initialState(turnOrder);
    localStorage.setItem(key, JSON.stringify(initial));
    return initial;
  }

  function notifyAll(state) {
    listeners.forEach((cb) => cb(state));
  }

  const storageHandler = (e) => {
    if (e.key === key) notifyAll(load());
  };
  window.addEventListener("storage", storageHandler);

  return {
    mode: "local",
    subscribe(cb) {
      listeners.add(cb);
      cb(load());
      return () => listeners.delete(cb);
    },
    async commit(updates) {
      const merged = { ...load(), ...updates };
      localStorage.setItem(key, JSON.stringify(merged));
      notifyAll(merged);
    },
  };
}

/* ---------- URL 状態の読み書き ---------- */

function encodeState(seed, names) {
  const params = new URLSearchParams();
  params.set("seed", seed);
  params.set("names", names.join(","));
  return `${location.origin}${location.pathname}#play?${params.toString()}`;
}

function parseHash() {
  const hash = location.hash.replace(/^#/, "");
  if (!hash.startsWith("play")) return null;
  const query = hash.split("?")[1] || "";
  const params = new URLSearchParams(query);
  const seed = params.get("seed");
  const namesRaw = params.get("names");
  if (!seed || !namesRaw) return null;
  const names = namesRaw.split(",").map((n) => n.trim()).filter(Boolean);
  if (names.length < 2) return null;
  return { seed, names };
}

function storageKey(seed) {
  return `coyote:who:${seed}`;
}

/* ---------- 描画ヘルパー ---------- */

const app = document.getElementById("app");

function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") el.className = v;
    else if (k.startsWith("on") && typeof v === "function") {
      el.addEventListener(k.slice(2), v);
    } else if (k === "html") {
      el.innerHTML = v;
    } else {
      el.setAttribute(k, v);
    }
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c == null) return;
    el.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  });
  return el;
}

function brandHeader(sub) {
  return h("div", { class: "brand" }, [
    h("h1", { class: "display" }, "コヨーテ"),
    h("div", { class: "sub" }, sub || "焚き火を囲んで、嘘と駆け引きを。"),
  ]);
}

function footerNote(mode) {
  const syncLabel =
    mode === "firebase" ? "端末間で同期中"
    : mode === "local" ? "この端末のみ（同期なし）"
    : "";
  return h("div", { class: "footer-note" }, [
    document.createTextNode(`コヨーテ Web版 v${APP_VERSION} ／ 数字の宣言は口頭で行ってください。${syncLabel ? " ／ 手番・×: " + syncLabel : ""}`),
  ]);
}

/* ---------- 画面 1: セットアップ（人数・名前・シード） ---------- */

function renderSetup() {
  app.innerHTML = "";
  let playerCount = 4;
  let names = Array.from({ length: playerCount }, () => "");
  let seed = Math.random().toString(36).slice(2, 8);

  const panel = h("div", { class: "card-panel" });

  function renderNameFields() {
    const container = panel.querySelector(".name-fields");
    container.innerHTML = "";
    for (let i = 0; i < playerCount; i++) {
      const input = h("input", {
        type: "text",
        placeholder: `プレイヤー${i + 1}の名前`,
        value: names[i] || "",
        oninput: (e) => (names[i] = e.target.value),
      });
      container.appendChild(
        h("div", { class: "name-row" }, [
          h("div", { class: "num" }, String(i + 1)),
          input,
        ])
      );
    }
  }

  const countField = h("div", { class: "field" }, [
    h("label", {}, "参加人数（3〜10人）"),
    h("input", {
      type: "number",
      min: "3",
      max: "10",
      value: String(playerCount),
      oninput: (e) => {
        let v = Math.max(3, Math.min(10, Number(e.target.value) || 3));
        playerCount = v;
        if (names.length < v) {
          names = names.concat(Array.from({ length: v - names.length }, () => ""));
        } else {
          names = names.slice(0, v);
        }
        renderNameFields();
      },
    }),
  ]);

  const nameFieldsWrap = h("div", { class: "field name-fields" });

  const seedInput = h("input", {
    type: "text",
    value: seed,
    oninput: (e) => (seed = e.target.value),
  });

  const seedField = h("div", { class: "field" }, [
    h("label", {}, "共通シード値（全員に同じ値を配ります）"),
    h("div", { class: "seed-row" }, [
      seedInput,
      h("button", {
        class: "btn btn-ghost btn-small",
        onclick: () => {
          seed = Math.random().toString(36).slice(2, 8);
          seedInput.value = seed;
        },
      }, "再生成"),
    ]),
    h("div", { class: "helper" }, "このシード値が同じなら、誰の端末でも同じ配札・同じ手番順になります。"),
  ]);

  const errorSlot = h("div", {});

  const submitBtn = h("button", { class: "btn btn-primary" }, "URLを作成する");
  submitBtn.addEventListener("click", () => {
    errorSlot.innerHTML = "";
    const cleaned = names.map((n) => n.trim());
    if (cleaned.some((n) => !n)) {
      errorSlot.appendChild(h("div", { class: "error-box" }, "すべてのプレイヤーの名前を入力してください。"));
      return;
    }
    if (new Set(cleaned).size !== cleaned.length) {
      errorSlot.appendChild(h("div", { class: "error-box" }, "名前が重複しています。別々の名前にしてください。"));
      return;
    }
    if (!seed.trim()) {
      errorSlot.appendChild(h("div", { class: "error-box" }, "シード値を入力してください。"));
      return;
    }
    renderLinks(seed.trim(), cleaned);
  });

  panel.appendChild(h("h3", {}, "ゲームを作る"));
  panel.appendChild(h("div", { class: "helper" }, "人数・名前・共通シード値を決めて、参加者用のURLを発行します。手番順もこのシードから自動で決まります。"));
  panel.appendChild(h("div", { class: "divider" }));
  panel.appendChild(countField);
  panel.appendChild(nameFieldsWrap);
  panel.appendChild(seedField);
  panel.appendChild(errorSlot);
  panel.appendChild(submitBtn);

  app.appendChild(brandHeader());
  app.appendChild(panel);
  app.appendChild(footerNote());

  renderNameFields();
}

/* ---------- 画面 2: URL発行結果 ---------- */

function renderLinks(seed, names) {
  app.innerHTML = "";
  const url = encodeState(seed, names);
  const order = computeTurnOrder(seed, names);

  const panel = h("div", { class: "card-panel" });
  panel.appendChild(h("h3", {}, "URLができました"));
  panel.appendChild(h("div", { class: "helper" }, "このURLを全員に配ってください。同じURLを開いて、各自の名前をタップすればゲームが始まります。"));
  panel.appendChild(h("div", { class: "divider" }));
  panel.appendChild(h("div", { class: "url-box" }, url));

  const copyBtn = h("button", { class: "btn btn-ghost btn-small" }, "URLをコピー");
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(url);
      copyBtn.textContent = "コピーしました";
      setTimeout(() => (copyBtn.textContent = "URLをコピー"), 1500);
    } catch {
      copyBtn.textContent = "コピーできませんでした";
    }
  });
  panel.appendChild(copyBtn);

  const openBtn = h("button", { class: "btn btn-primary", style: "margin-top:12px;" }, "このURLで開始する");
  openBtn.addEventListener("click", () => {
    location.hash = url.split("#")[1];
    route();
  });
  panel.appendChild(openBtn);

  const orderPanel = h("div", { class: "card-panel" });
  orderPanel.appendChild(h("h3", {}, "手番順（このシードから自動決定）"));
  const orderList = h("div", { class: "link-list" });
  order.forEach((n, i) => {
    orderList.appendChild(
      h("div", { class: "link-item" }, [
        h("span", { class: "name" }, `${i + 1}. ${n}`),
      ])
    );
  });
  orderPanel.appendChild(orderList);
  orderPanel.appendChild(h("div", { class: "helper" }, "この順番は全員の端末で自動的に一致します。ゲーム画面でも確認できます。"));

  const backBtn = h("button", { class: "btn btn-ghost", style: "margin-top:16px;" }, "設定に戻る");
  backBtn.addEventListener("click", renderSetup);

  app.appendChild(brandHeader());
  app.appendChild(panel);
  app.appendChild(orderPanel);
  app.appendChild(backBtn);
  app.appendChild(footerNote());
}

/* ---------- 画面 3: 自分が誰かを選ぶ ---------- */

function renderPick(seed, names) {
  app.innerHTML = "";
  const panel = h("div", { class: "card-panel" });
  panel.appendChild(h("h3", {}, "あなたは誰ですか？"));
  panel.appendChild(h("div", { class: "helper" }, "自分の名前をタップしてください。この端末では次回から自動で選ばれます。"));
  panel.appendChild(h("div", { class: "divider" }));

  const grid = h("div", { class: "pick-grid" });
  names.forEach((name) => {
    const btn = h("button", { class: "pick-btn" }, name);
    btn.addEventListener("click", () => {
      sessionStorage.setItem(storageKey(seed), name);
      renderGame(seed, names, name);
    });
    grid.appendChild(btn);
  });
  panel.appendChild(grid);

  app.appendChild(brandHeader("参加者を選んでください"));
  app.appendChild(panel);
  app.appendChild(footerNote());
}

/* ---------- 画面 4: ゲーム盤面 ---------- */

async function renderGame(seed, names, self) {
  app.innerHTML = "";
  app.appendChild(brandHeader("同期しています…"));

  let round;
  try {
    round = resolveRound(seed, names);
  } catch (e) {
    app.innerHTML = "";
    app.appendChild(brandHeader());
    app.appendChild(h("div", { class: "error-box" }, e.message));
    return;
  }
  const { hands, total, notes } = round;
  const turnOrder = computeTurnOrder(seed, names);

  const store = await createStore(seed, turnOrder);

  let state = null;
  let awaitingOutcome = false; // コヨーテ判定中（前の人 or 自分、どちらの負けか選ぶ待ち）のローカルUI状態

  store.subscribe((s) => {
    state = s;
    renderBoard();
  });

  const selfIndex = turnOrder.indexOf(self);

  function previousActiveName() {
    if (!state) return null;
    const prevIdx = nextActiveIndex(turnOrder, state.lives, selfIndex - 1, -1);
    return turnOrder[prevIdx];
  }

  function applyLoss(loserName, resultLabel) {
    const lives = { ...state.lives, [loserName]: (state.lives[loserName] || 0) + 1 };
    const eliminatedNow = lives[loserName] >= LIVES_TO_ELIMINATE;
    store.commit({
      lives,
      round: (state.round || 1) + 1,
      lastResult: {
        loser: loserName,
        total,
        label: resultLabel,
        eliminated: eliminatedNow,
        ts: Date.now(),
      },
    });
    awaitingOutcome = false;
  }

  function renderBoard() {
    app.innerHTML = "";

    // ---- 手番・ライフ パネル ----
    const turnPanel = h("div", { class: "card-panel turn-panel" });
    const turnHeader = h("div", { class: "turn-header" }, [
      h("span", {}, `ラウンド ${state.round}`),
      h("span", { class: "turn-current" }, "手番順(参考)"),
    ]);
    turnPanel.appendChild(turnHeader);

    const chipRow = h("div", { class: "chip-row" });
    turnOrder.forEach((name) => {
      const livesCount = state.lives[name] || 0;
      const eliminated = livesCount >= LIVES_TO_ELIMINATE;
      const isSelf = name === self;
      const chip = h("div", {
        class: `chip ${isSelf ? "chip-active" : ""} ${eliminated ? "chip-eliminated" : ""}`,
      }, [
        h("div", { class: "chip-name" }, name + (isSelf ? "（あなた）" : "")),
        h("div", { class: "chip-x" }, "×".repeat(livesCount) || "―"),
      ]);
      chipRow.appendChild(chip);
    });
    turnPanel.appendChild(chipRow);

    if (state.lastResult) {
      const r = state.lastResult;
      turnPanel.appendChild(
        h("div", { class: "last-result" },
          `前ラウンド: 合計${r.total} → ${r.label}(${r.loser}に×${r.eliminated ? "・脱落" : ""})`
        )
      );
    }
    app.appendChild(brandHeader(`このラウンドの参加者: ${names.join(" / ")}`));
    app.appendChild(turnPanel);

    // ---- カード盤面 ----
    const wrap = h("div", { class: "table-wrap" });

    const ring = h("div", { class: "others-ring" });
    names.filter((n) => n !== self).forEach((name) => {
      const card = hands[name];
      const isSpecial = card.kind !== "number";
      const eliminated = (state.lives[name] || 0) >= LIVES_TO_ELIMINATE;
      ring.appendChild(
        h("div", { class: `card ${isSpecial ? "card-special" : ""} ${eliminated ? "card-eliminated" : ""}` }, [
          isSpecial ? h("div", { class: "icon" }, card.icon) : null,
          h("div", { class: "value" }, card.display),
          h("div", { class: "owner" }, name),
        ])
      );
    });
    wrap.appendChild(ring);

    wrap.appendChild(h("div", { class: "fire" }, "🔥"));
    wrap.appendChild(h("div", { class: "self-card" }, [h("div", { class: "mark" }, "?")]));
    wrap.appendChild(
      h("div", { class: "self-label" }, `あなた（${self}）のカードは見えません`)
    );

    // ---- 操作パネル ----
    const controls = h("div", { class: "reveal-box" });

    const coyoteBtn = h("button", { class: "btn btn-coyote" }, "🐺 コヨーテ！（合計を見る）");
    const outcomeSlot = h("div", { class: "outcome-slot" });

    coyoteBtn.addEventListener("click", () => {
      awaitingOutcome = true;
      coyoteBtn.disabled = true;

      outcomeSlot.innerHTML = "";
      outcomeSlot.appendChild(
        h("div", { class: "total-result" }, [
          h("div", { class: "value" }, String(total)),
          h("div", { class: "label" }, "本当の合計値"),
        ])
      );
      if (notes.length) {
        const notesBox = h("div", { class: "notes-box" });
        notes.forEach((n) => notesBox.appendChild(h("div", { class: "note-line" }, n)));
        outcomeSlot.appendChild(notesBox);
      }

      const prevName = previousActiveName();
      const outcomeButtons = h("div", { class: "outcome-buttons" });

      const overBtn = h("button", { class: "btn btn-danger" },
        `前の宣言が超えていた → ${prevName || "前の人"}の負け`
      );
      overBtn.addEventListener("click", () => applyLoss(prevName, "前の宣言オーバー"));

      const notOverBtn = h("button", { class: "btn btn-danger" },
        `超えていない・同じ → 自分（${self}）の負け`
      );
      notOverBtn.addEventListener("click", () => applyLoss(self, "コヨーテ失敗"));

      outcomeButtons.appendChild(overBtn);
      outcomeButtons.appendChild(notOverBtn);
      outcomeSlot.appendChild(outcomeButtons);
    });

    controls.appendChild(coyoteBtn);
    controls.appendChild(coyoteBtn);
    controls.appendChild(h("div", { class: "helper" }, "前の宣言を疑ったら「コヨーテ！」を押してください。数字の宣言自体は口頭で行います。"));
    controls.appendChild(outcomeSlot);
    wrap.appendChild(controls);

    const switchBtn = h("button", { class: "btn btn-ghost btn-small", style: "margin-top:8px;" }, "自分を選び直す");
    switchBtn.addEventListener("click", () => {
      sessionStorage.removeItem(storageKey(seed));
      renderPick(seed, names);
    });

    app.appendChild(wrap);
    app.appendChild(switchBtn);

    if (!isFirebaseConfigured()) {
      app.appendChild(
        h("div", { class: "error-box" }, "Firebase未設定のため、手番と×はこの端末内でのみ表示されています(他の端末とは共有されません)。設定方法はREADMEを参照してください。")
      );
    }

    app.appendChild(footerNote(store.mode));
  }
}

/* ---------- ルーティング ---------- */

function route() {
  const state = parseHash();
  if (!state) {
    renderSetup();
    return;
  }
  const { seed, names } = state;
  const remembered = sessionStorage.getItem(storageKey(seed));
  if (remembered && names.includes(remembered)) {
    renderGame(seed, names, remembered);
  } else {
    renderPick(seed, names);
  }
}

window.addEventListener("hashchange", route);
window.addEventListener("DOMContentLoaded", route);
