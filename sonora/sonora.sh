#!/usr/bin/env bash
# Inicia Sonora como servidor para usarla en el navegador (alternativa a la app de escritorio).
# Solo atiende a este equipo. Variables opcionales: SONORA_MUSIC_DIR, SONORA_PORT.
cd "$(dirname "$0")"
exec uv run uvicorn main:app --app-dir backend --host 127.0.0.1 --port "${SONORA_PORT:-8765}"
