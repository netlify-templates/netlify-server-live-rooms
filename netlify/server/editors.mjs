// Who can edit. With EDIT_TOKEN set, the board is read-only except for
// browsers that unlocked it with the token. Without it, everyone can edit.
//
// Unlocking sends the token in a POST body (never in a URL, where it would end
// up in history and logs). The server answers with a cookie that holds an
// HMAC of the token rather than the token itself, so changing EDIT_TOKEN
// (and redeploying) locks every browser again.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const COOKIE = "editor";
const MAX_AGE = 30 * 24 * 60 * 60;

const token = () => process.env.EDIT_TOKEN || "";

export const locked = () => token() !== "";

const sameText = (a, b) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

const cookieValue = () => createHmac("sha256", token()).update("live-rooms editor").digest("base64url");

const cookies = (request) =>
  new Map(
    (request.headers.get("cookie") ?? "")
      .split(";")
      .map((part) => part.trim().split("="))
      .filter(([name]) => name)
      .map(([name, ...value]) => [name, value.join("=")]),
  );

// Browsers send cookies with WebSocket handshakes from other sites too (when
// SameSite allows it), so a request that comes from another site's page never
// counts as an editor's.
const sameOrigin = (request) => {
  const origin = request.headers.get("origin");

  if (!origin) {
    return true;
  }
  try {
    return new URL(origin).host === new URL(request.url).host;
  } catch {
    return false;
  }
};

export const canEdit = (request) => !locked() || (sameOrigin(request) && sameText(cookies(request).get(COOKIE) ?? "", cookieValue()));

const setCookie = (request, value, maxAge) => {
  // Browsers drop Secure cookies on plain http, except on localhost.
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";

  return `${COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
};

// POST /api/unlock with { token }.
export const unlock = async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Use POST" }, { status: 405 });
  }
  if (!locked()) {
    return Response.json({ canEdit: true });
  }

  const { token: given } = await request.json().catch(() => ({}));

  if (typeof given !== "string" || !sameOrigin(request) || !sameText(given, token())) {
    // Slows down guessing a little. With a long random token, guessing gets
    // nowhere anyway.
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    return Response.json({ error: "That's not the token." }, { status: 403 });
  }

  return Response.json({ canEdit: true }, { headers: { "set-cookie": setCookie(request, cookieValue(), MAX_AGE) } });
};

// POST /api/lock
export const lock = (request) =>
  request.method === "POST" ? Response.json({ canEdit: !locked() }, { headers: { "set-cookie": setCookie(request, "", 0) } }) : Response.json({ error: "Use POST" }, { status: 405 });
