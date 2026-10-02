const app = document.querySelector('#app');
let eventSource = null;
let state = null;
let clientId = null;
let currentToken = null;
let userName = localStorage.getItem('wt-name') || '';
let activeTab = 'chat';
let suppressPlaybackEvent = false;
let localObjectUrl = '';
let hlsInstance = null;
let reconnectTimer = null;
let reconnecting = false;

const escapeHtml = (s) => String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
const formatTime = (sec) => {
  if (!Number.isFinite(sec)) return '00:00';
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  return h ? `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}` : `${String(m).padStart(2,'0')}:${String(r).padStart(2,'0')}`;
};
const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0,2).map(x => x[0]).join('').toUpperCase() || '?';

function shell(content, topRight='') {
  return `<header class="topbar"><div class="brand"><div class="logo">▶</div>WatchTogether</div><div>${topRight}</div></header><main>${content}</main><div id="toast" class="toast"></div>`;
}

function landing() {
  app.innerHTML = shell(`<div class="page landing">
    <section class="hero">
      <div class="badge"><span class="dot"></span> Sync watch parties</div>
      <h1>Watch together.<br><span>Anywhere.</span></h1>
      <p>Create a room, share a six-character code, and watch the same video in sync. Playback events, chat, and room presence stay coordinated while the actual video stream goes directly to each browser.</p>
      <div class="mini-note">Paste a direct <b>MP4</b>, <b>HLS (.m3u8)</b>, or supported hosted video link such as <b>Streamable</b>. The server resolves supported links while the actual video streams directly to each browser.</div>
      <div class="features">
        <div class="feature"><b>⏯ Sync</b><span>Play, pause, and seek together.</span></div>
        <div class="feature"><b>💬 Chat</b><span>Talk without leaving the room.</span></div>
        <div class="feature"><b>📱 Responsive</b><span>Works on phones, tablets, and PCs.</span></div>
      </div>
    </section>
    <section class="actions">
      <div class="card action-card">
        <h3>Create a room</h3>
        <p>You'll receive a room code you can send to friends.</p>
        <input id="createName" class="field" placeholder="Your name" maxlength="24" value="${escapeHtml(userName)}" />
        <button id="createRoom" class="btn btn-primary btn-wide" style="margin-top:10px">Create room</button>
      </div>
      <div class="card action-card">
        <h3>Join a room</h3>
        <p>Enter a room code and start watching.</p>
        <input id="joinName" class="field" placeholder="Your name" maxlength="24" value="${escapeHtml(userName)}" />
        <input id="joinToken" class="field" style="margin-top:10px; text-transform:uppercase; letter-spacing:.16em" placeholder="ABC123" maxlength="6" />
        <button id="joinRoom" class="btn btn-wide" style="margin-top:10px">Join room</button>
      </div>
    </section>
  </div>`);

  document.querySelector('#createRoom').onclick = async () => {
    const name = document.querySelector('#createName').value.trim() || 'Guest';
    saveName(name);
    try {
      const r = await fetch('/api/rooms', { method:'POST' });
      const data = await r.json();
      openRoom(data.token);
    } catch { toast('Could not create the room. Is the server running?'); }
  };
  document.querySelector('#joinRoom').onclick = () => {
    const name = document.querySelector('#joinName').value.trim() || 'Guest';
    const token = document.querySelector('#joinToken').value.trim().toUpperCase();
    if (token.length !== 6) return toast('Enter a 6-character room code.');
    saveName(name);
    openRoom(token);
  };
}

function saveName(name) { userName = name || 'Guest'; localStorage.setItem('wt-name', userName); }

function openRoom(token) {
  currentToken = token;
  history.pushState({}, '', `?room=${encodeURIComponent(token)}`);
  renderRoomShell();
  connect();
}

function renderRoomShell() {
  app.innerHTML = shell(`<div class="room">
    <section class="video-pane">
      <div class="room-head">
        <div class="room-title"><h2 id="roomVideoTitle">No video selected</h2><p>Room <strong id="roomTokenLabel">${escapeHtml(currentToken || '')}</strong> · <span id="memberCount">0</span> watching</p></div>
        <div class="room-actions">
          <span class="badge"><span class="dot"></span><span id="connectionStatus">Connecting</span></span>
          <button class="btn btn-ghost small" id="copyInvite">Copy invite</button>
          <button class="btn btn-ghost small" id="leaveRoom">Leave</button>
        </div>
      </div>
      <div class="video-shell">
        <video id="video" playsinline controls preload="metadata"></video>
        <div id="emptyVideo" class="empty-video"><div><strong>No video loaded</strong>Use a direct MP4/HLS URL or choose a local file below. A local file is only visible on this device.</div></div>
      </div>
      <div class="control-card">
        <div class="control-row">
          <button class="btn btn-ghost small" id="playPause">▶ Play</button>
          <button class="btn btn-ghost small" id="back10">↶ 10s</button>
          <button class="btn btn-ghost small" id="forward10">10s ↷</button>
          <div class="timebar"><input id="seek" class="range" type="range" min="0" max="100" value="0" step="0.1" /></div>
          <span class="badge" id="timeLabel">00:00 / 00:00</span>
        </div>
      </div>
      <div class="card video-source">
        <div class="source-row"><input id="videoUrl" class="field" placeholder="MP4, HLS, or Streamable link" /><button id="loadUrl" class="btn btn-primary">Load video</button><input id="fileInput" type="file" accept="video/*" hidden /><button id="pickFile" class="btn btn-ghost">Local file</button></div>
        <div class="settings"><span>Playback control: <b id="controlMode">Host only</b></span><label class="switch" title="Host can enable this"><input id="allowControl" type="checkbox" /><span class="slider"></span></label></div>
      </div>
    </section>
    <aside class="side">
      <div class="side-top"><div class="side-tabs"><button class="tab active" data-tab="chat">Chat</button><button class="tab" data-tab="members">Members</button></div></div>
      <div class="side-content">
        <div id="chatPanel" class="chat-list"></div>
        <div id="memberPanel" class="member-list hidden"></div>
        <form id="chatForm" class="chat-input"><input id="chatText" class="field" maxlength="500" placeholder="Say something…" autocomplete="off" /><button class="btn btn-primary">Send</button></form>
      </div>
    </aside>
  </div>`);

  document.querySelectorAll('.tab').forEach(btn => btn.onclick = () => { activeTab = btn.dataset.tab; renderSide(); });
  document.querySelector('#copyInvite').onclick = async () => {
    const link = `${location.origin}/?room=${currentToken}`;
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(link);
      else throw new Error();
      toast('Invite link copied.');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  };
  document.querySelector('#leaveRoom').onclick = async () => { await trySend({type:'leave'}); eventSource?.close(); eventSource = null; history.pushState({}, '', '/'); landing(); };
  document.querySelector('#chatForm').onsubmit = e => { e.preventDefault(); const input = document.querySelector('#chatText'); const text = input.value.trim(); if (!text) return; trySend({type:'chat', text}); input.value=''; };
  document.querySelector('#loadUrl').onclick = () => { const url = document.querySelector('#videoUrl').value.trim(); if (!url) return toast('Paste a direct video URL.'); trySend({type:'set_video', url, title: url.split('/').pop()?.split('?')[0] || 'Video'}); };
  document.querySelector('#pickFile').onclick = () => document.querySelector('#fileInput').click();
  document.querySelector('#fileInput').onchange = e => {
    const file = e.target.files?.[0]; if (!file) return;
    if (localObjectUrl) URL.revokeObjectURL(localObjectUrl);
    localObjectUrl = URL.createObjectURL(file);
    setVideoElement(localObjectUrl, file.name);
    document.querySelector('#video').dataset.local = '1';
    toast('Local preview loaded only on this device.');
  };
  document.querySelector('#allowControl').onchange = e => trySend({type:'set_control', allowControl:e.target.checked});

  const video = document.querySelector('#video');
  video.addEventListener('loadedmetadata', () => {
    updateTime();
    selectPreferredAudio(video);
  });
  video.addEventListener('error', () => {
    if (video.dataset.local === '1') return;
    document.querySelector('#emptyVideo').classList.remove('hidden');
    toast('The video could not be decoded or the stream is unavailable.');
  });
  video.addEventListener('timeupdate', updateTime);
  video.addEventListener('play', () => {
    if (suppressPlaybackEvent || !state || video.dataset.local === '1' || !canControlLocal()) return;
    trySend({type:'playback', action:'play', position:video.currentTime});
  });
  video.addEventListener('pause', () => {
    if (suppressPlaybackEvent || !state || video.dataset.local === '1' || !canControlLocal()) return;
    trySend({type:'playback', action:'pause', position:video.currentTime});
  });
  document.querySelector('#playPause').onclick = () => togglePlay();
  document.querySelector('#back10').onclick = () => seekBy(-10);
  document.querySelector('#forward10').onclick = () => seekBy(10);
  document.querySelector('#seek').oninput = (e) => {
    const v = document.querySelector('#video');
    if (!v.duration) return;
    v.currentTime = Number(e.target.value) / 100 * v.duration;
  };
  document.querySelector('#seek').onchange = () => {
    if (!canControlLocal()) return toast('Only the host can control playback right now.');
    const v = document.querySelector('#video');
    trySend({type:'playback', action:v.paused?'pause':'play', position:v.currentTime});
  };
}

async function connect() {
  clientId = sessionStorage.getItem('wt-client-id') || crypto.randomUUID();
  sessionStorage.setItem('wt-client-id', clientId);
  setConnection('Connecting');
  eventSource?.close();
  try {
    const roomUrl = `/api/rooms/${encodeURIComponent(currentToken)}`;
    const probe = await fetch(roomUrl, { cache: 'no-store' });
    if (!probe.ok) throw new Error('Room not found');

    const joinResponse = await fetch(`${roomUrl}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name: userName || 'Guest' }),
    });
    const data = await joinResponse.json().catch(() => ({}));
    if (!joinResponse.ok) throw new Error(data.error || 'Could not join');
    clientId = data.clientId;
    sessionStorage.setItem('wt-client-id', clientId);
    applyRoom(data.room);

    eventSource = new EventSource(`/events?token=${encodeURIComponent(currentToken)}&clientId=${encodeURIComponent(clientId)}`);
    eventSource.addEventListener('state', e => { try { applyRoom(JSON.parse(e.data)); } catch {} });
    eventSource.addEventListener('chat', e => {
      try {
        const message = JSON.parse(e.data);
        if (!state) return;
        state.messages = [...(state.messages || []), message].slice(-100);
        renderChat();
      } catch {}
    });
    eventSource.onopen = () => {
      reconnecting = false;
      clearTimeout(reconnectTimer);
      setConnection('Connected');
    };
    eventSource.onerror = () => {
      if (reconnecting) return;
      reconnecting = true;
      setConnection('Reconnecting…');
      eventSource?.close();
      eventSource = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        reconnecting = false;
        if (currentToken) connect();
      }, 1500);
    };
  } catch (err) {
    eventSource?.close();
    eventSource = null;
    setConnection('Connection error');
    toast(err.message || 'Room not found or server unavailable.');
  }
}

async function trySend(msg) {
  if (!currentToken || !clientId) return false;
  try {
    const r = await fetch(`/api/rooms/${encodeURIComponent(currentToken)}/action`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...msg,clientId})});
    if (!r.ok) { const d=await r.json().catch(()=>({})); if(d.error) toast(d.error); return false; }
    return true;
  } catch { toast('Connection lost.'); return false; }
}

function setConnection(text) { const el=document.querySelector('#connectionStatus'); if(el) el.textContent=text; }
function canControlLocal() { return Boolean(state && (state.allowControl || state.hostId === clientId)); }

function handleMessage(msg) {
  if (msg.type === 'hello') clientId = msg.clientId;
  if (msg.type === 'joined') applyRoom(msg.room);
  if (msg.type === 'state') applyRoom(msg.room);
  if (msg.type === 'chat') { state?.messages?.push(msg.message); renderChat(); }
  if (msg.type === 'error') toast(msg.message);
}

function applyRoom(room) {
  state = room;
  renderRoomMeta();
  renderMembers();
  renderChat();
  const allow = document.querySelector('#allowControl');
  const isHost = state.hostId === clientId;
  allow.checked = state.allowControl;
  allow.disabled = !isHost;
  document.querySelector('#controlMode').textContent = state.allowControl ? 'Everyone' : 'Host only';
  document.querySelectorAll('.control-card button, #seek, #loadUrl').forEach(el => { el.disabled = !canControlLocal(); });
  if (state.videoUrl && state.videoUrl !== document.querySelector('#video')?.dataset.url) {
    setVideoElement(state.videoUrl, state.videoTitle, false);
  }
  syncPlayback();
}

function renderRoomMeta() {
  document.querySelector('#roomVideoTitle').textContent = state.videoTitle || 'No video selected';
  document.querySelector('#roomTokenLabel').textContent = state.token;
  document.querySelector('#memberCount').textContent = state.members.length;
}
function renderMembers() {
  if (!state) return;
  document.querySelector('#memberPanel').innerHTML = state.members.map(m => `<div class="member"><div class="avatar">${escapeHtml(initials(m.name))}</div><div class="member-main"><div class="member-name">${escapeHtml(m.name)}</div><div class="member-role">${m.isHost ? 'Host' : 'Viewer'}</div></div></div>`).join('');
}
function renderChat() {
  const panel=document.querySelector('#chatPanel'); if(!panel) return;
  panel.innerHTML = (state?.messages || []).map(m => `<div class="chat-msg"><div class="chat-meta">${escapeHtml(m.sender)} · ${new Date(m.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div><div class="chat-bubble">${escapeHtml(m.text)}</div></div>`).join('') || `<div style="color:var(--muted);font-size:13px;padding:20px 6px;text-align:center">No messages yet. Say hello 👋</div>`;
  panel.scrollTop = panel.scrollHeight;
}
function renderSide() {
  document.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===activeTab));
  document.querySelector('#chatPanel').classList.toggle('hidden', activeTab!=='chat');
  document.querySelector('#memberPanel').classList.toggle('hidden', activeTab!=='members');
  document.querySelector('#chatForm').classList.toggle('hidden', activeTab!=='chat');
}
function selectPreferredAudio(video) {
  const tracks = video?.audioTracks;
  if (!tracks?.length) return false;
  let foundHindi = false;
  for (const track of tracks) {
    const language = String(track.language || '').toLowerCase();
    const label = String(track.label || '').toLowerCase();
    const hindi = /^(hin|hi)([-_]|$)/.test(language) || /(^|[^a-z])hindi([^a-z]|$)/.test(label);
    track.enabled = hindi;
    foundHindi ||= hindi;
  }
  return foundHindi;
}

function setVideoElement(url, title, autoplayState = true) {
  const video=document.querySelector('#video'); if(!video) return;
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.dataset.url=url;
  video.dataset.local = url.startsWith('blob:') ? '1' : '0';
  const isHls = /\.m3u8(?:$|[?#])/i.test(url);
  if (isHls && window.Hls && window.Hls.isSupported()) {
    hlsInstance = new window.Hls({ enableWorker: true, lowLatencyMode: true });
    hlsInstance.loadSource(url);
    hlsInstance.attachMedia(video);
  } else {
    video.src=url;
  }
  document.querySelector('#emptyVideo').classList.add('hidden');
  document.querySelector('#roomVideoTitle').textContent = title || 'Video';
  if (autoplayState && state?.playing) setTimeout(syncPlayback, 250);
}
function syncPlayback() {
  const video=document.querySelector('#video'); if(!video || !state) return;
  if (!state.videoUrl && !video.src) return;
  const target = Math.max(0, Number(state.position || 0));
  if (Number.isFinite(video.duration)) {
    const drift = Math.abs(video.currentTime - target);
    if (drift > 0.7) { suppressPlaybackEvent=true; video.currentTime=target; setTimeout(()=>suppressPlaybackEvent=false,50); }
  }
  suppressPlaybackEvent=true;
  const p = state.playing ? video.play() : video.pause();
  if (p?.catch) p.catch(()=>{});
  setTimeout(()=>suppressPlaybackEvent=false, 100);
  updateTime();
}
function togglePlay(){
  if (!canControlLocal()) return toast('Only the host can control playback right now.');
  const video=document.querySelector('#video');
  if (video.paused) { video.play().catch(()=>{}); trySend({type:'playback',action:'play',position:video.currentTime}); }
  else { video.pause(); trySend({type:'playback',action:'pause',position:video.currentTime}); }
}
function seekBy(delta){ if(!canControlLocal()) return toast('Only the host can control playback right now.'); const v=document.querySelector('#video'); v.currentTime=Math.max(0,(v.currentTime||0)+delta); trySend({type:'playback',action:v.paused?'pause':'play',position:v.currentTime}); }
function updateTime(){
  const v=document.querySelector('#video'); if(!v) return;
  const seek=document.querySelector('#seek');
  seek.value = v.duration ? (v.currentTime / v.duration) * 100 : 0;
  document.querySelector('#timeLabel').textContent = `${formatTime(v.currentTime)} / ${formatTime(v.duration)}`;
  document.querySelector('#playPause').textContent = v.paused ? '▶ Play' : '⏸ Pause';
}
function toast(text){ const t=document.querySelector('#toast'); if(!t)return; t.textContent=text;t.classList.add('show');clearTimeout(window.__toast);window.__toast=setTimeout(()=>t.classList.remove('show'),2200); }

function bootstrap() {
  const token = new URLSearchParams(location.search).get('room');
  if (token) { currentToken = token.toUpperCase(); renderRoomShell(); connect(); }
  else landing();
}
window.addEventListener('popstate', bootstrap);
bootstrap();
