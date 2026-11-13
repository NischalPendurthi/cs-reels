#!/usr/bin/env bash
# Enable the daily CS Reels run (06:30, or at next boot if the PC was off).
# Undo with: systemctl --user disable --now cs-reels.timer
set -e
mkdir -p ~/.config/systemd/user
cp "$(dirname "$0")"/cs-reels.service "$(dirname "$0")"/cs-reels.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now cs-reels.timer
systemctl --user list-timers cs-reels.timer --no-pager
