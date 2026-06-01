/**
 * HERNÍ LOGIKA (běží v prohlížeči)
 * ================================
 * Načte zašifrovaný levels.json a postupně odemyká úrovně.
 * Nikde nedrží odpovědi — ověření = úspěšné AES-GCM dešifrování.
 */

const state = {
  data: null,
  branch: "zakladni", // "zakladni" | "tezka"
  index: 0,           // index aktuální úrovně v rámci větve
  current: null,      // obsah aktuální úrovně {prompt, image, hints, isLast}
  hintsShown: 0,      // kolik nápověd je odhaleno na AKTUÁLNÍ úrovni
  // Měření po částech.
  parts: {
    zakladni: { startTime: null, seconds: null, mistakes: 0, hints: 0 },
    tezka:    { startTime: null, seconds: null, mistakes: 0, hints: 0 }
  }
};

// ---- SKÓRE ----
const SCORE_BASE = 10000;       // základní balík bodů na ČÁST
const SCORE_PER_SECOND = 2;     // penalizace za sekundu
const SCORE_PER_MISTAKE = 100;  // penalizace za špatnou odpověď
const SCORE_PER_HINT = 150;     // penalizace za zobrazenou nápovědu (jen poprvé)

// Spočítá skóre jedné části. Pokud má část uzamčený čas (seconds), použije ho;
// jinak počítá živě z startTime.
function partResult(part) {
  let seconds = part.seconds;
  if (seconds === null) {
    seconds = part.startTime ? Math.floor((Date.now() - part.startTime) / 1000) : 0;
  }
  const hints = part.hints || 0;
  const raw = SCORE_BASE - seconds * SCORE_PER_SECOND
            - part.mistakes * SCORE_PER_MISTAKE
            - hints * SCORE_PER_HINT;
  return { score: Math.max(0, raw), seconds, mistakes: part.mistakes, hints };
}

// Uzamkne čas části (zastaví časomíru).
function lockPart(name) {
  const part = state.parts[name];
  if (part.seconds === null) {
    part.seconds = part.startTime ? Math.floor((Date.now() - part.startTime) / 1000) : 0;
  }
}

function formatTime(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

// Box s jedním skóre (řádek). Pro mezigratulaci po základní části.
function singleScoreHtml(name) {
  const r = partResult(state.parts[name]);
  return (
    '<div class="scorebox">' +
    '<div class="score-points">' + r.score.toLocaleString("cs-CZ") + ' bodů</div>' +
    '<div class="score-detail">Čas: ' + formatTime(r.seconds) +
    ' &nbsp;·&nbsp; Chyby: ' + r.mistakes +
    ' &nbsp;·&nbsp; Nápovědy: ' + r.hints + '</div>' +
    '</div>'
  );
}

// Slovní rank podle celkového skóre (max 20000 = 2 části po 10000).
function rankFor(total) {
  if (total >= 17000) return { title: "Velmistr šifer", note: "Naprostá špička!" };
  if (total >= 14000) return { title: "Mistr šifer", note: "Skvělý výkon!" };
  if (total >= 11000) return { title: "Zkušený luštitel", note: "Velmi dobré!" };
  if (total >= 8000)  return { title: "Šikovný detektiv", note: "Pěkná práce!" };
  if (total >= 5000)  return { title: "Učeň šifer", note: "Dobrý začátek!" };
  return { title: "Odvážný dobrodruh", note: "Hlavně že tě to bavilo!" };
}

// Celkový rozpis: základní + pokročilé + celkové + rank. Pro finále těžké části.
function totalScoreHtml() {
  const z = partResult(state.parts.zakladni);
  const t = partResult(state.parts.tezka);
  const total = z.score + t.score;
  const rank = rankFor(total);
  return (
    '<div class="scorebox">' +
    '<div class="score-line"><span>Základní úroveň</span><span>' + z.score.toLocaleString("cs-CZ") + ' b.</span></div>' +
    '<div class="score-sub">Čas ' + formatTime(z.seconds) + ' · Chyby ' + z.mistakes + ' · Nápovědy ' + z.hints + '</div>' +
    '<div class="score-line"><span>Těžká úroveň</span><span>' + t.score.toLocaleString("cs-CZ") + ' b.</span></div>' +
    '<div class="score-sub">Čas ' + formatTime(t.seconds) + ' · Chyby ' + t.mistakes + ' · Nápovědy ' + t.hints + '</div>' +
    '<div class="score-divider"></div>' +
    '<div class="score-line score-total"><span>Celkem</span><span>' + total.toLocaleString("cs-CZ") + ' b.</span></div>' +
    '<div class="score-rank">' + rank.title + '</div>' +
    '<div class="score-detail">' + rank.note + '</div>' +
    '</div>'
  );
}

// ---- UKLÁDÁNÍ POSTUPU (localStorage) ----
// Ukládáme JEN už dešifrovaný obsah dosažené úrovně, NIKDY odpovědi.
// Kdo hru nehrál, v úložišti nic použitelného nenajde.

const SAVE_KEY = "svatba_sifrovacka_v1";

function saveProgress() {
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        branch: state.branch,
        index: state.index,
        current: state.current, // obsah aktuální úrovně (už dešifrovaný)
        hintsShown: state.hintsShown,
        parts: state.parts
      })
    );
  } catch (e) {
    // localStorage může být vypnutý (privátní režim) — hra funguje dál, jen bez uložení
  }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.current || typeof s.index !== "number") return null;
    if (s.branch !== "zakladni" && s.branch !== "tezka") return null;
    // starý formát bez parts (z předchozí verze) — nepoužitelný, zahodíme
    if (!s.parts || !s.parts.zakladni || !s.parts.tezka) {
      clearProgress();
      return null;
    }
    return s;
  } catch (e) {
    return null;
  }
}

function clearProgress() {
  try { localStorage.removeItem(SAVE_KEY); } catch (e) {}
}

// ---- KRYPTO ----

function normalize(str) {
  return str
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function fromB64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function deriveKey(answer, salt, iterations) {
  const enc = new TextEncoder();
  const baseKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(normalize(answer)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
}

/**
 * Zkusí dešifrovat blok zadanou odpovědí.
 * Vrací objekt při úspěchu, null při špatné odpovědi.
 */
async function tryDecrypt(answer, block) {
  try {
    const salt = fromB64(block.salt);
    const iv = fromB64(block.iv);
    const data = fromB64(block.data);
    const key = await deriveKey(answer, salt, state.data.meta.iterations);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, data);
    return JSON.parse(new TextDecoder().decode(plain));
  } catch (e) {
    return null; // špatná odpověď = dešifrování selže
  }
}

// ---- ZVUKY (Web Audio API, bez souborů) ----
let audioCtx = null;
function ensureAudio() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); }
    catch (e) { audioCtx = null; }
  }
  return audioCtx;
}
// Zahraje sekvenci tónů. notes = [{f: frekvence, t: délka v s}, ...]
function playTones(notes) {
  const ctx = ensureAudio();
  if (!ctx) return;
  let when = ctx.currentTime;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = n.f;
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(0.25, when + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + n.t);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + n.t);
    when += n.t;
  }
}
function soundCorrect() { playTones([{ f: 660, t: 0.12 }, { f: 880, t: 0.18 }]); }
function soundWrong()   { playTones([{ f: 220, t: 0.18 }]); }
function soundFinale()  { playTones([{ f: 523, t: 0.15 }, { f: 659, t: 0.15 }, { f: 784, t: 0.15 }, { f: 1047, t: 0.3 }]); }

// ---- KONFETY (canvas, bez knihovny) ----
function launchConfetti(durationMs = 2500) {
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:100;";
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  function resize() { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
  resize();
  const colors = ["#b8924e", "#cdab6e", "#9a7838", "#6f8a5b", "#f3ece2", "#e3c889"];
  const N = 140;
  const parts = Array.from({ length: N }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.4,
    r: (4 + Math.random() * 6) * dpr,
    c: colors[(Math.random() * colors.length) | 0],
    vx: (-1 + Math.random() * 2) * dpr,
    vy: (2 + Math.random() * 3) * dpr,
    rot: Math.random() * Math.PI,
    vr: -0.1 + Math.random() * 0.2
  }));
  const start = performance.now();
  function frame(now) {
    const elapsed = now - start;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const p of parts) {
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot);
      ctx.fillStyle = p.c;
      ctx.fillRect(-p.r / 2, -p.r / 2, p.r, p.r * 0.6);
      ctx.restore();
    }
    if (elapsed < durationMs) {
      requestAnimationFrame(frame);
    } else {
      // dojezd: necháme propadnout dolů, pak odstraníme
      if (parts.some(p => p.y < canvas.height + 20)) requestAnimationFrame(frame);
      else canvas.remove();
    }
  }
  requestAnimationFrame(frame);
}

// ---- UI ----

const $ = (id) => document.getElementById(id);

function renderLevel(content) {
  state.current = content;
  $("success-box").classList.add("hidden");
  $("answer").value = "";
  $("answer").disabled = false;
  $("submit-btn").disabled = false;
  $("error").textContent = "";

  $("prompt").innerHTML = content.prompt;

  // --- NÁPOVĚDY ---
  // hintsShown se nastaví před voláním renderLevel (0 pro novou úroveň,
  // nebo obnovená hodnota po refreshi). Vykreslíme stav tlačítka i boxu.
  renderHints();

  const imgEl = $("level-image");
  if (content.image) {
    imgEl.src = content.image;
    imgEl.classList.remove("hidden");
  } else {
    imgEl.classList.add("hidden");
  }

  const num = state.index + 1;
  const total = state.data[state.branch].blocks.length + 1;
  const label = state.branch === "zakladni" ? "Základní" : "Těžká";
  $("level-label").textContent = `${label} úroveň — ${num} / ${total}`;

  // progress lišta
  $("progress-fill").style.width = (num / total * 100) + "%";

  // plynulý fade karty při každé nové úrovni
  const card = document.querySelector("#game .card");
  if (card) {
    card.classList.remove("card-fade");
    void card.offsetWidth; // restart animace
    card.classList.add("card-fade");
  }

  $("answer").focus();
}

// Vykreslí tlačítko nápovědy a box s už odhalenými nápovědami podle stavu.
function renderHints() {
  const hints = (state.current && state.current.hints) || [];
  const btn = $("hint-btn");
  const box = $("hint-box");

  // box: ukaž odhalené nápovědy
  if (state.hintsShown > 0) {
    box.innerHTML = hints
      .slice(0, state.hintsShown)
      .map((h) => '<div class="hint-item">' + h + "</div>")
      .join("");
    box.classList.remove("hidden");
  } else {
    box.innerHTML = "";
    box.classList.add("hidden");
  }

  // tlačítko: zobraz jen pokud zbývá nějaká nenápověda
  if (hints.length > 0 && state.hintsShown < hints.length) {
    const remaining = hints.length - state.hintsShown;
    btn.textContent = state.hintsShown === 0
      ? "💡 Nápověda (−" + SCORE_PER_HINT + " b.)"
      : "💡 Další nápověda (−" + SCORE_PER_HINT + " b.) · zbývá " + remaining;
    btn.classList.remove("hidden");
  } else {
    btn.classList.add("hidden");
  }
}

// Odhalí další nápovědu. Penalizuje jen poprvé (nová nápověda = nový odečet).
function showHint() {
  const hints = (state.current && state.current.hints) || [];
  if (state.hintsShown >= hints.length) return;

  const penalty = SCORE_PER_HINT;
  if (!confirm("Zobrazit nápovědu? Odečte ti to " + penalty + " bodů.")) return;

  state.hintsShown += 1;
  state.parts[state.branch].hints += 1; // penalizace (jen za nové odhalení)
  saveProgress();
  renderHints();
}

function showSuccess(text, opts = {}) {
  $("success-text").innerHTML = text;
  $("success-box").classList.remove("hidden");
  $("answer").disabled = true;
  $("submit-btn").disabled = true;
  // skryj tlačítko nápovědy (úroveň je vyřešená)
  $("hint-btn").classList.add("hidden");
  // běžná mezi-úroveň: tlačítko Pokračovat na další šifru
  $("continue-btn").classList.remove("hidden");
}

// Samostatná finální obrazovka (bez šifry). type: "basic" | "hard"
function showFinale(type, celebrate = true) {
  // skryj herní obrazovku, ukaž finále
  $("game").classList.add("hidden");
  $("intro").classList.add("hidden");
  $("finale").classList.remove("hidden");

  const actions = $("finale-actions");
  actions.innerHTML = "";

  if (type === "basic") {
    $("finale-text").innerHTML = "Dokončil/a jsi základní úroveň hry!";
    $("finale-text").style.color = "var(--green)";
    $("finale-score").innerHTML = singleScoreHtml("zakladni");

    const hard = document.createElement("button");
    hard.className = "btn-hard";
    hard.textContent = "Pokračovat na těžkou úroveň 🔥";
    hard.addEventListener("click", continueToHard);

    const share = makeShareButton();

    const quit = document.createElement("button");
    quit.className = "btn-quit";
    quit.textContent = "Ukončit hru";
    quit.addEventListener("click", endGame);

    actions.appendChild(hard);
    actions.appendChild(share);
    actions.appendChild(quit);
  } else {
    $("finale-text").innerHTML = "💍 Dokončil/a jsi celou hru!";
    $("finale-text").style.color = "var(--accent-deep)";
    $("finale-score").innerHTML = totalScoreHtml();

    const share = makeShareButton();
    actions.appendChild(share);

    const restart = document.createElement("button");
    restart.className = "btn-quit";
    restart.textContent = "↺ Hrát znovu";
    restart.addEventListener("click", restartGame);
    actions.appendChild(restart);
  }

  // oslava: konfety + fanfára (ne při obnově po refreshi)
  if (celebrate) {
    launchConfetti();
    soundFinale();
  }
}

// ---- SDÍLENÍ VÝSLEDKU ----
const GAME_URL = "https://dominikzaoral.github.io/svatba/";

function buildShareText() {
  const z = partResult(state.parts.zakladni);
  const t = partResult(state.parts.tezka);
  // pokud hráč hrál i těžkou (má uzamčený čas), uveď celkové; jinak jen základní
  const playedHard = state.parts.tezka.seconds !== null;
  let total, rankTitle;
  if (playedHard) {
    total = z.score + t.score;
    rankTitle = rankFor(total).title;
    return `Dokončil/a jsem svatební šifrovačku Jitky a Radomíra s ${total.toLocaleString("cs-CZ")} body — ${rankTitle}! Zahraj si taky: ${GAME_URL}`;
  }
  return `Zvládl/a jsem základní část svatební šifrovačky Jitky a Radomíra s ${z.score.toLocaleString("cs-CZ")} body! Zahraj si taky: ${GAME_URL}`;
}

function makeShareButton() {
  const btn = document.createElement("button");
  btn.className = "btn-go";
  btn.textContent = "📤 Pochlubit se skóre";
  btn.addEventListener("click", async () => {
    const text = buildShareText();
    try {
      if (navigator.share) {
        await navigator.share({ title: "Svatební šifrovačka", text, url: GAME_URL });
      } else {
        await navigator.clipboard.writeText(text);
        btn.textContent = "✓ Zkopírováno do schránky";
        setTimeout(() => { btn.textContent = "📤 Pochlubit se skóre"; }, 2000);
      }
    } catch (e) {
      // uživatel sdílení zrušil — nic neděláme
    }
  });
  return btn;
}

// Přechod z finální obrazovky základní hry na těžkou větev
function continueToHard() {
  $("finale").classList.add("hidden");
  $("game").classList.remove("hidden");
  startBranch("tezka");
}

async function handleSubmit() {
  const answer = $("answer").value;
  if (!answer.trim()) return;

  $("submit-btn").disabled = true;
  $("error").textContent = "Ověřuji…";

  const branch = state.data[state.branch];
  const nextIndex = state.index; // blocks[index] je zamčen odpovědí úrovně index

  // Je tohle poslední úroveň větve? Pak odpověď odemyká finalBlock.
  const isLastLevel = state.index === branch.blocks.length;

  if (isLastLevel) {
    const finale = await tryDecrypt(answer, branch.finalBlock);
    if (!finale) {
      state.parts[state.branch].mistakes += 1;
      saveProgress();
      soundWrong();
      $("error").textContent = "❌ Špatná odpověď, zkus to znovu.";
      $("submit-btn").disabled = false;
      return;
    }
    if (state.branch === "zakladni") {
      // zastav časomíru základní části (pauza do rozhodnutí pokračovat)
      lockPart("zakladni");
      state.current.finaleState = "basic";
      saveProgress();
      showFinale("basic");
    } else {
      lockPart("tezka");
      state.current.finaleState = "hard";
      saveProgress();
      showFinale("hard");
    }
    return;
  }

  // Běžná úroveň: odemkni další blok
  const next = await tryDecrypt(answer, branch.blocks[nextIndex]);
  if (!next) {
    state.parts[state.branch].mistakes += 1;
    saveProgress();
    soundWrong();
    $("error").textContent = "❌ Špatná odpověď, zkus to znovu.";
    $("submit-btn").disabled = false;
    return;
  }

  // Ulož odemčený obsah a ukaž success z právě vyřešené úrovně
  state._pendingNext = next;
  soundCorrect();
  showSuccess(next.prevSuccess, {});
}

function goNext() {
  const next = state._pendingNext;
  state._pendingNext = null;
  state.index += 1;
  state.hintsShown = 0; // nová úroveň → skryté nápovědy
  renderLevel({ prompt: next.prompt, image: next.image, hints: next.hints || [], isLast: next.isLast });
  saveProgress();
}

function startBranch(branch) {
  state.branch = branch;
  state.index = 0;
  state.hintsShown = 0;
  if (branch === "zakladni") {
    // nová hra: reset obou částí, spusť časomíru základní
    state.parts = {
      zakladni: { startTime: Date.now(), seconds: null, mistakes: 0, hints: 0 },
      tezka:    { startTime: null, seconds: null, mistakes: 0, hints: 0 }
    };
  } else if (branch === "tezka") {
    // časomíra těžké části se rozběhne TEĎ (po rozhodnutí pokračovat)
    state.parts.tezka.startTime = Date.now();
    state.parts.tezka.seconds = null;
    state.parts.tezka.mistakes = 0;
    state.parts.tezka.hints = 0;
  }
  const start = state.data[branch].start;
  renderLevel(start);
  saveProgress();
}

function endGame() {
  clearProgress();
  const html = '<div class="end">Děkujeme za hru! 💛<br>Tuhle záložku můžeš zavřít.</div>';
  $("intro").classList.add("hidden");
  $("finale").classList.add("hidden");
  $("game").classList.remove("hidden");
  $("game").innerHTML = html;
}

function restartGame() {
  // Jsme v těžké části? (hraní těžké nebo její finále) → nabídni volbu
  if (state.branch === "tezka") {
    $("restart-modal").classList.remove("hidden");
    return;
  }
  // Jinak (základní část) — rovnou dotaz a zpět na úvod
  if (!confirm("Opravdu začít znovu? Tvůj postup se ztratí a vrátíš se na úvod.")) return;
  restartToIntro();
}

// Úplný reset: zpět na úvodní obrazovku, vynuluje obě části
function restartToIntro() {
  clearProgress();
  state._pendingNext = null;
  state.index = 0;
  state.branch = "zakladni";
  state.hintsShown = 0;
  state.parts = {
    zakladni: { startTime: null, seconds: null, mistakes: 0, hints: 0 },
    tezka:    { startTime: null, seconds: null, mistakes: 0, hints: 0 }
  };
  $("game").classList.add("hidden");
  $("finale").classList.add("hidden");
  $("intro").classList.remove("hidden");
  $("start-btn").textContent = "Spustit šifrovací hru";
}

// Restart jen těžké části: skóre základní zůstává, těžká se měří znovu
function restartToHard() {
  state._pendingNext = null;
  $("finale").classList.add("hidden");
  $("game").classList.remove("hidden");
  startBranch("tezka"); // vynuluje a znovu spustí časomíru těžké části
}

// ---- INIT ----

// ---- TMAVÝ REŽIM ----
const THEME_KEY = "svatba_theme";

function loadTheme() {
  try { return localStorage.getItem(THEME_KEY) === "dark" ? "dark" : "light"; }
  catch (e) { return "light"; }
}

function applyTheme(theme) {
  if (theme === "dark") {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  const btn = $("theme-btn");
  if (btn) btn.textContent = theme === "dark" ? "☀️ Světlý režim" : "🌙 Tmavý režim";
}

function toggleTheme() {
  const next = loadTheme() === "dark" ? "light" : "dark";
  try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
  applyTheme(next);
}

async function init() {
  try {
    const res = await fetch("levels.json", { cache: "no-store" });
    state.data = await res.json();
  } catch (e) {
    $("prompt").textContent = "Nepodařilo se načíst hru (levels.json).";
    return;
  }

  $("submit-btn").addEventListener("click", handleSubmit);
  $("answer").addEventListener("keydown", (e) => {
    if (e.key === "Enter") handleSubmit();
  });
  $("continue-btn").addEventListener("click", goNext);
  $("hint-btn").addEventListener("click", showHint);
  $("restart-btn").addEventListener("click", restartGame);
  $("start-btn").addEventListener("click", startGame);

  // pravidla
  $("rules-btn").addEventListener("click", () => {
    $("intro").classList.add("hidden");
    $("rules").classList.remove("hidden");
  });
  $("rules-back").addEventListener("click", () => {
    $("rules").classList.add("hidden");
    $("intro").classList.remove("hidden");
  });

  // tmavý režim
  $("theme-btn").addEventListener("click", toggleTheme);
  applyTheme(loadTheme()); // aplikuj uložené téma a nastav text tlačítka

  // tlačítka v dialogu volby restartu (těžká část)
  $("rm-hard").addEventListener("click", () => {
    $("restart-modal").classList.add("hidden");
    restartToHard();
  });
  $("rm-full").addEventListener("click", () => {
    $("restart-modal").classList.add("hidden");
    restartToIntro();
  });
  $("rm-cancel").addEventListener("click", () => {
    $("restart-modal").classList.add("hidden");
  });

  // Pokud má hráč rozehráno, uprav text úvodního tlačítka
  if (loadProgress()) {
    $("start-btn").textContent = "Pokračovat ve hře";
  }
}

// Přepnutí z úvodní obrazovky do hry
function startGame() {
  $("intro").classList.add("hidden");
  $("game").classList.remove("hidden");

  const saved = loadProgress();
  if (saved) {
    state.branch = saved.branch;
    state.index = saved.index;
    state.hintsShown = saved.hintsShown || 0;
    if (saved.parts) state.parts = saved.parts;
    renderLevel(saved.current);
    // pokud hráč skončil na finálové obrazovce, obnov ji jako samostatnou obrazovku (bez oslavy)
    if (saved.current.finaleState === "basic") {
      showFinale("basic", false);
    } else if (saved.current.finaleState === "hard") {
      showFinale("hard", false);
    }
    return;
  }

  startBranch("zakladni");
}

init();
