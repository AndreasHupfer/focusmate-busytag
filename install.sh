#!/usr/bin/env bash
set -euo pipefail

EXTENSION_UUID="focusmate-busytag@reales"
EXTENSIONS_DIR="$HOME/.local/share/gnome-shell/extensions"
TARGET_DIR="$EXTENSIONS_DIR/$EXTENSION_UUID"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
    echo -e "${BOLD}Focusmate BusyTag — GNOME Shell Extension${NC}"
    echo "=========================================="
}

check_deps() {
    local missing=()
    command -v glib-compile-schemas &>/dev/null || missing+=("glib-compile-schemas  →  sudo apt install libglib2.0-bin")
    command -v gnome-extensions &>/dev/null || missing+=("gnome-extensions  →  sudo apt install gnome-shell-extensions")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo -e "${RED}Fehlende Abhängigkeiten:${NC}"
        for dep in "${missing[@]}"; do
            echo "  $dep"
        done
        exit 1
    fi
}

install_extension() {
    mkdir -p "$EXTENSIONS_DIR"

    if [[ "$SCRIPT_DIR" == "$TARGET_DIR" ]]; then
        echo "Installationsverzeichnis ist bereits das Ziel — kein Symlink nötig."
    elif [[ -L "$TARGET_DIR" ]]; then
        echo "Entferne vorhandenen Symlink..."
        rm "$TARGET_DIR"
        ln -s "$SCRIPT_DIR" "$TARGET_DIR"
        echo -e "${GREEN}✓ Symlink aktualisiert${NC}"
    elif [[ -d "$TARGET_DIR" ]]; then
        echo -e "${YELLOW}$TARGET_DIR existiert bereits als Ordner.${NC}"
        read -r -p "Überschreiben? [j/N] " confirm
        if [[ "$confirm" =~ ^[jJ]$ ]]; then
            rm -rf "$TARGET_DIR"
            ln -s "$SCRIPT_DIR" "$TARGET_DIR"
            echo -e "${GREEN}✓ Symlink erstellt${NC}"
        else
            echo "Abgebrochen."
            exit 0
        fi
    else
        ln -s "$SCRIPT_DIR" "$TARGET_DIR"
        echo -e "${GREEN}✓ Symlink erstellt: $TARGET_DIR${NC}"
    fi
}

compile_schema() {
    echo "Kompiliere GSettings-Schema..."
    glib-compile-schemas "$TARGET_DIR/schemas/"
    echo -e "${GREEN}✓ Schema kompiliert${NC}"
}

enable_extension() {
    echo "Aktiviere Extension..."
    gnome-extensions enable "$EXTENSION_UUID" 2>/dev/null || true

    local state
    state=$(gnome-extensions info "$EXTENSION_UUID" 2>/dev/null | grep "State:" | awk '{print $2}' || echo "UNKNOWN")

    if [[ "$state" == "ENABLED" ]]; then
        echo -e "${GREEN}✓ Extension aktiv${NC}"
    else
        echo -e "${YELLOW}Extension registriert — GNOME Shell neu laden:${NC}"
        echo "  X11:     Alt+F2 → 'r' → Enter"
        echo "  Wayland: Abmelden und wieder anmelden"
    fi
}

uninstall_extension() {
    echo "Deaktiviere Extension..."
    gnome-extensions disable "$EXTENSION_UUID" 2>/dev/null || true

    if [[ -L "$TARGET_DIR" ]]; then
        rm "$TARGET_DIR"
        echo -e "${GREEN}✓ Symlink entfernt${NC}"
    elif [[ -d "$TARGET_DIR" ]]; then
        rm -rf "$TARGET_DIR"
        echo -e "${GREEN}✓ Verzeichnis entfernt${NC}"
    else
        echo "Nichts zu entfernen unter $TARGET_DIR"
    fi
    echo "Deinstallation abgeschlossen."
}

# ── Hauptprogramm ──────────────────────────────────────────────────────────────

print_header

case "${1:-install}" in
    install)
        check_deps
        install_extension
        compile_schema
        enable_extension
        echo ""
        echo -e "${GREEN}${BOLD}Fertig!${NC} Öffne die Einstellungen und trage deinen Focusmate API-Key ein."
        ;;
    uninstall)
        uninstall_extension
        ;;
    schema)
        compile_schema
        ;;
    *)
        echo "Verwendung: $0 [install|uninstall|schema]"
        echo "  install    Symlink setzen, Schema kompilieren, Extension aktivieren (Standard)"
        echo "  uninstall  Extension deaktivieren und Symlink/Ordner entfernen"
        echo "  schema     Nur GSettings-Schema neu kompilieren"
        exit 1
        ;;
esac
