import { adapterError } from "./errors.js";

interface NetplanWifi {
  readonly passphrase: Uint8Array;
  readonly ssid: string;
}

const escapeKeyfileString = (input: string): string => {
  const escaped = input
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return escaped
    .replace(/^ +/u, (spaces) => "\\s".repeat(spaces.length))
    .replace(/ +$/u, (spaces) => "\\s".repeat(spaces.length));
};

const decodePassphrase = (input: Uint8Array): string => {
  const value = Buffer.from(input).toString("utf8");
  const validLength = value.length >= 8 && value.length <= 63;
  const validHex = value.length === 64 && /^[a-fA-F0-9]{64}$/u.test(value);
  if (
    (!validLength && !validHex) || value.includes("\0") ||
    !Buffer.from(value, "utf8").equals(Buffer.from(input))
  ) throw adapterError("invalid-input", "The Wi-Fi bootstrap passphrase is invalid.");
  return value;
};

export const renderNetworkConfig = (wifi: NetplanWifi): Uint8Array => {
  const document = {
    network: {
      version: 2,
      renderer: "NetworkManager",
      wifis: {
        wlan0: {
          dhcp4: true,
          optional: false,
          "access-points": {
            [wifi.ssid]: { password: decodePassphrase(wifi.passphrase) },
          },
        },
      },
    },
  };
  return Buffer.from(`${JSON.stringify(document, null, 2)}\n`, "utf8");
};

export const renderNetworkManagerProfile = (wifi: NetplanWifi): Uint8Array => {
  const passphrase = decodePassphrase(wifi.passphrase);
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
    `ssid=${escapeKeyfileString(wifi.ssid)}`,
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

export const assertNetworkConfig = (
  contents: Uint8Array,
  wifi: NetplanWifi,
): void => {
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(contents).toString("utf8"));
  } catch {
    throw adapterError("postcondition-failed", "The generated Netplan v2 document is invalid.");
  }
  const expected = renderNetworkConfig(wifi);
  if (!Buffer.from(contents).equals(Buffer.from(expected)) || document === null) {
    throw adapterError("postcondition-failed", "The generated Netplan v2 document is invalid.");
  }
};
