# Kairos — Time Tracker

A personal freelance time tracker. Runs entirely in your browser: a live timer,
manual entries, editing, per-client color-coding, at-a-glance weekly/monthly
totals, a PDF time export (grouped by project + task with pie charts), and JSON
backup/restore.

All data is stored **locally in your browser** (localStorage). There is no
server, no account, and no cloud sync. Your entries never leave your device
except when you export a PDF or a JSON backup yourself.

---

## Run it locally

You need [Node.js](https://nodejs.org) (version 18 or newer).

```bash
npm install      # once, to install dependencies
npm run dev      # start the local dev server
```

Then open the URL it prints (usually http://localhost:5173).

To make a production build:

```bash
npm run build    # outputs to dist/
npm run preview  # serve the built version locally to check it
```

---

## Deploy it free (Vercel)

This gets you a permanent URL you can open anywhere and "install" as an app.

1. **Put the code on GitHub.**
   - Create a free account at https://github.com if you don't have one.
   - Make a new empty repository (e.g. `kairos`), private is fine.
   - In this folder, run:
     ```bash
     git init
     git add .
     git commit -m "Kairos time tracker"
     git branch -M main
     git remote add origin https://github.com/YOUR_USERNAME/kairos.git
     git push -u origin main
     ```

2. **Connect it to Vercel.**
   - Sign up at https://vercel.com with your GitHub account (free "Hobby" plan).
   - Click **Add New → Project**, pick your `kairos` repo.
   - Vercel auto-detects Vite. Leave every setting at its default.
   - Click **Deploy**. In ~30 seconds you get a live URL like
     `https://kairos-yourname.vercel.app`.

3. **Every future change** you push to GitHub redeploys automatically.

(Netlify works identically if you prefer it — same steps, sign up at
https://netlify.com, import the repo, deploy.)

---

## Install it as an app (PWA)

Once it's live on your Vercel URL:

- **Desktop (Chrome/Edge):** open the URL, click the install icon in the address
  bar (or menu → "Install Kairos"). It opens in its own window and lands in your
  dock / taskbar.
- **iPhone (Safari):** open the URL, tap Share → **Add to Home Screen**.
- **Android (Chrome):** open the URL, menu → **Install app**.

It works offline after the first load.

---

## Important: back up your data

Because everything lives in your browser's localStorage, your entries are tied
to that browser on that device. They can be lost if you clear browser data or
switch devices. So:

- Hit **Backup** every week or two to download a JSON file.
- Use **Restore** to load a backup (it merges without creating duplicates).

The backup file is also how you move your data to another browser or device.

---

## What's inside

- `src/Kairos.jsx` — the whole app (one component).
- `src/main.jsx` — React entry point.
- `vite.config.js` — build + PWA config.
- `public/` — icons and favicon.
