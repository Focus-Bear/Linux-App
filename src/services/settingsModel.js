// Settings that the Linux app acts on, beyond the ones that already had pages.
// Keys and calls are the Windows app's (Preferences/SettingsTab/*.xaml.cs):
//
//   Strictness      kCuddlyModeEnabled               Cuddly / Grizzly
//   Accessibility   kIsReducedMotion                 no animations
//   Focus Sessions  kFocusMusicAutoStartPreference   "ask" | "play" | "off"
//   Account         POST /auth/reset-password { email }
//                   DELETE /user-data                 delete the account
//
// Pure functions only, covered by node --test.

// --- bear mode ------------------------------------------------------------------

export const BEAR_MODES = [
  {
    id: 'cuddly',
    label: 'Cuddly Bear',
    text: 'Gentle. A new focus session starts on Junior: you can pause or stop it at any time.',
  },
  {
    id: 'grizzly',
    label: 'Grizzly Bear',
    text: 'Strict. A new focus session starts on Pawfessor: no pausing, and stopping early takes typing a row of random characters.',
  },
];

export function normaliseBearMode(value) {
  return value === 'grizzly' ? 'grizzly' : 'cuddly';
}

// --- focus music at session start -----------------------------------------------

export const MUSIC_CHOICES = [
  { id: 'ask', label: 'Ask each time' },
  { id: 'play', label: 'Always play' },
  { id: 'off', label: 'Never' },
];

/** "ask" is the default, as on Windows. */
export function normaliseMusicChoice(value) {
  return value === 'play' || value === 'off' ? value : 'ask';
}

/**
 * What to do about focus music when a session starts: 'play', 'ask' or
 * 'nothing'. Music that is already playing is left alone, and a session that
 * was already handled (the app restarted during it) isn't asked about again.
 */
export function musicAction({ choice, sessionKey, handledKey, playing }) {
  if (!sessionKey || sessionKey === handledKey || playing) return 'nothing';
  const value = normaliseMusicChoice(choice);
  if (value === 'play') return 'play';
  if (value === 'ask') return 'ask';
  return 'nothing';
}

/** The track to start with: the one played last, else a random one. Null when there are none. */
export function autoPlayTrack(tracks, lastId, random = Math.random) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  return tracks.find((track) => track.id === lastId) || tracks[Math.floor(random() * tracks.length) % tracks.length];
}

// --- account --------------------------------------------------------------------

/** What has to be typed before the account can be deleted (DeleteAccountConfirmDialog). */
export const DELETE_WORD = 'DELETE';

export function canDeleteAccount(typed) {
  return String(typed ?? '') === DELETE_WORD;
}

/** Body of POST /auth/reset-password. Null without an email address. */
export function resetPasswordBody(email) {
  const value = String(email ?? '').trim();
  return value.includes('@') ? { email: value } : null;
}

/** True for accounts that sign in with a password (not Google or Apple), which are the ones that can reset it. */
export function hasPassword(user) {
  return typeof user?.sub === 'string' && user.sub.startsWith('auth0|');
}
