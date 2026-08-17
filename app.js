const SPOTIFY_API = "https://api.spotify.com/v1";
const ACCOUNTS_API = "https://accounts.spotify.com";
const STORAGE_KEY = "turntable-ios.session";
const scopes = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing"];

const $ = selector => document.querySelector(selector);
const setup = $("#setup"), player = $("#player"), clientIdInput = $("#client-id");
const state = { session: loadSession(), playback: null, lyrics: [], refreshTimer: null, progressTimer: null };
const redirectUri = new URL("./", location.href).href;
$("#redirect-uri").textContent = redirectUri;

function loadSession() { try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; } }
function saveSession() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.session)); }
function setStatus(message) { $("#connection").textContent = message; }
function showApp() { const signedIn = Boolean(state.session.access_token); setup.hidden = signedIn; player.hidden = !signedIn; clientIdInput.value = state.session.client_id || ""; }
function base64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomString() { const bytes = crypto.getRandomValues(new Uint8Array(64)); return base64url(bytes); }
async function challengeFor(verifier) { const data = new TextEncoder().encode(verifier); return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", data))); }

async function connect() {
  const clientId = clientIdInput.value.trim();
  if (!clientId) return alert("Paste the Spotify Client ID first.");
  const verifier = randomString();
  const oauthState = randomString();
  sessionStorage.setItem("turntable.pkce.verifier", verifier);
  sessionStorage.setItem("turntable.pkce.state", oauthState);
  state.session.client_id = clientId; saveSession();
  const query = new URLSearchParams({ client_id: clientId, response_type: "code", redirect_uri: redirectUri, scope: scopes.join(" "), state: oauthState, code_challenge_method: "S256", code_challenge: await challengeFor(verifier) });
  location.assign(`${ACCOUNTS_API}/authorize?${query}`);
}

async function completeAuthorization() {
  const params = new URLSearchParams(location.search);
  const code = params.get("code");
  if (!code) return;
  const expectedState = sessionStorage.getItem("turntable.pkce.state");
  const verifier = sessionStorage.getItem("turntable.pkce.verifier");
  if (!verifier || params.get("state") !== expectedState) throw new Error("The Spotify sign-in response could not be verified. Please try again.");
  const response = await fetch(`${ACCOUNTS_API}/api/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: state.session.client_id, grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }) });
  const tokens = await response.json();
  if (!response.ok) throw new Error(tokens.error_description || "Spotify did not complete sign-in.");
  state.session = { ...state.session, ...tokens, expires_at: Date.now() + tokens.expires_in * 1000 }; saveSession();
  sessionStorage.removeItem("turntable.pkce.verifier"); sessionStorage.removeItem("turntable.pkce.state");
  history.replaceState({}, document.title, redirectUri);
}

async function token() {
  if (!state.session.refresh_token) throw new Error("Connect Spotify first.");
  if (state.session.expires_at > Date.now() + 45_000) return state.session.access_token;
  const response = await fetch(`${ACCOUNTS_API}/api/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: state.session.client_id, grant_type: "refresh_token", refresh_token: state.session.refresh_token }) });
  const refreshed = await response.json();
  if (!response.ok) throw new Error(refreshed.error_description || "Spotify session expired. Connect again.");
  state.session = { ...state.session, ...refreshed, refresh_token: refreshed.refresh_token || state.session.refresh_token, expires_at: Date.now() + refreshed.expires_in * 1000 }; saveSession(); return state.session.access_token;
}

async function spotify(path, options = {}) {
  const response = await fetch(`${SPOTIFY_API}${path}`, { ...options, headers: { Authorization: `Bearer ${await token()}`, ...(options.headers || {}) } });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `Spotify request failed (${response.status}).`);
  return data;
}
function format(ms = 0) { const seconds = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function artworkUrl(playback) { return playback?.item?.album?.images?.[0]?.url || ""; }

function renderPlayback(playback) {
  state.playback = playback;
  const item = playback?.item;
  $("#track-title").textContent = item?.name || "Start a song in Spotify";
  $("#artist-name").textContent = item?.artists?.map(artist => artist.name).join(", ") || "Then return here to control it.";
  $("#label-title").textContent = item?.name || "No track playing";
  $("#device-name").textContent = playback?.device ? `${playback.device.name} · ${playback.device.type}` : "Choose a Spotify playback device";
  $("#artwork").src = artworkUrl(playback); $("#artwork").hidden = !item;
  $("#record").classList.toggle("playing", Boolean(playback?.is_playing));
  $("#play").textContent = playback?.is_playing ? "Ⅱ" : "▶";
  $("#play").setAttribute("aria-label", playback?.is_playing ? "Pause" : "Play");
  $("#progress").max = item?.duration_ms || 100; $("#progress").value = playback?.progress_ms || 0;
  $("#elapsed").textContent = format(playback?.progress_ms); $("#duration").textContent = format(item?.duration_ms);
  $("#volume").value = playback?.device?.volume_percent ?? 50;
}

async function refreshPlayback({ lyrics = true } = {}) {
  try {
    const playback = await spotify("/me/player"); renderPlayback(playback);
    setStatus(playback ? "Connected" : "No active playback");
    if (lyrics && playback?.item?.id !== state.lyricTrack) await loadLyrics(playback);
  } catch (error) { setStatus(error.message); }
}
async function loadLyrics(playback) {
  state.lyricTrack = playback.item?.id; state.lyrics = []; $("#lyrics").textContent = "Loading lyrics…";
  try {
    const query = new URLSearchParams({ track_name: playback.item.name, artist_name: playback.item.artists?.[0]?.name || "", album_name: playback.item.album?.name || "", duration: String(Math.round(playback.item.duration_ms / 1000)) });
    const response = await fetch(`https://lrclib.net/api/get?${query}`);
    if (!response.ok) throw new Error("No lyrics found.");
    const lyric = await response.json();
    state.lyrics = parseSynced(lyric.syncedLyrics || "");
    $("#lyrics").textContent = lyric.syncedLyrics || lyric.plainLyrics || "Lyrics are not available for this track.";
    if (state.lyrics.length) renderLyrics(playback.progress_ms || 0);
  } catch { $("#lyrics").textContent = "Lyrics are not available for this track."; }
}
function parseSynced(text) { return [...text.matchAll(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/gm)].map(match => ({ at: (Number(match[1]) * 60 + Number(match[2])) * 1000, text: match[3] })); }
function renderLyrics(progress) {
  const active = state.lyrics.reduce((index, line, next) => line.at <= progress ? next : index, -1);
  $("#lyrics").replaceChildren(...state.lyrics.map((line, index) => { const p = document.createElement("p"); p.textContent = line.text; if (index === active) p.className = "active"; return p; }));
}
async function command(path, options) { try { await spotify(path, options); await refreshPlayback({ lyrics: false }); } catch (error) { setStatus(error.message); } }
async function chooseDevices() {
  const dialog = $("#device-dialog"), list = $("#device-list"); list.replaceChildren();
  try {
    const { devices } = await spotify("/me/player/devices");
    if (!devices.length) { list.textContent = "Open Spotify on a device and start playback first."; }
    for (const device of devices) {
      const fragment = $("#device-template").content.cloneNode(true); const button = fragment.querySelector("button");
      fragment.querySelector(".device-title").textContent = device.name; fragment.querySelector(".device-meta").textContent = `${device.type}${device.is_active ? " · Active" : ""}`; button.classList.toggle("active", device.is_active);
      button.addEventListener("click", async () => { await command("/me/player", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device_ids: [device.id], play: state.playback?.is_playing || false }) }); dialog.close(); }); list.append(fragment);
    }
  } catch (error) { list.textContent = error.message; }
  dialog.showModal();
}
function startTimers() {
  clearInterval(state.refreshTimer); clearInterval(state.progressTimer);
  state.refreshTimer = setInterval(refreshPlayback, 8_000);
  state.progressTimer = setInterval(() => { if (!state.playback?.is_playing) return; state.playback.progress_ms += 1_000; $("#progress").value = state.playback.progress_ms; $("#elapsed").textContent = format(state.playback.progress_ms); if (state.lyrics.length) renderLyrics(state.playback.progress_ms); }, 1_000);
}
function disconnect() { localStorage.removeItem(STORAGE_KEY); state.session = {}; clearInterval(state.refreshTimer); clearInterval(state.progressTimer); showApp(); }

$("#connect").addEventListener("click", connect); $("#disconnect").addEventListener("click", disconnect); $("#devices").addEventListener("click", chooseDevices); $("#close-devices").addEventListener("click", () => $("#device-dialog").close());
$("#play").addEventListener("click", () => command(state.playback?.is_playing ? "/me/player/pause" : "/me/player/play", { method: "PUT" }));
$("#previous").addEventListener("click", () => command("/me/player/previous", { method: "POST" })); $("#next").addEventListener("click", () => command("/me/player/next", { method: "POST" }));
$("#progress").addEventListener("change", event => command(`/me/player/seek?position_ms=${Math.round(event.target.value)}`, { method: "PUT" }));
$("#volume").addEventListener("change", event => command(`/me/player/volume?volume_percent=${Math.round(event.target.value)}`, { method: "PUT" })); $("#refresh").addEventListener("click", () => refreshPlayback());

try { await completeAuthorization(); } catch (error) { alert(error.message); history.replaceState({}, document.title, redirectUri); }
showApp(); if (state.session.access_token) { await refreshPlayback(); startTimers(); }
if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js");
