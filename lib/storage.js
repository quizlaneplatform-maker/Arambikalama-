// Question images in Neon Object Storage (S3-compatible). The bucket is private: the app stores only
// the object key on the question and hands out short-lived presigned URLs for display.
// Credentials, endpoint and region come from the AWS_* env vars that `neon deploy` / `neon env pull` write.
const crypto = require("crypto");
const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const BUCKET = process.env.IMAGE_BUCKET || "assets";
const MAX_BYTES = 2 * 1024 * 1024;
const URL_TTL_S = 24 * 60 * 60; // presigned links last a day...
const URL_REFRESH_MS = 12 * 60 * 60 * 1000; // ...and are re-signed after 12h, so a game never sees one expire

const imagesEnabled = () => Boolean(process.env.AWS_ENDPOINT_URL_S3 && process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY);

let s3 = null;
const client = () => (s3 ??= new S3Client({ forcePathStyle: true })); // Neon requires path-style addressing

/** Detect the image type from its first bytes; the browser's Content-Type is not trusted. */
function sniff(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { type: "image/jpeg", ext: "jpg" };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: "image/png", ext: "png" };
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString("latin1"))) return { type: "image/gif", ext: "gif" };
  if (buf.length > 12 && buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return { type: "image/webp", ext: "webp" };
  return null;
}

/** Store an uploaded image for this teacher. Returns its object key. */
async function saveImage(ownerId, buf) {
  if (!Buffer.isBuffer(buf) || !buf.length) throw Object.assign(new Error("Choose an image to upload."), { status: 400 });
  if (buf.length > MAX_BYTES) throw Object.assign(new Error("Images can be up to 2 MB."), { status: 413 });
  const kind = sniff(buf);
  if (!kind) throw Object.assign(new Error("Use a JPEG, PNG, GIF or WebP image."), { status: 415 });
  // A new key per upload: an image never changes under an existing key.
  const key = `questions/${ownerId}/${crypto.randomBytes(12).toString("hex")}.${kind.ext}`;
  await client().send(new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: buf, ContentType: kind.type, CacheControl: "private, max-age=86400, immutable" }));
  return key;
}

/** Only keys this teacher uploaded can be attached to their questions. */
const ownsKey = (ownerId, key) => typeof key === "string" && new RegExp(`^questions/${ownerId}/[0-9a-f]{24}\\.(jpg|png|gif|webp)$`).test(key);

// Same URL for the same image while it is valid, so the host and players' browsers cache it
// instead of re-downloading on every game update.
const signed = new Map(); // key -> { url, at }
async function imageUrl(key) {
  if (!key || !imagesEnabled()) return null;
  const hit = signed.get(key);
  if (hit && Date.now() - hit.at < URL_REFRESH_MS) return hit.url;
  const url = await getSignedUrl(client(), new GetObjectCommand({ Bucket: BUCKET, Key: key }), { expiresIn: URL_TTL_S });
  signed.set(key, { url, at: Date.now() });
  return url;
}

/** Sign every image a game will show, before it starts, so game updates can read links synchronously. */
const warmUrls = (keys) => Promise.all([...new Set(keys.filter(Boolean))].map((k) => imageUrl(k).catch(() => null)));

/** The cached link for a key (for synchronous game-state code). Re-signs in the background when stale. */
function cachedUrl(key) {
  if (!key || !imagesEnabled()) return null;
  const hit = signed.get(key);
  if (!hit || Date.now() - hit.at >= URL_REFRESH_MS) imageUrl(key).catch(() => {});
  return hit?.url ?? null;
}

module.exports = { imagesEnabled, saveImage, ownsKey, imageUrl, warmUrls, cachedUrl, MAX_BYTES };
