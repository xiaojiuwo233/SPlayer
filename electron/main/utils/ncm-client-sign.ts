import crypto from "node:crypto";
import os from "node:os";

const HEX_CHARS = "0123456789ABCDEF";
const DEVICE_ID_PART_LENGTHS = [4, 4, 4, 4, 4, 4, 4, 5];

const stringToHex = (value: string): string => Buffer.from(value, "utf8").toString("hex").toUpperCase();

const sha256 = (value: string): string => crypto.createHash("sha256").update(value, "utf8").digest("hex");

const generateRandomHex = (length: number): string => {
  let result = "";
  for (let index = 0; index < length; index += 1) {
    result += HEX_CHARS[Math.floor(Math.random() * HEX_CHARS.length)];
  }
  return result;
};

const generateRandomMac = (): string => {
  const parts = Array.from({ length: 6 }, () => generateRandomHex(2));
  const firstByte = Number.parseInt(parts[0], 16);
  parts[0] = (firstByte & 0xfe).toString(16).padStart(2, "0").toUpperCase();
  return parts.join(":");
};

const getRealMacAddress = (): string | null => {
  try {
    const interfaces = os.networkInterfaces();
    for (const interfaceItems of Object.values(interfaces)) {
      if (!interfaceItems) continue;
      for (const interfaceItem of interfaceItems) {
        if (
          interfaceItem.mac &&
          interfaceItem.mac !== "00:00:00:00:00:00" &&
          !interfaceItem.internal
        ) {
          return interfaceItem.mac.toUpperCase();
        }
      }
    }
  } catch {
    return null;
  }

  return null;
};

export const getMacAddress = (): string => getRealMacAddress() || generateRandomMac();

export const generateRandomDeviceId = (): string =>
  DEVICE_ID_PART_LENGTHS.map((length) => generateRandomHex(length)).join("_");

export const generateWithCustomDeviceId = (
  macAddress: string,
  deviceId: string,
  secretKey: string = "",
): string => {
  const signString = `${macAddress}@@@${stringToHex(deviceId)}`;
  return `${signString}@@@@@@${sha256(signString + secretKey)}`;
};
