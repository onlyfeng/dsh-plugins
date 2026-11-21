// A checkpoint is stored verbatim and echoed by the controller in its return receipt.
export function contractText(value, maxBytes = 2048) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    Buffer.byteLength(value) > maxBytes ||
    /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(value)
  ) {
    throw Object.assign(new Error('INVALID_TEXT'), { code: 'INVALID_TEXT' })
  }
  return value
}
