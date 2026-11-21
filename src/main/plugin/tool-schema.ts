/**
 * The schema of a plugin tool's arguments (TODO 847, ARCHITECTURE 7.2 / 7.6.7).
 *
 * The manifest's `mcp.tools[].inputSchema` is limited to **a small subset of JSON Schema**. There are two reasons:
 *
 * 1. The gateway puts the schema as is into `tools/list`, and main **re-checks the arguments with the same schema**
 *    (as with the renderer: "what is passed is re-checked in main"). If the checking side cannot interpret every keyword, the published schema
 *    and main's check drift apart. An unknown keyword means "do not load" (the same policy as the manifest's `.strict()`).
 * 2. `pattern` (regular expressions) is not included - running a regular expression a plugin wrote on main's JS thread
 *    could let catastrophic backtracking hold main.
 *
 * Limits are set on size (JSON characters), depth, the number of properties of one object, and the number of enum values.
 * This file has **pure functions only** (it touches neither electron nor the DB).
 */

/** Upper limit on the number of JSON characters of a schema. */
export const MAX_TOOL_SCHEMA_CHARS = 8 * 1024
/** Upper limit on the nesting depth of a schema (the top-level object is 1). */
export const MAX_TOOL_SCHEMA_DEPTH = 6
/** Upper limit on the number of `properties` of one object. */
export const MAX_TOOL_SCHEMA_PROPERTIES = 32
/** Upper limit on the number of `enum` values. */
export const MAX_TOOL_SCHEMA_ENUM = 64
/** Upper limit on the number of JSON characters of arguments (one call). */
export const MAX_TOOL_ARGS_CHARS = 64 * 1024

const TYPES = ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const
type SchemaType = (typeof TYPES)[number]

/** The keywords that are interpreted. A schema with any other keyword is not loaded. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'default'
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isPrimitive(value: unknown): boolean {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value)
}

/**
 * Check the manifest's `inputSchema`. null if there is no problem, otherwise the first reason (a short English sentence).
 * The top level must be `type: "object"` (the MCP `inputSchema` convention).
 */
export function checkToolSchema(schema: unknown): string | null {
  if (!isRecord(schema)) return 'inputSchema must be an object'
  let text: string
  try {
    text = JSON.stringify(schema)
  } catch {
    return 'inputSchema must be JSON'
  }
  if (text.length > MAX_TOOL_SCHEMA_CHARS) return `inputSchema exceeds ${MAX_TOOL_SCHEMA_CHARS} characters`
  if (schema['type'] !== 'object') return 'inputSchema must have type "object"'
  return checkNode(schema, 1, 'inputSchema')
}

function checkNode(node: unknown, depth: number, path: string): string | null {
  if (depth > MAX_TOOL_SCHEMA_DEPTH) return `${path}: nested deeper than ${MAX_TOOL_SCHEMA_DEPTH}`
  if (!isRecord(node)) return `${path}: must be an object`
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) return `${path}: unsupported keyword "${key}"`
  }
  const type = node['type']
  if (typeof type !== 'string' || !(TYPES as readonly string[]).includes(type)) {
    return `${path}: type must be one of ${TYPES.join(' / ')}`
  }
  for (const key of ['title', 'description'] as const) {
    if (node[key] !== undefined && (typeof node[key] !== 'string' || (node[key] as string).length > 1024)) {
      return `${path}.${key}: must be a string of at most 1024 characters`
    }
  }
  for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems'] as const) {
    if (node[key] !== undefined && !isNonNegativeInt(node[key])) return `${path}.${key}: must be a non-negative integer`
  }
  for (const key of ['minimum', 'maximum'] as const) {
    if (node[key] !== undefined && (typeof node[key] !== 'number' || !Number.isFinite(node[key]))) {
      return `${path}.${key}: must be a number`
    }
  }
  const enumValues = node['enum']
  if (enumValues !== undefined) {
    if (!Array.isArray(enumValues) || enumValues.length === 0 || enumValues.length > MAX_TOOL_SCHEMA_ENUM) {
      return `${path}.enum: must be an array of 1..${MAX_TOOL_SCHEMA_ENUM} values`
    }
    if (!enumValues.every(isPrimitive)) return `${path}.enum: values must be strings, numbers, booleans or null`
  }
  const t = type as SchemaType
  const objectOnly = ['properties', 'required', 'additionalProperties'].filter((key) => node[key] !== undefined)
  if (t !== 'object' && objectOnly.length > 0) return `${path}.${objectOnly[0]}: only for type "object"`
  if (t !== 'array' && node['items'] !== undefined) return `${path}.items: only for type "array"`
  if (t === 'object') {
    const properties = node['properties'] ?? {}
    if (!isRecord(properties)) return `${path}.properties: must be an object`
    const names = Object.keys(properties)
    if (names.length > MAX_TOOL_SCHEMA_PROPERTIES) {
      return `${path}.properties: more than ${MAX_TOOL_SCHEMA_PROPERTIES} properties`
    }
    for (const name of names) {
      const error = checkNode(properties[name], depth + 1, `${path}.properties.${name}`)
      if (error !== null) return error
    }
    const required = node['required']
    if (required !== undefined) {
      if (!Array.isArray(required) || !required.every((name) => typeof name === 'string')) {
        return `${path}.required: must be an array of strings`
      }
      const missing = required.find((name) => !Object.hasOwn(properties, name))
      if (missing !== undefined) return `${path}.required: "${String(missing)}" is not in properties`
    }
    const additional = node['additionalProperties']
    if (additional !== undefined && typeof additional !== 'boolean') {
      return `${path}.additionalProperties: must be true or false`
    }
  }
  if (t === 'array') {
    const items = node['items']
    if (items !== undefined) {
      const error = checkNode(items, depth + 1, `${path}.items`)
      if (error !== null) return error
    }
  }
  return null
}

/**
 * Check arguments against a schema that passed `checkToolSchema`. null if they pass, otherwise the first reason (a short English sentence.
 * **The value itself is not put in the sentence** - it is only returned to the model, but this keeps the value from remaining even if it flows into a log).
 * `default` is used neither for checking nor for filling in (it is only published).
 */
export function checkToolArgs(schema: Record<string, unknown>, args: unknown): string | null {
  let text: string | undefined
  try {
    text = JSON.stringify(args)
  } catch {
    return 'arguments must be JSON'
  }
  if (text === undefined) return 'arguments must be an object'
  if (text.length > MAX_TOOL_ARGS_CHARS) return `arguments exceed ${MAX_TOOL_ARGS_CHARS} characters`
  return checkValue(schema, args, 'arguments')
}

function typeMatches(type: SchemaType, value: unknown): boolean {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
  }
}

function checkValue(schema: Record<string, unknown>, value: unknown, path: string): string | null {
  const type = schema['type'] as SchemaType
  if (!typeMatches(type, value)) return `${path}: expected ${type}`
  const enumValues = schema['enum']
  if (Array.isArray(enumValues) && !enumValues.some((candidate) => candidate === value)) {
    return `${path}: not one of the allowed values`
  }
  if (typeof value === 'string') {
    // The length is counted in code points (the JSON Schema convention).
    const length = [...value].length
    if (typeof schema['minLength'] === 'number' && length < schema['minLength']) return `${path}: too short`
    if (typeof schema['maxLength'] === 'number' && length > schema['maxLength']) return `${path}: too long`
  }
  if (typeof value === 'number') {
    if (typeof schema['minimum'] === 'number' && value < schema['minimum']) return `${path}: below minimum`
    if (typeof schema['maximum'] === 'number' && value > schema['maximum']) return `${path}: above maximum`
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return `${path}: too few items`
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return `${path}: too many items`
    const items = schema['items']
    if (isRecord(items)) {
      for (let i = 0; i < value.length; i += 1) {
        const error = checkValue(items, value[i], `${path}[${i}]`)
        if (error !== null) return error
      }
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema['properties']) ? schema['properties'] : {}
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : []
    for (const name of required) {
      if (!Object.hasOwn(value, name)) return `${path}.${name}: required`
    }
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(properties, key)) {
        const error = checkValue(properties[key] as Record<string, unknown>, value[key], `${path}.${key}`)
        if (error !== null) return error
      } else if (schema['additionalProperties'] === false) {
        return `${path}: unknown property`
      }
    }
  }
  return null
}
