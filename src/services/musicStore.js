// Focus Music player. The audio element lives here, outside React, so the music
// keeps playing while other pages are open. Tracks come from GET /tracks (the
// Windows app's catalogue); their download links are signed, so the list is
// read again each time the page opens.
import { useSyncExternalStore } from 'react';
import { toolsApi } from './toolsApi.js';
import { neighbourTrack, trackList } from './statsModel.js';

const LAST_TRACK_KEY = 'fb_last_focus_track';
const VOLUME_KEY = 'fb_focus_music_volume';

let state = {
  status: 'idle', // idle | loading | ready | error
  tracks: [],
  currentId: null,
  playing: false,
  position: 0,
  duration: 0,
  volume: 0.6,
  error: null,
};
const listeners = new Set();
let audio = null;

function set(patch) {
  state = { ...state, ...patch };
  listeners.forEach((listener) => listener());
}

function read(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  const saved = Number(read(VOLUME_KEY));
  if (Number.isFinite(saved) && saved > 0 && saved <= 1) state = { ...state, volume: saved };
  audio.volume = state.volume;
  audio.addEventListener('timeupdate', () => set({ position: audio.currentTime }));
  audio.addEventListener('durationchange', () => {
    if (Number.isFinite(audio.duration)) set({ duration: audio.duration });
  });
  audio.addEventListener('play', () => set({ playing: true, error: null }));
  audio.addEventListener('pause', () => set({ playing: false }));
  audio.addEventListener('ended', () => musicStore.next());
  audio.addEventListener('error', () => {
    if (!audio.getAttribute('src')) return;
    set({ playing: false, error: "That track couldn't be played. Check your connection, or pick another one." });
  });
  return audio;
}

export const musicStore = {
  async load() {
    if (state.status === 'loading') return;
    set({ status: state.tracks.length > 0 ? 'ready' : 'loading' });
    try {
      const tracks = trackList(await toolsApi.getTracks());
      const last = read(LAST_TRACK_KEY);
      set({
        status: 'ready',
        tracks,
        currentId: state.currentId || (tracks.some((track) => track.id === last) ? last : null),
      });
    } catch (error) {
      console.error('[Music] Could not load the tracks:', error);
      set({ status: state.tracks.length > 0 ? 'ready' : 'error' });
    }
  },

  play(id) {
    const track = state.tracks.find((item) => item.id === id);
    if (!track) return;
    const player = ensureAudio();
    if (state.currentId !== id || !player.getAttribute('src')) {
      player.src = track.url;
      set({ currentId: id, position: 0, duration: track.seconds, error: null });
      write(LAST_TRACK_KEY, id);
    }
    player.play().catch(() => {
      set({ playing: false, error: "That track couldn't be played. Check your connection, or pick another one." });
    });
  },

  pause() {
    if (audio) audio.pause();
  },

  toggle(id = state.currentId) {
    if (state.playing && id === state.currentId) musicStore.pause();
    else musicStore.play(id || state.tracks[0]?.id);
  },

  next() {
    const track = neighbourTrack(state.tracks, state.currentId, 1);
    if (track) musicStore.play(track.id);
  },

  previous() {
    const track = neighbourTrack(state.tracks, state.currentId, -1);
    if (track) musicStore.play(track.id);
  },

  setVolume(value) {
    const volume = Math.min(1, Math.max(0, Number(value) || 0));
    ensureAudio().volume = volume;
    write(VOLUME_KEY, String(volume));
    set({ volume });
  },

  get: () => state,
};

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** { status, tracks, currentId, playing, position, duration, volume, error } */
export function useMusic() {
  return useSyncExternalStore(subscribe, musicStore.get);
}
