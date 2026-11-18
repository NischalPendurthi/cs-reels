# CS Reels

A reels-style feed for CS interview prep: C++, OS, Computer Networks, DBMS, Computer Architecture and AI/ML (incl. LLMs and agents).
Everything follows the interview syllabus in `pipeline/syllabus.json`; clips that don't teach a syllabus item are dropped.
Clips are cut from trusted lecture channels and filtered Shorts, scored by Claude, and published daily.

```
app/        the installable web app (static: HTML/CSS/JS)
  data/     index.json + days/<date>.json  (written by the pipeline)
pipeline/   daily clip pipeline
  syllabus.json the interview syllabus per topic (the only allowed material; `q` = search query)
  config.json   topics, trusted channels, source exclusions, daily amounts, quality bar
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

**Source rules** (`config.json → exclude`). A video is never used if it
- is on the Prep Hub site (`~/Desktop/prep-hub/videos`: Video Picks and `data.js`),
- was uploaded more than `max_age_years` (8) years ago,
- is by an Indian creator (`indian_creators`, plus Claude's judgement per channel, cached in
  `state.json → creator_indian`).

Content comes from searching the trusted channels, as below:

1. Each topic has an ordered list of items in `syllabus.json`. Every run advances along it,
   rotating topics, and wraps around when it reaches the end. Later passes pick *different* videos,
   because already-processed videos are skipped.
2. Lectures are found by searching inside each topic's `channels`; Claude picks the most rigorous
   match for the `audience` described in the config. Shorts (whole reels) come from the same channels:
   searched inside each channel, plus a YouTube Shorts search filtered to those channels.
3. Claude cuts each lecture into 30–240s self-contained clips, scores accuracy, standalone value,
   clarity and depth (1–10), names the syllabus item each clip teaches, and writes quiz questions.
   Off-syllabus clips and clips below the `quality` bar are dropped.
   If YouTube rate-limits transcript requests (IpBlocked) or the network fails, the affected videos
   are not marked processed and are retried on the next run.
4. App feedback (exported JSON in `pipeline/feedback/`) removes reported clips; a channel with 3+
   reports is blocked.

Tune volume in `config.json → daily` (8 lectures/day gives roughly 25–35 deep clips).

## Android app

`android-app/` is a Capacitor wrapper that loads https://nischalpendurthi.github.io/cs-reels/,
so app and clip updates arrive without reinstalling. Native extras: sound plays without a tap,
portrait lock, and local notifications (08:00 "new clips", 21:00 streak nudge if you haven't watched yet).

Rebuild the APK (only needed when native code, the icon or `capacitor.config.json` changes):

```
cd ~/cs-reels/android-app && npx cap sync android && cd android && ANDROID_HOME=~/Android/Sdk ./gradlew assembleDebug
# → android-app/android/app/build/outputs/apk/debug/app-debug.apk
```
