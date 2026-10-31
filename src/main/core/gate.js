const invite = require('./invite');
const { USER_AGENT } = require('./util');

/**
 * Bramka serwera gry: „na serwer tylko z CrownLaunchera”.
 *
 * Launcher zgłasza serwerowi launchera (POST /v1/play), że za chwilę gra jako dany nick, i odnawia to zgłoszenie co minutę, dopóki
 * proces gry działa; po zamknięciu gry zdejmuje sesję (DELETE). Plugin na proxy Minecrafta (CrownGate) pyta serwer launchera,
 * czy wchodzący nick ma aktywną sesję i ważny klucz zaproszenia, i odrzuca resztę - dlatego klient bez launchera (zwykły
 * Minecraft, inny launcher) dostaje na serwerze odmowę.
 *
 * Uczciwie: to bramka na poziomie konta, nie DRM. Kto ma ważny klucz i napisze własny program zgłaszający sesję, wejdzie innym
 * klientem; kluczy jest tyle, ilu zaproszonych, a każdy da się unieważnić (odcina od razu przy następnym wejściu).
 *
 * Instancja wydarzenia (IGRZYSKA ŚMIERCI) zgłasza dodatkowo `event` i robi to KODEM WYDARZENIA (invite.eventHeaders): serwer przyjmie
 * taką sesję tylko od klucza z profilem tego wydarzenia, a plugin proxy może wymagać właśnie jej - wtedy gracz grający z CrownLaunchera,
 * ale z innej instancji, nie wejdzie na serwer wydarzenia.
 *
 * Zgłoszenie nigdy nie blokuje startu gry (brak sieci, błąd serwera): najwyżej serwer Minecrafta odmówi wejścia, a launcher
 * odnawia sesję w tle, więc po powrocie sieci wejście znów działa.
 */

const BEAT_MS = Math.max(1000, Number(process.env.CROWN_GATE_BEAT_MS) || 60 * 1000);
const TIMEOUT_MS = 5000;

const sessions = new Map(); // id instancji -> { nick, uuid, timer }

/** Adres zgłaszania sesji albo '' gdy launcher nie działa w trybie z kluczami zaproszeń (nie ma komu zgłaszać). */
function endpoint() {
  const base = invite.builtinServer();
  return invite.required() && base ? `${base}/v1/play` : '';
}

async function call(method, nick, uuid, event = '') {
  const url = endpoint();
  if (!url) return { skipped: true };
  const headers = event ? invite.eventHeaders(event, url) : invite.headersFor(url);
  if (!headers['X-Crown-Invite']) return { skipped: true }; // bez klucza nie ma czego zgłaszać (ekran z kluczem i tak blokuje grę)
  const full = method === 'DELETE' ? `${url}?nick=${encodeURIComponent(nick)}` : url;
  const res = await fetch(full, {
    method,
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Content-Type': 'application/json', ...headers },
    body: method === 'POST' ? JSON.stringify({ nick, uuid: uuid || undefined, event: event || undefined }) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  return { ok: false, status: res.status, message: String(body.error || `HTTP ${res.status}`) };
}

/**
 * Zgłasza grę dla konta i uruchamia odnawianie (`event` - id wydarzenia, gdy startuje jego instancja). Zwraca { ok } albo { ok:false, message } (do pokazania w konsoli gry);
 * `skipped` - launcher bez kluczy zaproszeń. Nie rzuca.
 */
async function begin(id, account, { event = '' } = {}) {
  end(id); // ponowny start tej samej instancji
  const nick = String(account?.username || '');
  if (!nick) return { skipped: true };
  const entry = { nick, uuid: String(account?.uuid || ''), event: String(event || ''), timer: null };
  let first;
  try {
    first = await call('POST', nick, entry.uuid, entry.event);
  } catch (e) {
    first = { ok: false, message: e.name === 'TimeoutError' || /fetch failed/i.test(e.message) ? 'brak połączenia z serwerem launchera' : e.message };
  }
  if (first.skipped) return first;
  entry.timer = setInterval(() => {
    call('POST', entry.nick, entry.uuid, entry.event).catch(() => {}); // chwilowy brak sieci: kolejne zgłoszenie za minutę
  }, BEAT_MS);
  entry.timer.unref?.();
  sessions.set(id, entry);
  return first;
}

/** Gra się zakończyła: przestaje odnawiać i zdejmuje sesję (nie czeka na odpowiedź). */
function end(id) {
  const entry = sessions.get(id);
  if (!entry) return;
  sessions.delete(id);
  clearInterval(entry.timer);
  call('DELETE', entry.nick, '', entry.event).catch(() => {}); // sesja i tak wygaśnie sama po kilku minutach
}

function endAll() {
  for (const id of [...sessions.keys()]) end(id);
}

module.exports = { begin, end, endAll, BEAT_MS };
