import { customAlphabet } from 'nanoid';
import { ID_PREFIXES, type IdPrefix } from './constants.js';

const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
const generate = customAlphabet(alphabet, 12);

/** Creates a prefixed identifier such as `scn_a1B2c3D4e5F6`. */
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${generate()}`;
}

const prefixValues: readonly string[] = Object.values(ID_PREFIXES);

export function hasIdPrefix(id: string, prefix: IdPrefix): boolean {
  return id.startsWith(`${prefix}_`) && id.length === prefix.length + 13;
}

export function idPrefixOf(id: string): IdPrefix | null {
  const prefix = id.split('_', 1)[0];
  return prefix !== undefined && prefixValues.includes(prefix) ? (prefix as IdPrefix) : null;
}
