# Sealdrop

Self-hosted, end-to-end encrypted file sharing, with short-lived links that AI tools can read directly.

- **Private links** for people: the file is encrypted in your browser, and the key lives in the part of the link after `#`, which browsers never send to the server.
- **AI links** for ChatGPT, Claude, Gemini or `curl`: a plain URL that returns the file itself (PDF, text, image…), even to fetchers that don't run JavaScript. It dies after N fetches or a few minutes.
- **Temporary or permanent** storage, **burn after N views**, optional **password**.
- **Preview in the browser**: video, audio, images, PDF (pdf.js, bundled), text and code. **Download** for everything, streamed straight to disk in Chromium browsers.
- **Local redaction** before upload: auto-detects emails, phone numbers, card numbers, Aadhaar, PAN, SSN, IBAN, IPs and your own custom words. It can extract a PDF to redacted text (best for AI) or black out areas on PDF pages and images (pages are flattened, so nothing survives under the boxes). Photo metadata such as GPS is stripped.

## Who can see what

| | File contents | File name / type | File size |
|---|---|---|---|
| Your VM's disk and database | ❌ ciphertext only | ❌ encrypted | ✅ roughly |
| Your VM while serving an **AI link** | ✅ in memory, during that request only | ✅ | ✅ |
| Your VM for **private links** | ❌ never | ❌ never | ✅ |
| Your hosting provider / network | ❌ (TLS ends on your VM) | ❌ | ✅ roughly |
| The AI you gave an AI link to | ✅ (that's the point) | ✅ | ✅ |
| Someone who finds an old AI link | ❌ link is dead | ❌ | ❌ |

### Crypto

- A random 256-bit AES-GCM key per file. The file is split into 4 MiB chunks, each authenticated separately. The chunk index and a "last chunk" flag are bound into each chunk's authentication data, so chunks can't be reordered, swapped or silently truncated.
- The name, MIME type and size are stored in an encrypted metadata blob.
- **Password:** the file key is wrapped with HKDF(link secret ‖ PBKDF2-SHA256(password, 600k iterations)). The server holds only the wrapped key and cannot brute-force the password without the link secret, which never reaches it.
- **Secrets are stored hashed:** manage tokens, view sessions and AI-link tokens are stored only as SHA-256 hashes.
- **Nothing is logged:** no request logging in the app, no access log in Caddy. SQLite runs with `secure_delete=ON`.
- **Hardened headers:** strict CSP (`default-src 'self'`, no third-party scripts, fonts or analytics), `Referrer-Policy: no-referrer`, `nosniff`, `frame-ancestors 'none'`.
- **AI-link responses** are served with `CSP: sandbox`. HTML, SVG and JS files are served as `text/plain`, so they can't run on your domain. They also carry `X-Robots-Tag: noindex`.

### Honest limits

1. **Web-based E2EE trusts the JavaScript your server sends.** If someone takes over your VM, they could serve a modified page that steals keys from people who open links later. Keep the VM patched, use SSH keys only, and don't run other services beside it.
2. **AI links decrypt on your server.** That's unavoidable if an AI with no JavaScript is to read the file. The key is in the URL path, used in memory, and never stored or logged. Only create AI links for files you're comfortable handing to that AI provider.
3. **Recipients can always keep a copy.** Expiry deletes the server's copy, not the recipient's.
4. **Memory limits:** previews over 512 MB are skipped. On Firefox and Safari, downloads are assembled in memory (Chromium streams them to disk), so very large files need enough RAM.
5. **Auto-detection is a helper.** Always review redactions yourself.

## Deploy on your VM

Requirements: a Linux VM with Docker and the Compose plugin, ports 80 and 443 open, and a domain.

```bash
git clone <your repo> sealdrop && cd sealdrop
cp .env.example .env
# edit .env: set DOMAIN and a long random UPLOAD_SECRET (openssl rand -base64 32)
docker compose up -d --build
```

1. **DNS:** create an A (and AAAA if you have IPv6) record for `DOMAIN` pointing at the VM. On Cloudflare, keep it **DNS only**, not proxied. Otherwise TLS ends at Cloudflare and they could see AI-link traffic.
2. **Firewall:** allow only 22, 80, 443 (for example `ufw allow 22,80,443/tcp && ufw allow 443/udp && ufw enable`).
3. Open `https://DOMAIN`, enter your upload secret once, and share.

**Update:** `git pull && docker compose up -d --build`

**Backups:** the `sealdrop-data` volume contains only ciphertext and hashed tokens. It's safe to back up anywhere, but it's useless without the links.

## Deploy on Pterodactyl

Use the custom egg in [`pterodactyl/egg-sealdrop.json`](pterodactyl/egg-sealdrop.json). It runs on the standard `ghcr.io/parkervcp/yolks:nodejs_24` image (Node 22.18+ also works).

1. **Import the egg:** Admin → Nests → *Import Egg* → choose `egg-sealdrop.json` (put it in any nest, or create one called "Web").
2. **Create an allocation bound to localhost:** Admin → Nodes → your node → Allocation → IP `127.0.0.1`, port e.g. `8095`.
   Binding to `127.0.0.1` matters: Docker-published ports **bypass UFW**, so a port on the public IP would expose plain HTTP to the internet.
3. **Create the server** with the Sealdrop egg and that allocation.
   - **Memory:** 512 MB is plenty.
   - **Disk:** as much as you want to store, plus about 400 MB for dependencies.
   - **Variables:** set a long random **Upload secret** (`openssl rand -base64 32`).
4. **Get the code in:** either
   - set **Git repository** to your repo's HTTPS URL before installing, and the installer clones and builds it; or
   - leave it empty and upload the files: zip the project (without `node_modules`, `dist`, `data`), upload it in the File Manager, *Unarchive*, then start. The first start builds the frontend (1–2 minutes).
5. **Put HTTPS in front** with a reverse proxy on the node itself, so TLS ends on your machine. For example, Caddy on the host:

   ```
   files.example.com {
       request_body {
           max_size 8MB
       }
       header Strict-Transport-Security "max-age=63072000; includeSubDomains"
       reverse_proxy 127.0.0.1:8095
   }
   ```

   Nginx works too. Use `client_max_body_size 8m;`, `proxy_request_buffering off;`, `proxy_buffering off;`, and `access_log off;` so AI-link URLs are never logged.

**Updating:** upload the new files (or use *Reinstall* with a Git repo), set **Rebuild on start** to `1`, restart once, then set it back to `0`.

**Where data lives:** `/home/container/data` inside the server volume holds ciphertext and hashed tokens only. Pterodactyl backups of the server are therefore encrypted at rest by design.

> If your Pterodactyl node belongs to a hosting company rather than you, remember that AI links decrypt on *their* machine. Private links stay end-to-end encrypted either way.

## Using it with ChatGPT (or any AI)

1. Upload your file. Optionally click **Redact before sharing** first.
2. Under **Share with an AI**, pick a lifetime (10 min is plenty) and a fetch limit, then click **Create AI link**.
3. Paste the link into the chat: *"Read this PDF: https://…/r/…/report.pdf"*.
4. Once the AI has fetched it, the link is dead. Revoke it early from the manage page if you like.

For long PDFs, **Redact → Extract text** gives AIs a clean `.txt`, which they read more reliably than scanned or flattened pages. Very long documents can still exceed the AI's context window.

## Development

```bash
npm install
npm test               # crypto format, API, PII detectors
npm run typecheck
npm run build          # frontend → dist/web
UPLOAD_SECRET=dev-secret-please-change npm start   # http://localhost:3000
# or, with hot reload: npm run dev:server  +  npm run dev:web  (http://localhost:5173)
```

Layout:

```
shared/format.ts       encryption format, used by browser and server
server/src/            Fastify API, SQLite (node:sqlite), blob store, cleanup
web/src/pages/         upload, view (/f/:id), manage (/m, /m/:id)
web/src/lib/           API client, transfer pipeline, pdf.js, preview, UI helpers
web/src/redact/        PII detection and the redaction editor
```

API summary:

| Method & path | Auth | Purpose |
|---|---|---|
| `POST /api/files` | upload secret | create upload (sizes, encrypted meta, policy) |
| `PUT /api/files/:id/chunks/:i` | manage token | upload a ciphertext chunk |
| `POST /api/files/:id/complete` | manage token | seal upload, start expiry clock |
| `GET /api/files/:id/peek` | none | policy + wrapped key, no view spent |
| `POST /api/files/:id/open` | none | spend a view, get a download session |
| `GET /api/files/:id/chunks/:i` | session or manage | ciphertext chunk |
| `GET /api/files/:id/manage` | manage token | owner info and AI links |
| `DELETE /api/files/:id` | manage token | erase now |
| `POST/DELETE /api/files/:id/ai-links[/:linkId]` | manage token | create / revoke AI links |
| `GET /r/:token/:key/:name` | the link itself | decrypted file for AI fetchers |
