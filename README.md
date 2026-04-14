# lilycummings.com — rebuild

Static, single-page portfolio for Lily Cummings (WWL-TV, New Orleans). Built as a modern editorial refresh of [lilycummings.net](https://www.lilycummings.net/) for preview at **lilycummings.creativecorerail.com** before cutover to the `.net`.

## Stack

- Static HTML / CSS / JS. No build step, no framework.
- Google Fonts (Fraunces + Inter). Swap to self-hosted for GDPR / perf if needed.
- YouTube `youtube-nocookie` embeds for reels.

## File layout

```
/
├── index.html
├── assets/
│   ├── css/styles.css
│   └── js/main.js
└── README.md
```

## Local preview

Any static server works. Examples:

```bash
# Python
python3 -m http.server 8080

# Node
npx serve .
```

Then open http://localhost:8080.

## Deployment — lilycummings.creativecorerail.com

Any of these work; pick whatever matches Creative Core Rail's current setup.

### Option A — GitHub Pages / Cloudflare Pages / Netlify
Push the repo, point the subdomain CNAME to the hosting target. Zero server cost.

### Option B — VPS with nginx
```nginx
server {
  listen 443 ssl http2;
  server_name lilycummings.creativecorerail.com;
  root /var/www/lilycummings;
  index index.html;

  # Long-cache static assets
  location /assets/ {
    expires 30d;
    add_header Cache-Control "public, immutable";
  }

  location / {
    try_files $uri $uri/ /index.html;
  }
}
```
Don't forget HTTPS via certbot/Let's Encrypt.

### Option C — Node.js (if you want a backend for the contact form)
```js
// server.js
const express = require('express');
const path = require('path');
const app = express();
app.use(express.static(path.join(__dirname)));
app.listen(process.env.PORT || 3000);
```

## Known items to address before pushing .net live

1. **Images are hotlinked to Squarespace CDN.** Fine for preview, *not* for production. Before cutover:
   - Download full-resolution originals from Lily's Squarespace media library.
   - Drop into `assets/img/` and swap the `<img src>` / `<source srcset>` URLs.
   - Add `width` / `height` attributes to prevent CLS.
   - Generate AVIF + WebP variants and use `<picture>` with multiple `<source>` tags.
2. **Contact form is inert.** The submit handler validates and shows a note. Wire it up:
   - Quick path: Formspree, Basin, or Getform endpoint in the `action` attribute.
   - Proper path: Node/Express or Flask route that validates, rate-limits, sends via SES/Postmark/Mailgun, and dumps into SQLite for audit.
3. **Meta / SEO:**
   - Update `og:url` and canonical once on final domain.
   - Add `sitemap.xml` and `robots.txt`.
   - Add Plausible / GA4 if desired.
4. **Accessibility:** run axe-core or Lighthouse. The markup is semantic, color contrast meets AA against the dark bg, focus states are visible, nav is keyboard-accessible, and `prefers-reduced-motion` is honored — but verify once content is final.
5. **Content review:** all biographical copy was rewritten; Lily should proof before launch.

## Editing

Content lives in `index.html`. Each section is clearly commented (`<!-- HERO -->`, `<!-- ABOUT -->`, etc.).

Design tokens are CSS custom properties at the top of `styles.css`:
- `--bg`, `--ink`, `--accent` control the palette.
- `--f-serif`, `--f-sans` control type.
- Swap the accent (`#c9a96a` gold) to match any brand evolution.

## Performance budget (current)

- HTML: ~15 KB uncompressed
- CSS:  ~11 KB uncompressed
- JS:   ~2 KB uncompressed
- Fonts and hero image are the heavy items — optimize before launch.
