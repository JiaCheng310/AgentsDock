# AgentsDock website

Static product and download site for AgentsDock.

## Preview

```bash
cd website
npm run dev
```

Open `http://localhost:4175`.

## Website languages

English pages live at the site root and Simplified Chinese at `zh/`. Keep each
localized page's language menu, canonical URL, reciprocal `en` / `zh-Hans`
alternate links, and `sitemap.xml` entries in sync. Shared assets and analytics
remain at the root. The website languages are independent of languages
supported by the clients.

The retired `zh-TW/` paths contain only no-index redirects to the matching
Simplified Chinese pages. Preserve these for old links, but do not list them in
language menus, alternate metadata, or the sitemap.

## Publish a desktop release

1. Upload the signed macOS DMG and Linux AppImage into `website/releases/`, or replace their URLs with your release-hosting URLs.
2. Add each artifact's SHA256 to `website/releases/latest.json`.
3. Set the platform's `available` value to `true`.
4. Deploy the contents of `website/` to any static host.

The UI reads `releases/latest.json` at runtime, so releases do not require rebuilding the website.
