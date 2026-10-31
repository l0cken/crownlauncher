/**
 * Ustawienia wbudowane w launcher (wpisujesz raz, przebudowujesz instalator - i wszyscy gracze
 * dostają je bez żadnej konfiguracji).
 *
 * GITHUB_REPO       - publiczne repozytorium "właściciel/repo", z którego launcher czyta ogłoszenia
 *                     (plik announcements.json) i pobiera aktualizacje (GitHub Releases).
 * ANNOUNCEMENTS_URL - alternatywa: własny serwer (server/server.js) pod adresem https://…
 * UPDATE_URL        - opcjonalny osobny adres katalogu z aktualizacjami (tryb serwera).
 * MS_CLIENT_ID      - „Application (client) ID” aplikacji Azure dla logowania Microsoft (opcjonalne).
 *
 * Pierwszeństwo: ustawienie gracza w launcherze > GITHUB_REPO > ANNOUNCEMENTS_URL.
 */
module.exports = {
  // Serwery przypięte na samej górze listy serwerów w każdej instancji (przy każdym starcie gry).
  PINNED_SERVERS: [{ name: 'KORONAMC.PL', ip: 'koronamc.pl' }],

  // Nazwa pokazywana graczom i w grze (ekran tytułowy: "Minecraft 1.21.11/CrownClient").
  CLIENT_NAME: 'CrownClient',

  // Serwer peleryn (server/server.js, wystawiony przez HTTPS): każdy gracz launchera udostępnia swoją pelerynę
  // sam i automatycznie, a gracze z koroną są wykrywani po uruchomieniu gry. Puste = tryb GitHub (peleryny i
  // koronę nadaje administracja) albo adres serwera ogłoszeń, jeśli taki jest ustawiony.
  CAPES_URL: '',

  // Discord Rich Presence ("Gra w CrownClient"). Wpisz "Application ID" aplikacji Discord o nazwie
  // CrownClient (discord.com/developers/applications). Puste = funkcja wyłączona.
  DISCORD_CLIENT_ID: '1559281166312538122                                          ',
  // Opcjonalnie: klucz obrazka wgranego w Rich Presence → Art Assets (puste = ikona aplikacji).
  DISCORD_LARGE_IMAGE: '',

  // Prywatna dystrybucja z własnego serwera (VPS „anarchia”, usługa crownlauncher za Caddy/HTTPS): ogłoszenia,
  // aktualizacje, peleryny i lista blokad idą stąd, nie z GitHuba. Wcześniej: GITHUB_REPO: 'l0cken/crownlauncher'.
  GITHUB_REPO: '',
  ANNOUNCEMENTS_URL: 'https://launcher.locken.pl',
  UPDATE_URL: '',
  MS_CLIENT_ID: '',

  // Prywatna dystrybucja (tylko z własnym serwerem: GITHUB_REPO puste, ANNOUNCEMENTS_URL = https://twoja-domena,
  // serwer uruchomiony z INVITE_ONLY=1). true = launcher przy pierwszym starcie prosi o klucz zaproszenia i bez
  // niego nie uruchomi gry. Klucze tworzysz na serwerze: node server/server.js create-invite "Nazwa".
  INVITE_REQUIRED: true,
};
