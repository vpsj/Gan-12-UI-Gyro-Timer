import './style.css'

import $ from 'jquery';
import { Subscription, interval } from 'rxjs';
import { TwistyPlayer } from 'cubing/twisty';
import { experimentalSolve3x3x3IgnoringCenters } from 'cubing/search';
import * as THREE from 'three';

import {
  now,
  connectGanCube,
  GanCubeConnection,
  GanCubeEvent,
  GanCubeMove,
  MacAddressProvider,
  makeTimeFromTimestamp,
  cubeTimestampLinearFit
} from 'gan-web-bluetooth';

import { faceletsToPattern, patternToFacelets } from './utils';

// ======================================================
// 🧩 Constants
// ======================================================
const SOLVED_STATE =
  'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

// ======================================================
// 🎲 Setup TwistyPlayer
// ======================================================
const twistyPlayer = new TwistyPlayer({
  puzzle: '3x3x3',
  visualization: 'PG3D',
  alg: '',
  experimentalSetupAnchor: 'start',
  background: 'none',
  controlPanel: 'none',
  hintFacelets: 'none',
  experimentalDragInput: 'none',
  tempoScale: 5,
});

$('#cube').append(twistyPlayer);

// ======================================================
// 🌍 Variables
// ======================================================
let conn: GanCubeConnection | null = null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let twistyScene: THREE.Scene | null = null;
let twistyVantage: any = null;
let basis: THREE.Quaternion | null = null;
let cubeStateInitialized = false;

// ======================================================
// 🧭 Correct cube orientation — WHITE FRONT, BLUE TOP
// ======================================================
(async () => {
  const vList = await twistyPlayer.experimentalCurrentVantages();
  twistyVantage = [...vList][0];
  twistyScene = await twistyVantage.scene.scene();

  // We use the VANTAGE camera directly instead of cube rotation
  // Cubing.js default camera looks toward +Z (green front)
  // We want white front (+Y) and blue top (-Z)
  const camera = twistyVantage.scene._threeCamera as THREE.PerspectiveCamera;

  // Apply a rotation matrix to move view:
  // Look at Y+ instead of Z+, then tilt slightly downward
  const rotation = new THREE.Euler(
    -Math.PI / 2.2, // tilt down a bit (white front)
    Math.PI,        // flip 180° to correct left/right
    0
  );
  camera.rotation.copy(rotation);

  twistyVantage.render();
  console.log('%c✅ Orientation set: White front, Blue top', 'color:#0f0;font-weight:bold;');
})();

// ======================================================
// 🔄 Animate cube orientation (gyro updates)
// ======================================================
let cubeQuaternion = new THREE.Quaternion();
async function animateCubeOrientation() {
  if (twistyScene && twistyVantage) {
    twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
    twistyVantage.render();
  }
  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

// ======================================================
// ⚙️ GanCube event handlers
// ======================================================
async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') {
    const { x: qx, y: qy, z: qz, w: qw } = event.quaternion;
    const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();

    if (!basis) {
      basis = quat.clone().conjugate();
    }

    cubeQuaternion.copy(quat.premultiply(basis));
  }
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type === 'MOVE') {
    if (timerState === 'READY') setTimerState('RUNNING');
    twistyPlayer.experimentalAddMove(event.move, { cancel: false });
    lastMoves.push(event);
    if (timerState === 'RUNNING') solutionMoves.push(event);
    if (lastMoves.length > 256) lastMoves = lastMoves.slice(-256);
  }
}

async function handleFaceletsEvent(event: GanCubeEvent) {
  if (event.type === 'FACELETS' && !cubeStateInitialized) {
    if (event.facelets !== SOLVED_STATE) {
      const kpattern = faceletsToPattern(event.facelets);
      const solution = await experimentalSolve3x3x3IgnoringCenters(kpattern);
      twistyPlayer.alg = solution.invert();
    } else {
      twistyPlayer.alg = '';
    }
    cubeStateInitialized = true;
  }
}

function handleCubeEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') handleGyroEvent(event);
  else if (event.type === 'MOVE') handleMoveEvent(event);
  else if (event.type === 'FACELETS') handleFaceletsEvent(event);
  else if (event.type === 'DISCONNECT') {
    twistyPlayer.alg = '';
    $('#connect').html('Connect');
  }
}

// ======================================================
// 💾 MAC address persistence
// ======================================================
const customMacAddressProvider: MacAddressProvider = async (
  device,
  isFallbackCall
): Promise<string | null> => {
  const savedMac = localStorage.getItem('gan_cube_mac');
  if (savedMac && !isFallbackCall) {
    console.log(`Using saved MAC: ${savedMac}`);
    return savedMac;
  }

  const manualMac = prompt(
    'Please enter your cube’s MAC address (e.g., F0:AB:12:34:56:78):'
  );
  if (manualMac) {
    localStorage.setItem('gan_cube_mac', manualMac);
    console.log(`Saved MAC: ${manualMac}`);
    return manualMac;
  }

  return null;
};

// ======================================================
// 🧩 UI Controls
// ======================================================
$('#reset-state').on('click', async () => {
  await conn?.sendCubeCommand({ type: 'REQUEST_RESET' });
  twistyPlayer.alg = '';
});

$('#reset-gyro').on('click', async () => {
  basis = null;
});

$('#connect').on('click', async () => {
  if (conn) {
    conn.disconnect();
    conn = null;
    $('#connect').html('Connect');
  } else {
    conn = await connectGanCube(customMacAddressProvider);
    conn.events$.subscribe(handleCubeEvent);
    await conn.sendCubeCommand({ type: 'REQUEST_HARDWARE' });
    await conn.sendCubeCommand({ type: 'REQUEST_FACELETS' });
    await conn.sendCubeCommand({ type: 'REQUEST_BATTERY' });
    $('#connect').html('Disconnect');
  }
});

// ======================================================
// ⏱ Timer logic
// ======================================================
let timerState: 'IDLE' | 'READY' | 'RUNNING' | 'STOPPED' = 'IDLE';

function setTimerState(state: typeof timerState) {
  timerState = state;
  switch (state) {
    case 'IDLE':
      stopLocalTimer();
      $('#timer').hide();
      break;
    case 'READY':
      setTimerValue(0);
      $('#timer').show().css('color', '#0f0');
      break;
    case 'RUNNING':
      solutionMoves = [];
      startLocalTimer();
      $('#timer').css('color', '#999');
      break;
    case 'STOPPED':
      stopLocalTimer();
      $('#timer').css('color', '#fff');
      const fittedMoves = cubeTimestampLinearFit(solutionMoves);
      const lastMove = fittedMoves.slice(-1).pop();
      setTimerValue(lastMove ? lastMove.cubeTimestamp! : 0);
      break;
  }
}

twistyPlayer.experimentalModel.currentPattern.addFreshListener(async (kpattern) => {
  const facelets = patternToFacelets(kpattern);
  if (facelets === SOLVED_STATE && timerState === 'RUNNING') {
    setTimerState('STOPPED');
    twistyPlayer.alg = '';
  }
});

function setTimerValue(timestamp: number) {
  const t = makeTimeFromTimestamp(timestamp);
  $('#timer').html(
    `${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds
      .toString(10)
      .padStart(3, '0')}`
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
  if (timerState === 'IDLE' && conn) setTimerState('READY');
  else setTimerState('IDLE');
}

$(document).on('keydown', (event) => {
  if (event.which === 32) {
    event.preventDefault();
    activateTimer();
  }
});

$('#cube').on('touchstart', () => {
  activateTimer();
});
