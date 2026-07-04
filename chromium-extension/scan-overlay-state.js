export function shouldReinjectScanOverlay(error) {
  const message = String(error?.message || error || "");
  return message.includes("Receiving end does not exist");
}
