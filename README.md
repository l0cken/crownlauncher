# CrownLauncher

Launcher Minecrafta w stylu starego Feather Clienta, zintegrowany z [Modrinth](https://modrinth.com).

![logo](assets/logo.png)

> **Nieoficjalny launcher.** To nie jest oficjalny produkt Minecraft — nie jest zatwierdzony przez Mojang ani
> Microsoft i nie jest z nimi powiązany. Minecraft jest znakiem towarowym Mojang Synergies AB.

## Funkcje

- **Instancje** – własne, odseparowane profile gry (mody, ustawienia, światy, RAM, argumenty JVM).
- **Wersje 1.21.4 – 26.3** – lista pobierana z manifestu Mojang, zakres ustawiony w `src/main/core/mojang.js`
  (`MIN_VERSION` / `MAX_VERSION`).
- **Loader**: wyłącznie **Fabric** (przez profile meta) — tylko na nim działają CrownClient (korona przed
  nickiem) i peleryny. Vanilla, Quilt, NeoForge i Forge zostały usunięte. Dawne instancje **Vanilla** przechodzą
  na Fabric automatycznie (przy pierwszym odczycie listy albo starcie gry; świat i pliki zostają, zmienia się tylko
  loader). Instancje Quilt/NeoForge/Forge zostają na dysku, ale się nie uruchomią (launcher pokaże komunikat),
  a paczki `.mrpack` wymagające takiego loadera są odrzucane z czytelnym błędem; paczka bez loadera staje się
  instancją Fabric.
- **Modrinth**: wyszukiwarka modów, paczek modów (`.mrpack` → nowa instancja), paczek zasobów i shaderów;
  instalacja z automatycznym dociąganiem wymaganych zależności i weryfikacją sum SHA-1.
- **Java**: właściwy runtime (Java 21 / 25…) pobierany automatycznie z serwerów Mojang.
- **Konta**: offline oraz Microsoft (logowanie kodem urządzenia, tokeny szyfrowane przez `safeStorage`).
- **Serwery i szybkie dołączanie**: lista serwerów ze statusem na żywo (Server List Ping: MOTD, gracze, opóźnienie,
  ikona). „Dołącz” uruchamia instancję (przypisaną albo dobraną po wersji serwera) i od razu łączy z serwerem
  (`--quickPlayMultiplayer`).
- **Import**: plik `.mrpack` z dysku (przycisk „Importuj .mrpack” lub przeciągnięcie na okno) tworzy nową instancję;
  serwery można zaimportować z `servers.dat` istniejących instancji.
- **Skiny**: launcher **nie wstrzykuje skinów do gry** — skin w grze jest taki, jaki daje konto albo serwer.
  Strona *Skiny* czyta **oficjalny skin konta** razem z modelem ramion (klasyczny = Steve, wąski = Alex) i wykrywa
  jego zmiany (patrz „Skiny” niżej); jest też biblioteka lokalna (import PNG 64×64/64×32, przeciąganie na okno,
  pobieranie po nicku) z podglądem 3D i — dla konta Microsoft — ustawianiem skina, zmianą peleryny konta i
  przywracaniem domyślnego skina przez API Minecraft Services.
- **Rozpoznawanie modów**: pliki z importowanych paczek `.mrpack` i wgrane ręcznie są rozpoznawane po sumie SHA-1
  w Modrinth (nazwa, ikona, wersja), więc przeglądarka modów oznacza je jako „Zainstalowano”.
- **Przypięty serwer** (`PINNED_SERVERS` w `app-config.js`, domyślnie KORONAMC.PL):
  - w launcherze jest zawsze pierwszy na liście, nie ma przycisku „Usuń”, a nazwę i adres narzuca launcher
    (gracz wybiera tylko instancję do dołączania); usunięcie i zmianę adresu odrzuca też proces główny;
  - w grze jest wpisywany na samą górę `servers.dat` przy każdym starcie, pozostałe wpisy zostają nietknięte;
    jeśli gracz usunie go w menu Minecrafta, wraca po zamknięciu gry i przy następnym uruchomieniu
    (usunięcia w trakcie sesji bez moda nie da się zablokować).
- **CrownClient i Discord**: w grze na ekranie tytułowym widać „Minecraft 1.21.11/CrownClient”
  (`CLIENT_NAME`, argument `--versionType`), a w profilu Discord „Gra w CrownClient” z wersją gry, loaderem i
  czasem gry (Rich Presence, patrz „Wbudowane ustawienia”). Adres serwera jest pokazywany tylko dla serwera
  przypiętego; prywatnych adresów launcher nie wysyła. Gracz może to wyłączyć w *Ustawienia → Launcher*.
- **Przełącznik kont w launcherze** (dawny mod Account Switcher, teraz wbudowany): kliknięcie konta w panelu
  bocznym otwiera listę zapisanych kont (premium i offline) z przełączaniem jednym kliknięciem, dodawaniem konta
  Microsoft i konta offline oraz usuwaniem. Logowanie Microsoft działa **bez rejestracji w Azure** — kodem
  urządzenia (login.live.com, publiczne Client ID oficjalnego launchera, tak jak robił to mod). Własny Client ID
  nadal można ustawić w *Ustawienia → Konta*. Przełącznik nie jest już modem w grze; stare kopie Account
  Switchera z poprzednich wersji launchera są usuwane z instancji przy starcie. Jedyny komponent w grze to
  **CrownClient** (korona przed nickiem), ładowany przez launcher spoza folderu `mods`
  (jary w `assets/mods`, wybierane po wersji gry przez `manifest.json`, wgrywane
  `node scripts/sync-bundled-mods.js <katalog z jarami>` — skrypt odmawia pracy, jeśli w jarze są dane logowania).
- **Avatary kont bez ujawniania adresu IP** (od 0.1.41): twarz konta w panelu bocznym, przełączniku kont i ustawieniach pochodzi z oficjalnego
  skina (aktywne konto) albo z mc-heads.net — ale launcher **nigdy nie łączy się z tym serwisem sam**. O obrazek prosi się serwer launchera
  (`GET /v1/avatar/<nick|uuid>`, tylko z kluczem zaproszenia), który pobiera go dalej, więc mc-heads.net widzi adres serwera, a nie adres IP
  gracza (sam nick lub UUID konta nadal do niego trafia). Bez serwera, bez klucza zaproszenia albo gdy serwis nie ma obrazka, launcher rysuje
  własny zastępnik z inicjałem — nigdy zapasowego połączenia wprost. Testy: `node dev-tests/avatar-test.js` (też z `CROWN_BACKEND=cf`) i
  `node dev-tests/avatar-ui-test.js` (prawdziwy Electron).
- **Pakiet CrownClient pod każdą wersję Minecrafta** (można wyłączyć w *Ustawienia → Launcher*):
  - **Mody**: w nowej instancji Fabric launcher dokłada z Modrinth cały zestaw (zgodny z paczką autora) w
    **najnowszych wydaniach dla danej wersji gry — tak jak są na Modrinth** (release, a gdy go brak beta/alpha);
    mod bez wydania dla tej wersji jest pomijany. W zestawie: Lithium, FerriteCore, ModernFix, C2ME, Entity
    Culling, More Culling, BadOptimizations, ScalableLux, Noisium, Ksyxis, Dynamic FPS, Simple Voice Chat, e4mc,
    Mod Menu, Gamma Utils, Just Zoom, Shulker Box Tooltip, Skyboxify, uku's Armor HUD i inne oraz ich
    biblioteki (Fabric API, Cloth Config, YACL…). Pełna lista: `PACK` i `LIBS` w `performance-mods.js`.
  - **Renderer**: poniżej Minecrafta **26.2** **VulkanMod + Not Enough Vulkan**, a Sodium (z Sodium Extra, Iris i
    ImmediatelyFast) jest usuwany — o ile VulkanMod ma wydanie dla danej wersji (1.21.4, 1.21.5, 1.21.9–1.21.11,
    26.1–26.1.2; Not Enough Vulkan od 1.21.10) i komputer ma sterownik Vulkan. W pozostałych wersjach
    (1.21.6–1.21.8) VulkanMod nie ma wydania, więc jest Sodium. Od **26.2** Vulkan jest w opcjach samego
    Minecrafta, więc tam zawsze Sodium. Ustawienie *Renderer* pozwala wymusić Sodium. Gdyby gra z VulkanMod
    zamknęła się sama zaraz po starcie, launcher wraca do Sodium i nie próbuje już Vulkana w tej instancji.
  - **Kontrola zgodności** (`mod-check.js`): po instalacji launcher czyta `fabric.mod.json` każdego dołożonego
    moda (także modułów zagnieżdżonych) i sprawdza to, co przy starcie sprawdziłby Fabric Loader: wersję
    Minecrafta, Javę, loadera, zależności od innych modów z wersjami i `breaks`. Mod, który by przeszkadzał, jest
    cofany do starszej, zgodnej wersji, a gdy takiej nie ma — usuwany (zamiast okna „Some of your mods are
    incompatible”). Znane przypadki: Resourcify i Cubes Without Borders nie działają z VulkanMod, C2ME wymaga
    Javy 22+ (więc tylko od Minecrafta 26.1).
  - **Istniejące instancje** nie są zmieniane same; pakiet (z zamianą Sodium ↔ VulkanMod) stosuje przycisk
    **Optymalizuj** w ustawieniach instancji. Paczki `.mrpack` i ręcznie dobrane mody zostają nietknięte.
  - **Aktualizacje modów**: w zakładce *Mody* launcher sprawdza w Modrinth (na wejściu i na przycisk
    *Sprawdź aktualizacje*), czy są nowsze wersje zgodne z grą instancji; mod ma wtedy znacznik z numerem nowej
    wersji i przycisk *Aktualizuj*, jest też *Aktualizuj wszystko*. Nie przeskakujemy na mniej stabilny kanał
    (z wydania nie na alphę), nie cofamy wersji, a wyłączony mod zostaje wyłączony.
  - **CustomSkinLoader** (rysuje peleryny) jest zarządzany przez launcher i **ukryty na liście modów**.
  - **Duplikaty**: dwa jary tego samego moda (stara i nowa wersja po aktualizacji, plik spoza indeksu, ModernFix i
    jego fork) wywołują „duplicate mod” przy starcie. Po każdej instalacji/aktualizacji moda i przed startem gry
    launcher porównuje `id` z `fabric.mod.json` i zostawia **najnowszą wersję**, a starsze kopie usuwa (razem z
    wpisem w indeksie); komunikat mówi, co usunięto. Wyłączone (`.disabled`) i obce pliki nie są ruszane.
  - **Limity zapytań (HTTP 429)**: Modrinth i serwery Mojang ograniczają liczbę zapytań na minutę. Launcher czeka
    według nagłówka `Retry-After`, pamięta odczyty z Modrinth przez 90 s i sprawdza aktualizacje jednym zbiorczym
    zapytaniem (osobne zapytanie tylko dla modów, które się zmieniły), a przy odmowie pokazuje komunikat z nazwą
    serwera („…chwilowo ogranicza liczbę zapytań — spróbuj za minutę”), a nie samo „HTTP 429”.
  - **JVM**: dostrojony garbage collector G1 i flagi zamiast domyślnych (krótsze pauzy, mniej zacięć); na Javie 25
    (Minecraft 26.x) dodatkowo zwarte nagłówki obiektów (`-XX:+UseCompactObjectHeaders`: mniej pamięci).
    Nie jest dokładany, gdy gracz sam wybrał GC w argumentach JVM.
- **Newsy** na ekranie startowym to ogłoszenia launchera publikowane kluczem dostępu (patrz „Ogłoszenia” niżej);
  bez ogłoszeń i bez uprawnień do publikowania sekcja jest ukryta, a błąd pobierania jest pokazywany każdemu.
- **Peleryny CrownClient**: 6 wbudowanych projektów (Korona, Złoto, Północ, Karmazyn, Szmaragd, Królewska) i własne
  PNG, podgląd 3D na modelu (zakładka *Skiny i peleryny*). Własne pliki mogą mieć dowolny z popularnych układów
  (64×32, HD 2:1 do 2048×1024, OptiFine 46×22 i jego wielokrotności, 22×17) — launcher dopasowuje je do formatu
  gry przy dodawaniu (też po przeciągnięciu pliku na okno). „Użyj w grze” ustawia pelerynę także na koncie offline:
  w grze rysuje ją mod **CustomSkinLoader** z Modrinth, który launcher dokłada sam (instancje Fabric)
  i konfiguruje **wyłącznie pod peleryny**. Ta sama tekstura służy do **elytr**: wbudowane projekty mają skrzydła w kształcie z gry (zewnętrzna strona, z wzorem peleryny), a własny plik bez skrzydeł (np. 22×17) dostaje je dorysowane z peleryny przy dodawaniu. Peleryny **widoczne dla wszystkich** graczy launchera nadaje
  administracja (patrz „Peleryny graczy” niżej). Wyłączane tylko przez graczy z dostępem z panelu w *Ustawienia → Launcher* („Peleryny i korona w grze”; patrz „Wyłączanie korony i peleryn”).
- **Odświeżanie**: **F5** / **Ctrl+R** przeładowuje launcher (z Ctrl+Shift+R bez cache) i pobiera od nowa newsy
  oraz ogłoszenia; zostajesz na tej samej podstronie, a uruchomione gry dalej widać jako „w grze”.
- **Konsola** gry na żywo w launcherze: kolorowana (poziomy INFO/WARN/ERROR, kolor wątku, ślady stosu z wyróżnionymi
  wyjątkami i „Caused by”, linie launchera, adresy), z filtrami poziomów i wyszukiwaniem.
- **Awarie gry: który mod ją wywołał i automatyczna naprawa.** Gdy gra się wysypie, launcher analizuje log
  i raport awarii (`crash-analyzer.js`): komunikaty Fabric Loadera o niezgodnościach, błędy mixinów, wyjątki
  w punktach wejścia, „Suspected Mods” z raportu, a na końcu ślady stosu (pakiet klasy → jar moda). Wynik widać
  w oknie po awarii, w konsoli (`AWARIA: …`) i jako karta na stronie instancji. Przy pewnych wskazaniach launcher
  **od razu naprawia** (`crash-fixer.js`): doinstalowuje brakującą zależność z Modrinth, aktualizuje za starą
  zależność (np. Fabric API) albo mod niezgodny z wersją gry, a gdy to nie pomaga lub chodzi o Javę/konflikt
  z innym modem — wyłącza mod (plik dostaje `.disabled`, „Cofnij” w oknie awarii). Loader, Fabric API, renderer
  (Sodium/VulkanMod) i CrownClient nie są wyłączane (wtedy schodzi druga strona konfliktu); słabe wskazania
  (sam ślad stosu) niczego nie ruszają. Wyłączane w *Ustawienia → Launcher* („Naprawiaj awarie automatycznie”).

## Uruchomienie

```bash
npm install
npm start
```

Dane (instancje, biblioteki, zasoby, Java) trafiają do `%APPDATA%\CrownLauncher`. Launcher działa tylko w Windowsie.

## Eksport instancji (od 0.1.40)

Na stronie instancji, w zakładce *Ustawienia*, karta **Eksport instancji** zapisuje instancję do pliku **`.mrpack`** (format paczek
Modrinth): mody (także wyłączone), konfiguracje, paczki zasobów, shadery, `options.txt` i `servers.dat`, a na życzenie **światy**. Taki plik
zaimportujesz w CrownLauncherze (*Instancje → Importuj .mrpack*), w Modrinth App i w Prism Launcher — więc to i kopia zapasowa, i sposób na
przeniesienie instancji na inny komputer albo wysłanie jej znajomemu.

- Wszystko trafia do `overrides/` paczki (launcher nie zna adresów pobierania modów), więc paczka jest samowystarczalna i działa bez
  sieci, tylko większa niż „odchudzona” paczka z linkami.
- Pomijane: dzienniki, raporty awarii, zrzuty ekranu, pamięć podręczna i dane techniczne (`.fabric`, `.mixin.out`…), dane zarządzane przez
  launcher (CustomSkinLoader — peleryny) oraz pliki wyglądające na poufne (nazwy z `token`, `secret`, `password`, `credential`, `api_key`,
  `.pem`, `.key`…); ich liczbę widać po eksporcie. **Ustawienia launchera** (nick, konta, RAM, ścieżka Javy, argumenty JVM) **nie są w paczce**.
- Plik powstaje strumieniowo (`zip-writer.js`) pod nazwą `*.part` i dopiero gotowy dostaje nazwę `.mrpack`; przerwany eksport nie zostawia
  uszkodzonego pliku. Limit: 1,5 GB danych (import czyta paczkę w pamięci) i klasyczny ZIP (4 GB, 65 535 plików) — duże światy eksportuj osobno.
- Gra w tej instancji musi być zamknięta (spójność plików). **Instancji wydarzenia (zablokowanej) nie da się eksportować** — jej zestaw plików
  jest zamknięty (odmawia rdzeń i kanał IPC; tryb wydarzenia blokuje eksport całkiem).
- Testy: `node dev-tests/export-test.js` (17; archiwum czyta też systemowe `tar`, a pełny obieg eksport → import robi prawdziwy importer
  launchera — wymaga sieci) i `node dev-tests/export-ui-test.js` (7; prawdziwy Electron z podstawionym oknem „Zapisz jako”).

## Wbudowane ustawienia (`app-config.js`)

Wpisujesz raz w [`src/main/core/app-config.js`](src/main/core/app-config.js), przebudowujesz instalator i wszyscy
gracze dostają je bez konfiguracji.

| Ustawienie | Co robi |
|---|---|
| `PINNED_SERVERS` | serwery przypięte na górze (launcher i `servers.dat`), nie do usunięcia |
| `CLIENT_NAME` | nazwa pokazywana w grze i na Discordzie (domyślnie `CrownClient`) |
| `DISCORD_CLIENT_ID` | „Application ID” aplikacji Discord; puste = Rich Presence wyłączone |
| `DISCORD_LARGE_IMAGE` | opcjonalnie klucz obrazka z *Rich Presence → Art Assets* (puste = ikona aplikacji) |
| `GITHUB_REPO` | repozytorium z ogłoszeniami i wydaniami (patrz niżej) |
| `ANNOUNCEMENTS_URL` / `UPDATE_URL` | alternatywa: własny serwer |
| `MS_CLIENT_ID` | logowanie Microsoft (patrz niżej) |

### Discord Rich Presence („Gra w CrownClient”)

1. Wejdź na <https://discord.com/developers/applications> → **New Application**, nazwa **CrownClient**
   (to ona pojawia się po „Gra w”). Opcjonalnie wgraj ikonę aplikacji (logo).
2. Na stronie *General Information* skopiuj **Application ID** i wpisz w `DISCORD_CLIENT_ID`.
3. Przebuduj instalator i wydaj aktualizację. Discord musi być uruchomiony u gracza; launcher łączy się z nim
   lokalnie (potok IPC), więc nie potrzeba logowania ani biblioteki.

## Wyłączanie korony i peleryn (tylko dla wybranych)

„Peleryny i korona w grze” (korona CrownClient przed nickiem i peleryny z launchera) są domyślnie **zawsze włączone**. Administrator może dać wybranym
kluczom pole „Pozwól wyłączyć CrownClient” (panel `/admin`: nowy klucz, „Edytuj” albo przycisk przy kluczu; CLI serwera: `set-disable-client <id> on|off`) —
wtedy gracz ma w *Ustawienia → Launcher* przełącznik „Peleryny i korona w grze” (działa od następnego uruchomienia gry, dla wszystkich instancji). Bez dostępu
przełącznika nie ma, a ręcznie zmieniony plik ustawień nic nie wyłącza. Odebranie dostępu włącza koronę i peleryny z powrotem.

## Peleryny graczy (jak w Lunar / Badlion)

**W prywatnej dystrybucji (klucze zaproszeń) peleryny są tylko dla wybranych graczy.** Sekcja „Peleryny” w zakładce *Skiny*
pojawia się dopiero, gdy administrator włączy ją kluczowi w panelu `/admin` (pole „Peleryny” przy tworzeniu klucza, przycisk
„Włącz peleryny” przy kluczu albo `set-capes <id> on|off` w CLI serwera). Bez tego launcher nie pokazuje sekcji, a serwer
odrzuca wgrywanie peleryn; wyłączenie dostępu zdejmuje też peleryny wgrane tym kluczem. Starsze klucze nie mają dostępu.

Peleryny są **klientowe** — widzą je gracze, którzy grają przez CrownLauncher (CustomSkinLoader), nie serwer.
Mechanizm działa na tym samym repozytorium GitHub co ogłoszenia, bez własnego serwera:

- **Moja peleryna** — gracz wybiera ją w *Skiny i peleryny → Użyj w grze*; launcher zapisuje ją przed startem w
  `CustomSkinLoader/LocalSkin/capes/<nick>.png` w instancji. Pliki dostają **wszystkie konta zapisane w
  launcherze** (w każdej instancji), więc dwa konta na jednym komputerze widzą nawzajem swoje własne peleryny,
  także z innych instancji. Gracze na innych komputerach widzą ją dopiero po udostępnieniu (poniżej).
- **Peleryna nadana przez administrację** — osoba zalogowana kluczem dostępu (jak przy ogłoszeniach) klika
  *Gracze z koroną*, wpisuje nick i wybiera projekt. Launcher zapisuje plik `capes/players/<Nick>.png` w
  repozytorium, a **każdy** klient launchera pobiera pelerynę gracza z
  `raw.githubusercontent.com/<repo>/HEAD/capes/players/{nick}.png`. Widoczna w ciągu kilku minut (cache GitHuba).

### Skiny

Launcher **nie wczytuje i nie podmienia skinów w grze**. CustomSkinLoader dostaje konfigurację tylko z
pelerynami (`LocalSkin` → `CrownCapes`), a skin (i oficjalną pelerynę) bierze ze źródła `GameProfile`, czyli
dokładnie z tego, co przysłała gra: sesja konta Microsoft albo serwer (np. jego plugin skinów). Dzięki temu skin
w grze zawsze jest „taki, jaki jest”.

Zamiast tego strona *Skiny* **czyta** oficjalny skin:

- **Konto Microsoft** — skin, model ramion (klasyczny/Steve albo wąski/Alex) i aktywna peleryna z API Minecraft
  Services (`/minecraft/profile`). Gdy konto nie ma własnego skina, model domyślnego skina wynika z UUID.
- **Konto offline** — skin gracza premium o tym samym nicku (jeśli istnieje) z jego publicznego profilu Mojang;
  bez takiego konta pokazywany jest tylko domyślny model. W grze skin konta offline zależy od serwera.
- **Wykrywanie zmian** — launcher zapamiętuje ostatnio widziany skin, model i pelerynę (`skinSeen` w
  `config.json`). Odczyt następuje przy starcie, po powrocie do okna launchera, po zamknięciu gry, co 5 minut i
  na przycisk *Odśwież*; zmiana zrobiona w oficjalnym Minecrafcie, na minecraft.net lub w innym launcherze jest
  zgłaszana komunikatem, a podgląd 3D i avatar w panelu bocznym od razu pokazują nowy skin. Zmiany wykonane z
  samego launchera („Ustaw na koncie Microsoft”) nie są zgłaszane jako zmiana z zewnątrz.
- **Peleryny** są klientowe: widzą je tylko gracze launchera (CustomSkinLoader), nigdy gracze spoza niego.
Komponent **CrownClient** (źródła: osobny projekt `crownclient`) to jedyny kod, który launcher ładuje do gry
sam, spoza folderu `mods` (`-Dfabric.addMods`): korona przed nickiem w nametagu i na liście graczy (odstęp
korony od nicka to wąska spacja z czcionki moda — `assets/crownclient/font/crown.json`, wartość `advances`).
Rysowanie ikony przy nicku nie jest możliwe bez kodu w procesie gry. Przełącznik kont, logowanie Microsoft
i zarządzanie skinami są w samym launcherze.

Ograniczenia (świadome):

- Korona jest przy **każdym koncie zapisanym w tym samym launcherze** (launcher przekazuje CrownClientowi ich nicki w
  `-Dcrownclient.members`), więc dwa konta jednego gracza na jednym komputerze widzą koronę nawzajem bez żadnej
  listy. Dla graczy na innych komputerach obowiązuje poniższe (lista albo tryb serwera).
- Korona oznacza „jest na liście administracji” (plik w `capes/players`), a nie „gra przez CrownLauncher”: bez
  serwera launcher nie ma jak dowiedzieć się, kto jeszcze jest w grze, więc gracz, którego nie ma na liście, nie
  ma korony u innych (u siebie zawsze ją ma). Dodaj go w *Skiny i peleryny → Gracze z koroną* (wymaga klucza
  dostępu); korona pojawia się u pozostałych w ciągu ok. 5 minut. Automatyczne wykrywanie wymagałoby własnego
  serwera obecności.
- CrownClient (korona) jest zbudowany dla **każdej obsługiwanej wersji** Minecrafta (1.21.4 – 26.3, osobny jar na
  wersję w `assets/mods`). Gdyby dla jakiejś wersji jara zabrakło, konsola gry przy starcie to zgłosi.
- Nick w nazwie pliku **rozróżnia wielkość liter** i musi być taki sam jak w grze. Konta offline nie mają
  uwierzytelnienia, więc nick nie jest dowodem tożsamości — peleryna idzie za nickiem, nie za osobą.
- Gracze spoza launchera nie widzą tych peleryn. Samodzielne wgrywanie peleryn „dla wszystkich” przez każdego
  gracza wymagałoby własnego serwera (GitHub nie przyjmuje anonimowych zapisów).
- Do pobrania peleryn CustomSkinLoader wysyła nicki graczy do `raw.githubusercontent.com` i do Mojang.
  Konfigurację launchera nadpisuje przy każdym starcie, chyba że gracz sam ją zmodyfikuje (wtedy zostaje).
- Skiny i oficjalne peleryny z Minecrafta (Mojang) działają tak jak w grze bez launchera.

### Tryb serwera: automatyczne peleryny i korona dla wszystkich

W trybie GitHub (domyślnym) zapis do repozytorium wymaga tokena, więc peleryny i koronę nadaje administracja.
Token z uprawnieniem zapisu **nie może** siedzieć w launcherze (każdy mógłby go wyciągnąć z aplikacji), więc
„każdy sam udostępnia swoją pelerynę” wymaga własnego serwera. `server/server.js` ma na to gotowe endpointy:

1. Uruchom serwer (`node server/server.js`, najlepiej za reverse proxy z HTTPS, np. Caddy/nginx; dane w
   `DATA_DIR`) i wpisz jego adres w `CAPES_URL` w `app-config.js` (albo użyj istniejącego `ANNOUNCEMENTS_URL`).
2. Wydaj launcher. Od tej chwili:
   - **peleryna wybrana w launcherze** („Użyj w grze”, także własny plik) jest wysyłana na serwer i od razu widoczna
     dla wszystkich graczy launchera — bez nadawania, bez klucza;
   - **korona przed nickiem** pojawia się u każdego, kto uruchomił grę przez launcher (launcher zgłasza nick
     serwerowi przy starcie; wpis ważny 60 dni), więc nie trzeba nikogo dopisywać ręcznie;
   - CrownClient czyta listę z `GET /v1/crown-users`, CustomSkinLoader peleryny z `GET /capes/<Nick>.png`.
3. **Własność nicka:** konto Microsoft dowodzi jej tokenem Minecrafta (serwer pyta Minecraft Services; token nie jest
   zapisywany), konto offline — losowym sekretem, który launcher tworzy i zapamiętuje przy pierwszym użyciu
   nicka (`capeSecrets` w `config.json`). Nick zajęty przez konto premium nie da się przejąć sekretem; konto
   premium przejmuje nick zawsze. Administrator (klucz `admin`) może usunąć cudzą pelerynę
   (`DELETE /v1/capes/<Nick>` z `Authorization: Bearer <klucz>`).
4. **Ograniczenia serwera:** PNG do 1 MB w układach peleryny (64×32 i HD 2:1 do 2048 px, 22×17, 46×22), 30 zmian na
   godzinę z jednego adresu IP, maks. 5000 peleryn.
5. Serwer widzi nicki graczy i adresy IP (jak każdy serwer WWW) oraz peleryny; nie dostaje haseł ani tokenów
   logowania do gry poza jednorazową weryfikacją tokena Minecrafta.

## Ogłoszenia i aktualizacje przez GitHub (zalecane, bez serwera)

Wszystko opiera się na jednym **publicznym** repozytorium GitHub (np. `twojlogin/crownlauncher`). Trzyma ono tylko
wydania (instalatory) i plik `announcements.json` — kod launchera może zostać prywatny.

1. **Repozytorium:** na github.com utwórz publiczne, puste repozytorium (nazwa dowolna, np. `crownlauncher`).
2. **Wbudowanie w launcher:** w [`src/main/core/app-config.js`](src/main/core/app-config.js) ustaw
   `GITHUB_REPO: 'twojlogin/crownlauncher'`, zbuduj instalator (`npm run dist`) i rozdaj go graczom (pierwsza
   instalacja jest ręczna).
3. **Kto może ogłaszać:** dodaj te osoby w *Settings → Collaborators* (uprawnienie *Write*). Każda tworzy
   *fine-grained token* (*Only select repositories* → to repozytorium, *Contents: Read and write*) i wkleja go w
   launcherze: *Ustawienia → Ogłoszenia launchera*. Token jest tam „kluczem dostępu” (szyfruje go `safeStorage`).
   Po zalogowaniu na ekranie startowym pojawia się **Nowe ogłoszenie**.
4. **Wydanie aktualizacji:**

   ```powershell
   $env:GH_TOKEN = "github_pat_..."             # token z Contents: Read and write
   npm run release                              # buduje (do release/) i publikuje GitHub Release
   ```

   **Numer wersji rośnie sam.** Launcher aktualizuje się tylko do *wyższej* wersji, więc gdy wersja z `package.json`
   jest już wydana (albo skrypt wydał ją poprzednio — pamięta to w `scripts/.last-release.json`), `npm run release`
   podbija numer patch w `package.json` i `package-lock.json` i dopiero buduje. `--keep-version` wyłącza podbijanie.
   Wydanie nazywa się po prostu **CrownLauncher** (bez numeru i bez opisu; numer zostaje w tagu `vX.Y.Z`, którego
   potrzebuje mechanizm aktualizacji), a **po publikacji starsze wydania i ich tagi są usuwane** — w repozytorium
   zostaje jedno, najnowsze (`--keep-old` wyłącza usuwanie). Launcher w starszej wersji pobiera wtedy całość
   instalatora zamiast różnicy.
   Commity launchera (ogłoszenia, peleryny graczy) mają neutralny opis „CrownLauncher” — nie widać w nich nicków.

   **Zapisanie tokena (raz, żeby nie wpisywać go po każdym restarcie).** Gdy `GH_TOKEN` jest ustawiony w oknie,
   zapisz go zaszyfrowanego kluczem Windows (DPAPI — odczyt możliwy tylko na tym koncie i tym komputerze):

   ```powershell
   ConvertTo-SecureString $env:GH_TOKEN -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -LiteralPath "$env:USERPROFILE\.crownlauncher-gh-token"
   ```

   `npm run release` sam odczyta ten plik, gdy `GH_TOKEN` nie jest ustawiony. Po wygaśnięciu tokena ustaw nowy
   w `GH_TOKEN` i powtórz polecenie; plik usuwasz zwykłym `Remove-Item`.

   Launchery graczy sprawdzają wydania same (15 s po starcie i co 4 godziny) albo na żądanie przyciskiem
   **Sprawdź aktualizacje** w panelu bocznym. Gdy jest nowa wersja, pojawia się pogrubiony przycisk **Pobierz**:
   po kliknięciu launcher pobiera aktualizację, instaluje ją po cichu i **sam uruchamia nową wersję**.

   Wydanie powstaje najpierw jako **wersja robocza** (niewidoczna dla launcherów) i staje się publiczne dopiero,
   gdy na GitHubie jest komplet plików z `latest.yml` (instalator, `.blockmap`, zgodne rozmiary). Dzięki temu
   gracz, który akurat sprawdza aktualizacje, nie trafia na wydanie bez `latest.yml` (błąd 404). Gdy wgrywanie
   się przerwie, uruchom `npm run release` ponownie — uzupełni brakujące pliki, a niedokończone, już publiczne
   wydanie samo schowa z powrotem do wersji roboczej.

   Opublikowanego wydania nie da się „poprawić” pod tym samym numerem — launchery porównują wersje, więc każda
   zmiana wymaga wyższej wersji (skrypt robi to za Ciebie). Nie wklejaj tokenu do czatów ani plików; ustawiasz go
   tylko w swoim terminalu.

Uwagi: ogłoszenia to plik `announcements.json` (odświeżany co ok. minutę); uprawnienia zapisu GitHuba są jedyną
prawdziwą granicą — każdy współpracownik z *Write* technicznie może edytować plik, launcher tylko pilnuje, by
zwykły publikujący usuwał własne wpisy. Cofnięcie dostępu = usunięcie współpracownika lub unieważnienie tokenu.

**Gdy gracz nie widzi ogłoszeń:** odczyt jest anonimowy (`raw.githubusercontent.com`, a gdy ten host jest
zablokowany — zapasowo API GitHuba), a błąd pobierania jest pokazywany na ekranie startowym każdemu graczowi.
Najczęstsza przyczyna to stary instalator sprzed wbudowania `GITHUB_REPO` — taki launcher nie ma skąd czytać
ogłoszeń ani aktualizacji i trzeba go raz zainstalować ręcznie z najnowszego wydania.

## Alternatywa: własny serwer ogłoszeń i aktualizacji

Zamiast GitHuba możesz użyć małego serwera (`server/server.js`, bez zależności, dane w plikach JSON) — ma osobne
klucze per osoba z możliwością unieważnienia. W `app-config.js` ustaw wtedy `ANNOUNCEMENTS_URL` zamiast `GITHUB_REPO`.

```bash
node server/server.js create-key "Imię osoby" admin   # lub: publisher (klucz pokazany tylko raz)
node server/server.js list-keys
node server/server.js revoke-key <id>
npm run server                                         # start na 127.0.0.1:8787 (PORT, HOST, DATA_DIR)
```

- Serwer mówi czystym HTTP — w internecie wystaw go przez **HTTPS** (reverse proxy / hosting z TLS, `TRUST_PROXY=1`
  za proxy). Launcher przyjmuje `http://` wyłącznie dla localhost, żeby klucz nie szedł jawnym tekstem.
- W launcherze: *Ustawienia → Ogłoszenia launchera* — adres serwera (ustawiasz go u wszystkich użytkowników) i klucz
  (tylko u osób publikujących). Po zalogowaniu na ekranie startowym pojawia się „Nowe ogłoszenie”.
- Klucze są na serwerze przechowywane jako skróty SHA-256; w launcherze szyfruje je `safeStorage`.
- Role: `publisher` usuwa tylko własne ogłoszenia, `admin` — wszystkie.

### Aktualizacje z własnego serwera

Pliki aktualizacji hostuje ten sam serwer co ogłoszenia (`GET /updates/…`, publicznie; wgrywać może tylko klucz
`admin`). Launcher sprawdza je tak samo jak w trybie GitHub.

**Wydanie nowej wersji (tryb serwera):**

```powershell
npm version patch --no-git-tag-version          # wersja musi rosnąć
$env:CROWN_ADMIN_KEY = "crown_..."              # klucz admina z serwera
npm run release                                  # buduje i wgrywa na serwer (latest.yml na końcu)
```

Dla testów: `CROWN_SERVER=http://127.0.0.1:8787`. Pobieranie jest pełne (bez różnicowego), a integralność pliku
weryfikuje suma SHA-512 z `latest.yml`.

### Prywatna dystrybucja: launcher tylko dla zaproszonych graczy

Gdy launcher ma nie być publicznie dostępny (ani na GitHubie, ani pod adresem serwera), uruchom serwer z
`INVITE_ONLY=1` i zbuduj launcher z `INVITE_REQUIRED: true`.

1. **`app-config.js`:** `GITHUB_REPO: ''`, `ANNOUNCEMENTS_URL: 'https://twoja-domena'`, `INVITE_REQUIRED: true`.
2. **Serwer na VPS** (za HTTPS — Caddy/nginx, `TRUST_PROXY=1`):
   `INVITE_ONLY=1 DATA_DIR=/var/lib/crown node server/server.js`.
3. **Klucz dla gracza** (jeden na osobę, pokazany raz; serwer trzyma tylko skrót):
   ```bash
   node server/server.js create-invite "B3rusek"      # → CROWN-XXXX-XXXX-XXXX-XXXX (1 komputer, bez wygaśnięcia)
   node server/server.js create-invite "Ekipa" --uses 5 --days 30 --note "budowlańcy"
   node server/server.js list-invites                 # kto, użycia, wygaśnięcie, kiedy ostatnio użyty
   node server/server.js revoke-invite <id>           # jednej osobie odbiera dostęp
   node server/server.js release-invite <id>          # zwalnia wszystkie komputery klucza
   ```
   Wygodniej w **panelu**: `npm run panel` otwiera `https://<serwer>/admin` zalogowany (bilet jednorazowy z klucza
   admin zapisanego DPAPI). Przy tworzeniu i edycji klucza ustawiasz **liczbę użyć** (na ilu komputerach można go
   aktywować; ∞ = bez limitu), **datę wygaśnięcia** (po niej klucz nie działa także u osób, które już go aktywowały) i
   notatkę; w liście widać komputery, które użyły klucza, i możesz zwolnić każdy z osobna — launcher na zwolnionym
   komputerze traci klucz przy najbliższym sprawdzeniu i prosi o wpisanie go od nowa (użycie od razu jest wolne).
4. **Gracz:** wchodzi na `https://twoja-domena/`, wpisuje klucz → przeglądarka pobiera instalator. Przy pierwszym
   uruchomieniu launcher prosi o ten sam klucz, sprawdza go na serwerze i zapisuje zaszyfrowany (DPAPI).
5. **Wydania:** jak w trybie serwera (`npm run release`) — numer wersji rośnie sam. Klucz admin podajesz zmienną
   `CROWN_ADMIN_KEY` albo zapisujesz raz na komputerze (plik szyfrowany DPAPI, jak token GitHub — nie trzeba go potem
   wpisywać ani wklejać w czacie):
   ```powershell
   Read-Host "Klucz admin" -AsSecureString | ConvertFrom-SecureString | Set-Content "$env:USERPROFILE\.crownlauncher-admin-key"
   ```
6. **Wydarzenie (IGRZYSKA ŚMIERCI):** klucz z rodzajem „Kod: IGRZYSKA ŚMIERCI” (panel → Nowy klucz → Rodzaj klucza;
   CLI `create-invite "Nazwa" --profile igrzyska`, `set-profile <id> igrzyska|-`) to **kod wydarzenia**. Jako jedyny
   klucz gracza daje launcher ograniczony do wydarzenia (zablokowane Instancje, Serwery, Skiny i Modrinth); gracz z
   pełnym dostępem wpisuje kod w zakładce IGRZYSKA ŚMIERCI i nic mu nie blokuje. W panelu (karta „Wydarzenie”) wgrywasz
   mody (.jar), texturepacki (.zip), shaderpacki, **configi** (też z podfolderów) i **options.txt / servers.dat** —
   pojedynczo albo całym folderem `config` / `.minecraft` — oraz ustawiasz wersję Minecrafta (Fabric). Launcher przed
   każdym startem gry dociąga pliki z weryfikacją SHA-1: mody, texturepacki i shaderpacki to zamknięty zestaw (reszta
   jest usuwana), configi i opcje są wymuszane albo ustawiane jako domyślne (przełącznik „wymuszaj”). Foldery
   `mods`, `resourcepacks`, `shaderpacks`, `config` i `downloads` są u gracza ukryte w Eksploratorze (także przy
   „Pokaż ukryte elementy”) i poza grą zamknięte uprawnieniami NTFS — nie da się do nich wejść nawet po wpisaniu
   ścieżki (w trakcie gry `mods` i `resourcepacks` są tylko do odczytu). Launcher gracza nie pokazuje listy plików
   wydarzenia, nie otwiera narzędzi deweloperskich i (po zbudowaniu pakietu) nie da się go uruchomić jako zwykłego Node'a ani
   podłączyć debuggera; zmieniony `app.asar` kończy się odmową startu. Kod działa tylko w launcherze, który zna wydarzenia (starszy dostaje komunikat
   „wymaga nowszej wersji”).

Co jest chronione: instalator, `latest.yml` i aktualizacje, ogłoszenia, lista blokad, zapis peleryn i obecność —
wszystko wymaga klucza zaproszenia albo klucza administracji. Publiczne zostają `GET /capes/<nick>.png` i
`/v1/crown-users` (czyta je sama gra, która nie ma jak dołączyć klucza). Unieważniony gracz traci pobieranie
i aktualizacje od razu, a launcher blokuje mu start gry przy najbliższym sprawdzeniu (co ≤ 6 h; bez sieci klucz
działa jeszcze do 14 dni od ostatniego potwierdzenia).

**Uczciwe granice:** blokada w samym launcherze zatrzymuje przypadkowe użycie wyniesionego instalatora, ale kto
zmodyfikuje `app.asar`, ją ominie — prawdziwą bramką jest serwer. Klucz jest na osobę, bo da się go komuś podać
dalej (wtedy unieważniasz tę jedną osobę). Kod launchera nie jest tajny: kto ma instalator, rozpakuje `app.asar`.

**Przejście z GitHuba:** graczom, którzy mają już launcher, wystarczy wysłać klucz i link do strony pobierania —
instalator nakłada się na starą wersję, a dane (konta, instancje) zostają. Gdy graczy jest dużo, opublikuj
najpierw wydanie przejściowe na GitHubie z adresem serwera w launcherze:
`npm run release -- --github właściciel/repo` (po przejściu graczy usuń to wydanie i repozytorium).

## Instalator `.exe`

```bash
npm run dist
```

Wynik w katalogu `dist/` (przy `npm run release` — w `release/`). Instalator ma wbudowane wszystkie mody z
`assets/mods`, więc po zmianie jarów uruchom najpierw `node scripts/sync-bundled-mods.js <katalog z jarami>`.

## Logowanie Microsoft

Logowanie działa kodem urządzenia (bez przekierowań i bez haseł w launcherze) i **nie wymaga żadnej konfiguracji**:
domyślnie launcher używa przepływu `login.live.com` z publicznym Client ID oficjalnego launchera Minecrafta
(`00000000402b5328`) — dokładnie tak, jak robił to mod Account Switcher. Tokeny są szyfrowane przez `safeStorage`,
a sesja odświeża się sama (zapamiętany przepływ `live`).

**Uwaga:** to Client ID oficjalnego launchera, nie aplikacji CrownLauncher. Microsoft/Mojang oczekują od
niezależnych launcherów własnej, zatwierdzonej aplikacji, więc takie logowanie może zostać kiedyś zablokowane po
ich stronie. Bezpieczniejsza droga to własny Client ID (kreator: *Ustawienia → Konta → Dla zaawansowanych: własny
Client ID*, albo `MS_CLIENT_ID` w [`src/main/core/app-config.js`](src/main/core/app-config.js)): rejestracja w Azure,
„Allow public client flows” i zgłoszenie aplikacji do Mojang formularzem <https://aka.ms/AppRegInfo>. Własny
Client ID ma pierwszeństwo przed wbudowanym; konto offline działa zawsze.

## Struktura

```
src/main/            proces główny Electrona
  core/              logika launchera (bez zależności od UI)
    mojang.js        manifest wersji, reguły, dziedziczenie profili
    installer.js     biblioteki, klient, zasoby
    java.js          runtime Javy od Mojang
    loaders.js       Fabric
    launch.js        budowa polecenia i uruchomienie procesu
    export.js        eksport instancji do .mrpack (overrides/, bez logów i plików poufnych), zip-writer.js: strumieniowy zapis ZIP
    game.js          stan uruchomień, logi
    modrinth.js      API Modrinth, instalacja, .mrpack
    auth.js          konta offline i Microsoft
    avatars.js       twarze kont przez serwer launchera (mc-heads.net nie poznaje adresu IP gracza)
    instances.js     CRUD instancji i zawartości
    servers.js       lista serwerów, Server List Ping, import z servers.dat
    nbt.js           parser i serializer NBT (servers.dat)
    pinned-servers.js przypięte serwery na górze servers.dat (przed startem i po zamknięciu gry)
    bundled-mods.js  dobór wbudowanych modów (assets/mods) do wersji gry
    discord.js       Discord Rich Presence przez lokalny potok IPC (bez bibliotek)
    capes.js         biblioteka peleryn, wybór, CustomSkinLoader (konfiguracja tylko pod peleryny), nadawanie przez GitHub
    cape-art.js      wbudowane peleryny rysowane programowo + koder PNG
    performance-mods.js  Sodium, Lithium itd. dokładane do instancji Fabric
    skins.js         biblioteka skinów, odczyt oficjalnego skina i modelu + wykrywanie zmian, API peleryn konta, wyszukiwanie po nicku
    announcements.js klient ogłoszeń (GitHub / serwer): odczyt, logowanie kluczem, publikacja
    news.js          lista newsów = ogłoszenia (cache, kolejność przypiętych)
    app-config.js    wbudowane ustawienia: repozytorium, serwery przypięte, Discord, Client ID Microsoft
  updater.js         automatyczne aktualizacje (electron-updater: GitHub Releases albo serwer)
  ipc.js             kanały IPC
src/renderer/        interfejs (czysty HTML/CSS/JS, bez bundlera)
assets/              logo i ikony
```
