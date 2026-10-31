import { call } from './api.js';

export const LOADERS = [
  { id: 'fabric', label: 'Fabric' },
];

export const loaderLabel = (id) => LOADERS.find((l) => l.id === id)?.label || id;

export const COLORS = ['#f2b01e', '#d4264a', '#3fb68b', '#3b82f6', '#8b5cf6', '#ec4899', '#14b8a6', '#64748b'];

export const state = {
  info: null,
  config: null,
  accounts: [],
  selectedAccount: null,
  instances: [],
  servers: [],
  versions: [],
  states: {}, // id -> 'installing' | 'running'
  progress: {}, // id -> { stage, current, total, detail }
  logs: {}, // id -> string[]
};

// ---- subskrypcje: "live" jest czyszczone przy zmianie strony ----
const liveSubs = new Set();
const dataSubs = new Set();

/** Wywołuje fn od razu i przy każdej zmianie stanu gry/postępu (do czasu opuszczenia strony). */
export function live(fn) {
  liveSubs.add(fn);
  fn();
}
export function notify() {
  for (const fn of [...liveSubs]) fn();
}

const globalDataSubs = new Set();

/** Wywołuje fn po zmianie danych (lista instancji, konta) - do opuszczenia strony. */
export function onData(fn) {
  dataSubs.add(fn);
}
/** Jak onData, ale na stałe (np. panel konta w pasku bocznym). */
export function onDataGlobal(fn) {
  globalDataSubs.add(fn);
}
export function dataChanged() {
  for (const fn of [...globalDataSubs, ...dataSubs]) fn();
}

const leaveHandlers = [];

/** Wywoływane raz przy opuszczeniu bieżącej strony (np. do zdejmowania nasłuchiwaczy). */
export function onLeave(fn) {
  leaveHandlers.push(fn);
}

export function resetSubscriptions() {
  liveSubs.clear();
  dataSubs.clear();
  for (const fn of leaveHandlers.splice(0)) fn();
}

// ---- odświeżanie danych ----
export async function refreshInstances() {
  state.instances = await call('instances:list');
  dataChanged();
}

export async function refreshServers() {
  state.servers = await call('servers:list');
  dataChanged();
}

export async function refreshAccounts() {
  const { accounts, selected } = await call('accounts:list');
  state.accounts = accounts;
  state.selectedAccount = selected;
  dataChanged();
}

export async function refreshConfig() {
  state.config = await call('config:get');
}

export const currentAccount = () => state.accounts.find((a) => a.id === state.selectedAccount) || null;
export const instanceById = (id) => state.instances.find((i) => i.id === id) || null;
export const lastInstance = () =>
  state.instances.find((i) => i.id === state.config?.lastInstance) || state.instances[0] || null;
