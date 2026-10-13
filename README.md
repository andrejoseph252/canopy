# Canopy

A dark, quiet place to throw every little thing you need to do, buy, read or look into. You type messy notes and they sort themselves.

- **Instant capture:** simple rules sort things immediately, even offline
- **AI sorting (optional):** Gemini splits brain dumps into separate items, cleans up titles, picks a kind, finds dates and groups related things ("Japan trip")
- **Learns from you:** when you change an item's kind, the AI follows that next time
- **Syncs** between phone and laptop through a private GitHub Gist
- **Installable** on your phone's home screen, and works offline

Plain HTML/CSS/JS with no build step and no server.

## 1. Put it on GitHub Pages

```sh
cd ~/ToDoList
git init && git add . && git commit -m "Canopy"
gh repo create canopy --public --source . --push
```

Then on GitHub: **repo → Settings → Pages → Source: Deploy from a branch → `main` / root → Save**.
After about a minute it's live at `https://<your-username>.github.io/canopy/`.

> The repo contains only code. Your to-dos and keys are never in it.

## 2. Turn on sync (GitHub Gist)

1. Go to **github.com/settings/tokens → Generate new token (classic)**.
2. Name it `canopy`, set **No expiration** (or a long one), and check **only `gist`**.
3. Copy the token, open Canopy → ⚙ → paste it into *GitHub token* → **save**.
4. Leave *Gist ID* empty. Canopy creates a secret Gist on the first sync and fills the ID in.

## 3. Turn on AI sorting

### Claude Haiku 5.5 (default: fast and reliable)

1. Sign up at **console.anthropic.com** and add a little prepaid credit. Leave auto-reload off.
2. Optional: set a monthly spend limit in the Console's billing/limits settings.
3. Go to **API keys → Create key** and copy it.
4. In Canopy → ⚙ → Provider: *Claude Haiku 5.5* → paste the key → **test it** → **save**.

Each capture is one request, roughly $0.0002 (about 800 tokens in and 250 out at $0.10 / $0.50 per million). Even 30 captures a day comes to well under $1 a month. It runs at low effort, so a capture is usually sorted in a second or two.

### Gemini (free alternative)

1. Go to **aistudio.google.com/apikey** → **Create API key**.
2. In Canopy → ⚙ → Provider: *Gemini* → paste the key → **test it** → **save**.

The free tier is sometimes overloaded (503 errors) and may use what you send to improve Google's products.

If the AI can't be reached for any reason, captures stay rule-sorted and get re-sorted automatically later.

## 4. Set up your phone

1. On the laptop: ⚙ → **copy setup code**. Send it to your phone privately (AirDrop, or Universal Clipboard).
2. On the phone, open your GitHub Pages URL → ⚙ → paste into *Setup code* → **save**.
3. **iPhone:** Share → *Add to Home Screen*. **Android:** ⋮ → *Install app*.

## How it works

| What | Where it lives |
|---|---|
| App code | GitHub Pages (public) |
| Your items | This device's browser storage + `canopy.json` in your secret Gist |
| Tokens / keys | Only in each device's browser storage |

- Edits save locally right away and sync about 1.5 s later. The app also pulls when you reopen it and every minute while it's open.
- Each item keeps its own "last edited" time, so edits on both devices merge instead of one overwriting the other.
- A *secret* Gist is unlisted, not encrypted. Anyone with its exact URL could read it.

## Run locally

```sh
python3 -m http.server 8000   # then open http://localhost:8000
```
