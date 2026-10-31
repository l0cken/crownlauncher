#!/usr/bin/env bash
# Zbudowanie CrownLaunchera dla Linuksa (AppImage x86_64) + testy Linuksa. SAMOWYSTARCZALNE: potrzebuje tylko Node 22+ (najlepiej 24),
# npm i dostępu do internetu (pobierze Electrona i narzędzia electron-buildera). Uruchom w katalogu projektu (rozpakowanym źródle):
#
#     bash scripts/build-linux.sh              # testy Linuksa + build AppImage
#     bash scripts/build-linux.sh --smoke      # dodatkowo uruchomi zbudowany AppImage na 15 s (wymaga ekranu albo xvfb-run)
#     bash scripts/build-linux.sh --no-tests   # tylko build
#
# Wynik: release/CrownLauncher-<wersja>.AppImage + release/latest-linux.yml (+ .blockmap, jeśli powstanie). Te pliki skopiuj do folderu
# release/ projektu na Windowsie i tam uruchom:   npm.cmd run release -- --linux --skip-build
# (wgrywa je na serwer launcher.locken.pl kluczem admin z pliku DPAPI; wersja musi być ta sama co w wydaniu Windows).
set -uo pipefail
cd "$(dirname "$0")/.."

RUN_TESTS=1
SMOKE=0
for a in "$@"; do
  case "$a" in
    --no-tests) RUN_TESTS=0 ;;
    --smoke) SMOKE=1 ;;
    -h|--help) sed -n '2,13p' "$0"; exit 0 ;;
    *) echo "Nieznana opcja: $a"; exit 1 ;;
  esac
done

say() { printf '\n\033[1;33m→ %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || die "Brak Node.js. Zainstaluj Node 24 (np. nvm: https://github.com/nvm-sh/nvm, potem: nvm install 24)."
command -v npm >/dev/null || die "Brak npm."
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
[ "$NODE_MAJOR" -ge 22 ] || die "Node $(node -v) jest za stary - potrzebny 22 albo nowszy (zalecany 24)."
ARCH=$(uname -m)
if [ "$ARCH" != "x86_64" ]; then
  echo "UWAGA: ten komputer to $ARCH, a config buduje AppImage x64 - na ARM electron-builder może się nie udać (patrz README: Java na ARM)."
fi
VERSION=$(node -p "require('./package.json').version")
say "CrownLauncher $VERSION - Node $(node -v), $ARCH"

say "npm ci"
npm ci || die "npm ci nie powiodło się (internet? wersja Node?)."

FAILED=()
run_test() {
  local name="$1"
  say "test: $name"
  if node "dev-tests/$name.js"; then echo "  ✓ $name"; else echo "  ✗ $name"; FAILED+=("$name"); fi
}
if [ "$RUN_TESTS" = 1 ]; then
  run_test linux-support-test   # logika Linuksa z podstawioną platformą
  run_test linux-real-test      # prawdziwy /proc, dlopen, chmod (tylko Linux)
  run_test export-test          # eksport .mrpack (ostatni punkt potrzebuje internetu)
  run_test secrets-test
fi

say "budowanie AppImage (to trwa kilka minut: pobiera Electrona i narzędzia)"
export CROWN_OUT_DIR=release CROWN_TARGET=linux
npm run dist:linux || die "Budowanie AppImage nie powiodło się - patrz komunikaty wyżej."

APPIMAGE="release/CrownLauncher-$VERSION.AppImage"
YML="release/latest-linux.yml"
[ -f "$APPIMAGE" ] || die "Brak $APPIMAGE po buildzie."
[ -f "$YML" ] || die "Brak $YML po buildzie."
chmod +x "$APPIMAGE"

say "kontrola plików"
node -e "
const fs = require('fs'), crypto = require('crypto');
const yml = fs.readFileSync('$YML', 'utf8');
const want = /sha512:\s*(\S+)/.exec(yml)?.[1];
const size = Number(/size:\s*(\d+)/.exec(yml)?.[1]);
const buf = fs.readFileSync('$APPIMAGE');
const got = crypto.createHash('sha512').update(buf).digest('base64');
if (!yml.includes('CrownLauncher-$VERSION.AppImage')) { console.error('latest-linux.yml nie wskazuje na AppImage'); process.exit(1); }
if (got !== want) { console.error('SHA-512 AppImage różni się od latest-linux.yml'); process.exit(1); }
if (size && size !== buf.length) { console.error('rozmiar AppImage różni się od latest-linux.yml'); process.exit(1); }
console.log('  ✓ latest-linux.yml zgodny z plikiem: ' + (buf.length / 1048576).toFixed(1) + ' MB, wersja $VERSION');
" || die "Pliki wydania są niespójne."

SMOKE_RESULT="(nie uruchamiano - dodaj --smoke)"
if [ "$SMOKE" = 1 ]; then
  say "start AppImage na 15 s"
  UD=$(mktemp -d)
  EXTRA=()
  [ "$(id -u)" = 0 ] && EXTRA+=(--no-sandbox)   # root: Electron odmawia startu z sandboxem
  LAUNCH=("$APPIMAGE" --appimage-extract-and-run --user-data-dir="$UD" "${EXTRA[@]}")
  if [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; then
    if command -v xvfb-run >/dev/null; then LAUNCH=(xvfb-run -a "${LAUNCH[@]}"); else LAUNCH=(); fi
  fi
  if [ ${#LAUNCH[@]} -eq 0 ]; then
    SMOKE_RESULT="pominięto: brak ekranu (DISPLAY/WAYLAND_DISPLAY) i xvfb-run"
  else
    "${LAUNCH[@]}" >"$UD/smoke.log" 2>&1 &
    PID=$!
    sleep 15
    if kill -0 "$PID" 2>/dev/null; then
      SMOKE_RESULT="OK - aplikacja działała 15 s bez wyjścia"
      pkill -P "$PID" 2>/dev/null; kill "$PID" 2>/dev/null
    else
      SMOKE_RESULT="BŁĄD - aplikacja zakończyła się przed 15 s; log: $UD/smoke.log"
      tail -n 15 "$UD/smoke.log"
      FAILED+=("smoke")
    fi
    wait "$PID" 2>/dev/null
  fi
fi

say "GOTOWE"
echo "  AppImage:        $(pwd)/$APPIMAGE"
echo "  latest-linux.yml: $(pwd)/$YML"
ls release/*.blockmap 2>/dev/null | sed 's/^/  blockmap:         /' | head -3
echo "  start (smoke):   $SMOKE_RESULT"
if [ ${#FAILED[@]} -gt 0 ]; then
  printf '\n\033[1;31mUWAGA: nie przeszło: %s\033[0m\n' "${FAILED[*]}"
  echo "Zapisz pełne wyjście tego polecenia (to ważna informacja o Linuksie) przed wydaniem AppImage."
fi
cat <<EOF

Co dalej:
  1. Uruchom AppImage ręcznie i sprawdź: okno się otwiera, klucz zaproszenia i konto offline działają, gra startuje,
     w konsoli gry nie ma alarmów "ANTYCHEAT: wykryto wstrzyknięte biblioteki" na legalnych bibliotekach.
     Gdy AppImage nie startuje: sudo apt install libfuse2  albo  $APPIMAGE --appimage-extract-and-run
  2. Skopiuj  $APPIMAGE  i  $YML  (oraz .blockmap, jeśli jest) do folderu release/ projektu na Windowsie.
  3. Na Windowsie:  npm.cmd run release -- --linux --skip-build
EOF
[ ${#FAILED[@]} -eq 0 ]
