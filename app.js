"use strict";

// ---------- Constants ----------

const ON_COURT = 5;
const MIN_PLAYERS = 5;
const MAX_PLAYERS = 20;
const DEFAULT_PLAYERS = 7;
const MIN_INTERVAL = 10;
const MAX_INTERVAL = 99 * 60;
const FLASH_MS = 8000;
const MESSAGE_MS = 3000;
const LONG_PRESS_MS = 220;

const BLACK = 0;
const COLOR = 1;

const TEAM_COLORS = [
  ["ORANGE", "#f57314"],
  ["RED", "#d11f26"],
  ["BLUE", "#1f61d9"],
  ["GREEN", "#1a9947"],
  ["YELLOW", "#fad11a"],
  ["PURPLE", "#8038b8"],
  ["WHITE", "#f2f2f2"],
];

// ---------- State (nothing is persisted; every visit starts fresh) ----------

const state = {
  intervalSeconds: 300,
  colorIndex: 0,
  teams: [makeTeam(), makeTeam()],
  running: false,
  paused: false,
  endAt: 0,             // ms timestamp when the current timer ends
  pausedRemaining: 0,   // ms left while paused
  flashUntil: 0,
  steps: [],            // per timer end: { at, skipped, swaps }, feeds HISTORY and lets BACK undo
  lastShownSecond: -1,
};

function defaultName(index) {
  return `Player ${index + 1}`;
}

function makeTeam() {
  const names = [];
  for (let i = 0; i < DEFAULT_PLAYERS; i++) names.push(defaultName(i));
  // names: first five are on court (next out first), the rest is the bench (next in first).
  // history: swaps recorded by name so roster edits never change what was announced.
  return { names, history: [] };
}

// ---------- Rotation ----------

function hasBench(team) {
  return team.names.length > ON_COURT;
}

function advance(team) {
  if (!hasBench(team)) return false;
  const outName = team.names[0];
  const inName = team.names[ON_COURT];
  team.names.shift();
  team.names.push(outName);
  team.history.push({ inName, outName });
  return true;
}

// Reverses advance: the player sent to the back returns to the front,
// which pushes the one who came in back to the head of the bench.
function undo(team) {
  const last = team.history.pop();
  if (!last) return;
  const index = team.names.lastIndexOf(last.outName);
  if (index < 0) return; // Player was removed since; nothing to put back.
  team.names.splice(index, 1);
  team.names.unshift(last.outName);
}

// The next `count` swaps the rotation will make, without changing the team.
function upcomingSwaps(team, count) {
  const names = [...team.names];
  const swaps = [];
  for (let i = 0; i < count; i++) {
    if (names.length <= ON_COURT) {
      swaps.push(null);
      continue;
    }
    const outName = names.shift();
    swaps.push({ inName: names[ON_COURT - 1], outName });
    names.push(outName);
  }
  return swaps;
}

function teamName(teamIndex) {
  return teamIndex === BLACK ? "BLACK" : TEAM_COLORS[state.colorIndex][0];
}

// ---------- History of substitutions made this session ----------

// state.steps holds one entry per timer end: { at, skipped, swaps: [black swap | null, color swap | null] }.

function renderLog() {
  const list = $("#log-list");
  if (state.steps.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "No substitutions yet.";
    list.replaceChildren(empty);
    return;
  }

  list.replaceChildren(...state.steps.map((step, i) => {
    const item = document.createElement("li");

    const when = document.createElement("span");
    when.className = "when";
    when.textContent = new Date(step.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

    const number = document.createElement("span");
    number.className = "number";
    number.textContent = step.skipped ? `${i + 1} SKIP` : `${i + 1}`;

    item.append(when, number, ...step.swaps.map((swap, teamIndex) => {
      const cell = document.createElement("span");
      cell.className = `swap team-${teamIndex}`;
      if (swap) {
        const inName = document.createElement("span");
        inName.className = "in";
        inName.textContent = swap.inName;
        const outName = document.createElement("span");
        outName.className = "out";
        outName.textContent = swap.outName;
        cell.append(inName, outName);
      } else {
        cell.textContent = "-";
      }
      return cell;
    }));
    return item;
  }).reverse());
}

function openLog() {
  closeMenu();
  renderLog();
  $("#log").hidden = false;
  $("#log-list").scrollTop = 0;
}

function closeLog() {
  $("#log").hidden = true;
}

// ---------- Menu ----------

function openMenu() {
  const button = $("#menu-button").getBoundingClientRect();
  const menu = $("#menu");
  menu.style.top = `${button.bottom + 6}px`;
  menu.hidden = false;
}

function closeMenu() {
  $("#menu").hidden = true;
  resetStopButton();
}

// ---------- Sound (Web Audio, one voice that restarts) ----------

let audio = null;
let voice = null;

const TICK = [[880, 0.12]];
const ALERT = [
  [1320, 0.25], [0, 0.08], [990, 0.25], [0, 0.08],
  [1320, 0.25], [0, 0.08], [990, 0.25], [0, 0.08],
  [1320, 0.25], [0, 0.08], [990, 0.5],
];

// Must run inside a user gesture (START) so mobile browsers allow sound.
function unlockAudio() {
  try {
    // Safari 16.4+: play even when the ringer switch is on silent.
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === "suspended") audio.resume();
  } catch (e) {
    console.warn("Audio unavailable", e);
  }
}

function stopSound() {
  if (!voice) return;
  try { voice.stop(); } catch (e) { /* already stopped */ }
  voice.disconnect();
  voice = null;
}

function playSound(segments, volume) {
  if (!audio) return;
  if (audio.state === "suspended") audio.resume();
  stopSound();

  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  osc.connect(gain).connect(audio.destination);

  let t = audio.currentTime + 0.01;
  gain.gain.setValueAtTime(0, t);
  for (const [frequency, duration] of segments) {
    if (frequency > 0) {
      osc.frequency.setValueAtTime(frequency, t);
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(volume, t + 0.005);
      gain.gain.setValueAtTime(volume, t + duration - 0.02);
      gain.gain.linearRampToValueAtTime(0, t + duration);
    }
    t += duration;
  }

  osc.start();
  osc.stop(t + 0.05);
  osc.onended = () => { if (voice === osc) voice = null; };
  voice = osc;
}

const tick = () => playSound(TICK, 0.15);
const alertSound = () => playSound(ALERT, 0.3);

// ---------- Screen wake lock ----------

let wakeLock = null;

async function keepAwake() {
  if (!state.running || !("wakeLock" in navigator) || document.visibilityState !== "visible") return;
  try {
    if (!wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch (e) {
    console.warn("Wake lock unavailable", e);
  }
}

function releaseWakeLock() {
  if (wakeLock) wakeLock.release();
  wakeLock = null;
}

// ---------- DOM helpers ----------

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const setupScreen = $("#setup");
const sessionScreen = $("#session");
const rosterPanel = $("#roster");

function contrastText(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 0.6 ? "#000" : "#fff";
}

function applyTeamColor() {
  const [name, color] = TEAM_COLORS[state.colorIndex];
  document.documentElement.style.setProperty("--team-color", color);
  document.documentElement.style.setProperty("--team-text", contrastText(color));

  $(".color-cycle").firstChild.textContent = name;
  $('.roster-column[data-team="1"] .roster-head').textContent = name;
}

// ---------- Setup ----------

function renderSetup() {
  $("#minutes").textContent = Math.floor(state.intervalSeconds / 60);
  $("#seconds").textContent = String(state.intervalSeconds % 60).padStart(2, "0");
  applyTeamColor();

  for (const column of $$(".setup-team")) {
    const teamIndex = Number(column.dataset.team);
    const names = state.teams[teamIndex].names;
    $(".count", column).textContent = names.length;

    const list = $(".name-list", column);
    list.replaceChildren(...names.map((name, i) => {
      const row = document.createElement("div");
      row.className = "name-row";

      const number = document.createElement("span");
      number.className = i < ON_COURT ? "number" : "number bench";
      number.textContent = i < ON_COURT ? `${i + 1}` : `${i + 1} B`;

      const input = document.createElement("input");
      input.type = "text";
      input.maxLength = 24;
      input.value = name;
      input.autocomplete = "off";
      input.enterKeyHint = "next";
      input.addEventListener("input", () => {
        names[i] = input.value.trim() || defaultName(i);
      });
      input.addEventListener("blur", () => {
        input.value = names[i];
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") input.blur();
      });

      row.append(number, input);
      return row;
    }));
  }
}

function changeInterval(delta) {
  state.intervalSeconds = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, state.intervalSeconds + delta));
  renderSetup();
}

function changePlayerCount(teamIndex, delta) {
  const names = state.teams[teamIndex].names;
  const target = Math.min(MAX_PLAYERS, Math.max(MIN_PLAYERS, names.length + delta));
  while (names.length < target) names.push(defaultName(names.length));
  while (names.length > target) names.pop();
  renderSetup();
}

function showSetup() {
  closeMenu();
  closeLog();
  state.running = false;
  state.paused = false;
  releaseWakeLock();
  stopSound();
  closeRoster();
  sessionScreen.hidden = true;
  setupScreen.hidden = false;
  renderSetup();
}

// ---------- Session ----------

function startSession() {
  document.activeElement?.blur();
  unlockAudio();

  for (const team of state.teams) team.history = [];
  state.steps = [];
  state.running = true;
  state.paused = false;
  state.flashUntil = 0;
  startInterval(Date.now());

  setupScreen.hidden = true;
  sessionScreen.hidden = false;
  keepAwake();
  tick();
  renderSession();
  renderTimer();
}

function startInterval(startAt) {
  state.endAt = startAt + state.intervalSeconds * 1000;
  state.lastShownSecond = -1;
}

function remainingMs() {
  return state.paused ? state.pausedRemaining : state.endAt - Date.now();
}

function formatTime(totalSeconds) {
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

// Timer ended (or skipped): the swap happens and the next timer starts right away.
function substitute(at, skipped = false) {
  const swaps = state.teams.map((team) => (advance(team) ? team.history[team.history.length - 1] : null));
  state.steps.push({ at, skipped, swaps });
  state.flashUntil = at + FLASH_MS;
  startInterval(at);
  if (!$("#log").hidden) renderLog();
}

function update() {
  if (!state.running || state.paused) return;

  let ended = false;
  // Chain from the previous end so no drift builds up and backgrounded time catches up.
  while (remainingMs() <= 0) {
    substitute(state.endAt);
    ended = true;
  }

  if (ended) {
    alertSound();
    renderSession();
  } else if (flashShown && Date.now() >= state.flashUntil) {
    renderSession();
    state.lastShownSecond = -1;
  } else if (isSecondHalf() !== shownSecondHalf) {
    renderSession();
  }

  renderTimer();
}

function togglePause() {
  if (!state.running) return;
  if (state.paused) {
    state.endAt = Date.now() + state.pausedRemaining;
    state.paused = false;
  } else {
    state.pausedRemaining = Math.max(0, remainingMs());
    state.paused = true;
  }
  state.lastShownSecond = -1;
  renderSession();
  renderTimer();
}

function skip() {
  if (!state.running) return;
  substitute(Date.now(), true);
  if (state.paused) state.pausedRemaining = state.intervalSeconds * 1000;
  alertSound();
  renderSession();
  renderTimer();
}

// Undo the last substitution (e.g. after skipping too far) and restart the timer.
// With nothing to undo it just restarts the current timer.
function back() {
  if (!state.running) return;

  // Undone substitutions leave the log, since they didn't really happen.
  const step = state.steps.pop();
  if (step) {
    step.swaps.forEach((swap, i) => { if (swap) undo(state.teams[i]); });
  }

  state.flashUntil = 0;
  startInterval(Date.now());
  if (state.paused) state.pausedRemaining = state.intervalSeconds * 1000;
  tick();
  renderSession();
  renderTimer();
}

let flashShown = false;
let shownSecondHalf = false;

function isSecondHalf() {
  return remainingMs() <= state.intervalSeconds * 500;
}

function renderSession() {
  flashShown = !state.paused && Date.now() < state.flashUntil;
  shownSecondHalf = isSecondHalf();

  $("#band").classList.toggle("alert", flashShown);
  $("#paused-label").hidden = !state.paused;

  for (const panel of $$(".session-team")) {
    const team = state.teams[Number(panel.dataset.team)];
    const [due, afterDue] = upcomingSwaps(team, 2);

    // First half: big = swap just made, small = swap due at 0:00.
    // Second half: big = swap due at 0:00 (it stays big through the alarm), small = the one after.
    const current = shownSecondHalf ? due : team.history[team.history.length - 1];
    const next = shownSecondHalf ? afterDue : due;

    $(".chip.in .name", panel).textContent = current ? current.inName : "-";
    $(".chip.out .name", panel).textContent = current ? current.outName : "-";
    $(".chip.in", panel).classList.toggle("active", !!current);
    $(".chip.out", panel).classList.toggle("active", !!current);

    $(".mini.in", panel).textContent = next ? next.inName : "-";
    $(".mini.out", panel).textContent = next ? next.outName : "-";
    $(".mini.in", panel).classList.toggle("active", !!next);
    $(".mini.out", panel).classList.toggle("active", !!next);
  }
}

// STOP needs a second tap so a stray touch mid-game doesn't end the session.
const STOP_CONFIRM_MS = 3000;
let stopArmedTimer = 0;

function resetStopButton() {
  clearTimeout(stopArmedTimer);
  stopArmedTimer = 0;
  $("#stop").textContent = "STOP";
}

function pressStop() {
  if (stopArmedTimer) {
    showSetup();
    return;
  }
  $("#stop").textContent = "SURE?";
  stopArmedTimer = setTimeout(resetStopButton, STOP_CONFIRM_MS);
}

function renderTimer() {
  const seconds = Math.ceil(Math.max(0, remainingMs()) / 1000);
  if (seconds === state.lastShownSecond) return;

  if (!state.paused && state.lastShownSecond > seconds && seconds >= 1 && seconds <= 3) tick();
  state.lastShownSecond = seconds;

  const time = $("#time");
  time.textContent = formatTime(seconds);
  time.classList.toggle("paused", state.paused);
  time.classList.toggle("warn", !state.paused && !flashShown && seconds <= 10);
}

// ---------- Players panel ----------

let messageTimer = 0;

function showMessage(text) {
  const message = $("#roster-message");
  message.textContent = text;
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => { message.textContent = ""; }, MESSAGE_MS);
}

function openRoster() {
  closeMenu();
  $("#roster-message").textContent = "";
  for (const input of $$(".add-row input")) input.value = "";
  rosterPanel.hidden = false;
  renderRoster();
}

function closeRoster() {
  cancelDrag();
  document.activeElement?.blur();
  rosterPanel.hidden = true;
}

function renderRoster() {
  for (const column of $$(".roster-column")) {
    const teamIndex = Number(column.dataset.team);
    const names = state.teams[teamIndex].names;

    $(".roster-list", column).replaceChildren(...names.map((name, i) => {
      const row = document.createElement("div");
      row.className = i < ON_COURT ? "roster-row court" : "roster-row";
      row.dataset.team = teamIndex;
      row.dataset.index = i;

      const order = document.createElement("span");
      order.className = "order";
      order.textContent = i < ON_COURT ? "COURT" : `BENCH ${i - ON_COURT + 1}`;

      const label = document.createElement("span");
      label.className = "name";
      label.textContent = name;

      const remove = document.createElement("button");
      remove.className = "btn remove";
      remove.type = "button";
      remove.textContent = "X";
      remove.addEventListener("click", () => removePlayer(teamIndex, i));

      row.append(order, label, remove);
      row.addEventListener("pointerdown", onRowPointerDown);
      row.addEventListener("contextmenu", (e) => e.preventDefault());
      return row;
    }));
  }
}

function rosterChanged() {
  renderRoster();
  if (state.running) renderSession();
  else renderSetup();
}

function addPlayer(teamIndex, input) {
  const names = state.teams[teamIndex].names;
  if (names.length >= MAX_PLAYERS) {
    showMessage(`A team can have at most ${MAX_PLAYERS} players`);
    return;
  }
  const name = input.value.trim() || defaultName(names.length);
  names.push(name);
  input.value = "";
  showMessage(`${name} added to the end of the ${teamName(teamIndex)} bench`);
  rosterChanged();
}

function removePlayer(teamIndex, index) {
  const names = state.teams[teamIndex].names;
  if (names.length <= MIN_PLAYERS) {
    showMessage(`A team needs at least ${MIN_PLAYERS} players`);
    return;
  }
  const [name] = names.splice(index, 1);
  const text = index < ON_COURT ? `${name} removed, ${names[ON_COURT - 1]} goes on court` : `${name} removed`;
  showMessage(text);
  rosterChanged();
}

function swapPlayers(a, b) {
  if (a.team === b.team && a.index === b.index) return;
  const listA = state.teams[a.team].names;
  const listB = state.teams[b.team].names;
  [listA[a.index], listB[b.index]] = [listB[b.index], listA[a.index]];
  showMessage(`Swapped ${listB[b.index]} and ${listA[a.index]}`);
  rosterChanged();
}

function movePlayer(source, toTeam) {
  const from = state.teams[source.team].names;
  const to = state.teams[toTeam].names;
  if (source.team !== toTeam) {
    if (from.length <= MIN_PLAYERS) {
      showMessage(`A team needs at least ${MIN_PLAYERS} players`);
      return;
    }
    if (to.length >= MAX_PLAYERS) {
      showMessage(`A team can have at most ${MAX_PLAYERS} players`);
      return;
    }
  }
  const [name] = from.splice(source.index, 1);
  to.push(name);
  showMessage(`${name} moved to the end of the ${teamName(toTeam)} bench`);
  rosterChanged();
}

// ---------- Drag and drop (pointer events; touch needs a short hold so lists still scroll) ----------

let drag = null;

function onRowPointerDown(e) {
  if (e.button > 0 || e.target.closest(".remove")) return;
  const row = e.currentTarget;
  cancelDrag();
  drag = {
    row,
    source: { team: Number(row.dataset.team), index: Number(row.dataset.index) },
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    x: e.clientX,
    y: e.clientY,
    active: false,
    ghost: null,
    target: null,
    timer: 0,
  };
  if (e.pointerType !== "mouse") {
    row.classList.add("pressing");
    drag.timer = setTimeout(activateDrag, LONG_PRESS_MS);
  }
}

function activateDrag() {
  if (!drag) return;
  drag.active = true;
  drag.row.classList.remove("pressing");
  drag.row.classList.add("dragging");

  const rect = drag.row.getBoundingClientRect();
  const ghost = drag.row.cloneNode(true);
  ghost.classList.remove("dragging");
  ghost.classList.add("ghost");
  ghost.style.width = `${rect.width}px`;
  document.body.append(ghost);
  drag.ghost = ghost;
  moveGhost();
  if (navigator.vibrate) navigator.vibrate(15);
}

function moveGhost() {
  drag.ghost.style.left = `${drag.x}px`;
  drag.ghost.style.top = `${drag.y}px`;

  const hit = document.elementFromPoint(drag.x, drag.y);
  const row = hit?.closest(".roster-row");
  const column = hit?.closest(".roster-column");
  const target = row && row !== drag.row ? row : !row && column ? column : null;

  if (target !== drag.target) {
    drag.target?.classList.remove("drop-target");
    target?.classList.add("drop-target");
    drag.target = target;
  }
}

function cancelDrag() {
  if (!drag) return;
  clearTimeout(drag.timer);
  drag.row.classList.remove("pressing", "dragging");
  drag.target?.classList.remove("drop-target");
  drag.ghost?.remove();
  drag = null;
}

document.addEventListener("pointermove", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;

  if (!drag.active) {
    const distance = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
    if (e.pointerType === "mouse" && distance > 5) activateDrag();
    else if (e.pointerType !== "mouse" && distance > 10) cancelDrag(); // finger is scrolling
    return;
  }
  moveGhost();
});

document.addEventListener("pointerup", (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  if (drag.active && drag.target) {
    const { source, target } = drag;
    if (target.classList.contains("roster-row")) {
      swapPlayers(source, { team: Number(target.dataset.team), index: Number(target.dataset.index) });
    } else {
      movePlayer(source, Number(target.dataset.team));
    }
  }
  cancelDrag();
});

document.addEventListener("pointercancel", cancelDrag);

// Once a drag is active, stop the page/list from scrolling under the finger.
document.addEventListener("touchmove", (e) => {
  if (drag && drag.active) e.preventDefault();
}, { passive: false });

// ---------- Wiring ----------

for (const button of $$("[data-interval]")) {
  button.addEventListener("click", () => changeInterval(Number(button.dataset.interval)));
}
for (const button of $$("[data-count]")) {
  const teamIndex = Number(button.closest(".setup-team").dataset.team);
  button.addEventListener("click", () => changePlayerCount(teamIndex, Number(button.dataset.count)));
}
$(".color-cycle").addEventListener("click", () => {
  state.colorIndex = (state.colorIndex + 1) % TEAM_COLORS.length;
  applyTeamColor();
});

$("#start").addEventListener("click", startSession);
$("#time").addEventListener("click", togglePause);
$("#back").addEventListener("click", back);
$("#skip").addEventListener("click", skip);
$("#players").addEventListener("click", openRoster);
$("#open-log").addEventListener("click", openLog);
$("#stop").addEventListener("click", pressStop);
$("#roster-close").addEventListener("click", closeRoster);
$("#log-close").addEventListener("click", closeLog);

$("#menu-button").addEventListener("click", () => {
  if ($("#menu").hidden) openMenu();
  else closeMenu();
});
// Tapping anywhere outside the menu closes it.
document.addEventListener("pointerdown", (e) => {
  if (!$("#menu").hidden && !e.target.closest("#menu, #menu-button")) closeMenu();
});

for (const form of $$(".add-row")) {
  const teamIndex = Number(form.closest(".roster-column").dataset.team);
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    addPlayer(teamIndex, $("input", form));
  });
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    update();
    keepAwake();
  }
});

setInterval(update, 200);
showSetup();
