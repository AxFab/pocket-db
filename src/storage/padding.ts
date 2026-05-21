export function alignTo4Bytes(length: number): number {
  return Math.ceil(length / 4) * 4;
}
