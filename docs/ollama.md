# Ollama anbinden

GeoTandem spricht Modelle über eine OpenAI-kompatible Schnittstelle an
(Adresse mit `/v1`, eingetragen unter *Administration › Modell ›
Modellanbindungen*, siehe [README](../README.md#modellanbindungen-ab-e2)).
Diese Seite beschreibt, wie [Ollama](https://ollama.com) dafür aufgesetzt wird:

1. **Ollama als Container** (empfohlen), mit `docker run` oder Compose.
2. **Ollama nativ auf dem Host.**

Warum zwei Wege: Läuft GeoTandem im Container, ist `localhost` der Container
selbst. Ein Ollama, das nur auf `127.0.0.1` des Hosts lauscht (Standard der
nativen Installation), ist von dort nicht erreichbar. Im gemeinsamen
Docker-Netz dagegen erreicht GeoTandem Ollama unter dessen Containernamen,
ohne Eingriff in den Host.

## 1. Ollama als Container (empfohlen)

Beide Container hängen im selben Docker-Netz `llm`. Port 11434 muss dafür nicht
auf dem Host veröffentlicht werden; das Image `ollama/ollama` lauscht im Netz
bereits auf allen Adressen.

### Mit Compose

`compose.yaml` in einem eigenen Verzeichnis, getrennt von GeoTandem:

```yaml
services:
  ollama:
    image: ollama/ollama:latest
    container_name: ollama
    restart: unless-stopped
    # Nur nötig, wenn eine Anwendung auf dem Host (z. B. uvicorn) Ollama
    # ebenfalls nutzt; sonst weglassen.
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - ./models:/root/.ollama
    environment:
      OLLAMA_CONTEXT_LENGTH: 16384
    # NVIDIA-GPU; ohne GPU den ganzen Block `deploy` weglassen.
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
    networks: [llm]

networks:
  llm:
    name: llm   # fester Name, damit GeoTandem das Netz als `external` einbinden kann
```

```sh
docker compose up -d
docker exec ollama ollama pull qwen3:8b
```

### Mit `docker run`

```sh
docker network create llm
docker run -d --name ollama --network llm --restart unless-stopped \
  -v ollama:/root/.ollama -e OLLAMA_CONTEXT_LENGTH=16384 ollama/ollama
#  mit NVIDIA-GPU zusätzlich: --gpus all
#  für Anwendungen auf dem Host zusätzlich: -p 127.0.0.1:11434:11434
docker exec ollama ollama pull qwen3:8b
# ein schon laufender Ollama-Container kommt so ins Netz:
docker network connect llm ollama
```

### GPU prüfen

Voraussetzung ist das NVIDIA Container Toolkit auf dem Host
(`sudo nvidia-ctk runtime configure --runtime=docker`, danach Docker neu
starten).

```sh
docker exec ollama nvidia-smi    # die GPU ist im Container sichtbar
docker exec ollama ollama ps     # bei geladenem Modell: PROCESSOR «100% GPU»
```

### GeoTandem ins Netz bringen

Mit `docker run`: `--network llm`. Die [compose.yaml](../compose.yaml) von
GeoTandem hängt den Dienst bereits an das externe Netz `llm`; das Ollama-Projekt
muss zuerst laufen, damit das Netz existiert (sonst `docker network create
llm`). Ein eigenes `compose.override.yaml` ist nicht nötig.

Adresse der Anbindung: `http://ollama:11434/v1`.

Ein Containername ist für GeoTandem ein gewöhnlicher Hostname und gilt damit
als **extern**: Die Anbindung trägt das Kennzeichen «extern · ollama» und
erhält nur Metadaten. Die mitgelieferte `compose.yaml` gibt den Namen `ollama`
schon frei (`GEOTANDEM_LLM_LOCAL_HOSTS` ist dort `ollama` voreingestellt); mit
`docker run` oder einem anderen Containernamen selbst setzen, etwa in `.env`:

```sh
GEOTANDEM_LLM_LOCAL_HOSTS=ollama
```

## 2. Ollama nativ auf dem Host

Der Container erreicht den Host als `host.docker.internal`
([compose.yaml](../compose.yaml) setzt dafür `host-gateway`; mit `docker run`:
`--add-host host.docker.internal:host-gateway`).

Ollama lauscht standardmässig nur auf `127.0.0.1` und ist damit aus dem
Container nicht erreichbar. `OLLAMA_HOST` auf die Adresse der Docker-Brücke
setzen (meist `172.17.0.1:11434`, prüfbar mit `ip -4 addr show docker0`) oder
auf `0.0.0.0:11434` und den Port nach aussen sperren. Mit systemd:

```sh
sudo systemctl edit ollama
```

```ini
[Service]
Environment="OLLAMA_HOST=172.17.0.1:11434"
Environment="OLLAMA_CONTEXT_LENGTH=16384"
```

```sh
sudo systemctl restart ollama
```

Adresse der Anbindung: `http://host.docker.internal:11434/v1`.
`host.docker.internal` gilt als lokal.

Folgen für den Host: Das Kommandozeilenwerkzeug `ollama` erreicht den Server
nicht mehr auf `127.0.0.1`; dafür `export OLLAMA_HOST=172.17.0.1:11434` setzen.
Anwendungen, die direkt auf dem Host laufen (ohne Container), brauchen die
Änderung nicht, solange sie `127.0.0.1` nutzen und Ollama dort lauscht.

Läuft GeoTandem selbst nativ (ohne Container), genügt Ollama mit den
Standardeinstellungen und die Adresse `http://localhost:11434/v1`.

## Kontextlänge

Die Kontextlänge der Anbindung ist ein Budget für den Steckbrief und wird
nicht gesendet: die `/v1`-Schnittstelle kennt kein Feld dafür. Sie muss zu
`OLLAMA_CONTEXT_LENGTH` passen (in den Beispielen oben auf `16384` gesetzt),
sonst schneidet Ollama den Kontext still ab.

## Fehlersuche

- **Verbindung abgelehnt vom Container aus (nativ):** Ollama lauscht nur auf
  `127.0.0.1`. Prüfen mit `ss -ltn | grep 11434`, dann wie in Abschnitt 2
  umstellen.
- **`lookup registry.ollama.ai … 127.0.0.53 … connection refused` im
  Ollama-Container:** Der Container hängt an keinem Docker-Netz und hat darum
  die Namensauflösung des Hosts geerbt (`docker exec ollama cat
  /etc/resolv.conf` zeigt `127.0.0.53` statt `127.0.0.11`). Container neu
  erzeugen: `docker compose down && docker compose up -d`. Die Modelle bleiben
  im Volume bzw. in `./models`.
- **Verbindungstest meldet fehlenden Werkzeugaufruf:** Das Modell kann keine
  Werkzeuge (etwa `gemma3:4b`); ein anderes wählen, z. B. `qwen3:8b`.
