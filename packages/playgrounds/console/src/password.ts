// 64 symbols, so `byte & 63` maps each random byte onto one of them without bias.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const generatePassword = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(20)), (byte) => ALPHABET[byte & 63]).join("");
