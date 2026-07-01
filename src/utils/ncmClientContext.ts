const QR_DEVICE_ID_KEY = "splayer_ncm_qr_s_device_id";

const generateHex = (bytes: number): string => {
  const chars = "0123456789ABCDEF";
  let output = "";
  for (let index = 0; index < bytes * 2; index += 1) {
    output += chars[Math.floor(Math.random() * chars.length)];
  }
  return output;
};

/** 获取二维码登录使用的 sDeviceId */
export const getNcmQrSDeviceId = (): string => {
  try {
    const currentDeviceId = localStorage.getItem(QR_DEVICE_ID_KEY);
    if (currentDeviceId) return currentDeviceId;

    const nextDeviceId = generateHex(26);
    localStorage.setItem(QR_DEVICE_ID_KEY, nextDeviceId);
    return nextDeviceId;
  } catch {
    return generateHex(26);
  }
};
