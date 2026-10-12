/** `$.store` holds the dot under this key: one JSON value shared by every session on this machine. */
export const STORE_KEY = 'data'

export function newId(): string {
  return crypto.randomUUID().slice(0, 8)
}

/** Local time minus UTC in minutes at `at` (UTC-5 is -300). */
export function offsetAt(at: number): number {
  return -new Date(at).getTimezoneOffset()
}
