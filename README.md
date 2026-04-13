<p align="center">
  <img src="public/icon-512.png" width="80" alt="history-md icon" />
</p>

<h1 align="center">history-md</h1>

<p align="center">
  <strong>Logseq inspired, browser-first. A lightweight, self-hostable note-taking app.</strong><br>
  Markdown / block editor / backlinks / tags / actions / templates -- all in the browser.
</p>

<p align="center">
  <a href="https://github.com/KoichiIshiguro/history_by_md/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" alt="Next.js 16" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?logo=react" alt="React 19" />
  <img src="https://img.shields.io/badge/SQLite-local-003B57?logo=sqlite" alt="SQLite" />
  <img src="https://img.shields.io/badge/PWA-ready-5A0FC8" alt="PWA" />
</p>

---

## What is history-md?

Logseq and Obsidian are powerful, but heavy. Notion is cloud-only.
**history-md** is a lightweight, self-hostable alternative that runs entirely in the browser.

- **Block-based editing** with full Markdown/GFM support (tables, code blocks, Mermaid diagrams)
- **Daily journal + Pages + Tags** -- three ways to organize your notes
- **Backlinks** -- `{{page}}` references automatically create bidirectional links
- **Action tracking** -- `!action` / `!done` flags to manage tasks across pages
- **Templates** -- create reusable block templates, insert with `!template`
- **Theming** -- 5 built-in color themes, switchable from the menu
- **PWA** -- install on your phone, works offline
- **Self-hostable** -- your data stays on your server, in a single SQLite file

## Features

| Feature | Description |
|---------|-------------|
| Block Editor | Logseq-style outliner with indent/outdent, Undo/Redo (Ctrl+Z), multi-select |
| Markdown | GFM tables, code blocks, Mermaid diagrams, task lists, strikethrough |
| Pages | Hierarchical pages with parent/child nesting, full-path links `{{parent/child}}` |
| Tags | `#tag` auto-detection, tag inheritance for child blocks |
| Backlinks | Bidirectional references between pages and dates |
| Actions | `!action` (red) / `!done` (green) flags, filterable action list |
| Templates | Create in settings, insert with `!template` or `!t`, multi-line support |
| Multi-select | Shift+click range select, Delete, Ctrl+C/X/V for bulk operations |
| Themes | Orange, Blue, Purple, Green, Pink -- persisted in localStorage |
| Mobile | Responsive sidebar, swipe gestures, PWA installable |
| Auth | Google OAuth (NextAuth.js), multi-user with admin panel |

## Quick Start

```bash
# Clone
git clone https://github.com/KoichiIshiguro/history_by_md.git
cd history_by_md

# Install
npm install

# Set up environment
cp .env.example .env.local
# Edit .env.local with your Google OAuth credentials and NextAuth secret

# Run
npm run dev
```

Open [http://localhost:3000](http://localhost:3000)

### Environment Variables

Create a `.env.local` file:

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
NEXTAUTH_SECRET=your-random-secret-string
NEXTAUTH_URL=http://localhost:3000
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | [Next.js 16](https://nextjs.org/) (App Router) |
| UI | [React 19](https://react.dev/) + [Tailwind CSS v4](https://tailwindcss.com/) |
| Database | [SQLite](https://www.sqlite.org/) via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) |
| Auth | [NextAuth.js v5](https://authjs.dev/) (Google OAuth) |
| Markdown | [react-markdown](https://github.com/remarkjs/react-markdown) + remark-gfm + rehype-raw |
| Diagrams | [Mermaid](https://mermaid.js.org/) (CDN loaded) |
| PWA | Service Worker + Web App Manifest |

## Deploy

### VPS / Self-hosted

```bash
npm run build
npm start
```

SQLite database is stored at `./data/app.db`.

### Docker (Coming Soon)

## Roadmap

- [ ] Docker image for one-command self-hosting
- [ ] Graph view (page relationship visualization)
- [ ] Full-text search
- [ ] Import/Export (Markdown files, Logseq format)
- [ ] API for external integrations
- [ ] Collaboration (real-time editing)
- [ ] Plugin system

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

[MIT](LICENSE) - Use it however you want.

## Author

**Koichi Ishiguro** - [@KoichiIshiguro](https://github.com/KoichiIshiguro)

---

<p align="center">
  If you find this useful, please give it a star!
</p>
