#!/usr/bin/env bash
# Enable the daily CS Reels run (06:30, or at next boot if the PC was off).
# Undo with: systemctl --user disable --now cs-reels.timer
set -e
mkdir -p ~/.config/systemd/user
cp "$(dirname "$0")"/cs-reels.service "$(dirname "$0")"/cs-reels.timer ~/.config/systemd/user/
# Without lingering, systemd kills user services when you log out or the session ends,
# which cuts a running pipeline off mid-way (it happened on 2026-11-18).
loginctl enable-linger "$USER"
systemctl --user daemon-reload
systemctl --user enable --now cs-reels.timer
systemctl --user list-timers cs-reels.timer --no-pager
