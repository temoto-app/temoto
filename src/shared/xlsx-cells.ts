/**
 * Editing of cell values and formulas of `.xlsx` / `.xlsm` (TODO 1212 stage 1 / stage 2, wave 84 bundle E / wave 86 bundle D, ARCHITECTURE 7.4.9.1). **Pure functions that depend on neither the DOM nor Node**,
 * so the viewer (`aios.office`), the host (the renderer's ViewerPane) and main (the write in `ViewerBroker`) use the same decisions.
 *
 * - **Draft shape (a list of edits)**: a list of "which cell (`B2`) of which sheet part (`xl/worksheets/sheet1.xml`) becomes what", turned into a JSON
 *   string. Like a text draft it is a string, so it rides directly on the host's draft table, dirty state, autosave and the write-out before closing
 *   (TODO 606). The byte sequence (zip) is not held in the renderer. With no edits it is an empty string (= same as the base).
 * - **Interpreting input** (`parseCellInput`): number, boolean, date (only for cells with a date format), string, formula (stage 2, input starting with `=`).
 *   Formulas are not calculated: only the shape is checked and turned into the canonical form written to the file's `<f>` (`normalizeFormulaInput`).
 * - **Formula references** (`formulaReferences`): to put a "stale value" mark on dependent formula cells (aios does not calculate). References that cannot be read
 *   (defined names, structured references, external references, INDIRECT and the like) are `opaque`, and any single edit makes them count as stale (erring on the cautious side).
 * - **Refusal reasons** (`CellLockReason`): reason codes for cells that cannot be edited. The viewer shows them, and main re-checks with the same rules before writing.
 */

/** Name of the format put into the draft JSON. A draft of a version that cannot be read is discarded (`parseCellEdits` gives null). */
export const CELL_EDITS_FORMAT = 'aios.xlsx-cells/1'

/** Upper bound on the number of edits in one draft (overwrites of the same cell are not counted, after `collapseCellEdits`). */
export const MAX_CELL_EDITS = 10_000
/** Upper bound on a cell's string (32,767 characters, the same as Excel's cell limit). */
export const MAX_CELL_TEXT = 32_767
/** Upper bound on the length of a sheet part's path. */
const MAX_PART_PATH = 512
/** Excel's row and column limits (1,048,576 rows x XFD columns). */
export const MAX_ROWS = 1_048_576
export const MAX_COLUMNS = 16_384

/** Upper bound on formula characters (8,192, the same as Excel's formula limit; excluding the leading `=`). */
export const MAX_FORMULA_TEXT = 8_192

/**
 * The value written to a cell. `empty` clears the value (the style `s` stays). `f` is a formula (TODO 1212 stage 2): `v` is the form written to the file's `<f>`
 * (no leading `=`, the canonical form with `_xlfn.` attached: the result of `normalizeFormulaInput`). aios does not calculate, so it holds no value.
 */
export type CellValue =
  | { readonly t: 'n'; readonly v: number }
  | { readonly t: 's'; readonly v: string }
  | { readonly t: 'b'; readonly v: boolean }
  | { readonly t: 'f'; readonly v: string }
  | { readonly t: 'empty' }

export interface CellEdit {
  /** Path of the sheet part inside the zip (`xl/worksheets/sheet1.xml`). Not the sheet name (names can change, and duplicates would need handling). */
  readonly sheet: string
  /** `B2` (no `$`, uppercase). */
  readonly ref: string
  readonly value: CellValue
}

/** Reason codes for cells / files that cannot be edited. The viewer turns them into text, and main refuses with `unsupported`. */
export type CellLockReason =
  /**
   * The parent and children of a shared formula (`<f t="shared">`). Rewriting the parent erases the children's formulas, and rewriting a child mixes a different formula
   * into the shared range (`ref`) (unconfirmed whether Excel accepts it). Refused in stage 2 too. A cell with a non-shared formula can be edited in stage 2.
   */
  | 'sharedFormula'
  /** Inside the range of an array formula or data table. */
  | 'arrayFormula'
  /** A merged cell other than the top-left. */
  | 'merged'
  /** The header row of a table (ListObject). If it does not match the column names, Excel asks for repair. */
  | 'tableHeader'
  /** Inside a pivot table's range. */
  | 'pivot'
  /** A cell with a dynamic array or a rich value (the `cm` / `vm` attributes). */
  | 'richValue'
  /** The sheet is protected. */
  | 'protected'
  /** A workbook with a digital signature (`_xmlsignatures/`; rewriting would invalidate the signature). */
  | 'signed'
  /** A workbook with a signed macro (`xl/vbaProjectSignature*.bin`) (`.xlsm`; ARCHITECTURE 7.4.9.1 decided to refuse it in stage 2). */
  | 'signedMacro'

export const CELL_LOCK_REASONS: readonly CellLockReason[] = [
  'sharedFormula',
  'arrayFormula',
  'merged',
  'tableHeader',
  'pivot',
  'richValue',
  'protected',
  'signed',
  'signedMacro'
]

/** Kind of workbook signature (from part names). The document signature is checked first (if both exist, `signed`). */
export function workbookSignature(names: readonly string[]): 'signed' | 'signedMacro' | null {
  if (names.some((name) => /^_xmlsignatures\//i.test(name))) return 'signed'
  if (names.some((name) => /^xl\/vbaProjectSignature[^/]*$/i.test(name))) return 'signedMacro'
  return null
}

// ---- Cell addresses ----

/** 0-based column number -> `A` … `XFD`. */
export function columnName(col: number): string {
  let n = col + 1
  let label = ''
  while (n > 0) {
    const rem = (n - 1) % 26
    label = String.fromCharCode(65 + rem) + label
    n = Math.floor((n - 1) / 26)
  }
  return label
}

/** 0-based (row, column) -> `B2`. */
export function formatRef(row: number, col: number): string {
  return `${columnName(col)}${row + 1}`
}

function columnIndex(letters: string): number {
  let col = 0
  for (const ch of letters.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return col - 1
}

/** `B2` / `$B$2` -> 0-based. null if out of range or the shape is wrong. */
export function parseRef(ref: string): { readonly row: number; readonly col: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?([1-9]\d{0,6})$/.exec(ref)
  if (match === null) return null
  const col = columnIndex(match[1] ?? '')
  const row = Number(match[2]) - 1
  if (col < 0 || col >= MAX_COLUMNS || row < 0 || row >= MAX_ROWS) return null
  return { row, col }
}

/** A range (both ends inclusive, 0-based). */
export interface CellRange {
  readonly r1: number
  readonly c1: number
  readonly r2: number
  readonly c2: number
}

/** `A1:C3` / `A1` -> range (the direction is normalized). null if the shape is wrong. */
export function parseRange(text: string): CellRange | null {
  const [a, b, extra] = text.split(':')
  if (a === undefined || extra !== undefined) return null
  const from = parseRef(a)
  const to = b === undefined ? from : parseRef(b)
  if (from === null || to === null) return null
  return {
    r1: Math.min(from.row, to.row),
    c1: Math.min(from.col, to.col),
    r2: Math.max(from.row, to.row),
    c2: Math.max(from.col, to.col)
  }
}

export function rangeContains(range: CellRange, row: number, col: number): boolean {
  return row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2
}

/** Key of the draft table (sheet part + address). */
export function cellKey(sheet: string, ref: string): string {
  return `${sheet}\n${ref}`
}

// ---- Draft shape ----

function isCellValue(value: unknown): value is CellValue {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  switch (record.t) {
    case 'n':
      return typeof record.v === 'number' && Number.isFinite(record.v)
    case 's':
      return typeof record.v === 'string' && record.v.length <= MAX_CELL_TEXT
    case 'b':
      return typeof record.v === 'boolean'
    case 'f': {
      // A formula accepts only the canonical form (exactly the result of `normalizeFormulaInput`). Main re-checks the shape with this.
      if (typeof record.v !== 'string') return false
      const checked = normalizeFormulaInput(record.v)
      return checked.ok && checked.formula === record.v
    }
    case 'empty':
      return true
    default:
      return false
  }
}

function isSheetPart(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_PART_PATH &&
    value.endsWith('.xml') &&
    !value.startsWith('/') &&
    // Control characters, backslashes and `..` segments are not accepted (it is used only as a name inside the zip, but the shape is narrowed anyway).
    // eslint-disable-next-line no-control-regex -- regular expression for rejecting control characters
    !/[\u0000-\u001f\\]/.test(value) &&
    !value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  )
}

/** Collapse overwrites of the same cell (the last value wins; the order is the order first touched). */
export function collapseCellEdits(edits: readonly CellEdit[]): CellEdit[] {
  const order: string[] = []
  const last = new Map<string, CellEdit>()
  for (const edit of edits) {
    const key = cellKey(edit.sheet, edit.ref)
    if (!last.has(key)) order.push(key)
    last.set(key, edit)
  }
  return order.map((key) => last.get(key) as CellEdit)
}

/** List of edits -> draft string. With no edits, an empty string (same as the base = not dirty). */
export function serializeCellEdits(edits: readonly CellEdit[]): string {
  const collapsed = collapseCellEdits(edits)
  if (collapsed.length === 0) return ''
  return JSON.stringify({
    format: CELL_EDITS_FORMAT,
    edits: collapsed.map((edit) => ({ sheet: edit.sheet, ref: edit.ref, value: edit.value }))
  })
}

/**
 * Draft string -> list of edits (after collapsing). **It comes from the renderer / viewer, so the whole shape is validated**: if even one thing
 * is wrong, null (it never writes only part). An empty string means "no edits" and gives an empty list.
 */
export function parseCellEdits(text: string): CellEdit[] | null {
  if (text === '') return []
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record.format !== CELL_EDITS_FORMAT || !Array.isArray(record.edits)) return null
  const edits: CellEdit[] = []
  for (const item of record.edits as unknown[]) {
    if (typeof item !== 'object' || item === null) return null
    const edit = item as Record<string, unknown>
    if (!isSheetPart(edit.sheet) || typeof edit.ref !== 'string' || !isCellValue(edit.value)) return null
    const at = parseRef(edit.ref)
    if (at === null || edit.ref.includes('$')) return null
    edits.push({ sheet: edit.sheet, ref: formatRef(at.row, at.col), value: edit.value })
  }
  const collapsed = collapseCellEdits(edits)
  if (collapsed.length > MAX_CELL_EDITS) return null
  return collapsed
}

// ---- Formula input (TODO 1212 stage 2) ----

/**
 * Reasons a formula is refused. aios does not calculate formulas, but **if Excel cannot read a formula written to the file it asks for "repair"**,
 * so the shape is checked before writing (this is not a complete parse: a shape that cannot be confirmed is refused).
 */
export type FormulaProblem =
  /** Unbalanced parentheses or quotes, a bad sequence of operators, an unknown character, and the like. */
  | 'formulaSyntax'
  /** Over 8,192 characters. */
  | 'formulaTooLong'
  /**
   * Dynamic array (spill) functions, `LET` / `LAMBDA`, and the `@` / `#` operators. In the file they need metadata (`cm`) and `_xlpm.`
   * names, and written in a plain `<f>` they change meaning or cannot be opened in Excel.
   */
  | 'formulaDynamic'
  /** Structured references (`Table1[...]`), external references (`[1]Sheet1!A1`), 3D references (`Sheet1:Sheet3!A1`), and the intersection (the whitespace operator). */
  | 'formulaUnsupportedRef'
  /** References a sheet name that is not in the workbook (Excel treats it as an external reference). */
  | 'formulaUnknownSheet'
  /**
   * A function not in the allow table (security review of TODO 1212 stage 2). Functions that communicate outward or call outside code (`WEBSERVICE`, `HYPERLINK`,
   * `RTD`, `CALL`, `REGISTER.ID`, `IMAGE`, `STOCKHISTORY` and so on), user-defined functions (`_xludf.`, macros, add-ins), and unknown names.
   */
  | 'formulaFunction'

/**
 * Functions added in Excel 2010 and later (written with `_xlfn.` in the file; without it Excel gives `#NAME?`).
 * Of the "future functions" of MS-XLSX 2.2.2, those that may be written in a plain `<f>` (they do not spill). Functions not in the table are not written
 * (outside `ALLOWED_FUNCTIONS` = `formulaFunction`).
 */
const FUTURE_FUNCTIONS: ReadonlySet<string> = new Set([
  // 2010
  'AGGREGATE', 'BETA.DIST', 'BETA.INV', 'BINOM.DIST', 'BINOM.INV', 'CEILING.PRECISE', 'CHISQ.DIST', 'CHISQ.DIST.RT',
  'CHISQ.INV', 'CHISQ.INV.RT', 'CHISQ.TEST', 'CONFIDENCE.NORM', 'CONFIDENCE.T', 'COVARIANCE.P', 'COVARIANCE.S',
  'ERF.PRECISE', 'ERFC.PRECISE', 'EXPON.DIST', 'F.DIST', 'F.DIST.RT', 'F.INV', 'F.INV.RT', 'F.TEST', 'FLOOR.PRECISE',
  'GAMMA.DIST', 'GAMMA.INV', 'GAMMALN.PRECISE', 'HYPGEOM.DIST', 'LOGNORM.DIST', 'LOGNORM.INV', 'MODE.MULT', 'MODE.SNGL',
  'NEGBINOM.DIST', 'NETWORKDAYS.INTL', 'NORM.DIST', 'NORM.INV', 'NORM.S.DIST', 'NORM.S.INV', 'PERCENTILE.EXC',
  'PERCENTILE.INC', 'PERCENTRANK.EXC', 'PERCENTRANK.INC', 'POISSON.DIST', 'QUARTILE.EXC', 'QUARTILE.INC', 'RANK.AVG',
  'RANK.EQ', 'STDEV.P', 'STDEV.S', 'T.DIST', 'T.DIST.2T', 'T.DIST.RT', 'T.INV', 'T.INV.2T', 'T.TEST', 'VAR.P', 'VAR.S',
  'WEIBULL.DIST', 'WORKDAY.INTL', 'Z.TEST',
  // 2013
  'ACOT', 'ACOTH', 'ARABIC', 'BASE', 'BINOM.DIST.RANGE', 'BITAND', 'BITLSHIFT', 'BITOR', 'BITRSHIFT', 'BITXOR',
  'CEILING.MATH', 'COMBINA', 'COT', 'COTH', 'CSC', 'CSCH', 'DAYS', 'DECIMAL', 'ENCODEURL', 'FILTERXML', 'FLOOR.MATH',
  'FORMULATEXT', 'GAMMA', 'GAUSS', 'IFNA', 'IMCOSH', 'IMCOT', 'IMCSC', 'IMCSCH', 'IMSEC', 'IMSECH', 'IMSINH', 'IMTAN',
  'ISFORMULA', 'ISOWEEKNUM', 'MUNIT', 'NUMBERVALUE', 'PDURATION', 'PERMUTATIONA', 'PHI', 'RRI', 'SEC', 'SECH', 'SHEET',
  'SHEETS', 'SKEW.P', 'UNICHAR', 'UNICODE', 'WEBSERVICE', 'XOR',
  // 2016 / 2019
  'CONCAT', 'FORECAST.ETS', 'FORECAST.ETS.CONFINT', 'FORECAST.ETS.SEASONALITY', 'FORECAST.ETS.STAT', 'FORECAST.LINEAR',
  'IFS', 'MAXIFS', 'MINIFS', 'SWITCH', 'TEXTJOIN',
  // 365 (the ones that do not spill)
  'XLOOKUP', 'XMATCH', 'TEXTBEFORE', 'TEXTAFTER', 'VALUETOTEXT', 'ARRAYTOTEXT', 'ISOMITTED'
])

/**
 * Built-in functions up to Excel 2007 (those that need no prefix in the file). Material for the **allow table** (`ALLOWED_FUNCTIONS`);
 * those that communicate outward or call outside code (`HYPERLINK`, `RTD`, `CALL`, `REGISTER.ID`, `SQL.REQUEST`, `EUROCONVERT`) are not listed.
 */
const LEGACY_FUNCTIONS: readonly string[] = [
  'ABS', 'ACCRINT', 'ACCRINTM', 'ACOS', 'ACOSH', 'ADDRESS', 'AMORDEGRC', 'AMORLINC', 'AND', 'AREAS', 'ASC', 'ASIN', 'ASINH',
  'ATAN', 'ATAN2', 'ATANH', 'AVEDEV', 'AVERAGE', 'AVERAGEA', 'AVERAGEIF', 'AVERAGEIFS', 'BAHTTEXT', 'BESSELI', 'BESSELJ',
  'BESSELK', 'BESSELY', 'BETADIST', 'BETAINV', 'BIN2DEC', 'BIN2HEX', 'BIN2OCT', 'BINOMDIST', 'CEILING', 'CELL', 'CHAR',
  'CHIDIST', 'CHIINV', 'CHITEST', 'CHOOSE', 'CLEAN', 'CODE', 'COLUMN', 'COLUMNS', 'COMBIN', 'COMPLEX', 'CONCATENATE',
  'CONFIDENCE', 'CONVERT', 'CORREL', 'COS', 'COSH', 'COUNT', 'COUNTA', 'COUNTBLANK', 'COUNTIF', 'COUNTIFS', 'COUPDAYBS',
  'COUPDAYS', 'COUPDAYSNC', 'COUPNCD', 'COUPNUM', 'COUPPCD', 'COVAR', 'CRITBINOM', 'CUMIPMT', 'CUMPRINC', 'DATE', 'DATEDIF',
  'DATEVALUE', 'DAVERAGE', 'DAY', 'DAYS360', 'DB', 'DCOUNT', 'DCOUNTA', 'DDB', 'DEC2BIN', 'DEC2HEX', 'DEC2OCT', 'DEGREES',
  'DELTA', 'DEVSQ', 'DGET', 'DISC', 'DMAX', 'DMIN', 'DOLLAR', 'DOLLARDE', 'DOLLARFR', 'DPRODUCT', 'DSTDEV', 'DSTDEVP', 'DSUM',
  'DURATION', 'DVAR', 'DVARP', 'EDATE', 'EFFECT', 'EOMONTH', 'ERF', 'ERFC', 'ERROR.TYPE', 'EVEN', 'EXACT', 'EXP', 'EXPONDIST',
  'FACT', 'FACTDOUBLE', 'FALSE', 'FDIST', 'FIND', 'FINDB', 'FINV', 'FISHER', 'FISHERINV', 'FIXED', 'FLOOR', 'FORECAST',
  'FREQUENCY', 'FTEST', 'FV', 'FVSCHEDULE', 'GAMMADIST', 'GAMMAINV', 'GAMMALN', 'GCD', 'GEOMEAN', 'GESTEP', 'GETPIVOTDATA',
  'GROWTH', 'HARMEAN', 'HEX2BIN', 'HEX2DEC', 'HEX2OCT', 'HLOOKUP', 'HOUR', 'HYPGEOMDIST', 'IF', 'IFERROR', 'IMABS',
  'IMAGINARY', 'IMARGUMENT', 'IMCONJUGATE', 'IMCOS', 'IMDIV', 'IMEXP', 'IMLN', 'IMLOG10', 'IMLOG2', 'IMPOWER', 'IMPRODUCT',
  'IMREAL', 'IMSIN', 'IMSQRT', 'IMSUB', 'IMSUM', 'INDEX', 'INDIRECT', 'INFO', 'INT', 'INTERCEPT', 'INTRATE', 'IPMT', 'IRR',
  'ISBLANK', 'ISERR', 'ISERROR', 'ISEVEN', 'ISLOGICAL', 'ISNA', 'ISNONTEXT', 'ISNUMBER', 'ISODD', 'ISPMT', 'ISREF', 'ISTEXT',
  'JIS', 'KURT', 'LARGE', 'LCM', 'LEFT', 'LEFTB', 'LEN', 'LENB', 'LINEST', 'LN', 'LOG', 'LOG10', 'LOGEST', 'LOGINV',
  'LOGNORMDIST', 'LOOKUP', 'LOWER', 'MATCH', 'MAX', 'MAXA', 'MDETERM', 'MDURATION', 'MEDIAN', 'MID', 'MIDB', 'MIN', 'MINA',
  'MINUTE', 'MINVERSE', 'MIRR', 'MMULT', 'MOD', 'MODE', 'MONTH', 'MROUND', 'MULTINOMIAL', 'N', 'NA', 'NEGBINOMDIST',
  'NETWORKDAYS', 'NOMINAL', 'NORMDIST', 'NORMINV', 'NORMSDIST', 'NORMSINV', 'NOT', 'NOW', 'NPER', 'NPV', 'OCT2BIN',
  'OCT2DEC', 'OCT2HEX', 'ODD', 'ODDFPRICE', 'ODDFYIELD', 'ODDLPRICE', 'ODDLYIELD', 'OFFSET', 'OR', 'PEARSON', 'PERCENTILE',
  'PERCENTRANK', 'PERMUT', 'PHONETIC', 'PI', 'PMT', 'POISSON', 'POWER', 'PPMT', 'PRICE', 'PRICEDISC', 'PRICEMAT', 'PROB',
  'PRODUCT', 'PROPER', 'PV', 'QUARTILE', 'QUOTIENT', 'RADIANS', 'RAND', 'RANDBETWEEN', 'RANK', 'RATE', 'RECEIVED',
  'REPLACE', 'REPLACEB', 'REPT', 'RIGHT', 'RIGHTB', 'ROMAN', 'ROUND', 'ROUNDDOWN', 'ROUNDUP', 'ROW', 'ROWS', 'RSQ', 'SEARCH',
  'SEARCHB', 'SECOND', 'SERIESSUM', 'SIGN', 'SIN', 'SINH', 'SKEW', 'SLN', 'SLOPE', 'SMALL', 'SQRT', 'SQRTPI', 'STANDARDIZE',
  'STDEV', 'STDEVA', 'STDEVP', 'STDEVPA', 'STEYX', 'SUBSTITUTE', 'SUBTOTAL', 'SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'SUMSQ',
  'SUMX2MY2', 'SUMX2PY2', 'SUMXMY2', 'SYD', 'T', 'TAN', 'TANH', 'TBILLEQ', 'TBILLPRICE', 'TBILLYIELD', 'TDIST', 'TEXT',
  'TIME', 'TIMEVALUE', 'TINV', 'TODAY', 'TRANSPOSE', 'TREND', 'TRIM', 'TRIMMEAN', 'TRUE', 'TRUNC', 'TTEST', 'TYPE', 'UPPER',
  'USDOLLAR', 'VALUE', 'VAR', 'VARA', 'VARP', 'VARPA', 'VDB', 'VLOOKUP', 'WEEKDAY', 'WEEKNUM', 'WEIBULL', 'WORKDAY', 'XIRR',
  'XNPV', 'YEAR', 'YEARFRAC', 'YIELD', 'YIELDDISC', 'YIELDMAT', 'ZTEST'
]

/**
 * Built-in functions that, when Excel evaluates them, communicate outward or call outside code. Removed from the allow table even if
 * they are in the 2010-and-later table (`FUTURE_FUNCTIONS`) (those not in any table, such as `IMAGE`, `STOCKHISTORY`, `RTD` and `CALL`, never pass in the first place).
 */
const DENIED_FUNCTIONS: ReadonlySet<string> = new Set(['WEBSERVICE'])

/**
 * **The allow table of functions that may be written in a formula** (security review of TODO 1212 stage 2). The viewer is inside a sandbox and outside the trust boundary, so
 * the functions written from a draft into the user's file are narrowed in main (`parseCellEdits` -> `normalizeFormulaInput`). Unknown names are refused.
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set(
  [...LEGACY_FUNCTIONS, ...FUTURE_FUNCTIONS].filter((name) => !DENIED_FUNCTIONS.has(name))
)

/** Functions that return a dynamic array (spill), and functions that create `_xlpm.` names. Refused in stage 2 (`formulaDynamic`). */
const DYNAMIC_FUNCTIONS: ReadonlySet<string> = new Set([
  'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'RANDARRAY', 'TEXTSPLIT', 'VSTACK', 'HSTACK', 'TOCOL', 'TOROW',
  'WRAPROWS', 'WRAPCOLS', 'TAKE', 'DROP', 'CHOOSEROWS', 'CHOOSECOLS', 'EXPAND', 'GROUPBY', 'PIVOTBY', 'TRIMRANGE',
  'LET', 'LAMBDA', 'MAP', 'REDUCE', 'SCAN', 'MAKEARRAY', 'BYROW', 'BYCOL', 'ANCHORARRAY', 'SINGLE'
])

const ERROR_LITERAL = /^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA)/i
const WORD_CHAR = /[A-Za-z0-9_.$\\?À-￿]/
const CELL_WORD = /^\$?[A-Za-z]{1,3}\$?[1-9]\d{0,6}$/
const COLUMN_WORD = /^\$?[A-Za-z]{1,3}$/
const ROW_WORD = /^\$?[1-9]\d{0,6}$/
/** Sheet names that cannot be written without quotes (Excel quotes them as `'2024'!B2` / `'A1'!B2` / `'R1C1'!B2`): ones that start with a digit, look like a cell address, or look like R1C1. */
const NEEDS_QUOTES = /^(\d|\$?[A-Za-z]{1,3}\$?\d+$|[Rr]\d*[Cc]\d*$|[RrCc]$)/
const NUMBER_WORD = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

type FormulaTokenKind = 'str' | 'qname' | 'word' | 'err' | 'op' | 'open' | 'close' | 'comma' | 'semicolon' | 'bang' | 'colon' | 'lbrace' | 'rbrace' | 'space'

interface FormulaToken {
  readonly kind: FormulaTokenKind
  readonly text: string
}

class FormulaRejected extends Error {
  constructor(readonly reason: FormulaProblem) {
    super(reason)
  }
}

function tokenizeFormula(formula: string): FormulaToken[] {
  const tokens: FormulaToken[] = []
  let i = 0
  const n = formula.length
  while (i < n) {
    const ch = formula[i] ?? ''
    // eslint-disable-next-line no-control-regex -- regular expression for rejecting control characters
    if (/[\u0000-\u001f\u007f]/.test(ch)) throw new FormulaRejected('formulaSyntax')
    if (ch === '"' || ch === "'") {
      let j = i + 1
      for (;;) {
        if (j >= n) throw new FormulaRejected('formulaSyntax')
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) j += 2
          else break
        } else j++
      }
      tokens.push({ kind: ch === '"' ? 'str' : 'qname', text: formula.slice(i, j + 1) })
      i = j + 1
      continue
    }
    if (ch === ' ') {
      let j = i
      while (formula[j] === ' ') j++
      tokens.push({ kind: 'space', text: formula.slice(i, j) })
      i = j
      continue
    }
    if (ch === '[' || ch === ']') throw new FormulaRejected('formulaUnsupportedRef')
    if (ch === '@') throw new FormulaRejected('formulaDynamic')
    if (ch === '#') {
      const match = ERROR_LITERAL.exec(formula.slice(i))
      // `A1#` (a spill reference) and unknown error constants.
      if (match === null) throw new FormulaRejected('formulaDynamic')
      tokens.push({ kind: 'err', text: match[0].toUpperCase() })
      i += match[0].length
      continue
    }
    const single: Partial<Record<string, FormulaTokenKind>> = {
      '(': 'open',
      ')': 'close',
      ',': 'comma',
      ';': 'semicolon',
      '!': 'bang',
      ':': 'colon',
      '{': 'lbrace',
      '}': 'rbrace'
    }
    const kind = single[ch]
    if (kind !== undefined) {
      tokens.push({ kind, text: ch })
      i++
      continue
    }
    if (ch === '<' || ch === '>') {
      const two = formula.slice(i, i + 2)
      const op = two === '<=' || two === '>=' || two === '<>' ? two : ch
      tokens.push({ kind: 'op', text: op })
      i += op.length
      continue
    }
    if ('+-*/^&=%'.includes(ch)) {
      tokens.push({ kind: 'op', text: ch })
      i++
      continue
    }
    if (WORD_CHAR.test(ch)) {
      let j = i
      while (j < n && WORD_CHAR.test(formula[j] ?? '')) j++
      // The exponent of `1E+3`.
      if (/^(?:\d+(?:\.\d*)?|\.\d+)[eE]$/.test(formula.slice(i, j)) && /[+-]/.test(formula[j] ?? '') && /\d/.test(formula[j + 1] ?? '')) {
        j += 2
        while (j < n && /\d/.test(formula[j] ?? '')) j++
      }
      tokens.push({ kind: 'word', text: formula.slice(i, j) })
      i = j
      continue
    }
    throw new FormulaRejected('formulaSyntax')
  }
  return tokens
}

/** The uppercase name of a function with `_xlfn.` / `_xlws.` removed. */
function bareFunctionName(word: string): string {
  let name = word
  for (;;) {
    const next = name.replace(/^_xlfn\./i, '').replace(/^_xlws\./i, '')
    if (next === name) break
    name = next
  }
  return name.toUpperCase()
}

export type FormulaCheck =
  | { readonly ok: true; readonly formula: string; readonly sheets: readonly string[] }
  | { readonly ok: false; readonly reason: FormulaProblem }

/**
 * A formula the user typed (the rest after the leading `=`) -> the canonical form written to the file's `<f>`.
 * - Function names, cell addresses and `TRUE` / `FALSE` become uppercase, and functions of 2010 and later get `_xlfn.` (the inverse of `displayFormula`).
 * - Shape check: balanced parentheses, quotes and array constants, the sequence of operators and operands, argument separators.
 * - `sheets` is the sheet names referenced (quotes removed). Whether they exist in the workbook is checked by the caller (`formulaUnknownSheet`).
 */
export function normalizeFormulaInput(input: string): FormulaCheck {
  if (input.length > MAX_FORMULA_TEXT) return { ok: false, reason: 'formulaTooLong' }
  try {
    const tokens = tokenizeFormula(input)
    const out: string[] = []
    const sheets: string[] = []
    /** Kind of each open parenthesis (a function call, or a plain parenthesis). */
    const stack: ('call' | 'group')[] = []
    let expectOperand = true
    /** The previous non-whitespace token (for deciding an empty argument). */
    let previous: FormulaTokenKind | null = null
    /** There was whitespace just before (operands separated by whitespace = the intersection operator). */
    let sawSpace = false
    const at = (k: number): FormulaToken | undefined => tokens[k]
    const fail = (reason: FormulaProblem = 'formulaSyntax'): never => {
      throw new FormulaRejected(reason)
    }
    const operand = (): void => {
      if (!expectOperand) fail(sawSpace ? 'formulaUnsupportedRef' : 'formulaSyntax')
      expectOperand = false
    }
    for (let k = 0; k < tokens.length; k++) {
      const token = at(k) as FormulaToken
      switch (token.kind) {
        case 'space':
          out.push(token.text)
          sawSpace = true
          continue
        case 'str':
        case 'err':
          operand()
          out.push(token.text)
          break
        case 'qname':
        case 'word': {
          const next = at(k + 1)
          if (next?.kind === 'bang') {
            // A sheet name prefix (`Sheet1!` / `'My Sheet'!`). What follows is a reference (a word or `#REF!`).
            const name = token.kind === 'qname' ? token.text.slice(1, -1).replace(/''/g, "'") : token.text
            if (name === '' || name.includes(':')) fail('formulaUnsupportedRef')
            // If an unquoted name is of a form that needs quotes (starts with a digit, `A1` / `R1C1`, etc.), refuse it (a quoted one passes). The user fixes it and writes again.
            if (token.kind === 'word' && NEEDS_QUOTES.test(name)) fail()
            // Only one prefix (`A1!B1!C1` is malformed).
            if (previous === 'bang') fail()
            // `Sheet1:Sheet3!A1` (a 3D reference): the previous is `:` and the one before it is a word.
            if (at(k - 1)?.kind === 'colon') fail('formulaUnsupportedRef')
            const target = at(k + 2)
            if (target?.kind !== 'word' && target?.kind !== 'err') fail()
            if (target?.kind === 'word' && !(CELL_WORD.test(target.text) || COLUMN_WORD.test(target.text) || ROW_WORD.test(target.text))) {
              // A defined name on a sheet (`Sheet1!` followed by a name) passes (a form Excel can read). A name starting with a digit is refused.
              if (/^\d/.test(target.text)) fail()
            }
            sheets.push(name)
            out.push(token.text, '!')
            k++
            previous = 'bang'
            sawSpace = false
            continue
          }
          if (token.kind === 'qname') fail()
          if (next?.kind === 'open') {
            // A function call.
            operand()
            expectOperand = true
            if (/_xlpm\./i.test(token.text)) fail('formulaDynamic')
            // User-defined functions (`_xludf.`, macros, add-ins) are not written (outside the allow table; `formulaFunction` below).
            if (/^_xludf\./i.test(token.text)) fail('formulaFunction')
            const bare = bareFunctionName(token.text)
            if (!/^[A-Z][A-Z0-9_.]*$/.test(bare)) fail()
            if (DYNAMIC_FUNCTIONS.has(bare)) fail('formulaDynamic')
            // Function names are limited to the allow table (the built-in functions minus those that communicate outward or call outside code).
            if (!ALLOWED_FUNCTIONS.has(bare)) fail('formulaFunction')
            out.push(FUTURE_FUNCTIONS.has(bare) ? `_xlfn.${bare}` : bare)
            out.push('(')
            stack.push('call')
            k++
            previous = 'open'
            sawSpace = false
            continue
          }
          const text = token.text
          const nearColon = at(k + 1)?.kind === 'colon' || at(k - 1)?.kind === 'colon'
          if (NUMBER_WORD.test(text)) {
            operand()
            // A piece of a row range (`1:3`) need not be uppercased, so it stays as is.
            out.push(text)
          } else if (CELL_WORD.test(text) || (nearColon && (COLUMN_WORD.test(text) || ROW_WORD.test(text)))) {
            if (at(k - 1)?.kind === 'colon') {
              // The trailing piece of a range (`B2` of `A1:B2`). The `:` operator is making an operand wait.
              if (!expectOperand) fail()
            }
            operand()
            out.push(text.toUpperCase())
          } else if (/^(?:TRUE|FALSE)$/i.test(text)) {
            operand()
            out.push(text.toUpperCase())
          } else {
            // A defined name. A name starting with a digit or a name of only `.` cannot be created in Excel.
            if (/^[\d.]/.test(text)) fail()
            operand()
            out.push(text)
          }
          break
        }
        case 'bang':
          // A `!` outside a prefix.
          fail()
          break
        case 'colon':
          // The range operator (`A1:B2`). Before and after are references (words uppercased above).
          if (expectOperand || at(k + 1)?.kind !== 'word') fail()
          expectOperand = true
          out.push(':')
          break
        case 'op':
          if (token.text === '%') {
            if (expectOperand) fail()
          } else if (expectOperand) {
            if (token.text !== '+' && token.text !== '-') fail()
          } else expectOperand = true
          out.push(token.text)
          break
        case 'open':
          if (!expectOperand) fail()
          stack.push('group')
          out.push('(')
          break
        case 'close': {
          const top = stack.pop()
          if (top === undefined) fail()
          if (expectOperand) {
            // An empty argument (`NOW()` / `IF(A1,,)`) is allowed only inside a function call.
            if (top !== 'call' || (previous !== 'open' && previous !== 'comma')) fail()
          }
          expectOperand = false
          out.push(')')
          break
        }
        case 'comma': {
          const top = stack[stack.length - 1]
          // A top-level `,` (the union operator) is not accepted by Excel as a formula. A union inside parentheses comes only after an operand.
          if (top === undefined) fail()
          if (top === 'group' && expectOperand) fail()
          expectOperand = true
          out.push(',')
          break
        }
        case 'lbrace': {
          // An array constant (`{1,2;3,4}`). Only constants, `,`, `;` and signs are allowed inside.
          operand()
          let j = k + 1
          let body = '{'
          let wantValue = true
          for (; j < tokens.length; j++) {
            const inner = at(j) as FormulaToken
            if (inner.kind === 'rbrace') break
            if (inner.kind === 'space') continue
            if (inner.kind === 'comma' || inner.kind === 'semicolon') {
              if (wantValue) fail()
              wantValue = true
              body += inner.text
              continue
            }
            if (inner.kind === 'op' && (inner.text === '-' || inner.text === '+') && wantValue) {
              body += inner.text
              continue
            }
            if (!wantValue) fail()
            if (inner.kind === 'str' || inner.kind === 'err') body += inner.text
            else if (inner.kind === 'word' && (NUMBER_WORD.test(inner.text) || /^(?:TRUE|FALSE)$/i.test(inner.text))) body += inner.text.toUpperCase()
            else fail()
            wantValue = false
          }
          if (j >= tokens.length || wantValue) fail()
          out.push(`${body}}`)
          k = j
          previous = 'rbrace'
          sawSpace = false
          continue
        }
        case 'rbrace':
        case 'semicolon':
          fail()
          break
      }
      previous = token.kind
      sawSpace = false
    }
    if (stack.length > 0 || expectOperand) fail()
    const formula = out.join('').trim()
    if (formula === '') fail()
    return { ok: true, formula, sheets }
  } catch (err) {
    if (err instanceof FormulaRejected) return { ok: false, reason: err.reason }
    throw err
  }
}

/**
 * The file's `<f>` expression -> the form shown on screen (formula bar, input field). Remove `_xlfn.` (and `_xlws.`) of the 2010-and-later functions in the table
 * (`normalizeFormulaInput` puts them back). Prefixes of names not in the table are kept (removing them would give `#NAME?` on write-back).
 * The inside of strings and quoted sheet names is not touched.
 */
export function displayFormula(formula: string): string {
  let out = ''
  let i = 0
  const n = formula.length
  while (i < n) {
    const ch = formula[i] ?? ''
    if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < n) {
        if (formula[j] === ch) {
          if (formula[j + 1] === ch) j += 2
          else break
        } else j++
      }
      out += formula.slice(i, j + 1)
      i = j + 1
      continue
    }
    if (WORD_CHAR.test(ch)) {
      let j = i
      while (j < n && WORD_CHAR.test(formula[j] ?? '')) j++
      const word = formula.slice(i, j)
      const bare = bareFunctionName(word)
      const prefixed = /^_xl(?:fn|ws)\./i.test(word)
      out += prefixed && formula[j] === '(' && (FUTURE_FUNCTIONS.has(bare) || DYNAMIC_FUNCTIONS.has(bare)) ? bare : word
      i = j
      continue
    }
    out += ch
    i++
  }
  return out
}

/** Look up a sheet name in the workbook (case-insensitive, as in Excel). */
export function unknownSheetIn(sheets: readonly string[], known: readonly string[]): boolean {
  const names = new Set(known.map((name) => name.toLowerCase()))
  return sheets.some((sheet) => !names.has(sheet.toLowerCase()))
}

// ---- Interpreting input ----

export type CellInputResult =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly reason: 'tooLong' | FormulaProblem }

const NUMBER_INPUT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/
const DATE_INPUT = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
const TIME_INPUT = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/

/**
 * Date and time (UTC wall-clock components) -> Excel serial number. The inverse of `excelSerialToDate` in `aios.office`
 * (the 1900 system's "1900-02-29" error is absorbed from March on, the same treatment as in display).
 */
export function dateToSerial(
  parts: { readonly year: number; readonly month: number; readonly day: number; readonly hour?: number; readonly minute?: number; readonly second?: number },
  date1904: boolean
): number | null {
  const { year, month, day } = parts
  const hour = parts.hour ?? 0
  const minute = parts.minute ?? 0
  const second = parts.second ?? 0
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  const check = new Date(ms)
  // Do not accept a date such as February 30 by rolling it over.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null
  const days = ms / 86_400_000 + 25_569
  const serial = date1904 ? days - 1462 : days
  return serial < 0 ? null : serial
}

/**
 * The user's input -> a cell value (a small subset of how Excel interprets input).
 *
 * - Empty -> clear the value.
 * - Starts with `'` -> the rest stays a string (the same escape as in Excel).
 * - Starts with `=` -> a formula (stage 2). The shape is checked with `normalizeFormulaInput` and made canonical, and a reference to a sheet not in `sheetNames` is refused.
 * - `TRUE` / `FALSE` (case-insensitive) -> boolean.
 * - A number shape (`12` / `-3.5` / `1e3`) -> number. Digit grouping, `%` and currency are not interpreted (a format cannot be added, so they stay strings).
 * - In a date-formatted cell (`date`), `2026-11-13` / `2026/11/13 9:30` / `9:30` -> serial number.
 * - Anything else -> string.
 */
export function parseCellInput(
  text: string,
  options: { readonly date: boolean; readonly date1904: boolean; readonly sheetNames: readonly string[] }
): CellInputResult {
  if (text.startsWith('=')) {
    const checked = normalizeFormulaInput(text.slice(1))
    if (!checked.ok) return checked
    if (unknownSheetIn(checked.sheets, options.sheetNames)) return { ok: false, reason: 'formulaUnknownSheet' }
    return { ok: true, value: { t: 'f', v: checked.formula } }
  }
  if (text.length > MAX_CELL_TEXT) return { ok: false, reason: 'tooLong' }
  if (text === '') return { ok: true, value: { t: 'empty' } }
  if (text.startsWith("'")) return { ok: true, value: { t: 's', v: text.slice(1) } }
  const trimmed = text.trim()
  if (/^true$/i.test(trimmed)) return { ok: true, value: { t: 'b', v: true } }
  if (/^false$/i.test(trimmed)) return { ok: true, value: { t: 'b', v: false } }
  if (NUMBER_INPUT.test(trimmed)) {
    const n = Number(trimmed)
    if (Number.isFinite(n)) return { ok: true, value: { t: 'n', v: n } }
  }
  if (options.date) {
    const date = DATE_INPUT.exec(trimmed)
    if (date !== null) {
      const serial = dateToSerial(
        {
          year: Number(date[1]),
          month: Number(date[2]),
          day: Number(date[3]),
          hour: date[4] === undefined ? 0 : Number(date[4]),
          minute: date[5] === undefined ? 0 : Number(date[5]),
          second: date[6] === undefined ? 0 : Number(date[6])
        },
        options.date1904
      )
      if (serial !== null) return { ok: true, value: { t: 'n', v: serial } }
    }
    const time = TIME_INPUT.exec(trimmed)
    if (time !== null) {
      const hour = Number(time[1])
      const minute = Number(time[2])
      const second = time[3] === undefined ? 0 : Number(time[3])
      if (hour <= 23 && minute <= 59 && second <= 59) {
        return { ok: true, value: { t: 'n', v: (hour * 3600 + minute * 60 + second) / 86_400 } }
      }
    }
  }
  return { ok: true, value: { t: 's', v: text } }
}

// ---- Formula references ----

/** One reference inside a formula. `sheet` is the sheet name as written (the formula's own sheet if absent). `abs*` is whether there is a `$`. */
export interface FormulaRef {
  readonly sheet: string | null
  readonly range: CellRange
  readonly absRow1: boolean
  readonly absCol1: boolean
  readonly absRow2: boolean
  readonly absCol2: boolean
}

export interface FormulaReferences {
  readonly refs: readonly FormulaRef[]
  /** There is a reference that cannot be read (a defined name, a structured reference, an external reference, a 3D reference, INDIRECT / OFFSET and the like). */
  readonly opaque: boolean
}

/** Functions that build a reference (the target is decided by the contents). If one is present, treat it as an unreadable reference. */
const DYNAMIC_REFERENCE_FUNCTIONS = new Set(['INDIRECT', 'OFFSET', 'INDEX', 'CHOOSE', 'XLOOKUP', 'LET', 'LAMBDA'])

interface RefToken {
  readonly row: number | null
  readonly col: number | null
  readonly absRow: boolean
  readonly absCol: boolean
}

/** One part of `$B$2` / `B` / `2`. */
function refToken(text: string): RefToken | null {
  const cell = /^(\$?)([A-Za-z]{1,3})(\$?)([1-9]\d{0,6})$/.exec(text)
  if (cell !== null) {
    const col = columnIndex(cell[2] ?? '')
    const row = Number(cell[4]) - 1
    if (col >= MAX_COLUMNS || row >= MAX_ROWS) return null
    return { col, row, absCol: cell[1] === '$', absRow: cell[3] === '$' }
  }
  const column = /^(\$?)([A-Za-z]{1,3})$/.exec(text)
  if (column !== null) {
    const col = columnIndex(column[2] ?? '')
    if (col >= MAX_COLUMNS) return null
    return { col, row: null, absCol: column[1] === '$', absRow: true }
  }
  const row = /^(\$?)([1-9]\d{0,6})$/.exec(text)
  if (row !== null) {
    const r = Number(row[2]) - 1
    if (r >= MAX_ROWS) return null
    return { col: null, row: r, absCol: true, absRow: row[1] === '$' }
  }
  return null
}

function tokensToRef(sheet: string | null, a: RefToken, b: RefToken): FormulaRef | null {
  // `A:A` (whole column) / `1:1` (whole row) / `A1:B2`. If the shape is mixed, such as only one side lacking a row, it cannot be read.
  if ((a.row === null) !== (b.row === null) || (a.col === null) !== (b.col === null)) return null
  const r1 = a.row ?? 0
  const r2 = b.row ?? MAX_ROWS - 1
  const c1 = a.col ?? 0
  const c2 = b.col ?? MAX_COLUMNS - 1
  return {
    sheet,
    range: { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) },
    absRow1: a.absRow,
    absCol1: a.absCol,
    absRow2: b.absRow,
    absCol2: b.absCol
  }
}

const IDENT_CHAR = /[A-Za-z0-9_.$À-￿]/

/**
 * Pick up the references of a formula (no leading `=`, the contents of the file's `<f>`). This is not a complete parse: what cannot be picked up is `opaque`.
 */
export function formulaReferences(formula: string): FormulaReferences {
  const refs: FormulaRef[] = []
  let opaque = false
  let i = 0
  const n = formula.length
  /** The sheet name written before the reference being read. */
  let sheet: string | null = null

  const readIdent = (): string => {
    const start = i
    while (i < n && IDENT_CHAR.test(formula[i] ?? '')) i++
    return formula.slice(start, i)
  }

  /** If `:part` follows `first`, make it a range and add it to the references. */
  const finishRef = (first: string): void => {
    const a = refToken(first)
    let b = a
    if (formula[i] === ':') {
      const save = i
      i++
      const second = readIdent()
      const tb = refToken(second)
      if (tb === null) {
        // `Sheet1:Sheet3!A1` (a 3D reference) or an unreadable form.
        i = save
        opaque = true
        return
      }
      b = tb
    }
    if (a === null || b === null) {
      opaque = true
      return
    }
    const ref = tokensToRef(sheet, a, b)
    if (ref === null) opaque = true
    else refs.push(ref)
  }

  while (i < n) {
    const ch = formula[i] ?? ''
    if (ch === '"') {
      // A string constant (`""` is a quote inside it).
      i++
      while (i < n) {
        if (formula[i] === '"') {
          if (formula[i + 1] === '"') i += 2
          else {
            i++
            break
          }
        } else i++
      }
      continue
    }
    if (ch === '[' || ch === '{') {
      // A structured reference (`Table1[Col]`), an external reference (`[1]Sheet!A1`), an array constant (`{1,2}`: not a reference, but its inside is skipped).
      if (ch === '[') opaque = true
      const close = ch === '[' ? ']' : '}'
      let depth = 0
      while (i < n) {
        if (formula[i] === ch) depth++
        else if (formula[i] === close) {
          depth--
          if (depth === 0) {
            i++
            break
          }
        }
        i++
      }
      continue
    }
    if (ch === "'") {
      // `'My Sheet'!A1`
      i++
      let name = ''
      while (i < n) {
        if (formula[i] === "'") {
          if (formula[i + 1] === "'") {
            name += "'"
            i += 2
          } else {
            i++
            break
          }
        } else {
          name += formula[i]
          i++
        }
      }
      if (formula[i] !== '!') {
        opaque = true
        continue
      }
      i++
      sheet = name
      const first = readIdent()
      finishRef(first)
      sheet = null
      continue
    }
    if (IDENT_CHAR.test(ch)) {
      const start = i
      if (/[0-9.]/.test(ch)) {
        // A numeric constant or a row range (`1:3`).
        while (i < n && /[0-9.]/.test(formula[i] ?? '')) i++
        if (/[eE]/.test(formula[i] ?? '') && /[+\-0-9]/.test(formula[i + 1] ?? '')) {
          i += 2
          while (i < n && /[0-9]/.test(formula[i] ?? '')) i++
        }
        const text = formula.slice(start, i)
        if (IDENT_CHAR.test(formula[i] ?? '')) {
          // A sheet name that starts with digits (for example a year followed by a non-ASCII suffix, then `!A1`).
          i = start
          const ident = readIdent()
          if (formula[i] === '!') {
            i++
            sheet = ident
            finishRef(readIdent())
            sheet = null
          } else opaque = true
          continue
        }
        if (formula[i] === '!' && /^\d+$/.test(text)) {
          i++
          sheet = text
          finishRef(readIdent())
          sheet = null
          continue
        }
        if (formula[i] === ':' && /^\d+$/.test(text)) finishRef(text)
        continue
      }
      const ident = readIdent()
      if (formula[i] === '!') {
        i++
        sheet = ident
        finishRef(readIdent())
        sheet = null
        continue
      }
      if (formula[i] === '(') {
        // A function. A function that builds a reference is an unreadable reference. `_xlfn.` before the name is removed.
        const name = ident.replace(/^_xlfn\./i, '').replace(/^_xlws\./i, '').toUpperCase()
        if (DYNAMIC_REFERENCE_FUNCTIONS.has(name)) opaque = true
        continue
      }
      if (formula[i] === ':' && refToken(ident) !== null) {
        finishRef(ident)
        continue
      }
      if (refToken(ident) !== null && /\d$/.test(ident)) {
        finishRef(ident)
        continue
      }
      const upper = ident.toUpperCase()
      if (upper === 'TRUE' || upper === 'FALSE') continue
      // A defined name (or something that cannot be picked up).
      opaque = true
      continue
    }
    if (ch === '#') {
      // An error constant (`#REF!` / `#N/A`). `#REF!` means the reference is broken.
      const match = /^#[A-Z0-9/]+[!?]?/i.exec(formula.slice(i))
      i += match === null ? 1 : match[0].length
      continue
    }
    i++
  }
  return { refs, opaque }
}

/**
 * References of a shared formula's child (`<f t="shared" si="0"/>`): move the parent formula's references by the row and column offset from the parent (parts with `$` do not move).
 * Those that go outside the range are dropped (they are `#REF!` in Excel).
 */
export function shiftReferences(refs: readonly FormulaRef[], dRow: number, dCol: number): FormulaRef[] {
  const out: FormulaRef[] = []
  for (const ref of refs) {
    const wholeRows = ref.range.r1 === 0 && ref.range.r2 === MAX_ROWS - 1
    const wholeCols = ref.range.c1 === 0 && ref.range.c2 === MAX_COLUMNS - 1
    const r1 = ref.absRow1 || wholeRows ? ref.range.r1 : ref.range.r1 + dRow
    const r2 = ref.absRow2 || wholeRows ? ref.range.r2 : ref.range.r2 + dRow
    const c1 = ref.absCol1 || wholeCols ? ref.range.c1 : ref.range.c1 + dCol
    const c2 = ref.absCol2 || wholeCols ? ref.range.c2 : ref.range.c2 + dCol
    if (r1 < 0 || c1 < 0 || r2 >= MAX_ROWS || c2 >= MAX_COLUMNS) continue
    out.push({ ...ref, range: { r1: Math.min(r1, r2), c1: Math.min(c1, c2), r2: Math.max(r1, r2), c2: Math.max(c1, c2) } })
  }
  return out
}

/** One formula cell, as material for finding stale values. `sheet` is the sheet name (compared case-insensitively). */
export interface FormulaCell {
  readonly sheet: string
  readonly row: number
  readonly col: number
  readonly refs: readonly FormulaRef[]
  readonly opaque: boolean
}

/** A cell whose value changed (sheet name + position). */
export interface ChangedCell {
  readonly sheet: string
  readonly row: number
  readonly col: number
}

function sheetKey(name: string): string {
  return name.toLowerCase()
}

/** The key returned in the `formulaCellKey` form (the sheet name is lowercase). */
export function formulaCellKey(sheet: string, row: number, col: number): string {
  return `${sheetKey(sheet)}\n${row}\n${col}`
}

/**
 * Formula cells that depend (directly or indirectly) on a cell whose value changed = the cells that get the "stale value" mark. aios does not calculate, so
 * it only shows that the cached value (`<v>`) has gone stale (Excel recalculates on open: `fullCalcOnLoad`).
 * A formula with an unreadable reference counts as stale if even one cell changed.
 */
export function staleFormulaCells(formulas: readonly FormulaCell[], changed: readonly ChangedCell[]): Set<string> {
  const stale = new Set<string>()
  if (changed.length === 0) return stale
  /** Positions of what has "changed" now (per sheet). Formula cells that became stale also count as changed in the next round. */
  let frontier: ChangedCell[] = [...changed]
  const pending = formulas.filter((cell) => {
    if (cell.opaque) {
      stale.add(formulaCellKey(cell.sheet, cell.row, cell.col))
      return false
    }
    return true
  })
  // A formula made stale by an unreadable reference also makes the formulas that depend on it stale.
  for (const cell of formulas) if (cell.opaque) frontier.push({ sheet: cell.sheet, row: cell.row, col: cell.col })
  let remaining = pending
  while (frontier.length > 0 && remaining.length > 0) {
    const bySheet = new Map<string, ChangedCell[]>()
    for (const cell of frontier) {
      const key = sheetKey(cell.sheet)
      const list = bySheet.get(key)
      if (list === undefined) bySheet.set(key, [cell])
      else list.push(cell)
    }
    const next: ChangedCell[] = []
    const still: FormulaCell[] = []
    for (const formula of remaining) {
      const hit = formula.refs.some((ref) => {
        const targets = bySheet.get(sheetKey(ref.sheet ?? formula.sheet))
        return targets !== undefined && targets.some((cell) => rangeContains(ref.range, cell.row, cell.col))
      })
      if (hit) {
        stale.add(formulaCellKey(formula.sheet, formula.row, formula.col))
        next.push({ sheet: formula.sheet, row: formula.row, col: formula.col })
      } else {
        still.push(formula)
      }
    }
    frontier = next
    remaining = still
  }
  return stale
}
