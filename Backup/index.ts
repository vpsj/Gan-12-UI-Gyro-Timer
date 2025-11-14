// src/index.ts
import "./style.css";

import $ from "jquery";
import { Subscription, interval } from "rxjs";
import { TwistyPlayer } from "cubing/twisty";
import { experimentalSolve3x3x3IgnoringCenters } from "cubing/search";
import * as THREE from "three";
import { randomScrambleForEvent } from "cubing/scramble"; // ✅ Scramble import

import {
  now,
  connectGanCube,
  GanCubeConnection,
  GanCubeEvent,
  GanCubeMove,
  MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampLinearFit,
} from "gan-web-bluetooth";

import { faceletsToPattern, patternToFacelets } from "./utils";

const SOLVED_STATE =
  "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

// ------------------------------------------------------------
// TwistyPlayer Setup
// ------------------------------------------------------------
const twistyPlayer = new TwistyPlayer({
  puzzle: "3x3x3",
  visualization: "PG3D",
  alg: "",
  experimentalSetupAnchor: "start",
  background: "none",
  controlPanel: "none",
  hintFacelets: "none",
  experimentalDragInput: "none",
  tempoScale: 5,
  cameraLatitude: 15,
  cameraLongitude: 180,
});

$("#cube").append(twistyPlayer);

// ------------------------------------------------------------
// Scramble Controls
// ------------------------------------------------------------
let scrambleHistory: string[] = [];
let scrambleIndex = -1;

async function generateNewScramble() {
  const scramble = await randomScrambleForEvent("333");
  scrambleHistory.push(scramble);
  scrambleIndex = scrambleHistory.length - 1;
  displayScramble();
}

function displayScramble() {
  const scramble = scrambleHistory[scrambleIndex];
  $("#scramble-text").text(scramble);
  twistyPlayer.alg = scramble;
}

$("#next-scramble").on("click", async () => {
  if (scrambleIndex < scrambleHistory.length - 1) {
    scrambleIndex++;
    displayScramble();
  } else {
    await generateNewScramble();
  }
});

$("#prev-scramble").on("click", () => {
  if (scrambleIndex > 0) {
    scrambleIndex--;
    displayScramble();
  }
});

generateNewScramble();

// ------------------------------------------------------------
// Globals
// ------------------------------------------------------------
let conn: GanCubeConnection | null = null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let basis: THREE.Quaternion | null = null;
let cubeStateInitialized = false;

let twistyScene: THREE.Scene;
let twistyVantage: any;
let cubeQuaternion = new THREE.Quaternion();
let HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(-90 * Math.PI / 180, 180 * Math.PI / 180, 0)
);

// ------------------------------------------------------------
// Animation Loop
// ------------------------------------------------------------
async function animateCubeOrientation() {
  if (!twistyScene || !twistyVantage) {
    try {
      const vantages = await twistyPlayer.experimentalCurrentVantages();
      twistyVantage = [...vantages][0];
      twistyScene = await twistyVantage.scene.scene();
      console.log("✅ Twisty internals initialized");
    } catch {
      requestAnimationFrame(animateCubeOrientation);
      return;
    }
  }

  twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
  twistyVantage.render();

  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

// ------------------------------------------------------------
// Event Handlers
// ------------------------------------------------------------
async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type !== "GYRO") return;
  const { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
  const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();
  if (!basis) {
    basis = quat.clone().conjugate();
    console.log("✅ Gyro calibrated (basis set).");
  }
  cubeQuaternion.copy(quat.premultiply(basis).premultiply(HOME_ORIENTATION));
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type !== "MOVE") return;
  if (timerState === "READY") setTimerState("RUNNING");
  twistyPlayer.experimentalAddMove(event.move, { cancel: false });
  lastMoves.push(event);
  if (timerState === "RUNNING") solutionMoves.push(event);
  if (lastMoves.length > 256) lastMoves = lastMoves.slice(-256);
}

async function handleFaceletsEvent(event: GanCubeEvent) {
  if (event.type === "FACELETS" && !cubeStateInitialized) {
    if (event.facelets !== SOLVED_STATE) {
      const kpattern = faceletsToPattern(event.facelets);
      const solution = await experimentalSolve3x3x3IgnoringCenters(kpattern);
      twistyPlayer.alg = solution.invert();
    } else {
      twistyPlayer.alg = "";
    }
    cubeStateInitialized = true;
  }
}

function handleCubeEvent(event: GanCubeEvent) {
  if (!event) return;
  if (event.type === "GYRO") handleGyroEvent(event);
  else if (event.type === "MOVE") handleMoveEvent(event);
  else if (event.type === "FACELETS") handleFaceletsEvent(event);
  else if (event.type === "DISCONNECT") {
    twistyPlayer.alg = "";
    $("#connect").html("Connect");
    conn = null;
  }
}

// ------------------------------------------------------------
// MAC Handler
// ------------------------------------------------------------
const customMacAddressProvider: MacAddressProvider = async (device, isFallbackCall) => {
  const saved = localStorage.getItem("gan_cube_mac");
  if (saved && !isFallbackCall) return saved;
  const manual = prompt("Please enter your cube’s MAC address:");
  if (manual) {
    localStorage.setItem("gan_cube_mac", manual);
    return manual;
  }
  return null;
};

// ------------------------------------------------------------
// UI Controls
// ------------------------------------------------------------
$("#reset-state").on("click", async () => {
  await conn?.sendCubeCommand({ type: "REQUEST_RESET" });
  twistyPlayer.alg = "";
});

$("#reset-gyro").on("click", async () => {
  basis = null;
  console.log("Gyro reset; will recalibrate on next rotation.");
});

$("#connect").on("click", async () => {
  if (conn) {
    conn.disconnect();
    conn = null;
    $("#connect").html("Connect");
    return;
  }

  conn = await connectGanCube(customMacAddressProvider);
  conn.events$.subscribe(handleCubeEvent);

  await conn.sendCubeCommand({ type: "REQUEST_HARDWARE" });
  await conn.sendCubeCommand({ type: "REQUEST_FACELETS" });
  await conn.sendCubeCommand({ type: "REQUEST_BATTERY" });

  try {
    await conn.sendCubeCommand({ type: "REQUEST_GYRO" });
    console.log("✅ REQUEST_GYRO sent");
  } catch {
    console.warn("⚠️ Cube may not require REQUEST_GYRO");
  }

  $("#connect").html("Disconnect");
});

// ------------------------------------------------------------
// Timer + Inspection Logic
// ------------------------------------------------------------
let timerState: "IDLE" | "READY" | "RUNNING" | "STOPPED" = "IDLE";
let inspectionState: "NONE" | "INSPECT" | "COUNTDOWN" = "NONE";

function showOverlay(text: string, cssClass: string) {
  const el = $("#inspect-overlay");
  el.removeClass().addClass(cssClass).text(text).css("opacity", 1);
}

function hideOverlay() {
  $("#inspect-overlay").css("opacity", 0);
}

function startCountdownAndRunTimer() {
  inspectionState = "COUNTDOWN";
  let count = 3;
  showOverlay(String(count), "countdown");

  const countdownInterval = setInterval(() => {
    count--;
    if (count > 0) {
      showOverlay(String(count), "countdown");
    } else if (count === 0) {
      showOverlay("BEGIN!", "begin");
      setTimeout(() => {
        hideOverlay();
        setTimerState("RUNNING");
      }, 600);
      clearInterval(countdownInterval);
    }
  }, 1000);
}

function activateTimer() {
  if (timerState === "IDLE" && inspectionState === "NONE" && conn) {
    // 🟢 Start inspection phase
    inspectionState = "INSPECT";
    showOverlay("INSPECT...", "flash-slow");
    setTimerState("READY");
  } else if (inspectionState === "INSPECT") {
    // 🕒 Move to countdown phase
    hideOverlay();
    startCountdownAndRunTimer();
  } else if (timerState === "RUNNING") {
    // ⏹ Stop timer
    setTimerState("STOPPED");
    inspectionState = "NONE";
  } else {
    // 🔁 Reset
    inspectionState = "NONE";
    hideOverlay();
    setTimerState("IDLE");
  }
}

function setTimerState(state: typeof timerState) {
  timerState = state;
  switch (state) {
    case "IDLE":
      stopLocalTimer();
      $("#timer").hide();
      break;
    case "READY":
      setTimerValue(0);
      $("#timer").show().css("color", "#0f0");
      break;
    case "RUNNING":
      solutionMoves = [];
      startLocalTimer();
      $("#timer").css("color", "#999");
      break;
    case "STOPPED":
      stopLocalTimer();
      $("#timer").css("color", "#fff");
      const fitted = cubeTimestampLinearFit(solutionMoves);
      const lastMove = fitted.slice(-1).pop();
      setTimerValue(lastMove ? lastMove.cubeTimestamp! : 0);
      break;
  }
}

twistyPlayer.experimentalModel.currentPattern.addFreshListener(async (kpattern) => {
  const facelets = patternToFacelets(kpattern);
  if (facelets === SOLVED_STATE && timerState === "RUNNING") {
    setTimerState("STOPPED");
    twistyPlayer.alg = "";
  }
});

function setTimerValue(timestamp: number) {
  const t = makeTimeFromTimestamp(timestamp);
  $("#timer").html(
    `${t.minutes}:${t.seconds.toString(10).padStart(2, "0")}.${t.milliseconds
      .toString(10)
      .padStart(3, "0")}`
  );
}

let localTimer: Subscription | null = null;
function startLocalTimer() {
  const startTime = now();
  localTimer = interval(30).subscribe(() => setTimerValue(now() - startTime));
}
function stopLocalTimer() {
  localTimer?.unsubscribe();
  localTimer = null;
}

$(document).on("keydown", (event) => {
  if (event.which === 32) {
    event.preventDefault();
    activateTimer();
  }
});
$("#cube").on("touchstart", () => {
  activateTimer();
});
