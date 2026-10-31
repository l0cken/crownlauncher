const fs = require('fs');
const paths = require('./paths');

const DEFAULTS = {
  accounts: [],
  selectedAccount: null,
  memoryMb: 4096,
  jvmArgs: '',
  javaPath: '',
  hideOnLaunch: true,
  discordPresence: true, // "Gra w CrownClient" na Discordzie (działa, gdy ustawiono DISCORD_CLIENT_ID)
  capeByName: {}, // nick -> id wybranej peleryny
  capeSecrets: {}, // nick -> sekret dowodzący własności nicka na serwerze peleryn (losowy, tworzony przy pierwszym użyciu)
  capeShared: {}, // nick -> skrót peleryny, która jest teraz na serwerze peleryn
  skinSeen: {}, // konto -> ostatnio odczytany oficjalny skin (do wykrywania zmian zrobionych w Minecrafcie)
  optimizeJvm: true, // dostrojone flagi JVM (G1GC) zamiast domyślnych
  optimizeMods: true, // Sodium/VulkanMod, Lithium itd. dokładane do instancji Fabric (profil per wersja gry)
  renderer: 'auto', // 'auto' = VulkanMod tam, gdzie jest wydanie (od 26.2 Sodium), 'sodium' = zawsze Sodium (OpenGL)
  autoFixCrashes: true, // po awarii gry: aktualizacja / doinstalowanie / wyłączenie moda, który ją wywołał
  msClientId: '',
  lastInstance: null,
  announcementsUrl: '', // adres serwera ogłoszeń (https://...)
  publisherKey: '', // klucz publikowania (zaszyfrowany)
  publisherSource: '', // źródło ogłoszeń, dla którego klucz wydano ("github:właściciel/repo" albo "server:https://…") - tylko tam jest wysyłany
  publisherName: '',
  publisherRole: '',
  inviteKey: '', // klucz zaproszenia (zaszyfrowany) - prywatna dystrybucja, patrz invite.js
  inviteOrigin: '', // serwer, dla którego klucz wpisano (tylko tam jest wysyłany)
  inviteName: '',
  inviteCheckedAt: 0,
  inviteLost: '', // dlaczego launcher stracił klucz (np. „Ten klucz wygasł”) - pokazywane na ekranie blokady
  inviteProfile: '', // profil głównego klucza: '' = pełny dostęp, inaczej id wydarzenia (launcher ograniczony do wydarzenia)
  inviteCapes: false, // czy klucz ma dostęp do peleryn (sekcja w zakładce Skiny) - nadaje go administrator w panelu
  inviteDisableClient: false, // czy klucz pozwala wyłączyć „Peleryny i korona w grze” (przełącznik w Ustawieniach) - nadaje go administrator w panelu
  cosmetics: true, // peleryny (CustomSkinLoader) i korona przed nickiem (CrownClient) w grze; wyłączyć mogą tylko klucze z dostępem (invite.cosmeticsOff)
  eventKeys: {}, // kody wydarzeń wpisane przez graczy z pełnym dostępem: id wydarzenia -> zaszyfrowany klucz
  deviceId: '', // losowy identyfikator tej instalacji (zaszyfrowany DPAPI): klucz zaproszenia wiąże się z jednym komputerem
};

let data = null;

// Klucze z wcześniejszych wersji: skiny z launchera nie są już wstrzykiwane do gry (skin zostaje taki, jaki jest).
const LEGACY_KEYS = ['localSkins', 'skinSync', 'skinByName'];

function load() {
  if (data) return data;
  try {
    const saved = JSON.parse(fs.readFileSync(paths.config(), 'utf8'));
    data = { ...DEFAULTS, ...saved };
    // przełącznik „Skin i peleryny w grze” stał się „Peleryny i korona w grze”
    if ('localSkins' in saved && !('cosmetics' in saved)) data.cosmetics = saved.localSkins !== false;
    for (const key of LEGACY_KEYS) delete data[key];
  } catch {
    data = { ...DEFAULTS };
  }
  return data;
}

function save() {
  fs.mkdirSync(paths.root(), { recursive: true });
  const tmp = `${paths.config()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, paths.config());
}

function get() {
  return load();
}

function set(patch) {
  load();
  Object.assign(data, patch);
  save();
  return data;
}

// Pola, których nie wolno wysyłać do renderera (interfejsu): tokeny kont, klucz publikowania, sekrety nicków.
const PRIVATE_KEYS = ['accounts', 'publisherKey', 'publisherSource', 'capeSecrets', 'inviteKey', 'inviteOrigin', 'deviceId', 'eventKeys'];

/** Konfiguracja bez sekretów - jedyna wersja, która wychodzi poza proces główny. */
function publicView() {
  const out = { ...load() };
  for (const key of PRIVATE_KEYS) delete out[key];
  return out;
}

module.exports = { get, set, publicView, DEFAULTS };
