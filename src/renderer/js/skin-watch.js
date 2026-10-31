import { call } from './api.js';
import { toast } from './dom.js';
import { currentAccount, dataChanged, onDataGlobal } from './state.js';
import { drawHead, loadImage } from './skin-viewer.js';

/**
 * Oficjalny skin konta - tylko odczyt. Launcher nie podmienia skinów w grze; tutaj sprawdza (w tle i po powrocie
 * do okna), czy skin, jego model ramion (Steve/Alex) albo peleryna konta zmieniły się w oficjalnym Minecrafcie,
 * i od razu pokazuje to w launcherze (komunikat, strona Skiny, avatar w pasku bocznym).
 */

export const MODEL_LABEL = { classic: 'klasyczny (Steve)', slim: 'wąski (Alex)' };

const FOCUS_GAP_MS = 20 * 1000;
const POLL_MS = 5 * 60 * 1000;

let latest = null; // ostatni wynik skins:profile
let lastAt = 0;
let inflight = null;
let head = null; // { key, dataUrl } - twarz z oficjalnego skina, do avatara
const listeners = new Set();

export const officialProfile = () => latest;

/** Skin z odczytu: konto Microsoft albo - dla konta offline - premium o tym samym nicku. */
export function officialSkinOf(profile) {
  if (!profile) return null;
  if (profile.available) return profile.skin ? { ...profile.skin, model: profile.model, name: profile.name } : null;
  const o = profile.official;
  return o?.skin ? { ...o.skin, model: o.model, name: o.name || profile.name } : null;
}

const changeOf = (profile) => (profile?.available ? profile.change : profile?.official?.change) || null;

function describeChange(change, profile) {
  const model = profile.available ? profile.model : profile.official?.model;
  const parts = [];
  if (change.skin) parts.push('skin');
  if (change.model && !change.skin) parts.push('model ramion');
  if (change.cape) parts.push('peleryna');
  const what = parts.join(' i ');
  const label = model ? ` (${MODEL_LABEL[model] || model})` : '';
  return `Wykryto zmianę w oficjalnym Minecrafcie: ${what}${change.skin || change.model ? label : ''}.`;
}

async function updateHead(profile) {
  const skin = officialSkinOf(profile);
  const key = skin ? `${profile.name}:${skin.dataUrl.length}:${skin.dataUrl.slice(-48)}` : '';
  if (!skin) {
    if (head) {
      head = null;
      dataChanged();
    }
    return;
  }
  if (head?.key === key) return;
  try {
    const img = await loadImage(skin.dataUrl);
    const canvas = document.createElement('canvas');
    drawHead(canvas, img, 64);
    head = { key, name: String(skin.name || profile.name).toLowerCase(), dataUrl: canvas.toDataURL('image/png') };
    dataChanged(); // odśwież avatar w pasku bocznym
  } catch {
    /* zostaje avatar z serwera launchera albo lokalny zastępnik (components.js) */
  }
}

/** Twarz z oficjalnego skina dla danego konta (data URL) albo null - wtedy avatar bierze się z serwera launchera (components.js). */
export function headFor(account) {
  if (!account || !head) return null;
  return head.name === String(account.username || '').toLowerCase() ? head.dataUrl : null;
}

export function onOfficialSkin(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * Odczytuje oficjalny skin. `quiet` - bez komunikatu o zmianie (po akcji zrobionej z launchera).
 * Rzuca przy błędzie sieci/sesji; wywołania w tle łapią go same.
 */
export function refreshOfficialSkin({ quiet = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const profile = await call('skins:profile', { quiet });
      latest = profile;
      lastAt = Date.now();
      const change = changeOf(profile);
      if (change?.any) toast(describeChange(change, profile));
      updateHead(profile);
      for (const fn of [...listeners]) fn(profile);
      return profile;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

const background = () => refreshOfficialSkin().catch(() => {});

/** Uruchamia obserwację: przy starcie, po powrocie do okna, co kilka minut i po zmianie konta. */
let started = false;

export function startOfficialSkinWatch() {
  if (started) return;
  started = true;
  let accountId = currentAccount()?.id || null;
  background();
  window.addEventListener('focus', () => {
    if (Date.now() - lastAt > FOCUS_GAP_MS) background();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') background();
  }, POLL_MS);
  onDataGlobal(() => {
    const id = currentAccount()?.id || null;
    if (id === accountId) return;
    accountId = id;
    latest = null;
    head = null;
    background();
  });
}
