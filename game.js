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
  current: null,      // obsah aktuální úrovně {prompt, image, isLast}
  // Měření po částech. Každá část: startTime, elapsed (uzamčený čas v s), mistakes.
  parts: {
    zakladni: { startTime: null, seconds: null, mistakes: 0 },
    tezka:    { startTime: null, seconds: null, mistakes: 0 }
  }
};

// ---- SKÓRE ----
const SCORE_BASE = 10000;       // základní balík bodů na ČÁST
const SCORE_PER_SECOND = 2;     // penalizace za sekundu
const SCORE_PER_MISTAKE = 100;  // penalizace za špatnou odpověď

// Spočítá skóre jedné části. Pokud má část uzamčený čas (seconds), použije ho;
// jinak počítá živě z startTime.
function partResult(part) {
  let seconds = part.seconds;
  if (seconds === null) {
    seconds = part.startTime ? Math.floor((Date.now() - part.startTime) / 1000) : 0;
  }
  const raw = SCORE_BASE - seconds * SCORE_PER_SECOND - part.mistakes * SCORE_PER_MISTAKE;
  return { score: Math.max(0, raw), seconds, mistakes: part.mistakes };
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
    ' &nbsp;·&nbsp; Chyby: ' + r.mistakes + '</div>' +
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
    '<div class="score-sub">Čas ' + formatTime(z.seconds) + ' · Chyby ' + z.mistakes + '</div>' +
    '<div class="score-line"><span>Těžká úroveň</span><span>' + t.score.toLocaleString("cs-CZ") + ' b.</span></div>' +
    '<div class="score-sub">Čas ' + formatTime(t.seconds) + ' · Chyby ' + t.mistakes + '</div>' +
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

  $("answer").focus();
}

function showSuccess(text, opts = {}) {
  $("success-text").innerHTML = text;
  $("success-box").classList.remove("hidden");
  $("answer").disabled = true;
  $("submit-btn").disabled = true;

  const choices = $("finale-choices");
  const continueBtn = $("continue-btn");

  if (opts.finaleBasic) {
    // konec základní hry: 1) ukončit 2) pokračovat na těžkou
    choices.classList.remove("hidden");
    continueBtn.classList.add("hidden");
  } else if (opts.finaleHard) {
    // úplný konec
    choices.classList.add("hidden");
    continueBtn.classList.add("hidden");
  } else {
    // běžná úroveň: tlačítko pokračuj
    choices.classList.add("hidden");
    continueBtn.classList.remove("hidden");
  }
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
      $("error").textContent = "❌ Špatná odpověď, zkus to znovu.";
      $("submit-btn").disabled = false;
      return;
    }
    if (state.branch === "zakladni") {
      // zastav časomíru základní části (pauza do rozhodnutí pokračovat)
      lockPart("zakladni");
      const text = "Dokončil/a jsi základní úroveň hry!";
      state.current.finaleState = "basic";
      state.current.finaleSuccessText = text;
      saveProgress();
      showSuccess(text + singleScoreHtml("zakladni"), { finaleBasic: true });
    } else {
      lockPart("tezka");
      const text = "💍 Dokončil/a jsi celou hru!";
      state.current.finaleState = "hard";
      state.current.finaleSuccessText = text;
      saveProgress();
      showSuccess(text + totalScoreHtml(), { finaleHard: true });
    }
    return;
  }

  // Běžná úroveň: odemkni další blok
  const next = await tryDecrypt(answer, branch.blocks[nextIndex]);
  if (!next) {
    state.parts[state.branch].mistakes += 1;
    saveProgress();
    $("error").textContent = "❌ Špatná odpověď, zkus to znovu.";
    $("submit-btn").disabled = false;
    return;
  }

  // Ulož odemčený obsah a ukaž success z právě vyřešené úrovně
  state._pendingNext = next;
  showSuccess(next.prevSuccess, {});
}

function goNext() {
  const next = state._pendingNext;
  state._pendingNext = null;
  state.index += 1;
  renderLevel({ prompt: next.prompt, image: next.image, isLast: next.isLast });
  saveProgress();
}

function startBranch(branch) {
  state.branch = branch;
  state.index = 0;
  if (branch === "zakladni") {
    // nová hra: reset obou částí, spusť časomíru základní
    state.parts = {
      zakladni: { startTime: Date.now(), seconds: null, mistakes: 0 },
      tezka:    { startTime: null, seconds: null, mistakes: 0 }
    };
  } else if (branch === "tezka") {
    // časomíra těžké části se rozběhne TEĎ (po rozhodnutí pokračovat)
    state.parts.tezka.startTime = Date.now();
    state.parts.tezka.seconds = null;
    state.parts.tezka.mistakes = 0;
  }
  const start = state.data[branch].start;
  renderLevel(start);
  saveProgress();
}

function endGame() {
  clearProgress();
  $("game").innerHTML =
    '<div class="end">Děkujeme za hru! 💛<br>Tuhle záložku můžeš zavřít.</div>';
}

function restartGame() {
  if (!confirm("Opravdu začít znovu? Tvůj postup se ztratí a vrátíš se na úvod.")) return;
  clearProgress();
  state._pendingNext = null;
  state.index = 0;
  state.branch = "zakladni";
  state.parts = {
    zakladni: { startTime: null, seconds: null, mistakes: 0 },
    tezka:    { startTime: null, seconds: null, mistakes: 0 }
  };
  // zpět na úvodní obrazovku
  $("game").classList.add("hidden");
  $("intro").classList.remove("hidden");
  $("start-btn").textContent = "Spustit šifrovací hru";
}

// ---- INIT ----

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
  $("hard-btn").addEventListener("click", () => startBranch("tezka"));
  $("quit-btn").addEventListener("click", endGame);
  $("restart-btn").addEventListener("click", restartGame);
  $("start-btn").addEventListener("click", startGame);

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
    if (saved.parts) state.parts = saved.parts;
    renderLevel(saved.current);
    // pokud hráč skončil na finálové obrazovce, obnov ji i se skóre
    if (saved.current.finaleState === "basic") {
      showSuccess(saved.current.finaleSuccessText + singleScoreHtml("zakladni"), { finaleBasic: true });
    } else if (saved.current.finaleState === "hard") {
      showSuccess(saved.current.finaleSuccessText + totalScoreHtml(), { finaleHard: true });
    }
    return;
  }

  startBranch("zakladni");
}

init();
