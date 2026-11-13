# CS Reels

A reels-style feed with only core CS topics: DBMS, Computer Networks, Computer Architecture, C++ and AI/ML.
Clips are cut from trusted lecture channels and filtered Shorts, scored by Claude, and published daily.

```
app/        the installable web app (static: HTML/CSS/JS)
  data/     index.json + days/<date>.json  (written by the pipeline)
pipeline/   daily clip pipeline
  config.json   topics, syllabus order, trusted channels, daily amounts, quality bar
  state.json    syllabus position per topic, processed videos, run history
  logs/         one log per day
  feedback/     drop exported feedback files from the app here
systemd/    daily timer
```

## Daily use

| Task | Command |
|---|---|
| Turn on the daily run (06:30, catches up after boot) | `~/cs-reels/systemd/install-timer.sh` |
| Turn it off | `systemctl --user disable --now cs-reels.timer` |
| Run now | `~/cs-reels/pipeline/run-daily.sh` |
| Add more clips today | `~/cs-reels/pipeline/run-daily.sh --force` |
| One topic only | `~/cs-reels/pipeline/run-daily.sh --force --topics cpp --lectures 3` |
| See what tomorrow will fetch | `~/cs-reels/pipeline/run-daily.sh --plan` |
| Today's log | `cat ~/cs-reels/pipeline/logs/$(date +%F).log` |
| Open the app on this PC | `cd ~/cs-reels/app && python3 -m http.server 8765`, then open http://localhost:8765 |

## How the pipeline picks content

1. Each topic has an ordered `syllabus` in `config.json`. Every run advances along it,
   rotating topics, and wraps around when it reaches the end. Later passes pick *different* videos,
   because already-processed videos are skipped.
2. Lectures come only from `trusted_channels`. Shorts can come from anywhere but must score higher
   (`min_avg_score_untrusted_short`).
3. Claude cuts each lecture into 30–150s self-contained clips, scores accuracy, standalone
   value and clarity (1–10), and writes quiz questions. Clips below the quality bar are dropped.
4. App feedback (exported JSON in `pipeline/feedback/`) removes reported clips; a channel with 3+
   reports is blocked.

Tune volume in `config.json → daily` (6 lectures + 5 Shorts searches comes to roughly 30–40 clips/day).
