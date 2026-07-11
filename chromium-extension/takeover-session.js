function isHttpUrl(value) {
  if (!value || typeof value !== "string") return false;
  return /^https?:\/\//i.test(value);
}

export function buildBrowserTakeoverHeaders({ referrer, cookies }) {
  const headers = {};

  if (isHttpUrl(referrer)) {
    headers.Referer = referrer;
  }

  const cookiePairs = [];
  const seenCookieNames = new Set();
  for (const cookie of Array.isArray(cookies) ? cookies : []) {
    const name = typeof cookie?.name === "string" ? cookie.name.trim() : "";
    if (!name || seenCookieNames.has(name)) continue;
    seenCookieNames.add(name);
    cookiePairs.push(`${name}=${cookie?.value ?? ""}`);
  }

  if (cookiePairs.length) {
    headers.Cookie = cookiePairs.join("; ");
  }

  return Object.keys(headers).length ? headers : null;
}
