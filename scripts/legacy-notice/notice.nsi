; „Aktualizacja” dla starych launcherów (GitHub-mode, wersje <= 0.1.19), które odpytują repozytorium GitHub.
; To NIE jest launcher: instalator niczego nie instaluje - pokazuje komunikat i otwiera stronę z nowym launcherem.
; Stary launcher pobiera go jako „nową wersję”, uruchamia po cichu (/S), a komunikat jest widoczny mimo to
; (MessageBox bez /SD pokazuje się także w trybie cichym).
;
; Budowa:  makensis /DOUT=plik.exe notice.nsi             wersja produkcyjna (okno + otwarcie strony)
;          makensis /DOUT=plik.exe /DTEST_FILE=C:\x.txt notice.nsi   wersja testowa (zapisuje wiersz poleceń, bez okien)

Unicode true
Name "CrownLauncher"
Caption "CrownLauncher"
!ifndef OUT
  !define OUT "CrownLauncher-notice.exe"
!endif
OutFile "${OUT}"
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow
AutoCloseWindow true

!define SITE "https://launcher.locken.pl"

Section
!ifdef TEST_FILE
  ; test: tylko ślad uruchomienia (wiersz poleceń, z jakim launcher uruchomił instalator)
  FileOpen $0 "${TEST_FILE}" w
  FileWrite $0 "$CMDLINE"
  FileClose $0
!else
  MessageBox MB_OK|MB_ICONINFORMATION|MB_TOPMOST "Ta wersja CrownLaunchera jest przestarzała i nie będzie już aktualizowana.$\r$\n$\r$\nNajnowszy launcher pobierzesz ze strony:$\r$\n${SITE}$\r$\n$\r$\nDo pobrania potrzebny jest klucz zaproszenia od administratora."
  ExecShell "open" "${SITE}" "" SW_SHOWNORMAL
!endif
SectionEnd
