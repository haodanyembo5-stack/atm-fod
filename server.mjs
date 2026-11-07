import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import express from "express";
import { fileTypeFromFile } from "file-type";
import { Server } from "socket.io";
import { ExpressPeerServer } from "peer";

const root = dirname(fileURLToPath(import.meta.url));
const dataDirectory = process.env.DATA_DIRECTORY || join(root, "data");
const uploadsDirectory = process.env.UPLOADS_DIRECTORY || join(root, "uploads");
const publicationsPath = join(dataDirectory, "publications.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "0.0.0.0";
const youtubeApiKey = process.env.YOUTUBE_API_KEY;
const configuredSiteUrl = process.env.SITE_URL || process.env.RENDER_EXTERNAL_URL;
const siteOrigin = configuredSiteUrl ? new URL(configuredSiteUrl).origin : null;
const pwaIconFiles = new Map([
  ["/favicon.ico", "apple-touch-icon.png"],
  ["/apple-touch-icon.png", "apple-touch-icon.png"],
  ["/icon-192.png", "icon-192.png"],
  ["/icon-512.png", "icon-512.png"]
]);
const maxFileSize = 15 * 1024 * 1024;
const maxFiles = 5;
const maxRequestSize = maxFileSize * maxFiles + 1024 * 1024;
const roles = new Set(["acheteur", "vendeur", "visiteur", "livreur", "chauffeur"]);
const mimeKinds = new Map([
  ["image/jpeg", "image"], ["image/png", "image"], ["image/gif", "image"], ["image/webp", "image"], ["image/avif", "image"],
  ["video/mp4", "video"], ["video/webm", "video"], ["video/quicktime", "video"], ["video/ogg", "video"],
  ["application/pdf", "pdf"],
  ["audio/mpeg", "audio"], ["audio/mp4", "audio"], ["audio/aac", "audio"], ["audio/wav", "audio"], ["audio/x-wav", "audio"], ["audio/vnd.wave", "audio"], ["audio/ogg", "audio"], ["audio/flac", "audio"], ["audio/webm", "audio"]
]);
const extensionKinds = new Map([
  ["jpg", "image"], ["jpeg", "image"], ["png", "image"], ["gif", "image"], ["webp", "image"], ["avif", "image"],
  ["mp4", "video"], ["webm", "video"], ["mov", "video"], ["ogv", "video"],
  ["pdf", "pdf"],
  ["mp3", "audio"], ["m4a", "audio"], ["aac", "audio"], ["wav", "audio"], ["ogg", "audio"], ["oga", "audio"], ["flac", "audio"], ["weba", "audio"]
]);
const requestCounts = new Map();
let publications = [];
let mutationQueue = Promise.resolve();

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  response.end(body);
}

function publicPublication(publication) {
  return {
    id: publication.id,
    author: publication.author,
    role: publication.role,
    message: publication.message,
    createdAt: publication.createdAt,
    location: publication.location,
    attachments: publication.attachments.map(({ name, kind, mimeType, size, url }) => ({ name, kind, mimeType, size, url }))
  };
}

function queueMutation(mutation) {
  const result = mutationQueue.then(mutation);
  mutationQueue = result.catch(() => {});
  return result;
}

async function savePublications(nextPublications) {
  const temporaryPath = join(dataDirectory, `${randomUUID()}.tmp`);
  await writeFile(temporaryPath, JSON.stringify(nextPublications, null, 2), { mode: 0o600 });
  await rename(temporaryPath, publicationsPath);
  publications = nextPublications;
}

function cleanDisplayName(filename) {
  return basename(String(filename).replaceAll("\\", "/"))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 120) || "fichier";
}

async function removePaths(paths) {
  await Promise.allSettled(paths.map((path) => rm(path, { force: true })));
}

async function parseMultipart(request) {
  const fields = Object.create(null);
  const fileTasks = [];
  const temporaryPaths = [];
  let parseError = null;
  const rememberError = (error) => { parseError ||= error; };
  let parser;

  try {
    parser = busboy({
      headers: request.headers,
      limits: { fileSize: maxFileSize, files: maxFiles, fields: 5, parts: maxFiles + 5, fieldSize: 4096 }
    });
  } catch {
    throw new RequestError(400, "Formulaire de publication invalide.");
  }

  parser.on("field", (name, value, info) => {
    if (info.valueTruncated) rememberError(new RequestError(413, "Un champ de la publication est trop long."));
    if (!["message", "author", "role", "latitude", "longitude"].includes(name) || Object.hasOwn(fields, name)) {
      rememberError(new RequestError(400, "Champs de publication invalides."));
      return;
    }
    fields[name] = value;
  });

  parser.on("file", (fieldName, file, info) => {
    if (fieldName !== "files") {
      file.resume();
      rememberError(new RequestError(400, "Champ de fichier invalide."));
      return;
    }
    if (!info.filename) {
      file.resume();
      return;
    }

    const temporaryPath = join(uploadsDirectory, `.${randomUUID()}.upload`);
    temporaryPaths.push(temporaryPath);
    file.on("limit", () => rememberError(new RequestError(413, "Chaque fichier doit faire 15 Mo ou moins.")));

    const task = pipeline(file, createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }))
      .then(async () => {
        if (file.truncated) throw new RequestError(413, "Chaque fichier doit faire 15 Mo ou moins.");
        const detected = await fileTypeFromFile(temporaryPath);
        if (!detected || !mimeKinds.has(detected.mime)) throw new RequestError(415, "Un des fichiers ne correspond pas à un format pris en charge.");

        const detectedKind = extensionKinds.get(detected.ext);
        const declaredKind = mimeKinds.get(info.mimeType) || extensionKinds.get(extname(info.filename).slice(1).toLowerCase());
        const isAudioMp4 = declaredKind === "audio" && detected.mime === "video/mp4" && detected.ext === "mp4";
        if (!detectedKind || !declaredKind || (detectedKind !== declaredKind && !isAudioMp4)) {
          throw new RequestError(415, "Le contenu d’un fichier ne correspond pas à son format déclaré.");
        }

        return {
          temporaryPath,
          name: cleanDisplayName(info.filename),
          kind: isAudioMp4 ? "audio" : detectedKind,
          mimeType: detected.mime,
          extension: detected.ext,
          size: (await stat(temporaryPath)).size
        };
      });
    task.catch(rememberError);
    fileTasks.push(task);
  });

  parser.on("filesLimit", () => rememberError(new RequestError(413, "Vous pouvez joindre jusqu’à 5 fichiers.")));
  parser.on("fieldsLimit", () => rememberError(new RequestError(413, "Le formulaire contient trop de champs.")));
  parser.on("partsLimit", () => rememberError(new RequestError(413, "La publication contient trop d’éléments.")));

  try {
    await pipeline(request, parser);
  } catch {
    rememberError(new RequestError(400, "Le transfert de la publication a été interrompu."));
  }

  const results = await Promise.allSettled(fileTasks);
  const failedFile = results.find((result) => result.status === "rejected");
  if (!parseError && failedFile) parseError = failedFile.reason;
  if (parseError) {
    await removePaths(temporaryPaths);
    throw parseError;
  }

  return { fields, files: results.map((result) => result.value), temporaryPaths };
}

function validateRateLimit(request) {
  const ip = request.socket.remoteAddress || "unknown";
  const now = Date.now();
  const recent = (requestCounts.get(ip) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 10) throw new RequestError(429, "Trop de publications pour le moment. Réessayez plus tard.");
  recent.push(now);
  requestCounts.set(ip, recent);
}

async function createPublication(request) {
  const contentLength = Number(request.headers["content-length"] || 0);
  if (contentLength > maxRequestSize) throw new RequestError(413, "La publication dépasse la taille maximale autorisée.");
  validateRateLimit(request);

  const parsed = await parseMultipart(request);
  const finalizedPaths = [];
  try {
    const message = (parsed.fields.message || "").trim();
    const author = cleanDisplayName(parsed.fields.author || "Visiteur").slice(0, 80);
    const role = roles.has(parsed.fields.role) ? parsed.fields.role : "visiteur";
    const latitudeText = (parsed.fields.latitude || "").trim();
    const longitudeText = (parsed.fields.longitude || "").trim();
    let location = null;

    if (message.length > 1000) throw new RequestError(413, "Le message ne peut pas dépasser 1 000 caractères.");
    if (Boolean(latitudeText) !== Boolean(longitudeText)) throw new RequestError(400, "La position GPS est incomplète.");
    if (latitudeText && longitudeText) {
      const latitude = Number(latitudeText);
      const longitude = Number(longitudeText);
      if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90 || !Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
        throw new RequestError(400, "La position GPS est invalide.");
      }
      location = { latitude, longitude };
    }
    if (!message && !parsed.files.length && !location) throw new RequestError(400, "Ajoutez un message, un fichier ou une position GPS.");

    const attachments = [];
    for (const file of parsed.files) {
      const storageName = `${randomUUID()}.${file.extension}`;
      const targetPath = join(uploadsDirectory, storageName);
      await rename(file.temporaryPath, targetPath);
      finalizedPaths.push(targetPath);
      attachments.push({
        name: file.name,
        kind: file.kind,
        mimeType: file.mimeType,
        size: file.size,
        url: `/media/${storageName}`,
        storageName
      });
    }

    const deleteToken = randomBytes(32).toString("base64url");
    const publication = {
      id: randomUUID(),
      author,
      role,
      message,
      createdAt: new Date().toISOString(),
      location,
      attachments,
      ownerTokenHash: createHash("sha256").update(deleteToken).digest("hex")
    };

    await queueMutation(() => savePublications([publication, ...publications]));
    return { publication: publicPublication(publication), deleteToken };
  } catch (error) {
    await removePaths([...parsed.temporaryPaths, ...finalizedPaths]);
    throw error;
  }
}

async function deletePublication(request, id) {
  const authorization = request.headers.authorization || "";
  const match = authorization.match(/^Bearer ([A-Za-z0-9_-]{40,})$/);
  if (!match) throw new RequestError(404, "Publication introuvable ou non autorisée.");
  const providedHash = createHash("sha256").update(match[1]).digest();

  return queueMutation(async () => {
    const index = publications.findIndex((publication) => publication.id === id);
    if (index === -1) throw new RequestError(404, "Publication introuvable ou non autorisée.");
    const expectedHash = Buffer.from(publications[index].ownerTokenHash, "hex");
    if (expectedHash.length !== providedHash.length || !timingSafeEqual(expectedHash, providedHash)) {
      throw new RequestError(404, "Publication introuvable ou non autorisée.");
    }
    const [removed] = publications.splice(index, 1);
    await savePublications(publications);
    await removePaths(removed.attachments.map((attachment) => join(uploadsDirectory, attachment.storageName)));
  });
}

function setCommonHeaders(response) {
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Permissions-Policy", "geolocation=(self)");
  response.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data: https://images.unsplash.com https://i.ytimg.com https://*.google-analytics.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://*.ttwstatic.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.tiktok.com https://*.ttwstatic.com; media-src 'self' blob:; connect-src 'self' https://*.googleapis.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com https://www.tiktok.com; frame-src 'self' https://www.youtube-nocookie.com https://www.tiktok.com https://maps.google.com https://www.google.com; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'");
}

function serveRange(request, response, filePath, mimeType, filename, fileSize) {
  const range = request.headers.range;
  const headers = {
    "Content-Type": mimeType,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=31536000, immutable"
  };

  if (range) {
    const match = range.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]) || fileSize === 0) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    const start = match[1] ? Number(match[1]) : Math.max(0, fileSize - Number(match[2]));
    const end = match[2] && match[1] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
    if (start >= fileSize || end < start) {
      response.writeHead(416, { "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    response.writeHead(206, { ...headers, "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${fileSize}` });
    if (request.method === "HEAD") response.end();
    else createReadStream(filePath, { start, end }).pipe(response);
    return;
  }

  response.writeHead(200, { ...headers, "Content-Length": fileSize });
  if (request.method === "HEAD") response.end();
  else createReadStream(filePath).pipe(response);
}

function validateYouTubeSearchRateLimit(request) {
  const key = `youtube:${request.socket.remoteAddress || "unknown"}`;
  const now = Date.now();
  const recent = (requestCounts.get(key) || []).filter((timestamp) => now - timestamp < 15 * 60 * 1000);
  if (recent.length >= 5) throw new RequestError(429, "Trop de recherches YouTube. Réessayez plus tard.");
  recent.push(now);
  requestCounts.set(key, recent);
}

async function searchYouTube(query) {
  const endpoint = new URL("https://www.googleapis.com/youtube/v3/search");
  endpoint.search = new URLSearchParams({
    part: "snippet",
    type: "video",
    maxResults: "8",
    q: query,
    key: youtubeApiKey
  }).toString();

  let upstream;
  try {
    upstream = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
  } catch {
    throw new RequestError(502, "La recherche YouTube est temporairement indisponible.");
  }
  if (!upstream.ok) throw new RequestError(502, "La recherche YouTube a échoué. Vérifiez la clé API et son quota.");

  const payload = await upstream.json();
  const videos = (Array.isArray(payload.items) ? payload.items : []).flatMap((item) => {
    const id = item.id?.videoId;
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(id)) return [];
    const snippet = item.snippet || {};
    const thumbnailUrl = snippet.thumbnails?.medium?.url;
    return [{
      id,
      title: typeof snippet.title === "string" ? snippet.title.slice(0, 200) : "Vidéo YouTube",
      channelTitle: typeof snippet.channelTitle === "string" ? snippet.channelTitle.slice(0, 100) : "",
      thumbnail: typeof thumbnailUrl === "string" && thumbnailUrl.startsWith("https://i.ytimg.com/") ? thumbnailUrl : null
    }];
  });
  return { videos };
}

async function handleRequest(request, response, io) {
  setCommonHeaders(response);
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/favicon.svg") {
    const icon = await readFile(join(root, "favicon.svg"));
    response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    response.end(request.method === "HEAD" ? undefined : icon);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/manifest.webmanifest") {
    const manifest = await readFile(join(root, "manifest.webmanifest"));
    response.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    response.end(request.method === "HEAD" ? undefined : manifest);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/service-worker.js") {
    const worker = await readFile(join(root, "service-worker.js"));
    response.writeHead(200, {
      "Content-Type": "text/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/"
    });
    response.end(request.method === "HEAD" ? undefined : worker);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/app-icon.svg") {
    const icon = await readFile(join(root, "app-icon.svg"));
    response.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
    response.end(request.method === "HEAD" ? undefined : icon);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pwaIconFiles.has(pathname)) {
    const icon = await readFile(join(root, "public", pwaIconFiles.get(pathname)));
    response.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
    response.end(request.method === "HEAD" ? undefined : icon);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/firebase-client.js") {
    const bundle = await readFile(join(root, "public", "firebase-client.js"));
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=300" });
    response.end(request.method === "HEAD" ? undefined : bundle);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/peerjs-client.js") {
    const client = await readFile(join(root, "node_modules", "peerjs", "dist", "peerjs.min.js"));
    response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" });
    response.end(request.method === "HEAD" ? undefined : client);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/robots.txt") {
    if (!siteOrigin) throw new RequestError(503, "Configurez SITE_URL avant de publier le site.");
    const body = `User-agent: *\nAllow: /\nSitemap: ${siteOrigin}/sitemap.xml\n`;
    response.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && pathname === "/sitemap.xml") {
    if (!siteOrigin) throw new RequestError(503, "Configurez SITE_URL avant de publier le site.");
    const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteOrigin}/</loc><changefreq>weekly</changefreq></url></urlset>`;
    response.writeHead(200, { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600" });
    response.end(request.method === "HEAD" ? undefined : body);
    return;
  }

  if ((request.method === "GET" || request.method === "HEAD") && (pathname === "/" || pathname === "/index.html")) {
    let html = await readFile(join(root, "index.html"), "utf8");
    const searchMetadata = siteOrigin
      ? `<link rel="canonical" href="${siteOrigin}/"><meta property="og:url" content="${siteOrigin}/">`
      : "";
    if (siteOrigin) html = html.replace('<meta name="robots" content="noindex, nofollow">', '<meta name="robots" content="index, follow, max-image-preview:large">');
    html = html.replace("<!-- PUBLIC_SITE_SEO -->", searchMetadata);
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-cache",
      ...(siteOrigin ? {} : { "X-Robots-Tag": "noindex, nofollow" })
    });
    response.end(request.method === "HEAD" ? undefined : html);
    return;
  }

  if (request.method === "GET" && pathname === "/api/health") {
    sendJson(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "GET" && pathname === "/api/youtube/search") {
    const query = url.searchParams.get("q")?.trim();
    if (!query || query.length > 120) throw new RequestError(400, "La recherche doit contenir de 1 à 120 caractères.");
    if (!youtubeApiKey) throw new RequestError(503, "La recherche YouTube nécessite la variable serveur YOUTUBE_API_KEY.");
    validateYouTubeSearchRateLimit(request);
    sendJson(response, 200, await searchYouTube(query));
    return;
  }

  if (request.method === "GET" && pathname === "/api/publications") {
    await mutationQueue;
    sendJson(response, 200, publications.map(publicPublication));
    return;
  }

  if (request.method === "POST" && pathname === "/api/publications") {
    const result = await createPublication(request);
    io.emit("publications updated");
    sendJson(response, 201, { ...result.publication, deleteToken: result.deleteToken });
    return;
  }

  const deleteMatch = pathname.match(/^\/api\/publications\/([0-9a-f-]{36})$/i);
  if (request.method === "DELETE" && deleteMatch) {
    await deletePublication(request, deleteMatch[1]);
    io.emit("publications updated");
    sendJson(response, 200, { deleted: true });
    return;
  }

  const mediaMatch = pathname.match(/^\/media\/([0-9a-f-]{36}\.[a-z0-9]+)$/i);
  if ((request.method === "GET" || request.method === "HEAD") && mediaMatch) {
    await mutationQueue;
    const attachment = publications.flatMap((publication) => publication.attachments).find((item) => item.storageName === mediaMatch[1]);
    if (!attachment) throw new RequestError(404, "Fichier introuvable.");
    const filePath = join(uploadsDirectory, attachment.storageName);
    const fileStats = await stat(filePath).catch(() => null);
    if (!fileStats?.isFile()) throw new RequestError(404, "Fichier introuvable.");
    serveRange(request, response, filePath, attachment.mimeType, attachment.name, fileStats.size);
    return;
  }

  throw new RequestError(404, "Page introuvable.");
}

async function start() {
  await mkdir(dataDirectory, { recursive: true });
  await mkdir(uploadsDirectory, { recursive: true });
  try {
    publications = JSON.parse(await readFile(publicationsPath, "utf8"));
    if (!Array.isArray(publications)) throw new Error("Le stockage des publications doit contenir une liste.");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await writeFile(publicationsPath, "[]\n", { mode: 0o600 });
  }

  const app = express();
  const server = createServer(app);
  const io = new Server(server);
  const peerServer = ExpressPeerServer(server);
  app.use("/peerjs", peerServer);
  peerServer.on("error", (error) => console.error("PeerJS server error:", error));

  app.use((request, response) => {
    const startedAt = Date.now();
    handleRequest(request, response, io).catch((error) => {
      if (!response.headersSent) {
        const status = error instanceof RequestError ? error.status : 500;
        if (status === 500) console.error("Request failed:", error.message);
        sendJson(response, status, { error: status === 500 ? "Erreur interne du serveur." : error.message });
      } else {
        response.destroy();
      }
    }).finally(() => {
      response.on("finish", () => console.log(`${request.method} ${request.url} ${response.statusCode} ${Date.now() - startedAt}ms`));
    });
  });

  function broadcastOnlineUsers() {
    const users = Array.from(io.sockets.sockets.values())
      .map((client) => client.data.userInfo)
      .filter(Boolean);
    io.emit("update user list", users);
  }

  io.on("connection", (socket) => {
    console.log("Un utilisateur est connecté :", socket.id);

    socket.on("user connected", (data) => {
      if (!data || typeof data !== "object" || Array.isArray(data)) return;
      const clientId = typeof data.clientId === "string" && /^[a-zA-Z0-9-]{1,64}$/.test(data.clientId)
        ? data.clientId
        : socket.id;
      const name = typeof data.name === "string"
        ? data.name.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 80) || "Visiteur"
        : "Visiteur";
      const peerId = typeof data.peerId === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(data.peerId)
        ? data.peerId
        : null;
      socket.data.userInfo = { clientId, name, peerId };
      broadcastOnlineUsers();
    });

    socket.on("chat message", (msg) => {
      if (typeof msg !== "string") return;
      const message = msg.trim().slice(0, 1000);
      if (!message) return;
      io.emit("chat message", { user: socket.data.userInfo?.name || "Visiteur", msg: message });
    });

    socket.on("disconnect", () => {
      console.log("Utilisateur déconnecté");
      broadcastOnlineUsers();
    });
  });

  server.headersTimeout = 15_000;
  server.requestTimeout = 120_000;
  server.listen(port, host, () => {
    const address = server.address();
    console.log(`ATM FOD disponible sur http://localhost:${address.port}`);
    console.log("Les publications et fichiers sont partagés par les visiteurs de cette instance.");
    if (siteOrigin) console.log(`Références SEO actives pour ${siteOrigin}`);
    else console.log("Configurez SITE_URL pour activer le sitemap et l’indexation publique.");
  });
}

start().catch((error) => {
  console.error("Impossible de démarrer le serveur:", error);
  process.exitCode = 1;
});