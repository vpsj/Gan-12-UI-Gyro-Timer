import "./style.css";

import $ from "jquery";
import { Subscription, interval } from "rxjs";
import { TwistyPlayer } from "cubing/twisty";
import { experimentalSolve3x3x3IgnoringCenters } from "cubing/search";
import * as THREE from "three";

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

// ------------------------------------------------------------
// CONSTANTS
// ------------------------------------------------------------
const SOLVED_STATE =
  "UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB";

// ------------------------------------------------------------
// INIT TWISTYPLAYER
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

  // ✅ This line fixes the cube orientation
  // x → rotate +90° around X (white → front)
  // y' → rotate -90° around Y (blue → top)
  experimentalSetupAlg: "x' y y'"
});

$("#cube").append(twistyPlayer);

// ------------------------------------------------------------
// GLOBALS
// ------------------------------------------------------------
let conn: GanCubeConnection | null = null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let basis: THREE.Quaternion | null = null;
let cubeStateInitialized = false;

// ------------------------------------------------------------
// GANCUBE EVENT HANDLERS
// ------------------------------------------------------------
async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type === "GYRO") {
    const { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();

    if (!basis) basis = quat.clone().conjugate();
  }
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type === "MOVE") {
    if (timerState === "READY") setTimerState("RUNNING");
    twistyPlayer.experimentalAddMove(event.move, { cancel: false });
    lastMoves.push(event);
    if (timerState === "RUNNING") solutionMoves.push(event);
    if (lastMoves.length > 256) lastMoves = lastMoves.slice(-256);
  }
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
  if (event.type === "GYRO") handleGyroEvent(event);
  else if (event.type === "MOVE") handleMoveEvent(event);
  else if (event.type === "FACELETS") handleFaceletsEvent(event);
  else if (event.type === "DISCONNECT") {
    twistyPlayer.alg = "";
    $("#connect").html("Connect");
  }
}

// ------------------------------------------------------------
// MAC ADDRESS PERSISTENCE
// ------------------------------------------------------------
const customMacAddressProvider: MacAddressProvider = async (
  device,
  isFallbackCall
): Promise<string | null> => {
  const savedMac = localStorage.getItem("gan_cube_mac");
  if (savedMac && !isFallbackCall) return savedMac;

  const manualMac = prompt("Please enter your cube’s MAC address:");
  if (manualMac) {
    localStorage.setItem("gan_cube_mac", manualMac);
    return manualMac;
  }
  return null;
};

// ------------------------------------------------------------
// UI BUTTONS
// ------------------------------------------------------------
$("#reset-state").on("click", async () => {
  await conn?.sendCubeCommand({ type: "REQUEST_RESET" });
  twistyPlayer.alg = "";
});

$("#reset-gyro").on("click", async () => {
  basis = null;
});

$("#connect").on("click", async () => {
  if (conn) {
    conn.disconnect();
    conn = null;
    $("#connect").html("Connect");
  } else {
    conn = await connectGanCube(customMacAddressProvider);
    conn.events$.subscribe(handleCubeEvent);
    await conn.sendCubeCommand({ type: "REQUEST_HARDWARE" });
    await conn.sendCubeCommand({ type: "REQUEST_FACELETS" });
    await conn.sendCubeCommand({ type: "REQUEST_BATTERY" });
    $("#connect").html("Disconnect");
  }
});

// ------------------------------------------------------------
// TIMER LOGIC
// ------------------------------------------------------------
let timerState: "IDLE" | "READY" | "RUNNING" | "STOPPED" = "IDLE";

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
      const fittedMoves = cubeTimestampLinearFit(solutionMoves);
      const lastMove = fittedMoves.slice(-1).pop();
      setTimerValue(lastMove ? lastMove.cubeTimestamp! : 0);
      break;
  }
}

twistyPlayer.experimentalModel.currentPattern.addFreshListener(
  async (kpattern) => {
    const facelets = patternToFacelets(kpattern);
    if (facelets === SOLVED_STATE && timerState === "RUNNING") {
      setTimerState("STOPPED");
      twistyPlayer.alg = "";
    }
  }
);

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
function activateTimer() {
  if (timerState === "IDLE" && conn) setTimerState("READY");
  else setTimerState("IDLE");
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
