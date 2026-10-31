// Walidacja ogłoszeń po stronie launchera (tryb GitHub nie ma serwera, który zrobiłby to za nas).
const LIMITS = { title: 80, text: 2000, url: 500 };
const LEVELS = ['info', 'important', 'event'];

function httpsUrl(value, field) {
  if (value === undefined || value === null || value === '') return '';
  const s = String(value).trim();
  if (s.length > LIMITS.url) throw new Error(`Pole „${field}” jest za długie.`);
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`Pole „${field}” musi być poprawnym adresem URL.`);
  }
  if (u.protocol !== 'https:') throw new Error(`Pole „${field}” musi zaczynać się od https://`);
  return u.href;
}

/** Zwraca znormalizowane pola ogłoszenia albo rzuca czytelny błąd. */
function validateAnnouncement(body = {}) {
  const title = String(body.title ?? '').trim();
  const text = String(body.text ?? '').trim();
  if (!title) throw new Error('Podaj tytuł ogłoszenia.');
  if (title.length > LIMITS.title) throw new Error(`Tytuł może mieć maks. ${LIMITS.title} znaków.`);
  if (text.length > LIMITS.text) throw new Error(`Treść może mieć maks. ${LIMITS.text} znaków.`);
  const level = body.level ?? 'info';
  if (!LEVELS.includes(level)) throw new Error('Niepoprawny rodzaj ogłoszenia.');
  const days = body.expiresInDays;
  if (days != null && days !== 0 && !(Number.isInteger(days) && days >= 1 && days <= 365)) {
    throw new Error('Czas wygaśnięcia: liczba dni od 1 do 365 albo brak.');
  }
  return {
    title,
    text,
    image: httpsUrl(body.image, 'obraz'),
    link: httpsUrl(body.link, 'link'),
    level,
    pinned: Boolean(body.pinned),
    expiresAt: days ? new Date(Date.now() + days * 86400_000).toISOString() : null,
  };
}

module.exports = { validateAnnouncement, LIMITS, LEVELS };
