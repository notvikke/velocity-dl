function urlPath(url) {
  if (!url || typeof url !== "string") return "";
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

function isLikelyManifestUrl(url) {
  return /\.(m3u8|mpd)$/i.test(urlPath(url));
}

function isLikelyDirectMediaUrl(url) {
  return /\.(mp4|mkv|webm|mov|m4v|mp3|m4a|aac|flac|wav|ogg|opus|m3u8|mpd|ts|m4s|weba)$/i.test(
    urlPath(url)
  );
}

function isLikelyJunkPlayableUrl(url) {
  if (!url || typeof url !== "string") return true;
  if (
    /(?:black[_-]?screen|teaser|trailer|promo|preview|sample|thumbnail|thumb|poster|sprite|ad[s]?)/i.test(
      url
    )
  ) {
    return true;
  }
  const shortDuration = /(?:^|[_-])(\d{1,2})s(?:[_\-.]|$)/i.exec(url);
  return !!(shortDuration && Number(shortDuration[1]) <= 8);
}

function isLikelyMasterManifestUrl(url) {
  return (
    typeof url === "string" &&
    /(?:^|\/)(?:master|playlist|manifest|index)[^/]*\.(?:m3u8|mpd)(?:$|[?#])/i.test(url)
  );
}

export function scorePlayableCandidate(url, mime) {
  let score = 0;
  if (isLikelyManifestUrl(url)) score += 140;
  if (isLikelyDirectMediaUrl(url)) score += 45;
  if (/^video\//i.test(mime || "")) score += 35;
  if (/^audio\//i.test(mime || "")) score += 15;
  if (isLikelyMasterManifestUrl(url)) score += 40;
  if (/\.mp4(?:$|[?#])/i.test(url)) score += 10;
  if (isLikelyJunkPlayableUrl(url)) score -= 300;
  return score;
}
