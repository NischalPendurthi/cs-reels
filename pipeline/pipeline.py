#!/usr/bin/env python3
"""CS Reels daily clip pipeline.

Each run:
  1. picks the next syllabus subtopics (rotating across topics),
  2. finds lectures + Shorts from trusted channels with yt-dlp,
  3. fetches transcripts,
  4. asks Claude (via the `claude` CLI) to cut lectures into self-contained
     45-120s clips, score them and write quiz questions,
  5. keeps only clips that pass the quality bar,
  6. writes app/data/days/<date>.json + app/data/index.json,
  7. commits (and pushes, if a git remote exists).

Usage:
  pipeline.py                 normal daily run (skips if already ran today)
  pipeline.py --force         run again today (adds more clips)
  pipeline.py --topics dbms   only these topics (comma separated)
  pipeline.py --lectures 2 --shorts 1   override daily amounts
  pipeline.py --plan          print what would be fetched, do nothing
"""
import argparse
import concurrent.futures as cf
import datetime as dt
import glob
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
import traceback

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PIPE = os.path.join(ROOT, "pipeline")
APP_DATA = os.path.join(ROOT, "app", "data")
DAYS_DIR = os.path.join(APP_DATA, "days")
STATE_PATH = os.path.join(PIPE, "state.json")
CONFIG_PATH = os.path.join(PIPE, "config.json")
FEEDBACK_DIR = os.path.join(PIPE, "feedback")
LOG_DIR = os.path.join(PIPE, "logs")
YTDLP = os.path.join(ROOT, ".venv", "bin", "yt-dlp")
CLAUDE = shutil.which("claude") or os.path.expanduser("~/.local/bin/claude")

TODAY = dt.date.today().isoformat()
_log_file = None


def log(*a):
    line = f"[{dt.datetime.now().strftime('%H:%M:%S')}] " + " ".join(str(x) for x in a)
    print(line, flush=True)
    if _log_file:
        _log_file.write(line + "\n")
        _log_file.flush()


def load_json(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except FileNotFoundError:
        return default


def save_json(path, data, indent=None):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, ensure_ascii=False, indent=indent)
    os.replace(tmp, path)


# ---------------------------------------------------------------- YouTube

def yt_search(query, n, short_only=False):
    if short_only:  # YouTube search with the "under 4 minutes" filter
        from urllib.parse import quote_plus
        target = f"https://www.youtube.com/results?search_query={quote_plus(query)}&sp=EgIYAQ%253D%253D"
        cmd = [YTDLP, "--flat-playlist", "-J", "--no-warnings", "--playlist-end", str(n), target]
    else:
        cmd = [YTDLP, "--flat-playlist", "-J", "--no-warnings", f"ytsearch{n}:{query}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        log("  search failed:", r.stderr.strip()[-300:])
        return []
    entries = json.loads(r.stdout).get("entries") or []
    out = []
    for e in entries:
        if not e or not e.get("id"):
            continue
        out.append({
            "id": e["id"],
            "title": e.get("title") or "",
            "duration": int(e.get("duration") or 0),
            "channel": e.get("channel") or e.get("uploader") or "",
            "is_short": "/shorts/" in (e.get("url") or ""),
        })
    return out


def yt_meta(video_id):
    cmd = [YTDLP, "-J", "--skip-download", "--no-warnings",
           f"https://www.youtube.com/watch?v={video_id}"]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        return None
    d = json.loads(r.stdout)
    return {
        "embeddable": bool(d.get("playable_in_embed", True)),
        "public": d.get("availability") in (None, "public", "unlisted"),
        "age_limit": d.get("age_limit") or 0,
        "duration": int(d.get("duration") or 0),
        "description": (d.get("description") or "")[:1500],
        "chapters": [{"t": int(c["start_time"]), "title": c["title"]} for c in (d.get("chapters") or [])],
        "aspect": (d.get("width") or 16) / max(1, (d.get("height") or 9)),
    }


def yt_transcript(video_id, languages):
    from youtube_transcript_api import YouTubeTranscriptApi
    api = YouTubeTranscriptApi()
    try:
        tl = api.list(video_id)
        try:
            t = tl.find_transcript(languages)
        except Exception:
            t = next(iter(tl))
        snippets = t.fetch().snippets
        return [{"t": s.start, "d": s.duration, "text": s.text.replace("\n", " ")} for s in snippets]
    except Exception as e:
        log("  no transcript:", type(e).__name__)
        return None


def transcript_blocks(snips, block_sec=8):
    """Merge caption snippets into ~8s blocks: '[123] text'."""
    lines, cur_t, cur = [], None, []
    for s in snips:
        if cur_t is None:
            cur_t = s["t"]
        cur.append(s["text"])
        if s["t"] + s["d"] - cur_t >= block_sec:
            lines.append(f"[{int(cur_t)}] {' '.join(cur)}")
            cur_t, cur = None, []
    if cur:
        lines.append(f"[{int(cur_t)}] {' '.join(cur)}")
    return "\n".join(lines)


# ---------------------------------------------------------------- Claude

SYSTEM_PROMPT = """You are a strict curator for a short-video learning app for computer science students (core CS: DBMS, computer networks, computer architecture, C++, AI/ML).
You read YouTube transcripts and turn them into reels: short, self-contained clips that each teach exactly one concept.
You are picky. A clip must make sense to someone who did not watch the rest of the video. Never include intros, outros, greetings, "like and subscribe", sponsor segments, course promotions, or "as we saw in the last video" set-up.
Score honestly on 1-10 scales. If the content is technically wrong, give accuracy <= 4. Transcripts may be Hinglish or auto-generated; judge the teaching, not the caption quality, but write all titles/summaries/quiz text in clear English.
Return only data that matches the JSON schema."""

QUIZ_SCHEMA = {
    "type": ["object", "null"],
    "properties": {
        "question": {"type": "string"},
        "options": {"type": "array", "items": {"type": "string"}, "minItems": 4, "maxItems": 4},
        "answer": {"type": "integer", "minimum": 0, "maximum": 3},
        "explanation": {"type": "string"},
    },
    "required": ["question", "options", "answer", "explanation"],
}

CLIP_PROPS = {
    "title": {"type": "string", "description": "Catchy but honest, max 60 chars"},
    "hook": {"type": "string", "description": "One line on what you will learn, max 100 chars"},
    "concept": {"type": "string", "description": "The single concept taught, 2-5 words"},
    "summary": {"type": "string", "description": "2 sentences, the key takeaway"},
    "accuracy": {"type": "integer", "minimum": 1, "maximum": 10},
    "standalone": {"type": "integer", "minimum": 1, "maximum": 10},
    "clarity": {"type": "integer", "minimum": 1, "maximum": 10},
    "quiz": QUIZ_SCHEMA,
}

LECTURE_SCHEMA = {
    "type": "object",
    "properties": {
        "clips": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"start": {"type": "integer"}, "end": {"type": "integer"}, **CLIP_PROPS},
                "required": ["start", "end", *CLIP_PROPS.keys()],
            },
        }
    },
    "required": ["clips"],
}

SHORT_SCHEMA = {
    "type": "object",
    "properties": {"educational": {"type": "boolean"}, **CLIP_PROPS},
    "required": ["educational", *CLIP_PROPS.keys()],
}


def claude_json(prompt, schema, cfg):
    cmd = [CLAUDE, "-p", "--model", cfg["llm"]["model"], "--output-format", "json",
           "--tools", "", "--strict-mcp-config", "--no-session-persistence",
           "--setting-sources", "", "--system-prompt", SYSTEM_PROMPT,
           "--json-schema", json.dumps(schema)]
    for attempt in range(2):
        try:
            r = subprocess.run(cmd, input=prompt, capture_output=True, text=True,
                               timeout=cfg["llm"]["timeout_sec"])
            d = json.loads(r.stdout)
            if d.get("is_error"):
                raise RuntimeError(d.get("result") or d.get("subtype"))
            out = d.get("structured_output")
            if out is None:
                out = json.loads(d.get("result") or "null")
            return out, float(d.get("total_cost_usd") or 0)
        except Exception as e:
            log(f"  claude call failed (attempt {attempt + 1}):", str(e)[:200])
            time.sleep(5)
    return None, 0.0


def lecture_prompt(video, meta, topic, subtopic, blocks):
    chapters = "\n".join(f"[{c['t']}] {c['title']}" for c in meta["chapters"]) or "(none)"
    return f"""Topic: {topic['name']}
Subtopic we are teaching today: {subtopic}
Video: "{video['title']}" by {video['channel']} ({meta['duration']}s long)
Chapters:
{chapters}

Cut this lecture into reels.
Rules:
- 0 to 12 clips. Only the genuinely useful parts. Zero is fine if the video is bad.
- Each clip 45-120 seconds (hard limits 30-150), teaching ONE concept, understandable on its own.
- start = the [seconds] timestamp of the block where the explanation begins (a sentence start, not mid-thought).
- end = the timestamp of the first block AFTER the explanation finishes.
- Clips must not overlap. Keep them in video order.
- Concepts relevant to {topic['name']} are fine even if not exactly "{subtopic}".
- Add a quiz (4 options, one correct, answer = index 0-3) for clips that teach something testable; otherwise quiz = null.

Transcript ([seconds] text):
{blocks}
"""


def short_prompt(video, meta, topic, subtopic, blocks):
    return f"""Topic: {topic['name']} (searched for: {subtopic})
YouTube Short: "{video['title']}" by {video['channel']} ({meta['duration']}s)
Description: {meta['description'][:600]}

Judge whether this Short actually teaches a core CS concept (educational = false for memes, motivation, career talk, "POV", setups, hype, course ads).
Score it and write title/hook/concept/summary. Add a quiz if it teaches something testable, else null.

Transcript ([seconds] text):
{blocks}
"""


# ---------------------------------------------------------------- selection

def is_trusted(channel, cfg, state):
    c = channel.strip().lower()
    if c in {b.lower() for b in state.get("blocked_channels", [])}:
        return False
    return c in {t.lower() for t in cfg["trusted_channels"]}


def blocked(channel, state):
    return channel.strip().lower() in {b.lower() for b in state.get("blocked_channels", [])}


def pick_lecture(topic, subtopic, cfg, state):
    d = cfg["daily"]
    q = f"{subtopic} {topic['query']}"
    results = yt_search(q, d["search_results"])
    cands = [v for v in results
             if v["id"] not in state["processed"]
             and not v["is_short"]
             and d["lecture_min_sec"] <= v["duration"] <= d["lecture_max_sec"]
             and is_trusted(v["channel"], cfg, state)]
    for v in cands[:4]:
        meta = yt_meta(v["id"])
        if meta and meta["embeddable"] and meta["public"] and meta["age_limit"] == 0:
            return v, meta
        state["processed"][v["id"]] = TODAY  # don't retry unembeddable
    return None, None


def pick_shorts(topic, subtopic, cfg, state, limit):
    d = cfg["daily"]
    q = f"{subtopic} {topic['query']}"
    results = yt_search(q, d["search_results"], short_only=True)
    cands = [v for v in results
             if v["id"] not in state["processed"]
             and 0 < v["duration"] <= d["short_max_sec"]
             and not blocked(v["channel"], state)]
    # trusted channels first, then the rest
    cands.sort(key=lambda v: 0 if is_trusted(v["channel"], cfg, state) else 1)
    out = []
    for v in cands:
        if len(out) >= limit * 2:  # fetch extra; many will be rejected
            break
        meta = yt_meta(v["id"])
        if meta and meta["embeddable"] and meta["public"] and meta["age_limit"] == 0:
            out.append((v, meta))
        else:
            state["processed"][v["id"]] = TODAY
    return out


# ---------------------------------------------------------------- processing

def passes(c, cfg, trusted=True):
    q = cfg["quality"]
    s = [c["accuracy"], c["standalone"], c["clarity"]]
    avg = sum(s) / 3
    need = q["min_avg_score"] if trusted else q["min_avg_score_untrusted_short"]
    return min(s) >= q["min_each_score"] and avg >= need


def clean_quiz(qz):
    if not qz or not isinstance(qz, dict):
        return None
    opts = qz.get("options") or []
    if len(opts) != 4 or not (0 <= int(qz.get("answer", -1)) <= 3):
        return None
    # shuffle so the right answer isn't always in the same slot
    order = list(range(4))
    random.shuffle(order)
    return {"question": qz["question"], "options": [opts[i] for i in order],
            "answer": order.index(int(qz["answer"])), "explanation": qz.get("explanation", "")}


def make_clip(video, meta, topic_key, subtopic, c, start, end, kind, seq):
    return {
        "id": f"{video['id']}_{start}",
        "videoId": video["id"],
        "kind": kind,
        "start": start,
        "end": end,
        "vertical": kind == "short" or meta["aspect"] < 1,
        "topic": topic_key,
        "subtopic": subtopic,
        "title": c["title"].strip(),
        "hook": c["hook"].strip(),
        "concept": c["concept"].strip(),
        "summary": c["summary"].strip(),
        "channel": video["channel"],
        "videoTitle": video["title"],
        "scores": {"accuracy": c["accuracy"], "standalone": c["standalone"], "clarity": c["clarity"]},
        "quiz": clean_quiz(c.get("quiz")),
        "added": TODAY,
        "seq": seq,
    }


def process_lecture(job, cfg):
    video, meta, topic_key, topic, subtopic = job
    snips = yt_transcript(video["id"], cfg["transcript_languages"])
    if not snips:
        return [], 0.0
    blocks = transcript_blocks(snips)
    out, cost = claude_json(lecture_prompt(video, meta, topic, subtopic, blocks), LECTURE_SCHEMA, cfg)
    if not out:
        return [], cost
    clips, last_end = [], -1
    dur = meta["duration"] or video["duration"]
    for i, c in enumerate(sorted(out.get("clips", []), key=lambda c: c["start"])):
        start, end = max(0, int(c["start"])), min(int(c["end"]), dur)
        if end - start < 30 or end - start > 150 or start < last_end:
            continue
        if not passes(c, cfg):
            continue
        last_end = end
        clips.append(make_clip(video, meta, topic_key, subtopic, c, start, end, "lecture", i))
    log(f"  lecture '{video['title'][:60]}' ({video['channel']}): {len(out.get('clips', []))} cut, {len(clips)} kept")
    return clips, cost


def process_short(job, cfg, state):
    video, meta, topic_key, topic, subtopic = job
    snips = yt_transcript(video["id"], cfg["transcript_languages"])
    if not snips:
        return [], 0.0
    out, cost = claude_json(short_prompt(video, meta, topic, subtopic, transcript_blocks(snips, 5)), SHORT_SCHEMA, cfg)
    if not out or not out.get("educational"):
        log(f"  short '{video['title'][:50]}': rejected (not educational)")
        return [], cost
    trusted = is_trusted(video["channel"], cfg, state)
    if not passes(out, cfg, trusted):
        log(f"  short '{video['title'][:50]}': rejected (scores)")
        return [], cost
    dur = meta["duration"] or video["duration"]
    log(f"  short '{video['title'][:50]}' ({video['channel']}): kept")
    return [make_clip(video, meta, topic_key, subtopic, out, 0, dur, "short", 0)], cost


# ---------------------------------------------------------------- feedback

def apply_feedback(state):
    """Read exported feedback files from the app: drop reported clips, block bad channels."""
    files = sorted(glob.glob(os.path.join(FEEDBACK_DIR, "*.json")))
    if not files:
        return
    reported = set()
    for f in files:
        d = load_json(f, {})
        reported.update(d.get("reported", []))
    if not reported:
        for f in files:
            _archive_feedback(f)
        return
    channel_reports = state.setdefault("channel_reports", {})
    removed = 0
    for path in glob.glob(os.path.join(DAYS_DIR, "*.json")):
        day = load_json(path, {})
        keep = []
        for c in day.get("clips", []):
            if c["id"] in reported:
                removed += 1
                channel_reports[c["channel"]] = channel_reports.get(c["channel"], 0) + 1
            else:
                keep.append(c)
        if len(keep) != len(day.get("clips", [])):
            day["clips"] = keep
            save_json(path, day)
    for ch, n in channel_reports.items():
        if n >= 3 and ch not in state.setdefault("blocked_channels", []):
            state["blocked_channels"].append(ch)
            log(f"  blocking channel after {n} reports: {ch}")
    state.setdefault("reported_ids", [])
    state["reported_ids"] = sorted(set(state["reported_ids"]) | reported)
    for f in files:
        _archive_feedback(f)
    log(f"feedback: removed {removed} reported clips")


def _archive_feedback(f):
    done = os.path.join(FEEDBACK_DIR, "processed")
    os.makedirs(done, exist_ok=True)
    os.replace(f, os.path.join(done, os.path.basename(f)))


# ---------------------------------------------------------------- output

def write_outputs(new_clips):
    path = os.path.join(DAYS_DIR, f"{TODAY}.json")
    day = load_json(path, {"date": TODAY, "clips": []})
    have = {c["id"] for c in day["clips"]}
    day["clips"].extend(c for c in new_clips if c["id"] not in have)
    save_json(path, day)
    rebuild_index()


def rebuild_index():
    days = []
    total = 0
    by_topic = {}
    for path in sorted(glob.glob(os.path.join(DAYS_DIR, "*.json"))):
        d = load_json(path, {})
        n = len(d.get("clips", []))
        if not n:
            continue
        total += n
        for c in d["clips"]:
            by_topic[c["topic"]] = by_topic.get(c["topic"], 0) + 1
        days.append({"date": d["date"], "file": f"days/{os.path.basename(path)}", "count": n})
    save_json(os.path.join(APP_DATA, "index.json"),
              {"updated": dt.datetime.now().isoformat(timespec="seconds"),
               "total": total, "byTopic": by_topic, "days": days}, indent=1)


def git_publish(n_new):
    if not os.path.isdir(os.path.join(ROOT, ".git")):
        return
    def g(*args):
        return subprocess.run(["git", "-C", ROOT, *args], capture_output=True, text=True)
    g("add", "app/data", "pipeline/state.json")
    if g("diff", "--cached", "--quiet").returncode == 0:
        return
    g("commit", "-m", f"feed: {TODAY} +{n_new} clips")
    if g("remote").stdout.strip():
        r = g("push")
        log("git push:", "ok" if r.returncode == 0 else r.stderr.strip()[-200:])


# ---------------------------------------------------------------- main

def main():
    global _log_file
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--topics")
    ap.add_argument("--lectures", type=int)
    ap.add_argument("--shorts", type=int)
    args = ap.parse_args()

    cfg = load_json(CONFIG_PATH, None)
    state = load_json(STATE_PATH, {})
    state.setdefault("pointer", {})
    state.setdefault("rotation", 0)
    state.setdefault("processed", {})
    state.setdefault("runs", [])

    if not args.force and not args.plan and state.get("last_run") == TODAY:
        print(f"Already ran today ({TODAY}). Use --force to add more.")
        return

    os.makedirs(LOG_DIR, exist_ok=True)
    if not args.plan:
        _log_file = open(os.path.join(LOG_DIR, f"{TODAY}.log"), "a")
    log(f"=== CS Reels pipeline {TODAY} ===")

    apply_feedback(state)

    topic_keys = list(cfg["topics"].keys())
    if args.topics:
        topic_keys = [t for t in args.topics.split(",") if t in cfg["topics"]]
    n_lect = args.lectures if args.lectures is not None else cfg["daily"]["lectures_per_day"]
    n_shorts = args.shorts if args.shorts is not None else cfg["daily"]["shorts_queries_per_day"]

    # Plan: rotate through topics; each topic advances along its syllabus.
    plan_lect, plan_shorts = [], []
    rot = state["rotation"]
    for i in range(n_lect):
        k = topic_keys[(rot + i) % len(topic_keys)]
        syl = cfg["topics"][k]["syllabus"]
        p = state["pointer"].get(k, 0)
        plan_lect.append((k, syl[p % len(syl)]))
        state["pointer"][k] = p + 1
    for i in range(n_shorts):
        k = topic_keys[(rot + i) % len(topic_keys)]
        syl = cfg["topics"][k]["syllabus"]
        p = max(0, state["pointer"].get(k, 1) - 1)
        # shorts: the current subtopic, or a random earlier one for variety
        sub = syl[p % len(syl)] if i % 2 == 0 else random.choice(syl[: (p % len(syl)) + 1])
        plan_shorts.append((k, sub))
    state["rotation"] = (rot + n_lect) % max(1, len(topic_keys))

    log("lectures:", "; ".join(f"{k}: {s}" for k, s in plan_lect))
    log("shorts:  ", "; ".join(f"{k}: {s}" for k, s in plan_shorts))
    if args.plan:
        return

    # Find videos (sequential: polite to YouTube).
    jobs_l, jobs_s = [], []
    for k, sub in plan_lect:
        topic = cfg["topics"][k]
        log(f"searching lecture: {k} / {sub}")
        v, meta = pick_lecture(topic, sub, cfg, state)
        if v:
            state["processed"][v["id"]] = TODAY
            jobs_l.append((v, meta, k, topic, sub))
        else:
            log("  nothing suitable from trusted channels")
    for k, sub in plan_shorts:
        topic = cfg["topics"][k]
        log(f"searching shorts: {k} / {sub}")
        for v, meta in pick_shorts(topic, sub, cfg, state, cfg["daily"]["max_shorts_per_query"]):
            state["processed"][v["id"]] = TODAY
            jobs_s.append((v, meta, k, topic, sub))

    # Cut + score (parallel Claude calls).
    all_clips, cost = [], 0.0
    with cf.ThreadPoolExecutor(cfg["daily"]["parallel_llm_calls"]) as ex:
        futs = [ex.submit(process_lecture, j, cfg) for j in jobs_l]
        futs += [ex.submit(process_short, j, cfg, state) for j in jobs_s]
        for f in cf.as_completed(futs):
            try:
                clips, c = f.result()
                all_clips.extend(clips)
                cost += c
            except Exception:
                log("  job crashed:", traceback.format_exc()[-400:])

    # Keep only the best few Shorts per search so one concept doesn't flood the feed.
    cap = cfg["daily"]["max_shorts_per_query"]
    groups = {}
    for c in all_clips:
        if c["kind"] == "short":
            groups.setdefault((c["topic"], c["subtopic"]), []).append(c)
    drop = set()
    for g in groups.values():
        g.sort(key=lambda c: -sum(c["scores"].values()))
        drop.update(c["id"] for c in g[cap:])
    reported = set(state.get("reported_ids", []))
    all_clips = [c for c in all_clips if c["id"] not in reported and c["id"] not in drop]
    # Lecture clips first (in syllabus order), then shorts.
    all_clips.sort(key=lambda c: (c["kind"] != "lecture", c["topic"], c["videoId"], c["seq"]))
    write_outputs(all_clips)

    by_topic = {}
    for c in all_clips:
        by_topic[c["topic"]] = by_topic.get(c["topic"], 0) + 1
    state["last_run"] = TODAY
    state["runs"].append({"date": TODAY, "clips": len(all_clips), "lectures": len(jobs_l),
                          "shorts": len(jobs_s), "byTopic": by_topic, "cost_usd": round(cost, 4)})
    state["runs"] = state["runs"][-120:]
    save_json(STATE_PATH, state, indent=1)
    log(f"done: +{len(all_clips)} clips {by_topic} (claude cost ~${cost:.3f})")
    git_publish(len(all_clips))


if __name__ == "__main__":
    main()
