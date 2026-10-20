/** Decodes the base64url VAPID public key into the bytes `pushManager.subscribe` expects. */
export function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(value)) throw new Error("invalid base64url");
  const standard = value.replace(/=+$/, "").replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
