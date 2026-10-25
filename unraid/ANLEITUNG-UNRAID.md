# HomeDeck auf Unraid installieren

Diese Anleitung beschreibt, wie du HomeDeck als Docker-Container auf Unraid installierst —
entweder klassisch per **Container-Template** (Variante A, funktioniert auf Unraid 6.12 und 7.x)
oder per **Docker Compose** (Variante B, Unraid 7.x mit integriertem Compose-Manager).

---

## Voraussetzungen

- Unraid 6.12+ (empfohlen: 7.x)
- Die HomeDeck-Projektdateien (dieser Ordner) auf deinem PC
- Ports: **8080** (Dashboard). Wenn der belegt ist, in Template/Compose einen anderen wählen.

---

## Schritt 1 — Projekt auf Unraid kopieren

1. Freigabe öffnen: `\\TOWER\appdata` (bzw. `\\<Dein-Unraid>\appdata`) im Windows-Explorer.
2. Neuen Ordner anlegen: `appdata\homedeck-src`
3. Den **Inhalt** des Projektordners dorthin kopieren:
   - `server/`, `public/`, `mock/`, `tests/`
   - `package.json`, `package-lock.json`, `Dockerfile`, `README.md`
   - **Nicht nötig:** `node_modules/` (wird im Image frisch installiert) und `data/`
     (darf auf dem Server nicht existieren — die Daten liegen später in `appdata/homedeck`)

Über die Unraid-Konsole prüfen:

```bash
ls /mnt/user/appdata/homedeck-src
# erwartet: Dockerfile  package.json  package-lock.json  public  server
```

---

## Schritt 2 — Docker-Image auf Unraid bauen

Unraid-Terminal öffnen (unten rechts `>_ Terminal`) und:

```bash
docker build --pull -t homedeck:latest /mnt/user/appdata/homedeck-src
```

Das dauert ein paar Minuten (Node-Basis-Image + npm-Abhängigkeiten). Danach:

```bash
# Node.js 24.22.1 (Security-Release 21.10.2026) ist im Dockerfile gepinnt.
docker images | grep homedeck
# erwartet:  homedeck   latest   ...
```

> 💡 Das Image wird lokal gebaut und liegt nur auf deinem Unraid. Die Warnung
> **"Repository not found on Docker Hub"** beim Anlegen des Containers ist daher **normal**.

---

## Schritt 3A — Installation per Template (Variante A, empfohlen)

1. Template-Datei auf den Unraid-USB-Stick kopieren:
   - Windows: `\\TOWER\flash\config\plugins\dockerMan\templates-user\`
   - Datei `unraid/homedeck.xml` dorthin kopieren.
2. Unraid-WebUI → **Docker** → **Add Container** (oben links).
3. Im Feld **Template** die geladene Datei `homedeck.xml` auswählen (Pfeil im Feld).
4. Alle Felder sind vorausgefüllt:
   - **Repository:** `homedeck:latest`
   - **Web-UI-Port:** `8080`
   - **Appdata:** `/mnt/user/appdata/homedeck` (Datenbank, Uploads, Verschlüsselungsschlüssel)
   - **Docker-Socket:** standardmäßig nicht gemountet (Host-Root-Risiko). Für das Docker-Widget einen filternden Socket-Proxy verwenden.
5. **Apply** → Container startet. Über das Icon (WebUI) erreichst du das Dashboard.
6. Beim ersten Aufruf legt deinen **Admin-Account** an — fertig! 🎉

---

## Schritt 3B — Installation per Docker Compose (Variante B, Unraid 7.x)

1. Auf dem Flash-Laufwerk den Ordner anlegen:
   `flash/config/compose/homedeck/` (Windows: `\\TOWER\flash\config\compose\homedeck\`)
2. Den **kompletten Projektquellcode** (wie in Schritt 1, inkl. `Dockerfile`,
   `package.json`, `server/`, `public/`, `package-lock.json`) **plus** die Datei
   `unraid/docker-compose.yml` in diesen Ordner kopieren.
3. Unraid-WebUI → **Docker** → Reiter **Compose** (ab Unraid 7 vorhanden) →
   Projekt `homedeck` erscheint dort → **Compose Up**.
   Der Compose-Manager baut das Image (`build: .`) und startet den Container.
4. Dashboard: `http://<Unraid-IP>:8080`

---

## Schritt 4 — Dienste eintragen (wichtig bei Unraid!)

Weil HomeDeck im **Bridge-Netzwerk** des Containers läuft, erreichst du deine anderen
Container **nicht** über `localhost` oder `127.0.0.1`, sondern über:

- **die IP deines Unraid-Servers** (empfohlen), z. B. `http://192.168.1.10:8989` für Sonarr
  — das funktioniert für jeden Container mit Port-Mapping, oder
- **Container-Namen** wie `http://sonarr:8989` — das geht nur, wenn beide Container im
  selben Custom-Netzwerk hängen (bei Unraid standardmäßig nicht der Fall).

Also: In HomeDeck → **Admin → Services → Service hinzufügen** jeweils
`http://<Unraid-LAN-IP>:<Port>` eintragen plus API-Key/Passwort, mit **Test** prüfen, fertig.

**Tipp:** Host-IP fixieren (Unraid → Settings → Network) oder den Unraid-Namen verwenden
(`http://tower:8989`), falls dein Router/Unraid Namensauflösung anbietet.

---

## Updates

1. Geänderte Projektdateien erneut nach `appdata/homedeck-src` kopieren.
2. Image neu bauen:
   ```bash
   docker build --pull -t homedeck:latest /mnt/user/appdata/homedeck-src
   ```
3. Docker-Tab → HomeDeck → **Apply** / „Force update" (startet mit dem neuen Image neu).
   Deine Einstellungen (Datenbank) bleiben erhalten — sie liegen in `appdata/homedeck`.

## Backup

Alles Wichtige liegt in einem Ordner:

```
/mnt/user/appdata/homedeck/    ← homedeck.db (SQLite), .secret (Schlüssel), uploads/
```

Diesen Ordner in deine bestehende Unraid-Sicherung aufnehmen, dann sind Benutzer,
Layouts, Dienste und Zugangsdaten komplett gesichert.

---

## Reverse Proxy / HTTPS (optional)

Wenn HomeDeck über Nginx Proxy Manager / Swag / Caddy mit HTTPS erreichbar sein soll:

1. Im Template/Compose `TRUST_PROXY=1` setzen.
2. `SECURE_COOKIES=1` setzen, wenn **nur** HTTPS genutzt wird.
3. Reverse-Proxy muss **Websockets/SSE** durchreichen (Standard bei nginx `proxy_pass`-Setups:
   `proxy_set_header Upgrade $http_upgrade; proxy_set_header Connection "upgrade";` nicht nötig —
   SSE ist einfaches HTTP-Streaming, aber **Pufferung deaktivieren**:
   `proxy_buffering off; proxy_cache off;`).
4. Nach Änderung dieser Variablen den Container neu starten **und** ggf. neu einloggen.

---

## Fehlerbehebung

| Problem | Lösung |
| --- | --- |
| „Repository not found on Docker Hub“ beim Anlegen | Normal bei lokal gebauten Images — ignorieren. |
| Container startet nicht, Port belegt | In der Unraid-Log nachsehen (`docker logs HomeDeck`); Port 8080 im Template ändern. |
| Docker-Widget zeigt offline | Standardmäßig kein Socket-Mount (Sicherheit). Für das Widget einen filternden Socket-Proxy einrichten; Widget-Test in Admin → Services → ⚡. |
| Dienste „offline“ trotz laufendem Dienst | Statt `localhost` die **Unraid-LAN-IP** als URL verwenden (siehe Schritt 4). |
| Nach Reverse-Proxy kein Login / OAuth schlägt fehl | `TRUST_PROXY=1` setzen, Container neu starten. |
| Login-Seite lädt, aber nichts geht / alte Oberfläche | Browser-Cache leeren (Strg+Shift+R). |
| 2FA gesetzt und Code verloren | Admin kann 2FA in **Admin → Users** zurücksetzen. |

---

## Dateien in diesem Ordner (`unraid/`)

| Datei | Zweck |
| --- | --- |
| `homedeck.xml` | Unraid-Container-Template für „Add Container“ (Variante A) |
| `docker-compose.yml` | Compose-Datei für den Compose-Manager von Unraid 7 (Variante B) |
| `ANLEITUNG-UNRAID.md` | Diese Anleitung |
