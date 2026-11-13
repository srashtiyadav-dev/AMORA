'use strict';

const CALL_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  ...(Array.isArray(window.KINDRED_CONFIG?.iceServers) ? window.KINDRED_CONFIG.iceServers : []),
];

let kindredCallSocket = null;
let activeKindredCall = null;
const joinedCallMatches = new Set();
let matchSyncPromise = null;

function waitForCallSocket(socket) {
  if (socket.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Could not connect to the call service. Try again.')), 10000);
    socket.once('connect', () => { clearTimeout(timer); resolve(); });
    socket.once('connect_error', () => { clearTimeout(timer); reject(new Error('Could not connect to the call service. Try again.')); });
  });
}

function sendCallSignal(socket, matchId, type, data = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('call:signal', { matchId, type, data }, (error, result) => {
      if (error) return reject(new Error('The call service did not respond. Try again.'));
      if (!result?.ok) return reject(new Error(result?.error || 'Could not send the call signal.'));
      resolve(result);
    });
  });
}

function joinCallRoom(socket, matchId) {
  if (joinedCallMatches.has(matchId)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('match:join', matchId, (error, result) => {
      if (error) return reject(new Error('Could not join this match’s call room.'));
      if (!result?.ok) return reject(new Error(result?.error || 'This match is unavailable.'));
      joinedCallMatches.add(matchId);
      resolve();
    });
  });
}

async function syncCallRooms(socket) {
  if (matchSyncPromise) return matchSyncPromise;
  matchSyncPromise = (async () => {
    await waitForCallSocket(socket);
    const response = await apiRequest('/matches');
    await Promise.all((response.matches || []).map((match) => joinCallRoom(socket, match.id).catch(() => {})));
  })().finally(() => { matchSyncPromise = null; });
  return matchSyncPromise;
}

function initializeKindredCallPresence() {
  if (!BACKEND_ENABLED || !apiToken() || typeof apiSocket !== 'function') return;
  const socket = apiSocket();
  if (socket !== kindredCallSocket) {
    kindredCallSocket = socket;
    joinedCallMatches.clear();
    socket.off('call:signal', receiveKindredCallSignal);
    socket.on('call:signal', receiveKindredCallSignal);
    socket.on('connect', () => { joinedCallMatches.clear(); syncCallRooms(socket).catch(() => {}); });
    socket.on('disconnect', () => joinedCallMatches.clear());
  }
  if (socket.connected) syncCallRooms(socket).catch(() => {});
}

function setCallStatus(message) {
  if (activeKindredCall?.statusElement?.isConnected) activeKindredCall.statusElement.textContent = message;
}

function renderCallModal(call, incoming = false) {
  const isVideo = call.mediaType === 'video';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop call-backdrop';
  modal.innerHTML = `<section class="call-window" role="dialog" aria-modal="true" aria-label="${isVideo ? 'Video' : 'Voice'} call with ${escapeHtml(call.personName)}">
    <header class="call-window-head"><div><div class="eyebrow">${incoming ? 'Incoming' : 'Kindred'} ${isVideo ? 'video' : 'voice'} call</div><h2>${escapeHtml(call.personName)}</h2></div><button class="selfie-close" data-call-end aria-label="End call">×</button></header>
    <div class="call-stage ${isVideo ? 'video-stage' : 'voice-stage'}">
      <video class="call-remote-video" autoplay playsinline ${isVideo ? '' : 'hidden'}></video>
      <div class="call-avatar" ${isVideo ? 'hidden' : ''}>${escapeHtml(call.personName.slice(0,1).toUpperCase())}</div>
      <video class="call-local-video" autoplay playsinline muted ${isVideo ? '' : 'hidden'}></video>
    </div>
    <audio class="call-remote-audio" autoplay></audio>
    <p class="call-status" aria-live="polite">${incoming ? 'They’d like to talk with you.' : 'Connecting securely…'}</p>
    <div class="call-controls">${incoming ? '<button class="primary-btn" data-call-accept>Accept</button><button class="secondary-btn" data-call-decline>Decline</button>' : `<button class="secondary-btn" data-call-mute>Mute mic</button>${isVideo ? '<button class="secondary-btn" data-call-camera>Turn camera off</button>' : ''}<button class="primary-btn call-end-btn" data-call-end>End call</button>`}</div>
  </section>`;
  document.body.append(modal);
  call.modal = modal;
  call.remoteVideo = modal.querySelector('.call-remote-video');
  call.localVideo = modal.querySelector('.call-local-video');
  call.remoteAudio = modal.querySelector('.call-remote-audio');
  call.statusElement = modal.querySelector('.call-status');
  modal.querySelectorAll('[data-call-end]').forEach((button) => button.addEventListener('click', () => endKindredCall(true, 'ended')));
  modal.querySelector('[data-call-decline]')?.addEventListener('click', () => endKindredCall(true, 'declined'));
  modal.querySelector('[data-call-accept]')?.addEventListener('click', acceptKindredCall);
  modal.querySelector('[data-call-mute]')?.addEventListener('click', toggleCallMute);
  modal.querySelector('[data-call-camera]')?.addEventListener('click', toggleCallCamera);
}

function createCallPeer(call) {
  if (call.peerConnection) return call.peerConnection;
  const peer = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });
  call.peerConnection = peer;
  call.pendingIce = call.pendingIce || [];
  for (const track of call.localStream.getTracks()) peer.addTrack(track, call.localStream);
  peer.onicecandidate = ({ candidate }) => {
    if (candidate && activeKindredCall === call) {
      sendCallSignal(call.socket, call.matchId, 'ice', candidate.toJSON()).catch(() => {});
    }
  };
  peer.ontrack = ({ streams }) => {
    const [stream] = streams;
    if (!stream || activeKindredCall !== call) return;
    if (call.mediaType === 'video') {
      call.remoteVideo.srcObject = stream;
      call.remoteVideo.play().catch(() => setCallStatus('Connected. Tap the video to start playback.'));
    } else {
      call.remoteAudio.srcObject = stream;
      call.remoteAudio.play().catch(() => setCallStatus('Connected. Tap to enable call audio.'));
    }
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') setCallStatus('Connected');
    if (peer.connectionState === 'failed') setCallStatus('Could not connect. A TURN relay may be needed on this network.');
    if (peer.connectionState === 'disconnected') setCallStatus('Connection interrupted…');
  };
  return peer;
}

async function acquireCallMedia(call) {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Calls need a secure HTTPS connection and a supported browser.');
  call.localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: call.mediaType === 'video' ? { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
  if (call.mediaType === 'video') {
    call.localVideo.srcObject = call.localStream;
    call.localVideo.play().catch(() => {});
  }
}

async function applyRemoteOffer(call) {
  if (!call.accepted || !call.offer || call.remoteDescriptionApplied) return;
  const peer = createCallPeer(call);
  await peer.setRemoteDescription(new RTCSessionDescription(call.offer));
  call.remoteDescriptionApplied = true;
  for (const candidate of call.pendingIce.splice(0)) await peer.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  const answer = await peer.createAnswer();
  await peer.setLocalDescription(answer);
  await sendCallSignal(call.socket, call.matchId, 'answer', peer.localDescription.toJSON());
  setCallStatus('Calling…');
}

async function acceptKindredCall() {
  const call = activeKindredCall;
  if (!call || !call.incoming || call.accepted) return;
  const acceptButton = call.modal.querySelector('[data-call-accept]');
  if (acceptButton) acceptButton.disabled = true;
  try {
    await acquireCallMedia(call);
    call.accepted = true;
    call.modal.querySelector('.call-controls').innerHTML = `<button class="secondary-btn" data-call-mute>Mute mic</button>${call.mediaType === 'video' ? '<button class="secondary-btn" data-call-camera>Turn camera off</button>' : ''}<button class="primary-btn call-end-btn" data-call-end>End call</button>`;
    call.modal.querySelector('[data-call-mute]').onclick = toggleCallMute;
    call.modal.querySelector('[data-call-camera]')?.addEventListener('click', toggleCallCamera);
    call.modal.querySelector('[data-call-end]').onclick = () => endKindredCall(true, 'ended');
    setCallStatus('Joining call…');
    await sendCallSignal(call.socket, call.matchId, 'ready', {});
    await applyRemoteOffer(call);
  } catch (error) {
    notify(error.message || 'Could not access your microphone or camera.');
    await endKindredCall(true, 'declined');
  }
}

function receiveKindredCallSignal(message) {
  if (!message?.matchId || !message?.type) return;
  if (message.type === 'start') {
    if (activeKindredCall) {
      sendCallSignal(kindredCallSocket, message.matchId, 'end', { reason: 'busy' }).catch(() => {});
      return;
    }
    activeKindredCall = {
      matchId: message.matchId,
      socket: kindredCallSocket,
      incoming: true,
      accepted: false,
      mediaType: message.data?.mediaType === 'video' ? 'video' : 'voice',
      personName: cleanCallName(message.data?.name),
      from: message.from,
      pendingIce: [],
    };
    renderCallModal(activeKindredCall, true);
    return;
  }
  const call = activeKindredCall;
  if (!call || call.matchId !== message.matchId || call.from && call.from !== message.from) return;
  if (message.type === 'offer') {
    call.offer = message.data;
    applyRemoteOffer(call).catch((error) => { setCallStatus('Could not start the call.'); notify(error.message); });
  } else if (message.type === 'answer' && call.peerConnection) {
    call.peerConnection.setRemoteDescription(new RTCSessionDescription(message.data))
      .then(async () => { call.remoteDescriptionApplied = true; for (const candidate of call.pendingIce.splice(0)) await call.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {}); setCallStatus('Ringing…'); })
      .catch(() => setCallStatus('Could not connect. Try again.'));
  } else if (message.type === 'ice') {
    if (call.peerConnection?.remoteDescription) call.peerConnection.addIceCandidate(new RTCIceCandidate(message.data)).catch(() => {});
    else call.pendingIce.push(message.data);
  } else if (message.type === 'ready') {
    setCallStatus('Call accepted. Connecting…');
  } else if (message.type === 'end') {
    const reason = message.data?.reason;
    endKindredCall(false);
    notify(reason === 'declined' ? 'Your call was declined.' : reason === 'busy' ? 'They’re already on another call.' : 'The call ended.');
  }
}

function cleanCallName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 48) : 'Your match';
}

async function startKindredCall(person, mediaType, matchId) {
  if (!BACKEND_ENABLED || !matchId) return notify('Calls are available from an active Kindred match.');
  if (activeKindredCall) return notify('Finish your current call first.');
  if (!window.RTCPeerConnection) return notify('This browser does not support video or voice calls.');
  const socket = apiSocket();
  const call = activeKindredCall = {
    matchId,
    socket,
    incoming: false,
    accepted: true,
    mediaType: mediaType === 'video' ? 'video' : 'voice',
    personName: cleanCallName(person?.displayName || person?.name),
    pendingIce: [],
  };
  renderCallModal(call, false);
  try {
    await waitForCallSocket(socket);
    await joinCallRoom(socket, matchId);
    await acquireCallMedia(call);
    createCallPeer(call);
    await sendCallSignal(socket, matchId, 'start', { mediaType: call.mediaType, name: state.profile?.name || 'Your match' });
    const offer = await call.peerConnection.createOffer();
    await call.peerConnection.setLocalDescription(offer);
    await sendCallSignal(socket, matchId, 'offer', call.peerConnection.localDescription.toJSON());
    setCallStatus('Ringing…');
  } catch (error) {
    notify(error.message || 'Could not start the call. Check your microphone and camera permissions.');
    await endKindredCall(true, 'ended');
  }
}

async function endKindredCall(notifyRemote, reason = 'ended') {
  const call = activeKindredCall;
  if (!call) return;
  activeKindredCall = null;
  if (notifyRemote && call.socket?.connected) await sendCallSignal(call.socket, call.matchId, 'end', { reason }).catch(() => {});
  call.peerConnection?.close();
  call.localStream?.getTracks().forEach((track) => track.stop());
  if (call.modal?.isConnected) call.modal.remove();
}

function toggleCallMute(event) {
  if (!activeKindredCall?.localStream) return;
  const tracks = activeKindredCall.localStream.getAudioTracks();
  if (!tracks.length) return;
  tracks.forEach((track) => { track.enabled = !track.enabled; });
  event.currentTarget.textContent = tracks[0].enabled ? 'Mute mic' : 'Unmute mic';
}

function toggleCallCamera(event) {
  if (!activeKindredCall?.localStream) return;
  const tracks = activeKindredCall.localStream.getVideoTracks();
  if (!tracks.length) return;
  tracks.forEach((track) => { track.enabled = !track.enabled; });
  event.currentTarget.textContent = tracks[0].enabled ? 'Turn camera off' : 'Turn camera on';
}

function initializeProfilePhotoUpload() {
  document.addEventListener('click', (event) => {
    if (event.target.closest('#upload-photo')) document.getElementById('photo-input')?.click();
  });
  document.addEventListener('change', async (event) => {
    if (event.target.id !== 'photo-input' || !event.target.files?.[0]) return;
    const input = event.target;
    const file = input.files[0];
    input.value = '';
    if (!BACKEND_ENABLED || !apiToken()) return notify('Sign in to upload a profile photo.');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return notify('Choose a JPEG, PNG, or WebP image.');
    try {
      const bitmap = await createImageBitmap(file);
      const size = 720;
      const side = Math.min(bitmap.width, bitmap.height);
      const x = (bitmap.width - side) / 2;
      const y = (bitmap.height - side) / 2;
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = size;
      canvas.getContext('2d').drawImage(bitmap, x, y, side, side, 0, 0, size, size);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.8));
      if (!blob || blob.size > 800 * 1024) return notify('That image is too large after compression. Choose another photo.');
      const response = await fetch('/api/profile/photo', { method: 'PUT', headers: { Authorization: `Bearer ${apiToken()}`, 'Content-Type': 'image/jpeg' }, body: blob });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not upload that photo.');
      state.profile = { ...(state.profile || {}), img: result.photoUrl, photoUrl: result.photoUrl };
      save();
      renderProfile(document.getElementById('view'));
      notify('Your profile photo was updated.');
    } catch (error) {
      notify(error.message || 'Could not upload that photo.');
    }
  });
}

initializeProfilePhotoUpload();
