function secretChangeToken(value: string): string {
  if (!value) {
    return "";
  }
  let checksum = 0;
  for (let index = 0; index < value.length; index += 1) {
    checksum = (checksum + value.charCodeAt(index)) % 1_000_000_007;
  }
  return `${value.length}:${checksum}`;
}

export function tokenizeSecretInput(value?: string): string {
  return secretChangeToken(value?.trim() ?? "");
}
