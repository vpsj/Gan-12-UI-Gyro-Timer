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
  cubeTimestampCalcSkew,
  cubeTimestampLinearFit
} from 'gan-web-bluetooth';

import { faceletsToPattern, patternToFacelets } from './utils';

// ======================================================
// Constants
// ======================================================
const SOLVED_STATE =
  'UUUUUUUUURRRRRRRRRFFFFFFFFFDDDDDDDDDLLLLLLLLLBBBBBBBBB';

// ======================================================
// TwistyPlayer setup
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
// Globals
// ======================================================
let conn: GanCubeConnection | null = null;
let lastMoves: GanCubeMove[] = [];
let solutionMoves: GanCubeMove[] = [];
let twistyScene: THREE.Scene | null = null;
let twistyVantage: any = null;
let basis: THREE.Quaternion | null = null;
let cubeStateInitialized = false;

// ======================================================
// HOME_ORIENTATION: the single canonical baseline orientation
// (we rotate the *scene* to this quaternion and also multiply gyro by it)
// Goal: White in front, Blue on top
// ======================================================
// This quaternion is composed from Euler angles chosen to map
// Cubing.js default (White-up, Green-front) --> White-front, Blue-top.
// If you want a slight tilt, tweak these Euler values.
const HOME_ORIENTATION = new THREE.Quaternion().setFromEuler(
  new THREE.Euler(Math.PI / 2, 0, Math.PI) // +90° X, 0 Y, +180° Z
);

// Start cubeQuaternion aligned to HOME_ORIENTATION
let cubeQuaternion: THREE.Quaternion = new THREE.Quaternion().copy(HOME_ORIENTATION);

// ======================================================
// Initialize and apply HOME_ORIENTATION after TwistyPlayer loads
// We wait briefly (micro-delay) so TwistyPlayer's internal setup finishes.
// ======================================================
(async () => {
  const vantageList = await twistyPlayer.experimentalCurrentVantages();
  twistyVantage = [...vantageList][0];
  twistyScene = await twistyVantage.scene.scene();

  // Delay a tiny bit to ensure Cubing.js internal initialization finishes.
  // 200-400ms is usually enough; use 300ms as a safe default.
  setTimeout(() => {
    // Apply the canonical orientation to the scene and the working quaternion.
    twistyScene!.quaternion.copy(HOME_ORIENTATION);
    cubeQuaternion.copy(HOME_ORIENTATION);
    twistyVantage!.render();

    console.log('%c✅ HOME_ORIENTATION applied (white front, blue top)', 'color:#0a0;font-weight:bold;');
  }, 300);
})();

// ======================================================
// Animate orientation (slerp to cubeQuaternion, updated by gyro events)
// ======================================================
async function animateCubeOrientation() {
  if (twistyScene && twistyVantage) {
    twistyScene.quaternion.slerp(cubeQuaternion, 0.25);
    twistyVantage.render();
  }
  requestAnimationFrame(animateCubeOrientation);
}
requestAnimationFrame(animateCubeOrientation);

// ======================================================
// GanCube event handlers
// IMPORTANT: apply HOME_ORIENTATION in handleGyroEvent so gyro is relative
// to the forced baseline orientation.
// ======================================================
async function handleGyroEvent(event: GanCubeEvent) {
  if (event.type === 'GYRO') {
    const { x: qx, y: qy, z: qz, w: qw } = (event as any).quaternion;
    const quat = new THREE.Quaternion(qx, qz, -qy, qw).normalize();

    // Set basis (zero point) on first gyro reading
    if (!basis) {
      basis = quat.clone().conjugate();
    }

    // IMPORTANT: multiply by HOME_ORIENTATION so gyro rotation is expressed
    // relative to the same baseline that we applied to the scene.
    // Order: quat (device) premultiplied by basis (zeroing) and then premultiplied by HOME_ORIENTATION
    // so final = HOME_ORIENTATION * (basis * quat)
    cubeQuaternion.copy(quat.premultiply(basis).premultiply(HOME_ORIENTATION));
  }
}

async function handleMoveEvent(event: GanCubeEvent) {
  if (event.type === 'MOVE') {
    if (timerState === 'READY') setTimerState('RUNNING');
    twistyPlayer.experimentalAddMove(event.move, { cancel: false });
    lastMoves.push(event);
    if (timerState === 'RUNNING') solutionMoves.push(event);
    if (lastMoves.length > 256) lastMoves = lastMoves.slice(-256);
    // optional skew calculation:
    if (lastMoves.length > 10) {
      const skew = cubeTimestampCalcSkew(lastMoves);
      // if you have a UI field, update it here (example: $('#skew').val(skew + '%'))
      console.debug('cube timestamp skew:', skew);
    }
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
  else if (event.type === 'HARDWARE') {
    // you can populate UI fields here if you want
  } else if (event.type === 'BATTERY') {
    // optional battery handler
  } else if (event.type === 'DISCONNECT') {
    twistyPlayer.alg = '';
    $('#connect').html('Connect');
  }
}

// ======================================================
// MAC provider with persistence
// ======================================================
const customMacAddressProvider: MacAddressProvider = async (device, isFallbackCall): Promise<string | null> => {
  const savedMac = localStorage.getItem('gan_cube_mac');
  if (savedMac && !isFallbackCall) {
    return savedMac;
  }

  const manualMac = prompt('Please enter your cube’s MAC address (e.g., F0:AB:12:34:56:78):');
  if (manualMac) {
    localStorage.setItem('gan_cube_mac', manualMac);
    return manualMac;
  }

  return null;
};

// ======================================================
// UI handlers: connect, reset, etc.
// ======================================================
$('#reset-state').on('click', async () => {
  await conn?.sendCubeCommand({ type: 'REQUEST_RESET' });
  twistyPlayer.alg = '';
});

$('#reset-gyro').on('click', async () => {
  basis = null; // re-calibrate on next gyro event
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
// Timer logic (unchanged behavior)
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
    `${t.minutes}:${t.seconds.toString(10).padStart(2, '0')}.${t.milliseconds.toString(10).padStart(3, '0')}`
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
  if ((event as any).which === 32) {
    event.preventDefault();
    activateTimer();
  }
});

$('#cube').on('touchstart', () => {
  activateTimer();
});
