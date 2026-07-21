import { NetworkCommandError } from "./errors.js";

const escapeKeyfileString = (input: string): string => {
  const escaped = input
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return escaped
    .replace(/^ +/u, spaces => "\\s".repeat(spaces.length))
    .replace(/ +$/u, spaces => "\\s".repeat(spaces.length));
};

const validUtf8 = (value: string): boolean =>
  !value.includes("\0") && Buffer.from(value, "utf8").toString("utf8") === value;

export const validateSsid = (ssid: string): string => {
  const length = Buffer.byteLength(ssid, "utf8");
  if (!validUtf8(ssid) || length < 1 || length > 32) {
    throw new NetworkCommandError("invalid-ssid");
  }
  return ssid;
};

export const validatePassphrase = (passphrase: string): string => {
  const validLength = passphrase.length >= 8 && passphrase.length <= 63;
  const validHex = passphrase.length === 64 && /^[a-fA-F0-9]{64}$/u.test(passphrase);
  if (!validUtf8(passphrase) || (!validLength && !validHex)) {
    throw new NetworkCommandError("invalid-passphrase");
  }
  return passphrase;
};

export const renderNetworkManagerProfile = (ssidInput: string, passphraseInput: string): Buffer => {
  const ssid = validateSsid(ssidInput);
  const passphrase = validatePassphrase(passphraseInput);
  return Buffer.from([
    "[connection]",
    "id=agent-boot-wifi",
    "uuid=3f3ab79b-27d1-4c13-b606-f89cb3e9c36a",
    "type=wifi",
    "interface-name=wlan0",
    "autoconnect=true",
    "autoconnect-priority=100",
    "",
    "[wifi]",
    "mode=infrastructure",
    `ssid=${escapeKeyfileString(ssid)}`,
    "security=802-11-wireless-security",
    "",
    "[wifi-security]",
    "key-mgmt=wpa-psk",
    `psk=${escapeKeyfileString(passphrase)}`,
    "",
    "[ipv4]",
    "method=auto",
    "",
    "[ipv6]",
    "method=auto",
    "",
  ].join("\n"), "utf8");
};
