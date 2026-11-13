'use strict';

const CALL_ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  ...(Array.isArray(window.KINDRED_CONFIG?.iceServers) ? window.KINDRED_CONFIG.iceServers : []),
];

let kindredCallSocket = null;
let activeAMORACall = null;
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

function sendCallSignal(socket, matchId, type, data = {}, callId) {
  return new Promise((resolve, reject) => {
    socket.timeout(8000).emit('call:signal', { matchId, type, data, callId }, (error, result) => {
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

function initializeAMORACallPresence() {
  if (!BACKEND_ENABLED || !apiToken() || typeof apiSocket !== 'function') return;
  const socket = apiSocket();
  if (socket !== kindredCallSocket) {
    kindredCallSocket = socket;
    joinedCallMatches.clear();
    socket.off('call:signal', receiveAMORACallSignal);
    socket.on('call:signal', receiveAMORACallSignal);
    if (!socket.kindredMessageAlertsAttached) {
      socket.kindredMessageAlertsAttached = true;
      socket.on('message:new', handleAMORAMessage);
    }
    socket.on('connect', () => { joinedCallMatches.clear(); syncCallRooms(socket).catch(() => {}); });
    socket.on('disconnect', () => joinedCallMatches.clear());
  }
  if (socket.connected) syncCallRooms(socket).catch(() => {});
}

function handleAMORAMessage(message) {
  if (message?.senderId !== state.profile?.id) showAMORANotification('New AMORA message', message?.body || 'You have a new message.', `message-${message?.id || Date.now()}`);
  if (state.tab === 'messages' && state.selectedChat === message?.matchId) {
    const view = document.getElementById('view');
    if (view) renderApiMessages(view, { preserveScroll: true });
  }
}

function setCallStatus(message) {
  if (activeAMORACall?.statusElement?.isConnected) activeAMORACall.statusElement.textContent = message;
}

function startCallDuration(call) {
  if (call.durationTimer || activeAMORACall !== call) return;
  call.connectedAt = Date.now();
  const update = () => {
    const elapsed = Math.floor((Date.now() - call.connectedAt) / 1000);
    setCallStatus(`Connected · ${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`);
  };
  update();
  call.durationTimer = setInterval(update, 1000);
}

function showAMORANotification(title, body, tag) {
  if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const popup = new Notification(title, { body, tag, icon: '/favicon.ico' });
      popup.onclick = () => { window.focus(); popup.close(); };
    } catch { /* Browser may disable notifications for this tab. */ }
  } else if (!document.hidden && typeof notify === 'function') notify(`${title}: ${body}`);
}

async function requestAMORANotifications() {
  if (!('Notification' in window)) return notify('This browser does not support notifications.');
  if (Notification.permission === 'granted') return notify('Browser notifications are already enabled.');
  if (Notification.permission === 'denied') return notify('Notifications are blocked in browser settings.');
  try {
    const permission = await Notification.requestPermission();
    notify(permission === 'granted' ? 'Browser notifications enabled.' : 'Notifications were not enabled.');
  } catch { notify('Could not enable browser notifications. Check this site’s browser permissions.'); }
}

function renderCallModal(call, incoming = false) {
  const isVideo = call.mediaType === 'video';
  const modal = document.createElement('div');
  modal.className = 'modal-backdrop call-backdrop';
  modal.innerHTML = `<section class="call-window" role="dialog" aria-modal="true" aria-label="${isVideo ? 'Video' : 'Voice'} call with ${escapeHtml(call.personName)}">
    <header class="call-window-head"><div><div class="eyebrow">${incoming ? 'Incoming' : 'AMORA'} ${isVideo ? 'video' : 'voice'} call</div><h2>${escapeHtml(call.personName)}</h2></div><button class="selfie-close" data-call-end aria-label="End call">×</button></header>
    <div class="call-stage ${isVideo ? 'video-stage' : 'voice-stage'}">
      <video class="call-remote-video" autoplay playsinline ${isVideo ? '' : 'hidden'}></video>
      <div class="call-avatar ${isVideo ? 'video-placeholder' : ''}">${call.personPhoto ? `<img src="${escapeHtml(call.personPhoto)}" alt="">` : `<span>${escapeHtml(call.personName.slice(0,1).toUpperCase())}</span>`}</div>
      <video class="call-local-video" autoplay playsinline muted ${isVideo ? '' : 'hidden'}></video>
    </div>
    <audio class="call-remote-audio" autoplay></audio>
    <p class="call-status" aria-live="polite">${incoming ? 'They’d like to talk with you.' : 'Connecting securely…'}</p>
    <div class="call-controls">${incoming ? '<button class="call-control-btn accept" data-call-accept><span class="call-control-icon">☎</span><span>Accept</span></button><button class="call-control-btn danger" data-call-decline><span class="call-control-icon">×</span><span>Decline</span></button>' : `<button class="call-control-btn" data-call-mute><span class="call-control-icon">🎙</span><span>Mute mic</span></button>${isVideo ? '<button class="call-control-btn" data-call-camera><span class="call-control-icon">▣</span><span>Camera off</span></button>' : ''}<button class="call-control-btn danger" data-call-end><span class="call-control-icon">☎</span><span>End call</span></button>`}</div>
  </section>`;
  document.body.append(modal);
  call.modal = modal;
  call.remoteVideo = modal.querySelector('.call-remote-video');
  call.localVideo = modal.querySelector('.call-local-video');
  call.remoteAudio = modal.querySelector('.call-remote-audio');
  call.statusElement = modal.querySelector('.call-status');
  modal.querySelectorAll('[data-call-end]').forEach((button) => button.addEventListener('click', () => endAMORACall(true, 'ended')));
  modal.querySelector('[data-call-decline]')?.addEventListener('click', () => endAMORACall(true, 'declined'));
  modal.querySelector('[data-call-accept]')?.addEventListener('click', acceptAMORACall);
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
    if (candidate && activeAMORACall === call) {
      sendCallSignal(call.socket, call.matchId, 'ice', candidate.toJSON(), call.callId).catch(() => {});
    }
  };
  peer.ontrack = ({ streams }) => {
    const [stream] = streams;
    if (!stream || activeAMORACall !== call) return;
    if (call.mediaType === 'video') {
      call.modal.querySelector('.call-avatar')?.setAttribute('hidden', '');
      call.remoteVideo.srcObject = stream;
      call.remoteVideo.play().catch(() => setCallStatus('Connected. Tap the video to start playback.'));
    } else {
      call.remoteAudio.srcObject = stream;
      call.remoteAudio.play().catch(() => setCallStatus('Connected. Tap to enable call audio.'));
    }
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === 'connected') startCallDuration(call);
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
  await sendCallSignal(call.socket, call.matchId, 'answer', peer.localDescription.toJSON(), call.callId);
  setCallStatus('Calling…');
}

async function acceptAMORACall() {
  const call = activeAMORACall;
  if (!call || !call.incoming || call.accepted) return;
  const acceptButton = call.modal.querySelector('[data-call-accept]');
  if (acceptButton) acceptButton.disabled = true;
  try {
    await acquireCallMedia(call);
    call.accepted = true;
    call.modal.querySelector('.call-controls').innerHTML = `<button class="call-control-btn" data-call-mute><span class="call-control-icon">🎙</span><span>Mute mic</span></button>${call.mediaType === 'video' ? '<button class="call-control-btn" data-call-camera><span class="call-control-icon">▣</span><span>Camera off</span></button>' : ''}<button class="call-control-btn danger" data-call-end><span class="call-control-icon">☎</span><span>End call</span></button>`;
    call.modal.querySelector('[data-call-mute]').onclick = toggleCallMute;
    call.modal.querySelector('[data-call-camera]')?.addEventListener('click', toggleCallCamera);
    call.modal.querySelector('[data-call-end]').onclick = () => endAMORACall(true, 'ended');
    setCallStatus('Joining call…');
    await sendCallSignal(call.socket, call.matchId, 'ready', {}, call.callId);
    await applyRemoteOffer(call);
  } catch (error) {
    notify(error.message || 'Could not access your microphone or camera.');
    await endAMORACall(true, 'declined');
  }
}

function receiveAMORACallSignal(message) {
  if (!message?.matchId || !message?.type) return;
  if (message.type === 'start') {
    showAMORANotification('Incoming call', `${cleanCallName(message.data?.name)} is calling you.`, `call-${message.callId||message.matchId}`);
    if (activeAMORACall) {
      sendCallSignal(kindredCallSocket, message.matchId, 'end', { reason: 'busy' }, message.callId).catch(() => {});
      return;
    }
    activeAMORACall = {
      matchId: message.matchId,
      callId: message.callId,
      socket: kindredCallSocket,
      incoming: true,
      accepted: false,
      mediaType: message.data?.mediaType === 'video' ? 'video' : 'voice',
      personName: cleanCallName(message.data?.name),
      personPhoto: typeof message.data?.photoUrl === 'string' ? message.data.photoUrl.slice(0, 2048) : '',
      from: message.from,
      pendingIce: [],
    };
    renderCallModal(activeAMORACall, true);
    return;
  }
  const call = activeAMORACall;
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
    call.answered = true;
    clearTimeout(call.ringTimer);
    setCallStatus('Call accepted. Connecting…');
  } else if (message.type === 'end') {
    const reason = message.data?.reason;
    if (reason === 'no-answer' && call.incoming) showAMORANotification('Missed call', `${call.personName} tried to call you.`, `missed-${call.callId}`);
    endAMORACall(false);
    if (reason === 'no-answer') notify(`Missed call from ${call.personName}.`);
    else notify(reason === 'declined' ? 'Your call was declined.' : reason === 'busy' ? 'They’re already on another call.' : 'The call ended.');
  }
}

function cleanCallName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 48) : 'Your match';
}

async function startAMORACall(person, mediaType, matchId) {
  if (!BACKEND_ENABLED || !matchId) return notify('Calls are available from an active AMORA match.');
  if (activeAMORACall) return notify('Finish your current call first.');
  if (!window.RTCPeerConnection) return notify('This browser does not support video or voice calls.');
  const socket = apiSocket();
  const call = activeAMORACall = {
    matchId,
    socket,
    incoming: false,
    accepted: true,
    mediaType: mediaType === 'video' ? 'video' : 'voice',
    personName: cleanCallName(person?.displayName || person?.name),
    personPhoto: typeof (person?.photoUrl || person?.img) === 'string' ? (person.photoUrl || person.img).slice(0, 2048) : '',
    pendingIce: [],
  };
  renderCallModal(call, false);
  try {
    await waitForCallSocket(socket);
    await joinCallRoom(socket, matchId);
    await acquireCallMedia(call);
    createCallPeer(call);
    const started = await sendCallSignal(socket, matchId, 'start', { mediaType: call.mediaType, name: state.profile?.name || 'Your match', photoUrl: state.profile?.avatar ? avatarImage(state.profile.avatar) : state.profile?.img || '' });
    call.callId = started.callId;
    call.ringTimer = setTimeout(() => {
      if (activeAMORACall === call && !call.answered) {
        notify(`No answer from ${call.personName}.`);
        endAMORACall(true, 'no-answer');
      }
    }, 45000);
    const offer = await call.peerConnection.createOffer();
    await call.peerConnection.setLocalDescription(offer);
    await sendCallSignal(socket, matchId, 'offer', call.peerConnection.localDescription.toJSON(), call.callId);
    setCallStatus('Ringing…');
  } catch (error) {
    notify(error.message || 'Could not start the call. Check your microphone and camera permissions.');
    await endAMORACall(true, 'ended');
  }
}

async function endAMORACall(notifyRemote, reason = 'ended') {
  const call = activeAMORACall;
  if (!call) return;
  activeAMORACall = null;
  clearTimeout(call.ringTimer);
  clearInterval(call.durationTimer);
  if (notifyRemote && call.socket?.connected) await sendCallSignal(call.socket, call.matchId, 'end', { reason }, call.callId).catch(() => {});
  call.peerConnection?.close();
  call.localStream?.getTracks().forEach((track) => track.stop());
  if (call.modal?.isConnected) call.modal.remove();
}

function toggleCallMute(event) {
  if (!activeAMORACall?.localStream) return;
  const tracks = activeAMORACall.localStream.getAudioTracks();
  if (!tracks.length) return;
  tracks.forEach((track) => { track.enabled = !track.enabled; });
  const label = tracks[0].enabled ? 'Mute mic' : 'Unmute mic';
  event.currentTarget.querySelector('span:last-child').textContent = label;
  event.currentTarget.classList.toggle('is-off', !tracks[0].enabled);
}

function toggleCallCamera(event) {
  if (!activeAMORACall?.localStream) return;
  const tracks = activeAMORACall.localStream.getVideoTracks();
  if (!tracks.length) return;
  tracks.forEach((track) => { track.enabled = !track.enabled; });
  const label = tracks[0].enabled ? 'Camera off' : 'Camera on';
  event.currentTarget.querySelector('span:last-child').textContent = label;
  event.currentTarget.classList.toggle('is-off', !tracks[0].enabled);
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
      const freshPhotoUrl = `${result.photoUrl}?v=${Date.now()}`;
      state.profile = { ...(state.profile || {}), img: freshPhotoUrl, photoUrl: freshPhotoUrl, avatar: '' };
      save();
      renderProfile(document.getElementById('view'));
      notify('Your profile photo was updated.');
    } catch (error) {
      notify(error.message || 'Could not upload that photo.');
    }
  });
}

initializeProfilePhotoUpload();
